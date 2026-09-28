import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sandbox } from "sunaba-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flagBool, flagInt, flagStr, parseArgs } from "../src/args.js";
import {
  type CliContext,
  cmdBuild,
  cmdExec,
  cmdImages,
  cmdInit,
  cmdLogs,
  cmdLs,
  cmdResume,
  cmdRm,
  cmdRun,
  cmdShell,
  cmdStatus,
  cmdSuspend,
} from "../src/commands.js";
import { loadConfig, writeConfig } from "../src/config.js";

// A default-constructed LambdaMicrovmsClient is only reached through the
// regionOf fallback — every other path injects ctx.client. Its region
// provider is switchable so both fallback outcomes are testable without
// ambient AWS config.
const defaultClientRegion = vi.hoisted(() => ({
  value: "us-west-2" as string | Error | undefined,
}));
vi.mock("@aws-sdk/client-lambda-microvms", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@aws-sdk/client-lambda-microvms")>();
  class FakeDefaultClient {
    config = {
      region: async () => {
        const v = defaultClientRegion.value;
        if (v instanceof Error) throw v;
        if (v === undefined) throw new Error("Region is missing");
        return v;
      },
    };
    async send(): Promise<unknown> {
      return {};
    }
  }
  return { ...orig, LambdaMicrovmsClient: FakeDefaultClient };
});

const ARN = "arn:aws:lambda:us-east-1:123456789012:microvm-image:demo";

/** Stateful fake: lifecycle commands mutate the reported MicroVM state. */
class FakeClient {
  calls: unknown[] = [];
  /** Failures to inject, consumed in order: { cmd name, error, input subset }. */
  failures: { cmd: string; err: Error; input?: Record<string, unknown> }[] = [];
  constructor(private state = "RUNNING") {}
  /** Throw `err` the next time `cmd` is sent (optionally matching input fields). */
  failOnce(cmd: string, err: Error, input?: Record<string, unknown>): void {
    this.failures.push({ cmd, err, input });
  }
  async send(command: unknown): Promise<unknown> {
    this.calls.push(command);
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    const f = this.failures.findIndex(
      (x) =>
        x.cmd === name && (!x.input || Object.entries(x.input).every(([k, v]) => input[k] === v)),
    );
    if (f !== -1) throw this.failures.splice(f, 1)[0].err;
    switch (name) {
      case "ListMicrovmImagesCommand":
        return { items: [{ name: "demo", imageArn: ARN }] };
      case "ListMicrovmImageVersionsCommand":
        return {
          items: [
            {
              imageVersion: "1.0",
              status: "ACTIVE",
              state: "SUCCESSFUL",
              createdAt: new Date(),
            },
          ],
        };
      case "GetMicrovmImageVersionCommand":
        return { imageArn: ARN, imageVersion: input.imageVersion, state: "SUCCESSFUL" };
      case "RunMicrovmCommand":
        this.state = "RUNNING";
        // The real API returns a bare host — the SDK prepends https:// itself.
        return { microvmId: "m-1", endpoint: "e.lambda-microvm.on.aws", state: "PENDING" };
      case "GetMicrovmCommand": {
        // Report the transient state once, then settle — waiter-based code
        // observes PENDING→RUNNING / SUSPENDING→SUSPENDED transitions.
        const reported = this.state;
        if (reported === "PENDING") this.state = "RUNNING";
        else if (reported === "SUSPENDING") this.state = "SUSPENDED";
        return {
          microvmId: input.microvmIdentifier,
          state: reported,
          endpoint: "e.lambda-microvm.on.aws",
          imageArn: ARN,
          imageVersion: "1.0",
        };
      }
      case "ListMicrovmsCommand":
        return {
          items: [
            { microvmId: "m-1", state: "RUNNING", imageArn: ARN, startedAt: new Date() },
            { microvmId: "m-2", state: "TERMINATED", imageArn: ARN },
          ],
        };
      case "SuspendMicrovmCommand":
        this.state = "SUSPENDED";
        return {};
      case "ResumeMicrovmCommand":
        this.state = "RUNNING";
        return {};
      case "TerminateMicrovmCommand":
        this.state = "TERMINATING";
        return {};
      case "CreateMicrovmImageCommand":
        return { imageArn: ARN, imageVersion: "1.1" };
      default:
        return {};
    }
  }
  callsOf(name: string): { input: Record<string, unknown> }[] {
    return this.calls.filter(
      (c) => (c as { constructor: { name: string } }).constructor.name === name,
    ) as { input: Record<string, unknown> }[];
  }
}

function ctx(lines: string[] = [], extra: Partial<CliContext> = {}, state = "RUNNING") {
  const client = new FakeClient(state);
  return {
    lines,
    client,
    context: {
      client: client as never,
      region: "us-east-1",
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(`ERR ${l}`),
      ...extra,
    } as CliContext,
  };
}

/** Advance fake timers until `p` settles — for code that sleeps between polls. */
async function runTimersUntilSettled(p: Promise<unknown>): Promise<void> {
  let settled = false;
  void p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 1_000 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000);
}

describe("parseArgs", () => {
  it("parses flags, values, positionals and --", () => {
    const a = parseArgs(["exec", "m-1", "--timeout", "5000", "--json", "--", "ls", "-la"]);
    expect(a._).toEqual(["exec", "m-1"]);
    expect(a.cmd).toEqual(["ls", "-la"]);
    expect(flagInt(a, "timeout", { min: 0, max: 99999 })).toBe(5000);
    expect(flagBool(a, "json")).toBe(true);
  });

  it("supports --key=value and bare flags", () => {
    const a = parseArgs(["--image=demo", "--all"]);
    expect(flagStr(a, "image")).toBe("demo");
    expect(flagBool(a, "all")).toBe(true);
  });

  it("flagInt validates bounds", () => {
    const a = parseArgs(["--timeout", "abc"]);
    expect(() => flagInt(a, "timeout", { min: 0, max: 10 })).toThrow();
  });

  it("flagBool rejects a swallowed positional (--rm myname)", () => {
    const a = parseArgs(["--rm", "myname"]);
    expect(() => flagBool(a, "rm")).toThrow(/doesn't take a value/);
    expect(flagBool(parseArgs(["--rm"]), "rm")).toBe(true);
    expect(flagBool(parseArgs(["--rm=true"]), "rm")).toBe(true);
    expect(flagBool(parseArgs(["--rm=false"]), "rm")).toBe(false);
  });
});

describe("init", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes sunaba.json and Dockerfile", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-cli-"));
    dirs.push(dir);
    const c = ctx();
    const code = await cmdInit(parseArgs([]), { ...c.context, cwd: dir });
    expect(code).toBe(0);
    const cfg = loadConfig(dir);
    expect(cfg.name).toBe(path.basename(dir));
    expect(cfg.baseImage).toBe("al2023-1");
    const dockerfile = readFileSync(path.join(dir, "Dockerfile"), "utf8");
    // The agent is OPTIONAL — shown commented out; never COPY a directory
    // init doesn't create.
    expect(dockerfile).toContain("sunaba-agent");
    expect(dockerfile).not.toMatch(/^RUN npm install -g sunaba-agent$/m);
    expect(dockerfile).not.toContain("COPY sunaba-agent/");
    expect(dockerfile).toMatch(/^#\s+RUN npm install -g sunaba-agent$/m);
    // Installing the agent without starting it serves nothing — the
    // commented recipe must include the command that runs it.
    expect(dockerfile).toMatch(/^#\s+CMD \["sunaba-agentd"\]$/m);
    // init users installed from npm: no steps that need a sunaba checkout.
    expect(dockerfile).not.toContain("npm pack");
    expect(dockerfile).not.toContain("once published");
    expect(JSON.parse(readFileSync(path.join(dir, "sunaba.json"), "utf8")).sourceDir).toBe(".");
  });

  it("init placeholders load as unset (no empty strings leak into API input)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-cli-"));
    dirs.push(dir);
    await cmdInit(parseArgs([]), { ...ctx().context, cwd: dir });
    const cfg = loadConfig(dir);
    // init writes "" placeholders so users see which keys exist — they
    // must read back as absent, never reach RunMicrovm as "".
    expect(cfg.executionRoleArn).toBeUndefined();
    expect(cfg.buildRoleArn).toBeUndefined();
    expect(cfg.artifactBucket).toBeUndefined();
    const { client, context, lines } = ctx([], { cwd: dir });
    await cmdRun(parseArgs(["--image", "demo", "--json"]), context);
    const run = client.callsOf("RunMicrovmCommand")[0];
    expect(run.input.executionRoleArn).toBeUndefined();
    expect(
      JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}").executionRoleArn,
    ).toBeUndefined();
  });

  it("sanitizes an invalid --name into a valid image name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-cli-"));
    dirs.push(dir);
    await cmdInit(parseArgs(["--name", "My App.v2!"]), { ...ctx().context, cwd: dir });
    expect(loadConfig(dir).name).toBe("My-App-v2");
  });

  it("refuses to overwrite an existing config", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-cli-"));
    dirs.push(dir);
    await cmdInit(parseArgs([]), { ...ctx().context, cwd: dir });
    await expect(cmdInit(parseArgs([]), { ...ctx().context, cwd: dir })).rejects.toThrow(
      /already exists/,
    );
  });
});

describe("build", () => {
  it("builds from an s3 uri with flags", async () => {
    const { client, context, lines } = ctx();
    const code = await cmdBuild(
      parseArgs([
        "--s3-uri",
        "s3://bkt/app.zip",
        "--name",
        "demo",
        "--role",
        "arn:aws:iam::123456789012:role/build",
      ]),
      context,
    );
    expect(code).toBe(0);
    const create = client.callsOf("CreateMicrovmImageCommand")[0];
    expect(create.input.name).toBe("demo");
    expect(create.input.buildRoleArn).toBe("arn:aws:iam::123456789012:role/build");
    expect(lines[0]).toContain(`built ${ARN}`);
  });

  it("takes name/role from sunaba.json", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-cli-"));
    try {
      writeConfig(
        { name: "cfg-name", sourceDir: ".", buildRoleArn: "arn:aws:iam::123456789012:role/r" },
        dir,
      );
      const { client, context } = ctx([], { cwd: dir });
      // --s3-uri bypasses the S3 upload path, so no artifact bucket is used.
      const code = await cmdBuild(parseArgs(["--s3-uri", "s3://bkt/app.zip"]), context);
      expect(code).toBe(0);
      expect(client.callsOf("CreateMicrovmImageCommand")[0]?.input).toMatchObject({
        name: "cfg-name",
        buildRoleArn: "arn:aws:iam::123456789012:role/r",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing role", async () => {
    await expect(
      cmdBuild(parseArgs(["--s3-uri", "s3://bkt/a.zip", "--name", "x"]), ctx().context),
    ).rejects.toThrow(/build role/);
  });

  it("region fallback taps the default provider chain, not the injected client", async () => {
    // Regression: the fallback must build a fresh client — an injected
    // fake without .config.region must not veto profile/env resolution.
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_DEFAULT_REGION", "");
    try {
      const { client, context } = ctx([], { region: undefined });
      const code = await cmdBuild(
        parseArgs([
          "--s3-uri",
          "s3://bkt/app.zip",
          "--name",
          "demo",
          "--role",
          "arn:aws:iam::123456789012:role/build",
        ]),
        context,
      );
      expect(code).toBe(0);
      // Managed-name expansion proves the mocked default client's region.
      const create = client.callsOf("CreateMicrovmImageCommand")[0];
      expect(create.input.baseImageArn).toBe("arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports 'region required' when no provider resolves a region", async () => {
    // The default chain's provider rejects ("Region is missing") — the
    // CLI must surface its own actionable error, not the SDK's.
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_DEFAULT_REGION", "");
    const prev = defaultClientRegion.value;
    defaultClientRegion.value = undefined;
    try {
      const { context } = ctx([], { region: undefined });
      await expect(
        cmdBuild(
          parseArgs([
            "--s3-uri",
            "s3://bkt/a.zip",
            "--name",
            "x",
            "--role",
            "arn:aws:iam::123456789012:role/r",
          ]),
          context,
        ),
      ).rejects.toThrow(/region required/);
    } finally {
      defaultClientRegion.value = prev;
      vi.unstubAllEnvs();
    }
  });

  it("rethrows non-missing provider errors instead of 'region required'", async () => {
    // A provider failing for a real reason (malformed profile etc.) must
    // surface its own error — only "Region is missing" maps to the CLI's.
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_DEFAULT_REGION", "");
    const prev = defaultClientRegion.value;
    defaultClientRegion.value = new Error("profile exploded");
    try {
      const { context } = ctx([], { region: undefined });
      await expect(
        cmdBuild(
          parseArgs([
            "--s3-uri",
            "s3://bkt/a.zip",
            "--name",
            "x",
            "--role",
            "arn:aws:iam::123456789012:role/r",
          ]),
          context,
        ),
      ).rejects.toThrow(/profile exploded/);
    } finally {
      defaultClientRegion.value = prev;
      vi.unstubAllEnvs();
    }
  });

  it("rethrows errors that merely contain 'Region is missing'", async () => {
    // Only the SDK's exact absence error maps to "region required" — a
    // different failure mentioning it must not be swallowed.
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_DEFAULT_REGION", "");
    const prev = defaultClientRegion.value;
    defaultClientRegion.value = new Error("wrapped: Region is missing (inner)");
    try {
      const { context } = ctx([], { region: undefined });
      await expect(
        cmdBuild(
          parseArgs([
            "--s3-uri",
            "s3://bkt/a.zip",
            "--name",
            "x",
            "--role",
            "arn:aws:iam::123456789012:role/r",
          ]),
          context,
        ),
      ).rejects.toThrow(/wrapped:/);
    } finally {
      defaultClientRegion.value = prev;
      vi.unstubAllEnvs();
    }
  });
});

describe("run", () => {
  it("launches a sandbox by image name and prints the id", async () => {
    const { client, context, lines } = ctx();
    const code = await cmdRun(parseArgs(["--image", "demo"]), context);
    expect(code).toBe(0);
    expect(lines[0]).toContain("m-1");
    expect(lines[0]).toContain("e.lambda-microvm.on.aws");
    const run = client.callsOf("RunMicrovmCommand")[0];
    expect(run.input.imageIdentifier).toBe(ARN);
    expect(run.input.imageVersion).toBe("1.0");
  });

  it("attaches the managed HTTP_INGRESS + SHELL_INGRESS connectors (never ALL_INGRESS)", async () => {
    const { client, context } = ctx();
    await cmdRun(parseArgs(["--image", "demo"]), context);
    // RunMicrovm rejects ALL_INGRESS combined with any other ingress connector.
    expect(client.callsOf("RunMicrovmCommand")[0].input.ingressNetworkConnectors).toEqual([
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS",
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:SHELL_INGRESS",
    ]);
  });

  it("--image-version pins the version; --version works as a compat alias", async () => {
    const { client, context } = ctx();
    await cmdRun(parseArgs(["--image", "demo", "--image-version", "9.9"]), context);
    expect(client.callsOf("RunMicrovmCommand")[0].input.imageVersion).toBe("9.9");

    const c2 = ctx();
    await cmdRun(parseArgs(["--image", "demo", "--version", "8.8"]), c2.context);
    expect(c2.client.callsOf("RunMicrovmCommand")[0].input.imageVersion).toBe("8.8");

    // --image-version wins when both are present.
    const c3 = ctx();
    await cmdRun(
      parseArgs(["--image", "demo", "--image-version", "7.7", "--version", "8.8"]),
      c3.context,
    );
    expect(c3.client.callsOf("RunMicrovmCommand")[0].input.imageVersion).toBe("7.7");
  });

  it("--json emits only safe public fields (no client/token internals)", async () => {
    const { context, lines } = ctx();
    await cmdRun(parseArgs(["--image", "demo", "--json"]), context);
    const out = JSON.parse(lines[0]);
    expect(out.microvmId).toBe("m-1");
    // The real API returns a bare host; the SDK prepends https:// itself.
    expect(out.endpoint).toBe("e.lambda-microvm.on.aws");
    expect(out.imageArn).toBe(ARN);
    // Only the explicit allowlist may be emitted — no client/token internals.
    const allowed = new Set([
      "microvmId",
      "endpoint",
      "state",
      "imageArn",
      "imageVersion",
      "executionRoleArn",
    ]);
    expect(Object.keys(out).every((k) => allowed.has(k))).toBe(true);
  });

  it("--json with a command prints the exec result as JSON, not raw output", async () => {
    const exec = vi.spyOn(Sandbox.prototype, "exec").mockResolvedValue({
      output: "hi\n",
      exitCode: 3,
    });
    try {
      for (const argv of [
        ["--image", "demo", "--json", "--", "echo", "hi"],
        ["--image", "demo", "--json", "--exec", "echo hi"],
      ]) {
        const { context, lines } = ctx();
        expect(await cmdRun(parseArgs(argv), context)).toBe(3);
        const out = lines.filter((l) => !l.startsWith("ERR ")).map((l) => JSON.parse(l));
        expect(out).toEqual([{ microvmId: "m-1", output: "hi\n", exitCode: 3 }]);
      }
    } finally {
      exec.mockRestore();
    }
  });

  it("--no-auto-resume alone produces an idlePolicy with autoResumeEnabled=false", async () => {
    const { client, context } = ctx();
    await cmdRun(parseArgs(["--image", "demo", "--no-auto-resume"]), context);
    const run = client.callsOf("RunMicrovmCommand")[0];
    expect(run.input.idlePolicy).toMatchObject({ autoResumeEnabled: false });
  });

  it("rejects stray positional arguments", async () => {
    const { client, context } = ctx();
    await expect(cmdRun(parseArgs(["--image", "demo", "ls"]), context)).rejects.toThrow(
      /unexpected arguments/,
    );
    expect(client.callsOf("RunMicrovmCommand")).toHaveLength(0);
  });

  it("rejects unknown flags — a typo must not be silently ignored", async () => {
    const { client, context } = ctx();
    await expect(
      cmdRun(parseArgs(["--image", "demo", "--tmieout", "5000"]), context),
    ).rejects.toThrow(/unknown flag --tmieout/);
    expect(client.callsOf("RunMicrovmCommand")).toHaveLength(0);
    // Unknown flags are rejected before any side effect (connect/resume).
    await expect(cmdExec(parseArgs(["m-1", "--jsoon", "--", "ls"]), ctx().context)).rejects.toThrow(
      /unknown flag --jsoon/,
    );
    // Global flags stay allowed on every command.
    const c3 = ctx();
    await cmdRun(
      parseArgs(["--image", "demo", "--region", "us-east-1", "--profile", "p"]),
      c3.context,
    );
    expect(c3.client.callsOf("RunMicrovmCommand")).toHaveLength(1);
  });

  it("rejects a bare value-flag — '--timeout' with no value is a typo, not a bool", async () => {
    const { client, context } = ctx();
    await expect(cmdRun(parseArgs(["--image", "demo", "--timeout"]), context)).rejects.toThrow(
      /requires a value/,
    );
    expect(client.callsOf("RunMicrovmCommand")).toHaveLength(0);
  });

  it("rejects --exec together with a -- command", async () => {
    await expect(
      cmdRun(parseArgs(["--image", "demo", "--exec", "echo a", "--", "echo b"]), ctx().context),
    ).rejects.toThrow(/not both/);
    await expect(
      cmdRun(parseArgs(["--image", "demo", "--shell", "--", "ls"]), ctx().context),
    ).rejects.toThrow(/shell/);
  });

  it("--rm without a command fails before creating a MicroVM", async () => {
    const { client, context } = ctx();
    await expect(cmdRun(parseArgs(["--image", "demo", "--rm"]), context)).rejects.toThrow(
      /--rm requires a command/,
    );
    expect(client.callsOf("RunMicrovmCommand")).toHaveLength(0);
  });

  it("rejects a bare --exec before creating a MicroVM", async () => {
    const { client, context } = ctx();
    // `--exec` at end of argv is flag-true, not a command — must not run a VM.
    await expect(cmdRun(parseArgs(["--image", "demo", "--exec"]), context)).rejects.toThrow(
      /--exec requires a command/,
    );
    expect(client.callsOf("RunMicrovmCommand")).toHaveLength(0);
  });

  it("rejects an empty --exec", async () => {
    await expect(
      cmdRun(parseArgs(["--image", "demo", "--exec", ""]), ctx().context),
    ).rejects.toThrow(/empty --exec/);
    await expect(cmdExec(parseArgs(["m-1", "--exec", ""]), ctx().context)).rejects.toThrow(
      /empty --exec/,
    );
  });

  it("--rm terminates the VM even when exec fails", async () => {
    const { client, context } = ctx();
    // exec() fails fast: the fake's shell-token response lacks a token, so
    // no WebSocket is ever opened — then finally{} must still terminate.
    await expect(
      cmdRun(parseArgs(["--image", "demo", "--rm", "--exec", "true"]), context),
    ).rejects.toThrow();
    expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(1);
  });

  it("--rm: a second SIGINT force-exits even while terminate is in-flight", async () => {
    const client = new FakeClient();
    const lines: string[] = [];
    const context = {
      client: client as never,
      region: "us-east-1",
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(`ERR ${l}`),
    } as CliContext;
    // Stall TerminateMicrovm so cleanup is in-flight when signals land.
    let terminateSent = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = client.send.bind(client);
    client.send = (async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "TerminateMicrovmCommand") {
        terminateSent = true;
        await gate;
      }
      return orig(command);
    }) as typeof client.send;
    const exits: number[] = [];
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null | undefined) => {
        exits.push(Number(code));
        return undefined as never;
      });
    const before = process.listeners("SIGINT");
    try {
      const run = cmdRun(parseArgs(["--image", "demo", "--rm", "--exec", "true"]), context);
      const assertion = expect(run).rejects.toThrow();
      for (let i = 0; i < 100 && !terminateSent; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(terminateSent).toBe(true);
      // Grab the listener cmdRun registered (don't emit a real SIGINT —
      // vitest's own handlers would react).
      const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
      expect(added).toHaveLength(1);
      const handler = added[0] as () => void;
      handler();
      // Persistent listener — still attached after firing once, so a
      // second signal reaches our handler instead of the default kill.
      expect(process.listeners("SIGINT")).toContain(handler);
      handler();
      // Second signal force-exits immediately — the stalled Terminate
      // must not trap Ctrl-C behind the cleanup wait.
      expect(exits).toEqual([130]);
      release();
      await assertion;
      await new Promise((r) => setTimeout(r, 10));
      // Exactly one exit despite two signals; terminate was attempted once.
      expect(exits).toEqual([130]);
      expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(1);
      expect(process.listeners("SIGINT")).not.toContain(handler);
    } finally {
      exitSpy.mockRestore();
      release();
    }
  });

  it("--rm: SIGINT during an in-flight RunMicrovm waits for create, then terminates", async () => {
    const client = new FakeClient();
    const lines: string[] = [];
    const context = {
      client: client as never,
      region: "us-east-1",
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(`ERR ${l}`),
    } as CliContext;
    // Stall the RunMicrovm response: the service may already have created
    // the VM, so exiting here would orphan it.
    let runSent = false;
    let releaseRun!: () => void;
    const gate = new Promise<void>((r) => (releaseRun = r));
    const orig = client.send.bind(client);
    client.send = (async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "RunMicrovmCommand") {
        runSent = true;
        await gate;
      }
      return orig(command);
    }) as typeof client.send;
    const exits: number[] = [];
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null | undefined) => {
        exits.push(Number(code));
        return undefined as never;
      });
    const before = process.listeners("SIGINT");
    try {
      const run = cmdRun(parseArgs(["--image", "demo", "--rm", "--exec", "true"]), context);
      const assertion = expect(run).rejects.toThrow();
      for (let i = 0; i < 100 && !runSent; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(runSent).toBe(true);
      const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
      expect(added).toHaveLength(1);
      added[0](); // SIGINT while vmId is still unknown
      await new Promise((r) => setTimeout(r, 20));
      // Must NOT exit — the pending RunMicrovm may have created a VM.
      expect(exits).toHaveLength(0);
      releaseRun();
      await assertion;
      await new Promise((r) => setTimeout(r, 10));
      // Create settled → cleanup terminated the VM → single exit.
      expect(exits).toEqual([130]);
      expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(1);
    } finally {
      exitSpy.mockRestore();
      releaseRun();
    }
  });

  it("--json with a bad value fails before creating a MicroVM", async () => {
    const { client, context } = ctx();
    await expect(cmdRun(parseArgs(["--image", "demo", "--json", "typo"]), context)).rejects.toThrow(
      /--json/,
    );
    expect(client.callsOf("RunMicrovmCommand")).toHaveLength(0);
  });
});

describe("validation & config", () => {
  it("rejects stray positionals on exec/shell/status", async () => {
    await expect(cmdExec(parseArgs(["m-1", "m-2", "--", "ls"]), ctx().context)).rejects.toThrow(
      /unexpected arguments/,
    );
    await expect(cmdShell(parseArgs(["m-1", "x"]), ctx().context)).rejects.toThrow(
      /unexpected arguments/,
    );
    await expect(cmdStatus(parseArgs(["m-1", "x"]), ctx().context)).rejects.toThrow(
      /unexpected arguments/,
    );
  });

  it("loadConfig rejects malformed configs with clear errors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-cli-"));
    writeFileSync(path.join(dir, "sunaba.json"), JSON.stringify({ name: 123 }));
    expect(() => loadConfig(dir)).toThrow(/"name" must be a string/);
    writeFileSync(path.join(dir, "sunaba.json"), "5");
    expect(() => loadConfig(dir)).toThrow(/must contain a JSON object/);
    writeFileSync(path.join(dir, "sunaba.json"), "[]");
    expect(() => loadConfig(dir)).toThrow(/must contain a JSON object/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadConfig cannot be prototype-polluted by __proto__ keys", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-cli-"));
    try {
      // JSON.parse stores __proto__ as an own property — a naive out[k]=v
      // copy would write it to the result's PROTOTYPE, letting an
      // unvalidated non-string reach cfg.executionRoleArn.
      writeFileSync(path.join(dir, "sunaba.json"), '{"__proto__":{"executionRoleArn":123}}');
      const cfg = loadConfig(dir);
      expect(cfg.executionRoleArn).toBeUndefined();
      expect(Object.getPrototypeOf(cfg)).toBe(Object.prototype);
      // Non-string values on real fields still throw.
      writeFileSync(path.join(dir, "sunaba.json"), '{"executionRoleArn":123}');
      expect(() => loadConfig(dir)).toThrow(/must be a string/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("list & status", () => {
  it("ls hides TERMINATED by default and shows all with --all", async () => {
    const { context, lines } = ctx();
    await cmdLs(parseArgs([]), context);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("m-1");

    const { context: c2, lines: l2 } = ctx();
    await cmdLs(parseArgs(["--all"]), c2);
    expect(l2).toHaveLength(2);
  });

  it("images prints name + arn", async () => {
    const { context, lines } = ctx();
    await cmdImages(parseArgs([]), context);
    expect(lines[0]).toBe(`demo\t${ARN}`);
  });

  it("status prints state and endpoint", async () => {
    const { context, lines } = ctx();
    await cmdStatus(parseArgs(["m-1"]), context);
    expect(lines[0]).toContain("RUNNING");
    expect(lines[0]).toContain("e.lambda-microvm.on.aws");
  });

  it("ls --image resolves an image name to an ARN", async () => {
    const { client, context } = ctx();
    await cmdLs(parseArgs(["--image", "demo"]), context);
    const list = client.callsOf("ListMicrovmsCommand")[0];
    expect(list.input.imageIdentifier).toBe(ARN);
  });

  it("ls accepts --image-version and the --version compat alias", async () => {
    const { client, context } = ctx();
    await cmdLs(parseArgs(["--image-version", "2.0"]), context);
    expect(client.callsOf("ListMicrovmsCommand")[0].input.imageVersion).toBe("2.0");

    const c2 = ctx();
    await cmdLs(parseArgs(["--version", "3.0"]), c2.context);
    expect(c2.client.callsOf("ListMicrovmsCommand")[0].input.imageVersion).toBe("3.0");
  });
});

describe("logs", () => {
  class FakeLogs {
    calls: unknown[] = [];
    async send(command: unknown): Promise<unknown> {
      this.calls.push(command);
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input as {
        logGroupNamePrefix?: string;
        logStreamNamePrefix?: string;
        logStreamName?: string;
        nextToken?: string;
      };
      switch (name) {
        case "DescribeLogGroupsCommand":
          return { logGroups: [{ logGroupName: "/aws/lambda-microvms/" }] };
        case "DescribeLogStreamsCommand":
          return {
            logStreams: ["m-1", "m-10-impostor"]
              .filter((s) => s.startsWith(input.logStreamNamePrefix ?? ""))
              .map((logStreamName) => ({ logStreamName })),
          };
        case "GetLogEventsCommand": {
          const ALL = [
            { timestamp: 1, message: "a" },
            { timestamp: 2, message: "b" },
          ];
          // Backward paging (--tail): "bN" token = events before index N.
          if (input.limit !== undefined) {
            const end = input.nextToken ? Number(input.nextToken.slice(1)) : ALL.length;
            const start = Math.max(0, end - input.limit);
            return {
              events: ALL.slice(start, end),
              nextBackwardToken: start > 0 ? `b${start}` : undefined,
            };
          }
          // Forward paging: "fN" token = next index N. Repeating = done.
          const start = input.nextToken ? Number(input.nextToken.slice(1)) : 0;
          return { events: ALL.slice(start), nextForwardToken: `f${ALL.length}` };
        }
        default:
          return {};
      }
    }
    inputs(n: string): Record<string, unknown>[] {
      return this.calls
        .filter((c) => (c as { constructor: { name: string } }).constructor.name === n)
        .map((c) => (c as { input: Record<string, unknown> }).input);
    }
  }

  it("discovers the managed log group and pages every stream", async () => {
    const fake = new FakeLogs();
    const lines: string[] = [];
    const code = await cmdLogs(parseArgs(["m-1"]), {
      region: "us-east-1",
      logsClient: fake,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
    });
    expect(code).toBe(0);
    // Pages: initial + repeated-token probe, then stops.
    const gets = fake.inputs("GetLogEventsCommand");
    expect(gets).toHaveLength(2);
    expect(gets[1].nextToken).toBe("f2");
    expect(gets[0].logGroupName).toBe("/aws/lambda-microvms/");
    // Over-matching "m-10-impostor" streams must be filtered out.
    expect(gets.every((g) => g.logStreamName === "m-1")).toBe(true);
    expect(lines.map((l) => l.replace(/^\S+ /, ""))).toEqual(["a", "b"]);
  });

  it("--tail prints only the last N events via backward paging", async () => {
    const fake = new FakeLogs();
    const lines: string[] = [];
    await cmdLogs(parseArgs(["m-1", "--tail", "1"]), {
      region: "us-east-1",
      logsClient: fake,
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("b");
    // Backward fetch used limit, not a full forward drain.
    expect(fake.inputs("GetLogEventsCommand")[0].limit).toBe(1);
  });

  it("errors when no streams match", async () => {
    const fake = new FakeLogs();
    const lines: string[] = [];
    const code = await cmdLogs(parseArgs(["nope"]), {
      region: "us-east-1",
      logsClient: fake,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain("no log streams");
  });

  it("rejects extra positional arguments", async () => {
    await expect(cmdLogs(parseArgs(["m-1", "extra"]), { region: "us-east-1" })).rejects.toThrow(
      /unexpected arguments/,
    );
  });

  it("the usage error lists --tail with the other logs flags", async () => {
    await expect(cmdLogs(parseArgs([]), { region: "us-east-1" })).rejects.toThrow(
      /\[--group name\] \[--follow\] \[--tail n\]/,
    );
  });

  /** Managed groups whose DescribeLogStreams can fail per group. */
  class ProbeFailLogs extends FakeLogs {
    constructor(
      private groups: string[],
      private failFor: (group: string) => Error | undefined,
    ) {
      super();
    }
    override async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: { logGroupName?: string } }).input;
      if (name === "DescribeLogGroupsCommand") {
        this.calls.push(command);
        return { logGroups: this.groups.map((logGroupName) => ({ logGroupName })) };
      }
      const err =
        name === "DescribeLogStreamsCommand" ? this.failFor(input.logGroupName ?? "") : undefined;
      if (err) {
        this.calls.push(command);
        throw err;
      }
      return super.send(command);
    }
  }
  const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

  it("surfaces a stream probe failure instead of 'no log streams'", async () => {
    // AccessDenied/throttling must not read as "this MicroVM has no logs".
    const fake = new ProbeFailLogs(["/aws/lambda-microvms/demo"], () =>
      awsError("AccessDeniedException", "not authorized to perform: logs:DescribeLogStreams"),
    );
    await expect(
      cmdLogs(parseArgs(["m-1"]), { region: "us-east-1", logsClient: fake }),
    ).rejects.toThrow(/not authorized/);
  });

  it("a probe failure in one group doesn't hide the streams found in another", async () => {
    // Least-privilege IAM may allow DescribeLogStreams on some groups only.
    const fake = new ProbeFailLogs(
      ["/aws/lambda-microvms/demo", "/aws/lambda-microvms/denied"],
      (g) =>
        g.endsWith("/denied") ? awsError("AccessDeniedException", "not authorized") : undefined,
    );
    const lines: string[] = [];
    const code = await cmdLogs(parseArgs(["m-1"]), {
      region: "us-east-1",
      logsClient: fake,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.map((l) => l.replace(/^\S+ /, ""))).toEqual(["a", "b"]);
  });

  it("treats a group deleted mid-scan as having no streams", async () => {
    const fake = new ProbeFailLogs(["/aws/lambda-microvms/demo"], () =>
      awsError("ResourceNotFoundException", "The specified log group does not exist."),
    );
    const lines: string[] = [];
    const code = await cmdLogs(parseArgs(["m-1"]), {
      region: "us-east-1",
      logsClient: fake,
      err: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain("no log streams matching m-1");
  });

  it("prefers the VM's image-specific log group over unrelated groups", async () => {
    // Multiple managed groups exist; the target stream lives only in the
    // image-specific one (image name "demo" comes from the VM's imageArn).
    class MultiGroupLogs extends FakeLogs {
      override async send(command: unknown): Promise<unknown> {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        this.calls.push(command);
        switch (name) {
          case "DescribeLogGroupsCommand":
            return {
              logGroups: [
                { logGroupName: "/aws/lambda-microvms/unrelated" },
                { logGroupName: "/aws/lambda-microvms/demo" },
              ],
            };
          case "DescribeLogStreamsCommand":
            return {
              logStreams:
                input.logGroupName === "/aws/lambda-microvms/demo"
                  ? [{ logStreamName: "m-1" }]
                  : [],
            };
          case "GetLogEventsCommand":
            return { events: [{ timestamp: 1, message: "found" }] };
          default:
            return {};
        }
      }
    }
    const fake = new MultiGroupLogs();
    const { context } = ctx();
    const lines: string[] = [];
    const code = await cmdLogs(parseArgs(["m-1"]), {
      ...context,
      logsClient: fake,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(fake.inputs("GetLogEventsCommand")[0].logGroupName).toBe("/aws/lambda-microvms/demo");
    expect(lines[0]).toContain("found");
  });

  it("--group bypasses discovery entirely", async () => {
    const fake = new FakeLogs();
    const lines: string[] = [];
    const code = await cmdLogs(parseArgs(["m-1", "--group", "custom-group"]), {
      region: "us-east-1",
      logsClient: fake,
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(fake.inputs("DescribeLogGroupsCommand")).toHaveLength(0);
    expect(fake.inputs("GetLogEventsCommand").every((g) => g.logGroupName === "custom-group")).toBe(
      true,
    );
  });

  it("drops terminal control sequences from log messages", async () => {
    // Messages are written by code inside the sandbox — they must not
    // reach the viewer's terminal as escape sequences.
    class HostileLogs extends FakeLogs {
      override async send(command: unknown): Promise<unknown> {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name !== "GetLogEventsCommand") return super.send(command);
        this.calls.push(command);
        const { nextToken } = (command as { input: { nextToken?: string } }).input;
        const message = "\u001b]0;title\u0007\u001b[31mred\u001b[0m\ttab\r\nnext\u009b2Jend";
        return { events: nextToken ? [] : [{ timestamp: 1, message }], nextForwardToken: "f1" };
      }
    }
    const lines: string[] = [];
    const code = await cmdLogs(parseArgs(["m-1", "--group", "g"]), {
      region: "us-east-1",
      logsClient: new HostileLogs(),
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines).toEqual(["1970-01-01T00:00:00.001Z ]0;titlered\ttab\nnext2Jend"]);
  });

  /** GetLogEvents answers from a script, one step per call. */
  class ScriptedLogs extends FakeLogs {
    constructor(
      private script: (Error | { events: { message: string }[]; nextForwardToken: string })[],
    ) {
      super();
    }
    override async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name !== "GetLogEventsCommand") return super.send(command);
      this.calls.push(command);
      const step = this.script.shift() ?? new Error("script exhausted");
      if (step instanceof Error) throw step;
      return step;
    }
  }
  const page = (nextForwardToken: string, ...messages: string[]) => ({
    events: messages.map((message) => ({ message })),
    nextForwardToken,
  });

  /** Run `logs --follow` until the script's final non-transient error stops it. */
  async function follow(fake: FakeLogs): Promise<string[]> {
    const lines: string[] = [];
    vi.useFakeTimers();
    try {
      const run = cmdLogs(parseArgs(["m-1", "--group", "g", "--follow"]), {
        region: "us-east-1",
        logsClient: fake,
        out: (l) => lines.push(l.replace(/^\S+ /, "")),
        err: (l) => lines.push(`ERR ${l}`),
      });
      const stopped = expect(run).rejects.toThrow(/not authorized/);
      await runTimersUntilSettled(run);
      await stopped;
    } finally {
      vi.useRealTimers();
    }
    return lines;
  }

  it("--follow prints the backlog, then polls from the saved token for new events", async () => {
    const fake = new ScriptedLogs([
      page("f1", "a"),
      awsError("ThrottlingException", "Rate exceeded"),
      page("f2", "b"),
      page("f2"),
      page("f2"),
      page("f3", "c"),
      page("f3"),
      awsError("ThrottlingException", "Rate exceeded"),
      awsError("AccessDeniedException", "not authorized"),
    ]);
    expect(await follow(fake)).toEqual([
      "a",
      "ERR warning: Rate exceeded — retrying",
      "b",
      "c",
      "ERR warning: Rate exceeded — retrying",
    ]);
    // Backlog (retrying f1 once), then every poll resumes from the last
    // token — nothing is printed twice.
    expect(fake.inputs("GetLogEventsCommand").map((g) => g.nextToken)).toEqual([
      undefined,
      "f1",
      "f1",
      "f2",
      "f2",
      "f2",
      "f3",
      "f3",
      "f3",
    ]);
  });

  it("--follow stops retrying a backlog page after 5 transient errors and keeps polling", async () => {
    const throttled = () => awsError("ThrottlingException", "Rate exceeded");
    const fake = new ScriptedLogs([
      throttled(),
      throttled(),
      throttled(),
      throttled(),
      throttled(),
      page("f1", "a"),
      page("f1"),
      awsError("AccessDeniedException", "not authorized"),
    ]);
    expect(await follow(fake)).toEqual([
      ...Array(5).fill("ERR warning: Rate exceeded — retrying"),
      "ERR warning: giving up on backlog for m-1 — following live",
      "a",
    ]);
  });
});

describe("lifecycle", () => {
  it("suspend/resume/rm send the right commands", async () => {
    for (const [cmd, cmdName, state] of [
      [cmdSuspend, "SuspendMicrovmCommand", "RUNNING"],
      [cmdResume, "ResumeMicrovmCommand", "SUSPENDED"],
      [cmdRm, "TerminateMicrovmCommand", "RUNNING"],
    ] as const) {
      const { client, context, lines } = ctx([], {}, state);
      const code = await cmd(parseArgs(["m-1"]), context);
      expect(code).toBe(0);
      expect(client.callsOf(cmdName)).toHaveLength(1);
      expect(lines[0]).toContain("m-1");
    }
  });

  it("reports 'suspended'/'resumed' on success (not 'suspendd')", async () => {
    const s = ctx([], {}, "RUNNING");
    expect(await cmdSuspend(parseArgs(["m-1"]), s.context)).toBe(0);
    expect(s.lines[0]).toBe("suspended m-1");

    const r = ctx([], {}, "SUSPENDED");
    expect(await cmdResume(parseArgs(["m-1"]), r.context)).toBe(0);
    expect(r.lines[0]).toBe("resumed m-1");
  });

  it("skips suspend/rm/resume when already in the target state", async () => {
    const s = ctx([], {}, "SUSPENDED");
    expect(await cmdSuspend(parseArgs(["m-1"]), s.context)).toBe(0);
    expect(s.client.callsOf("SuspendMicrovmCommand")).toHaveLength(0);
    expect(s.lines[0]).toContain("already suspended");

    const r = ctx([], {}, "RUNNING");
    expect(await cmdResume(parseArgs(["m-1"]), r.context)).toBe(0);
    expect(r.client.callsOf("ResumeMicrovmCommand")).toHaveLength(0);

    const t = ctx([], {}, "TERMINATED");
    expect(await cmdRm(parseArgs(["m-1"]), t.context)).toBe(0);
    expect(t.client.callsOf("TerminateMicrovmCommand")).toHaveLength(0);
  });

  it("requires at least one id", async () => {
    await expect(cmdRm(parseArgs([]), ctx().context)).rejects.toThrow(/usage/);
  });

  it("rm terminates a PENDING MicroVM directly (no RUNNING wait)", async () => {
    const { client, context, lines } = ctx([], {}, "PENDING");
    expect(await cmdRm(parseArgs(["m-1"]), context)).toBe(0);
    expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(1);
    expect(lines[0]).toContain("terminating");
  });

  it("suspend waits out a PENDING startup before suspending", async () => {
    const { client, context } = ctx([], {}, "PENDING");
    expect(await cmdSuspend(parseArgs(["m-1"]), context)).toBe(0);
    expect(client.callsOf("SuspendMicrovmCommand")).toHaveLength(1);
    // GetMicrovm polled until RUNNING before the suspend call.
    expect(client.callsOf("GetMicrovmCommand").length).toBeGreaterThanOrEqual(2);
  });

  it("rm waits out SUSPENDING before terminating", async () => {
    const { client, context } = ctx([], {}, "SUSPENDING");
    expect(await cmdRm(parseArgs(["m-1"]), context)).toBe(0);
    // The fake reports SUSPENDING once: Terminate must follow the poll
    // that saw SUSPENDED, not the first read.
    expect(
      client.calls.map((c) => (c as { constructor: { name: string } }).constructor.name),
    ).toEqual(["GetMicrovmCommand", "GetMicrovmCommand", "TerminateMicrovmCommand"]);
  });

  it("suspend/resume pass --timeout to the state wait", async () => {
    vi.useFakeTimers();
    try {
      for (const [cmd, verb, state] of [
        [cmdSuspend, "suspend", "RUNNING"],
        [cmdResume, "resume", "SUSPENDED"],
      ] as const) {
        // Accepts the call but never leaves its state — only the wait's
        // timeout ends the command.
        const stuck = {
          async send(c: unknown) {
            const n = (c as { constructor: { name: string } }).constructor.name;
            return n === "GetMicrovmCommand" ? { microvmId: "m-1", state } : {};
          },
        };
        const errs: string[] = [];
        const run = cmd(parseArgs(["m-1", "--timeout", "1000"]), {
          client: stuck as never,
          region: "us-east-1",
          out: () => {},
          err: (l) => errs.push(l),
        });
        await runTimersUntilSettled(run);
        expect(await run).toBe(1);
        expect(errs).toEqual([
          `warning: could not ${verb} m-1: timed out after 1000ms waiting for condition`,
        ]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("rm retries terminate on Conflict while stuck PENDING (no RUNNING wait)", async () => {
    // The VM never leaves PENDING — the old code would wait for RUNNING
    // forever inside the conflict retry.
    const conflict = new Error("transition in progress");
    conflict.name = "ConflictException";
    let firstTerminate = true;
    const calls: string[] = [];
    const stuck = {
      async send(cmd: unknown) {
        const n = (cmd as { constructor: { name: string } }).constructor.name;
        calls.push(n);
        if (n === "TerminateMicrovmCommand") {
          if (firstTerminate) {
            firstTerminate = false;
            throw conflict;
          }
          return {};
        }
        if (n === "GetMicrovmCommand") {
          return { microvmId: "m-1", state: "PENDING" };
        }
        return {};
      },
    };
    const lines: string[] = [];
    const code = await cmdRm(parseArgs(["m-1"]), {
      client: stuck as never,
      region: "us-east-1",
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
    });
    expect(code).toBe(0);
    expect(calls.filter((n) => n === "TerminateMicrovmCommand")).toHaveLength(2);
  });

  it("rm retries after ConflictException when VM settles SUSPENDED", async () => {
    const { client, context, lines } = ctx([], {}, "RUNNING");
    const conflict = new Error("conflict");
    conflict.name = "ConflictException";
    client.failOnce("TerminateMicrovmCommand", conflict);
    // First Terminate conflicts and the VM slides to SUSPENDED mid-retry.
    const mut = client as unknown as { state: string };
    const orig = client.send.bind(client);
    client.send = async (c: unknown) => {
      const n = (c as { constructor: { name: string } }).constructor.name;
      if (n === "TerminateMicrovmCommand" && client.failures.length) {
        mut.state = "SUSPENDING";
      }
      return orig(c);
    };
    expect(await cmdRm(parseArgs(["m-1"]), context)).toBe(0);
    expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(2);
    expect(lines[0]).toContain("terminating");
  });

  it("rm continues through other ids after a failure (exit 1)", async () => {
    const { client, context, lines } = ctx([], {}, "RUNNING");
    client.failOnce("TerminateMicrovmCommand", new Error("denied"), {
      microvmIdentifier: "m-1",
    });
    expect(await cmdRm(parseArgs(["m-1", "m-2"]), context)).toBe(1);
    expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(2);
    expect(lines.some((l) => l.includes("could not terminate m-1"))).toBe(true);
    expect(lines.some((l) => l.includes("terminating m-2"))).toBe(true);
  });
});
