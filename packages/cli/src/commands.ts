import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ListMicrovmImagesCommand,
  ResumeMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  buildMicrovmImage,
  type ClientOptions,
  DEFAULT_IDLE_POLICY,
  getMicrovm,
  isNotFoundError,
  type LambdaMicrovmsClientLike,
  listMicrovms,
  MAX_MICROVM_DURATION_SECONDS,
  partitionForRegion,
  resolveClient,
  resolveImageArn,
  resolveRegion,
  Sandbox,
  shellQuote as shq,
  waitForMicrovmState,
} from "sunaba-sdk";
import { assertFlags, flagBool, flagInt, flagStr, type ParsedArgs } from "./args.js";
import { configPath, loadConfig, type SunabaConfig, writeConfig } from "./config.js";

/** Minimal shape shared by the real CloudWatch Logs client and test fakes. */
export type LogsClient = LambdaMicrovmsClientLike;

export interface CliContext extends ClientOptions {
  /** Injected CloudWatch Logs client (tests). */
  logsClient?: LogsClient;
  out?: (line: string) => void;
  err?: (line: string) => void;
  cwd?: string;
}

const stdout = (ctx: CliContext) => ctx.out ?? ((l: string) => console.log(l));
const stderr = (ctx: CliContext) => ctx.err ?? ((l: string) => console.error(l));

/** CloudWatch error names worth retrying while tailing logs. */
const TRANSIENT_LOG_NAMES = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailableException",
  "InternalServerException",
  "LimitExceededException",
]);

function clientOpts(ctx: CliContext): ClientOptions {
  const opts: ClientOptions = {};
  if (ctx.region) opts.region = ctx.region;
  if (ctx.client) opts.client = ctx.client;
  if (ctx.clientConfig) opts.clientConfig = ctx.clientConfig;
  return opts;
}

/** "al2023-1" → arn:aws:lambda:{region}:aws:microvm-image:al2023-1 */
function baseImageArn(base: string | undefined, region?: string): string {
  const name = base ?? "al2023-1";
  if (name.startsWith("arn:")) return name;
  if (!region) throw new Error(`cannot expand managed base image '${name}' without a region`);
  return `arn:${partitionForRegion(region)}:lambda:${region}:aws:microvm-image:${name}`;
}

// Region resolution lives in the SDK's resolveRegion — explicit opt,
// clientConfig, injected client, env, then the default provider chain
// (~/.aws/config profiles). Translate its NoRegion to CLI spelling.
async function regionOf(ctx: CliContext): Promise<string> {
  return resolveRegion(clientOpts(ctx)).catch((e) => {
    if ((e as { code?: string }).code === "NoRegion") {
      throw new Error("region required: pass --region or set AWS_REGION");
    }
    throw e;
  });
}

// ── init ──────────────────────────────────────────────────────────────

const DOCKERFILE_TEMPLATE = `FROM almalinux:9-minimal

# Install node for your application (adjust to your runtime).
RUN microdnf install -y nodejs tar && microdnf clean all

# OPTIONAL in-guest agent: exec/fs API on :8080 + lifecycle hooks on
# :9000. Exec/shell work agent-free via the managed SHELL_INGRESS
# connector, so you only need this for the HTTP API or hooks.
# To use it, uncomment these lines. The agent only answers while
# sunaba-agentd runs: make it the container command, or start it from
# your own entrypoint next to the app.
#   RUN npm install -g sunaba-agent
#   EXPOSE 8080 9000
#   CMD ["sunaba-agentd"]

# Replace with your real application entrypoint.
# CMD ["node", "/app/server.js"]
`;

export async function cmdInit(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, ["name"]);
  if (args._.length) throw new Error(`unexpected arguments: ${args._.join(" ")}`);
  const dir = ctx.cwd ?? process.cwd();
  const cfgPath = configPath(dir);
  if (existsSync(cfgPath)) {
    throw new Error(`${cfgPath} already exists`);
  }
  // Image names must match ^[a-zA-Z0-9-_]{1,64}$ — sanitize dir names.
  const derived = (flagStr(args, "name") ?? path.basename(dir))
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const cfg: SunabaConfig = {
    name: derived || "sunaba-image",
    sourceDir: ".",
    baseImage: "al2023-1",
    // Empty placeholders document which keys `build`/`run` need filled in.
    artifactBucket: "",
    buildRoleArn: "",
    executionRoleArn: "",
  };
  writeConfig(cfg, dir);
  const dockerfile = path.join(dir, "Dockerfile");
  const wroteDockerfile = !existsSync(dockerfile);
  if (wroteDockerfile) writeFileSync(dockerfile, DOCKERFILE_TEMPLATE);
  stdout(ctx)(
    `wrote ${cfgPath}${wroteDockerfile ? " and Dockerfile" : " (kept existing Dockerfile)"} — fill in artifactBucket and buildRoleArn`,
  );
  return 0;
}

// ── build ─────────────────────────────────────────────────────────────

export async function cmdBuild(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, [
    "dir",
    "zip",
    "s3-uri",
    "name",
    "role",
    "bucket",
    "memory",
    "base-image",
    "base-version",
    "description",
    "timeout",
  ]);
  if (args._.length) throw new Error(`unexpected arguments: ${args._.join(" ")}`);
  const dir = ctx.cwd ?? process.cwd();
  const cfg = loadConfig(dir);
  // Explicit source flags win over sunaba.json; exactly one allowed.
  const flagSources = [
    flagStr(args, "dir") !== undefined,
    flagStr(args, "zip") !== undefined,
    flagStr(args, "s3-uri") !== undefined,
  ].filter(Boolean).length;
  if (flagSources > 1) throw new Error("at most one of --dir/--zip/--s3-uri");
  const sourceDir = flagStr(args, "dir") ?? (flagSources === 0 ? cfg.sourceDir : undefined);
  const zip = flagStr(args, "zip");
  const s3Uri = flagStr(args, "s3-uri");
  if (!sourceDir && !zip && !s3Uri) {
    throw new Error("image source required: --dir/--zip/--s3-uri or sunaba.json sourceDir");
  }
  const name = flagStr(args, "name") ?? cfg.name;
  if (!name) throw new Error("image name required: --name or sunaba.json name");
  const buildRoleArn = flagStr(args, "role") ?? cfg.buildRoleArn;
  if (!buildRoleArn) throw new Error("build role required: --role or sunaba.json buildRoleArn");
  const artifactBucket = flagStr(args, "bucket") ?? cfg.artifactBucket;
  if (s3Uri === undefined && !artifactBucket) {
    throw new Error("artifact bucket required for dir/zip sources: --bucket");
  }
  const memory = flagInt(args, "memory", { min: 512, max: 8192 });
  if (memory !== undefined && ![512, 1024, 2048, 4096, 8192].includes(memory)) {
    throw new Error("--memory must be one of 512, 1024, 2048, 4096, 8192");
  }
  // Region is only needed to expand a managed base-image NAME into an ARN.
  const base = flagStr(args, "base-image") ?? cfg.baseImage;
  const region = base?.startsWith("arn:") ? undefined : await regionOf(ctx);

  const result = await buildMicrovmImage({
    ...clientOpts(ctx),
    name,
    // Config/flag paths are relative to the config dir (ctx.cwd), not the
    // process cwd — resolve before handing to the SDK.
    source: s3Uri
      ? { s3Uri }
      : zip
        ? { zip: path.resolve(dir, zip) }
        : { dir: path.resolve(dir, sourceDir as string) },
    artifactBucket,
    buildRoleArn,
    baseImageArn: baseImageArn(base, region),
    baseImageVersion: flagStr(args, "base-version"),
    memoryMiB: memory,
    description: flagStr(args, "description"),
    buildTimeoutMs: flagInt(args, "timeout", { min: 60_000, max: 3_600_000 }),
  });
  stdout(ctx)(`built ${result.imageArn} version ${result.imageVersion} (${result.state})`);
  return 0;
}

// ── run ───────────────────────────────────────────────────────────────

export async function cmdRun(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, [
    "image",
    "image-version",
    "version",
    "exec",
    "max-duration",
    "idle",
    "suspended",
    "timeout",
    "run-timeout",
    "no-auto-resume",
    "rm",
    "json",
    "shell",
    "payload",
    "role",
  ]);
  if (args._.length) throw new Error(`unexpected arguments: ${args._.join(" ")}`);
  if (args.cmd.length && flagStr(args, "exec")) {
    throw new Error("pass the command either after -- or via --exec, not both");
  }
  // Bare `--exec` (flag with no value and nothing after --) must not create
  // a VM with no command — it would just sit billable.
  if (args.flags.exec === true && !args.cmd.length) {
    throw new Error("--exec requires a command");
  }
  const cfg = loadConfig(ctx.cwd ?? process.cwd());
  const image = flagStr(args, "image") ?? cfg.name;
  if (!image) throw new Error("image required: --image or sunaba.json name");
  const maxDuration = flagInt(args, "max-duration", {
    min: 1,
    max: MAX_MICROVM_DURATION_SECONDS,
  });
  const idleSecs = flagInt(args, "idle", { min: 1, max: 28_800 });
  const suspendedSecs = flagInt(args, "suspended", { min: 1, max: 28_800 });
  const timeoutMs = flagInt(args, "timeout", { min: 1_000, max: 3_600_000 });
  const runTimeoutMs = flagInt(args, "run-timeout", { min: 10_000, max: 3_600_000 });
  const autoResumeOff = flagBool(args, "no-auto-resume");
  const execFlag = flagStr(args, "exec");
  if (execFlag !== undefined && !execFlag) throw new Error("empty --exec command");
  const command = args.cmd.length ? args.cmd.map(shq).join(" ") : execFlag;
  const rm = flagBool(args, "rm");
  // Every flag must validate BEFORE Sandbox.create — a bad value after
  // creation leaves a billable VM running (e.g. `--json typo`).
  const json = flagBool(args, "json");
  const shell = flagBool(args, "shell");
  if (shell && command) {
    throw new Error("--shell cannot be combined with a command");
  }
  if (rm && !command && !shell) {
    throw new Error("--rm requires a command (-- <cmd> or --exec)");
  }

  // `rm` cleanup must cover the whole lifecycle: RunMicrovm can succeed
  // while the RUNNING wait (or a later exec) is interrupted. Track the ID
  // from the moment the service creates the VM and terminate exactly once.
  let sb: Sandbox | undefined;
  let vmId: string | undefined;
  // Settles when Sandbox.create settles — a signal that lands while
  // RunMicrovm is still in-flight must wait for the response: exiting
  // earlier would orphan a VM the service already created. Starts
  // pending so the wait is fail-safe even if create never runs.
  let resolveCreated: () => void = () => {};
  const createSettled = new Promise<void>((r) => (resolveCreated = r));
  // Share the in-flight cleanup: a second SIGINT during terminate must
  // await the SAME promise, not start over or exit before it lands.
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    if (!vmId) return Promise.resolve();
    cleanupPromise = (async () => {
      try {
        if (sb) {
          await sb.terminate();
        } else {
          // VM was created but no Sandbox wrapper exists: a signal landed
          // during Sandbox.create's RUNNING wait, or create failed after
          // its own best-effort terminate. TerminateMicrovm is idempotent,
          // so repeating it is safe and retries one the SDK could not send.
          const client = resolveClient(clientOpts(ctx));
          await client.send(new TerminateMicrovmCommand({ microvmIdentifier: vmId }));
        }
        stderr(ctx)(`terminating ${vmId}`);
      } catch (e) {
        // Never let cleanup mask the real exit path.
        stderr(ctx)(`warning: could not terminate ${vmId}: ${(e as Error).message ?? e}`);
      }
    })();
    return cleanupPromise;
  };
  // Persistent listeners + single-exit guard: `process.once` would drop
  // the listener after the first signal, so a second SIGINT during the
  // in-flight terminate would hit the default action and kill the
  // process before TerminateMicrovm lands.
  let exiting = false;
  const exitOnce = (code: number) => {
    if (exiting) return;
    exiting = true;
    process.exit(code);
  };
  let signals = 0;
  const onSignal = (code: number) => {
    // A second signal means "get me out NOW" — a hung RunMicrovm would
    // otherwise trap Ctrl-C behind createSettled until SIGKILL.
    if (++signals > 1) {
      stderr(ctx)("second signal — forcing exit (in-flight cleanup may not finish)");
      exitOnce(code);
      return;
    }
    void (async () => {
      if (!vmId) {
        stderr(ctx)("signal received — waiting for the pending create to settle");
        await createSettled;
      }
      await cleanup();
    })().finally(() => exitOnce(code));
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  if (rm) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }
  try {
    const creating = Sandbox.create({
      ...clientOpts(ctx),
      image,
      imageVersion: flagStr(args, "image-version") ?? flagStr(args, "version"),
      executionRoleArn: flagStr(args, "role") ?? cfg.executionRoleArn,
      ...(maxDuration !== undefined ? { maximumDurationSeconds: maxDuration } : {}),
      ...(idleSecs !== undefined || suspendedSecs !== undefined || autoResumeOff
        ? {
            idlePolicy: {
              maxIdleDurationSeconds: idleSecs ?? DEFAULT_IDLE_POLICY.maxIdleDurationSeconds,
              suspendedDurationSeconds:
                suspendedSecs ?? DEFAULT_IDLE_POLICY.suspendedDurationSeconds,
              autoResumeEnabled: !autoResumeOff,
            },
          }
        : {}),
      runHookPayload: flagStr(args, "payload"),
      ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
      onMicrovmCreated: (id) => {
        vmId = id;
      },
    });
    creating.then(resolveCreated, resolveCreated);
    sb = await creating;
    vmId = sb.microvmId;
    if (shell) {
      stderr(ctx)(`${vmId} ${sb.endpoint}`);
      await sb.interactiveShell();
      return 0;
    }
    if (command) {
      stderr(ctx)(`${vmId} ${sb.endpoint}`);
      const res = await sb.exec(command, { timeoutMs });
      stdout(ctx)(json ? JSON.stringify({ microvmId: vmId, ...res }) : res.output);
      return res.exitCode;
    }
    stdout(ctx)(
      json
        ? JSON.stringify({
            microvmId: vmId,
            endpoint: sb.endpoint,
            state: sb.state,
            imageArn: sb.imageArn,
            imageVersion: sb.imageVersion,
            executionRoleArn: sb.executionRoleArn,
          })
        : `${vmId} ${sb.endpoint}`,
    );
    return 0;
  } finally {
    if (rm) {
      // Unblock any signal handler parked on the pending create, then
      // clean up FIRST and detach — a signal during the terminate must
      // not kill the in-flight termination.
      resolveCreated();
      await cleanup();
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }
}

// ── ls / images ───────────────────────────────────────────────────────

export async function cmdLs(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, ["image", "image-version", "version", "all", "json"]);
  if (args._.length) throw new Error(`unexpected arguments: ${args._.join(" ")}`);
  const json = flagBool(args, "json");
  const image = flagStr(args, "image");
  const items = await listMicrovms({
    ...clientOpts(ctx),
    // The API wants an ARN; accept an image name like `run` does.
    image:
      image && !image.startsWith("arn:")
        ? await resolveImageArn(resolveClient(clientOpts(ctx)), image)
        : image,
    imageVersion: flagStr(args, "image-version") ?? flagStr(args, "version"),
  });
  const rows = flagBool(args, "all") ? items : items.filter((i) => i.state !== "TERMINATED");
  if (json) {
    stdout(ctx)(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const i of rows) {
    stdout(ctx)(
      `${i.microvmId ?? "?"}\t${i.state ?? "?"}\t${i.imageVersion ?? "-"}\t${i.startedAt?.toISOString() ?? "-"}`,
    );
  }
  return 0;
}

export async function cmdImages(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, ["json"]);
  if (args._.length) throw new Error(`unexpected arguments: ${args._.join(" ")}`);
  const client = resolveClient(clientOpts(ctx));
  const rows: { imageArn?: string; name?: string }[] = [];
  let nextToken: string | undefined;
  do {
    const res = (await client.send(
      new ListMicrovmImagesCommand(nextToken ? { nextToken } : {}),
    )) as { items?: { imageArn?: string; name?: string }[]; nextToken?: string };
    rows.push(...(res.items ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  if (flagBool(args, "json")) {
    stdout(ctx)(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const r of rows) stdout(ctx)(`${r.name ?? "?"}\t${r.imageArn ?? "?"}`);
  return 0;
}

// ── exec / shell ──────────────────────────────────────────────────────

export async function cmdExec(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, ["timeout", "exec", "json"]);
  const id = args._[0];
  if (!id) throw new Error("usage: sunaba exec <microvm-id> [--timeout ms] -- <cmd...>");
  if (args._.length > 1) throw new Error(`unexpected arguments: ${args._.slice(1).join(" ")}`);
  if (args.cmd.length && flagStr(args, "exec")) {
    throw new Error("pass the command either after -- or via --exec, not both");
  }
  // Validate flags BEFORE connect — a bad flag must not resume a suspended VM.
  const timeoutMs = flagInt(args, "timeout", { min: 1_000, max: 3_600_000 });
  const execFlag = flagStr(args, "exec");
  const json = flagBool(args, "json");
  if (execFlag !== undefined && !execFlag) throw new Error("empty --exec command");
  const command = args.cmd.length ? args.cmd.map(shq).join(" ") : execFlag;
  if (!command) throw new Error("no command: `sunaba exec <id> -- <cmd...>`");
  const sb = await Sandbox.connect(id, clientOpts(ctx));
  const res = await sb.exec(command, { timeoutMs });
  if (json) {
    stdout(ctx)(JSON.stringify(res));
  } else {
    stdout(ctx)(res.output);
  }
  return res.exitCode;
}

export async function cmdShell(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, []);
  const id = args._[0];
  if (!id) throw new Error("usage: sunaba shell <microvm-id>");
  if (args._.length > 1) throw new Error(`unexpected arguments: ${args._.slice(1).join(" ")}`);
  const sb = await Sandbox.connect(id, clientOpts(ctx));
  await sb.interactiveShell();
  return 0;
}

// ── suspend / resume / rm ─────────────────────────────────────────────

/** Wait out transient states so lifecycle calls don't hit ConflictException. */
async function stableMicrovmState(
  client: LambdaMicrovmsClientLike,
  id: string,
  waitPending = true,
): Promise<Awaited<ReturnType<typeof getMicrovm>>> {
  let info = await getMicrovm(client, id);
  if (waitPending && info.state === "PENDING") {
    info = await waitForMicrovmState(client, id, "RUNNING");
  }
  if (info.state === "SUSPENDING") {
    info = await waitForMicrovmState(client, id, "SUSPENDED");
  }
  return info;
}

/**
 * Terminal state revealed by a get/wait error: a purged record is "gone",
 * a waiter's UnexpectedState exposes `.actual` (TERMINATING/TERMINATED),
 * anything else is a real error.
 */
function terminalFromError(e: unknown): "TERMINATING" | "TERMINATED" | "gone" | null {
  const se = e as { code?: string; actual?: unknown };
  if (
    se?.code === "UnexpectedState" &&
    (se.actual === "TERMINATING" || se.actual === "TERMINATED")
  ) {
    return se.actual;
  }
  if (isNotFoundError(e)) return "gone";
  return null;
}

/** Wait for a stable state, tolerating the VM dying mid-transition. */
async function stableOrDead(
  client: LambdaMicrovmsClientLike,
  id: string,
  waitPending = true,
): Promise<Awaited<ReturnType<typeof getMicrovm>> | "dead"> {
  try {
    return await stableMicrovmState(client, id, waitPending);
  } catch (e) {
    const t = terminalFromError(e);
    if (t === "gone") return "dead";
    // Surface the real terminal state so callers print it accurately.
    if (t) return { state: t } as Awaited<ReturnType<typeof getMicrovm>>;
    throw e;
  }
}

/**
 * Send a lifecycle command with one ConflictException retry after
 * re-stabilizing. Returns "sent", "dead", or the settled info when the VM
 * reached its goal on its own during the wait. `settle` overrides the
 * default PENDING/SUSPENDING wait (rm must not wait PENDING→RUNNING).
 */
async function sendWithConflictRetry(
  client: LambdaMicrovmsClientLike,
  id: string,
  send: () => Promise<unknown>,
  settle: () => Promise<Awaited<ReturnType<typeof getMicrovm>> | "dead"> = () =>
    stableOrDead(client, id),
): Promise<"sent" | "dead" | Awaited<ReturnType<typeof getMicrovm>>> {
  try {
    await send();
    return "sent";
  } catch (e) {
    if ((e as { name?: string }).name !== "ConflictException") throw e;
  }
  return settle();
}

/** Shared driver for `suspend` and `resume` — identical flow, different command/goal. */
async function lifecycleCommand(
  ctx: CliContext,
  ids: readonly string[],
  verb: "suspend" | "resume",
  goal: "RUNNING" | "SUSPENDED",
  makeCommand: (id: string) => unknown,
  timeoutMs?: number,
): Promise<number> {
  const client = resolveClient(clientOpts(ctx));
  const out = stdout(ctx);
  let failed = 0;
  for (const id of ids) {
    try {
      const info = await stableOrDead(client, id);
      if (info === "dead") {
        out(`terminated ${id}`);
        continue;
      }
      if (info.state === goal) {
        out(`already ${goal === "SUSPENDED" ? "suspended" : "running"} ${id}`);
        continue;
      }
      if (info.state === "TERMINATED" || info.state === "TERMINATING") {
        out(`already ${info.state.toLowerCase()} ${id}`);
        continue;
      }
      const result = await sendWithConflictRetry(client, id, () => client.send(makeCommand(id)));
      if (result === "dead") {
        out(`terminated ${id}`);
        continue;
      }
      const done = verb === "suspend" ? "suspended" : "resumed";
      if (result !== "sent") {
        if (result.state === goal) {
          out(`${done} ${id}`);
          continue;
        }
        if (result.state === "TERMINATED" || result.state === "TERMINATING") {
          out(`already ${result.state.toLowerCase()} ${id}`);
          continue;
        }
        // Still in the pre-goal state after the conflict — one retry.
        await client.send(makeCommand(id));
      }
      await waitForMicrovmState(client, id, goal, { timeoutMs });
      out(`${done} ${id}`);
    } catch (e) {
      stderr(ctx)(`warning: could not ${verb} ${id}: ${(e as Error).message ?? e}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

export async function cmdSuspend(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, ["timeout"]);
  if (!args._.length) throw new Error("usage: sunaba suspend <microvm-id>...");
  return lifecycleCommand(
    ctx,
    args._,
    "suspend",
    "SUSPENDED",
    (id) => new SuspendMicrovmCommand({ microvmIdentifier: id }),
    flagInt(args, "timeout", { min: 1_000, max: 3_600_000 }),
  );
}

export async function cmdResume(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, ["timeout"]);
  if (!args._.length) throw new Error("usage: sunaba resume <microvm-id>...");
  return lifecycleCommand(
    ctx,
    args._,
    "resume",
    "RUNNING",
    (id) => new ResumeMicrovmCommand({ microvmIdentifier: id }),
    flagInt(args, "timeout", { min: 1_000, max: 3_600_000 }),
  );
}

export async function cmdRm(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, []);
  const ids = args._;
  if (!ids.length) throw new Error("usage: sunaba rm <microvm-id>...");
  const client = resolveClient(clientOpts(ctx));
  const goneMessage = (t: "TERMINATING" | "TERMINATED" | "gone", id: string) =>
    t === "gone" || t === "TERMINATED" ? `terminated ${id}` : `already terminating ${id}`;
  let failed = 0;
  for (const id of ids) {
    try {
      // rm must NOT wait for PENDING→RUNNING — a wedged startup is
      // killable exactly because it may never become stable. Only
      // SUSPENDING needs a settle (Terminate on SUSPENDING conflicts).
      let info: Awaited<ReturnType<typeof getMicrovm>> | "dead";
      try {
        info = await getMicrovm(client, id);
      } catch (e) {
        const t = terminalFromError(e);
        if (t) {
          stdout(ctx)(goneMessage(t, id));
          continue;
        }
        throw e;
      }
      if (info.state === "SUSPENDING") {
        try {
          info = await waitForMicrovmState(client, id, "SUSPENDED");
        } catch (e) {
          const t = terminalFromError(e);
          if (t) {
            stdout(ctx)(goneMessage(t, id));
            continue;
          }
          throw e;
        }
      }
      if (info.state === "TERMINATED" || info.state === "TERMINATING") {
        stdout(ctx)(`already ${info.state.toLowerCase()} ${id}`);
        continue;
      }
      // On a terminate conflict, re-check without waiting PENDING→RUNNING —
      // a wedged startup must still be killable. Only SUSPENDING settles.
      const result = await sendWithConflictRetry(
        client,
        id,
        () => client.send(new TerminateMicrovmCommand({ microvmIdentifier: id })),
        () => stableOrDead(client, id, false),
      );
      if (result === "dead") {
        stdout(ctx)(`terminated ${id}`);
        continue;
      }
      if (result !== "sent") {
        if (result.state === "TERMINATING" || result.state === "TERMINATED") {
          stdout(ctx)(`already ${result.state.toLowerCase()} ${id}`);
          continue;
        }
        // Settled in a live state (PENDING included — terminate works
        // there too) — retry once.
        await client.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
      }
      stdout(ctx)(`terminating ${id}`);
    } catch (e) {
      stderr(ctx)(`warning: could not terminate ${id}: ${(e as Error).message ?? e}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

// ── logs ──────────────────────────────────────────────────────────────

const LOG_GROUP_PREFIX = "/aws/lambda-microvms";

interface LogEvent {
  timestamp?: number;
  message?: string;
}

const ESC = String.fromCharCode(0x1b);
// Messages come from code inside the sandbox — untrusted. Drop CSI
// sequences (colors, cursor moves) whole and every other control
// character except tab and newline, so a message cannot drive the
// viewer's terminal.
const LOG_CONTROL_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|(?![\\t\\n])\\p{Cc}`, "gu");

function formatLogEvent(ev: LogEvent): string {
  const message = (ev.message ?? "").replace(LOG_CONTROL_RE, "");
  return `${new Date(ev.timestamp ?? 0).toISOString()} ${message}`;
}

async function logsClient(ctx: CliContext): Promise<LogsClient> {
  if (ctx.logsClient) return ctx.logsClient;
  const { CloudWatchLogsClient } = await import("@aws-sdk/client-cloudwatch-logs");
  // A custom endpoint aimed at Lambda MicroVMs must not leak into the
  // CloudWatch client.
  const { endpoint: _endpoint, ...rest } = (ctx.clientConfig ?? {}) as Record<string, unknown>;
  return new CloudWatchLogsClient({
    ...rest,
    ...(ctx.region ? { region: ctx.region } : {}),
  });
}

/** All groups under the managed /aws/lambda-microvms namespace. */
async function listManagedLogGroups(cw: LogsClient): Promise<string[]> {
  const { DescribeLogGroupsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = (await cw.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: LOG_GROUP_PREFIX,
        ...(nextToken ? { nextToken } : {}),
      }),
    )) as { logGroups?: { logGroupName?: string }[]; nextToken?: string };
    for (const g of res.logGroups ?? []) {
      if (g.logGroupName) names.push(g.logGroupName);
    }
    nextToken = res.nextToken;
  } while (nextToken);
  // Prefix match can over-match ("/aws/lambda-microvmsXYZ") — keep only
  // names under the managed namespace.
  return names.filter((n) => n === LOG_GROUP_PREFIX || n.startsWith(`${LOG_GROUP_PREFIX}/`));
}

/** Image name from an image ARN (arn:...:microvm-image:<name>) or bare name. */
function imageNameOf(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const i = arn.indexOf("microvm-image:");
  return i === -1 ? arn : arn.slice(i + "microvm-image:".length);
}

/** Stream names for one MicroVM inside a group (exact id or `id/…`). */
async function findStreams(cw: LogsClient, group: string, id: string): Promise<string[]> {
  const { DescribeLogStreamsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
  const names: string[] = [];
  let token: string | undefined;
  do {
    const res = (await cw.send(
      new DescribeLogStreamsCommand({
        logGroupName: group,
        logStreamNamePrefix: id,
        orderBy: "LogStreamName",
        ...(token ? { nextToken: token } : {}),
      }),
    )) as { logStreams?: { logStreamName?: string }[]; nextToken?: string };
    for (const s of res.logStreams ?? []) {
      // Prefix match can over-match ("m-1" hits "m-10") — keep exact id
      // or `${id}/…` custom streams only.
      if (s.logStreamName && (s.logStreamName === id || s.logStreamName.startsWith(`${id}/`))) {
        names.push(s.logStreamName);
      }
    }
    token = res.nextToken;
  } while (token);
  return names;
}

/**
 * Pick the log group + streams for a MicroVM. AWS writes default logs to
 * `/aws/lambda-microvms/<image-name>` — resolve the VM's image first so a
 * multi-image account doesn't silently read another image's group.
 * Falls back to scanning every managed group for the VM's streams.
 */
async function resolveLogTarget(
  cw: LogsClient,
  ctx: CliContext,
  id: string,
): Promise<{ group: string; streams: string[] }> {
  const client = resolveClient(clientOpts(ctx));
  // The image only orders the scan, so a failed lookup falls back to the
  // full scan — and is reported only if that scan finds nothing.
  let lookupError: unknown;
  const preferred = await getMicrovm(client, id)
    .then((i) => imageNameOf(i.imageArn))
    .then((n) => (n ? `${LOG_GROUP_PREFIX}/${n}` : undefined))
    .catch((e: unknown) => {
      if (!isNotFoundError(e)) lookupError = e;
      return undefined;
    });
  const groups = await listManagedLogGroups(cw);
  const ordered = preferred ? [preferred, ...groups.filter((g) => g !== preferred)] : groups.sort();
  // Probe groups with bounded concurrency — a busy account can have many
  // managed groups and a sequential scan would be slow.
  const CONCURRENCY = 4;
  // A group deleted mid-scan simply has no streams. Any other probe
  // failure (AccessDenied, throttling) only matters when no group yields
  // the streams — then it, not "no log streams", is the real cause.
  let probeError: unknown;
  for (let i = 0; i < ordered.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      ordered.slice(i, i + CONCURRENCY).map(async (group) => ({
        group,
        streams: await findStreams(cw, group, id).catch((e: unknown) => {
          if (!isNotFoundError(e)) probeError ??= e;
          return [] as string[];
        }),
      })),
    );
    const hit = batch.find((b) => b.streams.length);
    if (hit) return hit;
  }
  // A failed lookup or probe explains an empty result better than the
  // result itself, including "no log group at all".
  if (probeError !== undefined) throw probeError;
  if (lookupError !== undefined) throw lookupError;
  if (!ordered.length) {
    throw new Error(`no log group under ${LOG_GROUP_PREFIX} — pass --group`);
  }
  return { group: ordered[0] as string, streams: [] };
}

export async function cmdLogs(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, ["group", "follow", "tail"]);
  const id = args._[0];
  if (!id) throw new Error("usage: sunaba logs <microvm-id> [--group name] [--follow] [--tail n]");
  if (args._.length > 1) throw new Error(`unexpected arguments: ${args._.slice(1).join(" ")}`);
  const tail = flagInt(args, "tail", { min: 1, max: 10_000 });
  const follow = flagBool(args, "follow");
  if (follow && tail !== undefined) {
    stderr(ctx)("warning: --tail has no effect with --follow");
  }
  const cw = await logsClient(ctx);
  const { GetLogEventsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
  let group: string;
  let names: string[];
  const explicit = flagStr(args, "group");
  if (explicit) {
    group = explicit;
    names = await findStreams(cw, group, id);
  } else {
    const target = await resolveLogTarget(cw, ctx, id);
    group = target.group;
    names = target.streams;
  }
  if (!names.length) {
    stderr(ctx)(`no log streams matching ${id} in ${group}`);
    return 1;
  }

  // nextForwardToken is a per-stream cursor — track them separately.
  const tokens = new Map<string, string | undefined>();
  if (!follow) {
    const events: LogEvent[] = [];
    // Single stream with no --tail: stream output directly instead of
    // buffering the whole history in memory.
    const printNow = names.length === 1 && tail === undefined;
    const emit = (ev: LogEvent) => {
      if (printNow) {
        stdout(ctx)(formatLogEvent(ev));
      } else {
        events.push(ev);
      }
    };
    for (const streamName of names) {
      if (tail === undefined) {
        // Full drain, forward-paging; a repeated token means end-of-stream.
        let next: string | undefined;
        for (;;) {
          const res = (await cw.send(
            new GetLogEventsCommand({
              logGroupName: group,
              logStreamName: streamName,
              startFromHead: true,
              ...(next ? { nextToken: next } : {}),
            }),
          )) as {
            events?: LogEvent[];
            nextForwardToken?: string;
          };
          for (const ev of res.events ?? []) emit(ev);
          if (!res.nextForwardToken || res.nextForwardToken === next) break;
          next = res.nextForwardToken;
        }
      } else {
        // --tail: page BACKWARD so a large backlog costs O(tail), not O(all).
        let remaining = tail;
        let back: string | undefined;
        while (remaining > 0) {
          const res = (await cw.send(
            new GetLogEventsCommand({
              logGroupName: group,
              logStreamName: streamName,
              limit: Math.min(remaining, 10_000),
              ...(back ? { nextToken: back } : {}),
            }),
          )) as {
            events?: LogEvent[];
            nextBackwardToken?: string;
          };
          const got = res.events ?? [];
          for (const ev of got) emit(ev);
          remaining -= got.length;
          // Empty pages do NOT mean end-of-stream — only a repeated
          // backward token does.
          if (!res.nextBackwardToken || res.nextBackwardToken === back) break;
          back = res.nextBackwardToken;
        }
      }
    }
    events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    for (const ev of events.slice(tail !== undefined ? -tail : 0)) {
      stdout(ctx)(formatLogEvent(ev));
    }
    return 0;
  }
  // --follow: like `docker logs -f`, not `tail -f` — print every stream
  // from its head, then keep polling from the saved token for new events.
  // A repeated token = end-of-stream.
  const get = (streamName: string, next?: string) =>
    cw.send(
      new GetLogEventsCommand({
        logGroupName: group,
        logStreamName: streamName,
        startFromHead: true,
        ...(next ? { nextToken: next } : {}),
      }),
    ) as Promise<{
      events?: LogEvent[];
      nextForwardToken?: string;
    }>;
  const MAX_PAGES = 10; // cap work per stream per cycle — busy streams
  // producing faster than we page would otherwise starve peers/throttle.
  const isTransient = (e: unknown) => {
    const err = e as { name?: string; code?: string } | null;
    if (err?.name && TRANSIENT_LOG_NAMES.has(err.name)) return true;
    if (err?.code && /^(ECONNRESET|ETIMEDOUT|EPIPE|ENETUNREACH|UND_ERR_)/.test(err.code)) {
      return true;
    }
    return /throttl|TooManyRequests|socket hang up|fetch failed|ECONNRESET|ETIMEDOUT/i.test(
      String(e),
    );
  };
  // Initial backlog: print as we go so nothing is dropped. The page cap
  // only bounds this first pass per stream — a longer history keeps
  // printing in the polling loop below, MAX_PAGES per stream per cycle.
  // The attempt cap stops a persistently-failing stream from wedging
  // peers or the follow loop entirely.
  const MAX_ATTEMPTS = 5;
  for (const streamName of names) {
    let next: string | undefined;
    let attempts = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const res = await get(streamName, next);
        for (const ev of res.events ?? []) {
          stdout(ctx)(formatLogEvent(ev));
        }
        if (res.nextForwardToken) tokens.set(streamName, res.nextForwardToken);
        if (!res.nextForwardToken || res.nextForwardToken === next) break;
        next = res.nextForwardToken;
      } catch (e) {
        if (!isTransient(e)) throw e;
        stderr(ctx)(`warning: ${(e as Error).message ?? e} — retrying`);
        if (++attempts >= MAX_ATTEMPTS) {
          stderr(ctx)(`warning: giving up on backlog for ${streamName} — following live`);
          break;
        }
        page--; // retry this page after a short backoff
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }
  for (;;) {
    for (const streamName of names) {
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await get(streamName, tokens.get(streamName));
          for (const ev of res.events ?? []) {
            stdout(ctx)(formatLogEvent(ev));
          }
          const prev = tokens.get(streamName);
          if (res.nextForwardToken) tokens.set(streamName, res.nextForwardToken);
          if (!res.nextForwardToken || res.nextForwardToken === prev) break;
        }
      } catch (e) {
        // Transient throttling/service errors: warn and back off rather
        // than crash the follow loop.
        if (!isTransient(e)) throw e;
        stderr(ctx)(`warning: ${(e as Error).message ?? e} — retrying`);
      }
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// ── status ────────────────────────────────────────────────────────────

export async function cmdStatus(args: ParsedArgs, ctx: CliContext): Promise<number> {
  assertFlags(args, ["json"]);
  const id = args._[0];
  if (!id) throw new Error("usage: sunaba status <microvm-id>");
  if (args._.length > 1) throw new Error(`unexpected arguments: ${args._.slice(1).join(" ")}`);
  const json = flagBool(args, "json");
  const info = await getMicrovm(resolveClient(clientOpts(ctx)), id);
  stdout(ctx)(json ? JSON.stringify(info) : `${info.state}\t${info.endpoint ?? "-"}`);
  return 0;
}
