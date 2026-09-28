import {
  ListMicrovmImagesCommand,
  ListMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import WebSocket from "ws";
import { connectorArns, ManagedEgressConnector, ManagedIngressConnector } from "./connectors.js";
import { SunabaError } from "./errors.js";
import { execOverShell, microvmSubprotocols, openShellSocket, pipeInteractive } from "./shell.js";
import { AuthTokenManager, ShellTokenManager } from "./tokens.js";
import { regionForConnectors, resolveClient } from "./transport.js";
import {
  type ClientOptions,
  DEFAULT_IDLE_POLICY,
  type ExecOptions,
  type ExecResult,
  type LambdaMicrovmsClientLike,
  type MicrovmState,
  type PortSpec,
  type RequestOptions,
  type SandboxConnectOptions,
  type SandboxCreateOptions,
} from "./types.js";
import { DEFAULT_MAX_OUTPUT_BYTES, isNotFoundError, required, shellQuote, sleep } from "./util.js";
import { getMicrovm, waitForMicrovmState } from "./waiters.js";

/** Methods that are safe to auto-retry after a failed request. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);

// ALL_INGRESS cannot be combined with other connectors, so the default
// uses the granular pair: HTTP for request(), SHELL for exec()/shell.
const DEFAULT_INGRESS: readonly string[] = [
  ManagedIngressConnector.HTTP,
  ManagedIngressConnector.SHELL,
];

/**
 * A running (or suspended) AWS Lambda MicroVM.
 *
 * Handles the full lifecycle plus the two authenticated transports:
 *  - HTTPS requests to the app endpoint (`X-aws-proxy-auth` + `X-aws-proxy-port`)
 *  - the managed WebSocket PTY shell (SHELL_INGRESS, port 8022)
 */
export class Sandbox {
  readonly microvmId: string;
  endpoint: string;
  state: MicrovmState;

  readonly imageArn: string;
  readonly imageVersion?: string;
  readonly executionRoleArn?: string;

  private readonly client: LambdaMicrovmsClientLike;
  private readonly auth: AuthTokenManager;
  private readonly shellAuth: ShellTokenManager;

  private constructor(
    client: LambdaMicrovmsClientLike,
    info: {
      microvmId: string;
      endpoint?: string;
      state: MicrovmState;
      imageArn: string;
      imageVersion?: string;
      executionRoleArn?: string;
    },
    opts: { tokenTtlMinutes: number; allowedPorts: readonly PortSpec[] },
  ) {
    if (!info.endpoint) {
      throw new SunabaError("NoEndpoint", `MicroVM ${info.microvmId} has no endpoint yet`);
    }
    this.client = client;
    this.microvmId = info.microvmId;
    this.endpoint = info.endpoint;
    this.state = info.state;
    this.imageArn = info.imageArn;
    this.imageVersion = info.imageVersion;
    this.executionRoleArn = info.executionRoleArn;
    this.auth = new AuthTokenManager(client, this.microvmId, {
      expirationInMinutes: opts.tokenTtlMinutes,
      allowedPorts: opts.allowedPorts,
    });
    this.shellAuth = new ShellTokenManager(client, this.microvmId, opts.tokenTtlMinutes);
  }

  /**
   * Run a new MicroVM from an image and wait for RUNNING.
   * `image` may be a full ARN or an image name (resolved via ListMicrovmImages).
   */
  static async create(opts: SandboxCreateOptions): Promise<Sandbox> {
    const client = resolveClient(opts);
    const ingress = opts.ingress ?? DEFAULT_INGRESS;
    const egress = opts.egress ?? [ManagedEgressConnector.INTERNET];
    // Region is only needed to expand managed connector names into ARNs.
    const region = await regionForConnectors(opts, [...ingress, ...egress]);
    const imageArn = await resolveImageArn(client, opts.image);
    const imageVersion = opts.imageVersion ?? (await latestActiveVersion(client, imageArn));

    const res = (await client.send(
      new RunMicrovmCommand({
        imageIdentifier: imageArn,
        ...(imageVersion ? { imageVersion } : {}),
        ...(opts.executionRoleArn ? { executionRoleArn: opts.executionRoleArn } : {}),
        idlePolicy: opts.idlePolicy ?? DEFAULT_IDLE_POLICY,
        ...(opts.maximumDurationSeconds
          ? { maximumDurationInSeconds: opts.maximumDurationSeconds }
          : {}),
        ...(opts.logging ? { logging: opts.logging } : {}),
        ...(opts.runHookPayload ? { runHookPayload: opts.runHookPayload } : {}),
        ...(opts.clientToken ? { clientToken: opts.clientToken } : {}),
        ingressNetworkConnectors: connectorArns(ingress, region),
        egressNetworkConnectors: connectorArns(egress, region),
      }),
    )) as { microvmId?: string; endpoint?: string; state?: MicrovmState };

    const microvmId = required(res.microvmId, "microvmId");
    try {
      // Inside the cleanup try: a throwing callback must not leak the VM.
      opts.onMicrovmCreated?.(microvmId);
      const info = await waitForMicrovmState(client, microvmId, "RUNNING", {
        timeoutMs: opts.runTimeoutMs ?? 120_000,
      });
      return new Sandbox(
        client,
        {
          microvmId,
          endpoint: info.endpoint ?? res.endpoint,
          state: info.state ?? "RUNNING",
          imageArn,
          imageVersion: info.imageVersion ?? imageVersion,
          executionRoleArn: info.executionRoleArn ?? opts.executionRoleArn,
        },
        {
          tokenTtlMinutes: opts.tokenTtlMinutes ?? 30,
          allowedPorts: opts.allowedPorts ?? ["all"],
        },
      );
    } catch (e) {
      // Don't leak a billable MicroVM when startup fails (wait error,
      // or RUNNING-but-no-endpoint which the Sandbox ctor rejects).
      // Best-effort terminate: a single retry absorbs throttle blips; the
      // outcome is still swallowed — cleanup never masks the real error.
      for (let i = 0; i < 2; i++) {
        try {
          await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
          break;
        } catch {
          if (i === 0) await sleep(1_000);
        }
      }
      throw e;
    }
  }

  /** Attach to an existing MicroVM by ID (resuming it first if suspended). */
  static async connect(microvmId: string, opts: SandboxConnectOptions = {}): Promise<Sandbox> {
    const client = resolveClient(opts);
    // A just-created MicroVM may 404 briefly — retry a few seconds.
    let info: Awaited<ReturnType<typeof getMicrovm>> | undefined;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        info = await getMicrovm(client, microvmId);
        break;
      } catch (e) {
        if (!isNotFoundError(e) || Date.now() > deadline) throw e;
        await sleep(800);
      }
    }
    if (info.state === "TERMINATED" || info.state === "TERMINATING") {
      throw new SunabaError(
        "Gone",
        `MicroVM ${microvmId} is ${info.state} and cannot be connected`,
      );
    }
    if (info.state === "PENDING") {
      info = await waitForMicrovmState(client, microvmId, "RUNNING", {
        timeoutMs: opts.runTimeoutMs ?? 120_000,
      });
    }
    // SUSPENDING is transient — wait it out, then the normal resume path applies.
    if (info.state === "SUSPENDING") {
      info = await waitForMicrovmState(client, microvmId, "SUSPENDED", {
        timeoutMs: opts.runTimeoutMs ?? 120_000,
      });
    }
    if (info.state === "SUSPENDED" && (opts.resume ?? true)) {
      // Race: auto-resume or another client may beat us to ResumeMicrovm —
      // on Conflict, re-read and accept RUNNING (goal reached) or retry
      // once if still suspended.
      for (let attempt = 0; ; attempt++) {
        try {
          await client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
          break;
        } catch (e) {
          if ((e as { name?: string }).name !== "ConflictException" || attempt > 0) throw e;
          const cur = await getMicrovm(client, microvmId);
          if (cur.state === "RUNNING") break;
          if (cur.state !== "SUSPENDED" && cur.state !== "SUSPENDING") throw e;
        }
      }
      info = await waitForMicrovmState(client, microvmId, "RUNNING", {
        timeoutMs: opts.runTimeoutMs ?? 120_000,
      });
    }
    if (!info.imageArn) {
      throw new SunabaError("NotFound", `MicroVM ${microvmId} not found or missing image`);
    }
    return new Sandbox(
      client,
      {
        microvmId,
        endpoint: info.endpoint,
        state: info.state ?? "PENDING",
        imageArn: info.imageArn,
        imageVersion: info.imageVersion,
        executionRoleArn: info.executionRoleArn,
      },
      {
        tokenTtlMinutes: opts.tokenTtlMinutes ?? 30,
        allowedPorts: opts.allowedPorts ?? ["all"],
      },
    );
  }

  /** Refresh state and endpoint from the service. */
  async refresh(): Promise<this> {
    const info = await getMicrovm(this.client, this.microvmId);
    if (info.state) this.state = info.state;
    if (info.endpoint) this.endpoint = info.endpoint;
    return this;
  }

  /**
   * Authenticated HTTPS request to the app inside the MicroVM.
   * Adds `X-aws-proxy-auth` (JWE) and `X-aws-proxy-port` headers,
   * refreshing the token and retrying once on 403.
   */
  async request(path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = `https://${this.endpoint}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers(opts.headers);
    if (opts.port !== undefined) headers.set("X-aws-proxy-port", String(opts.port));
    headers.set("X-aws-proxy-auth", await this.auth.get());
    // A ReadableStream body is consumed by the first send — never retry those.
    const retryableBody = !(opts.body instanceof ReadableStream);
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined && opts.body !== null ? { body: opts.body } : {}),
      ...(opts.body instanceof ReadableStream ? ({ duplex: "half" } as RequestInit) : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const drain = async (r: Response) => {
      await r.arrayBuffer().catch(() => {}); // free the keep-alive connection
    };
    // Auto-retry only for idempotent methods — a POST whose response was
    // lost after the side effect would otherwise execute twice. Callers
    // can opt in with `retry: true` when their endpoint is idempotent.
    const autoRetry =
      retryableBody &&
      (IDEMPOTENT_METHODS.has((opts.method ?? "GET").toUpperCase()) || opts.retry === true);
    let res = await fetch(url, init);
    if (res.status === 401 || res.status === 403) {
      this.auth.invalidate(); // even for stream bodies: drop the dead token
    }
    if (autoRetry && (res.status === 401 || res.status === 403)) {
      await drain(res);
      headers.set("X-aws-proxy-auth", await this.auth.get());
      res = await fetch(url, init);
    }
    // Transient 429/5xx: up to 2 retries with light backoff.
    for (let i = 0; autoRetry && i < 2 && (res.status === 429 || res.status >= 500); i++) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      await drain(res);
      const retryAfterMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 10_000) : 0;
      await sleep(Math.max(retryAfterMs, 250 * (i + 1)));
      res = await fetch(url, init);
    }
    return res;
  }

  /**
   * Authenticated WebSocket to an app port inside the MicroVM.
   * Auth and port selection ride on Sec-WebSocket-Protocol subprotocols.
   * Resolves once the socket is open.
   */
  async websocket(
    path: string,
    opts: { port?: number; protocols?: string[]; timeoutMs?: number } = {},
  ): Promise<import("ws").WebSocket> {
    const p = path.startsWith("/") ? path : `/${path}`;
    const timeout = opts.timeoutMs ?? 15_000;
    const attempt = async (): Promise<WebSocket> => {
      const token = await this.auth.get();
      const ws = new WebSocket(`wss://${this.endpoint}${p}`, [
        ...microvmSubprotocols(token, opts.port ?? 8080),
        ...(opts.protocols ?? []),
      ]);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            ws.close();
            reject(new SunabaError("WsTimeout", `WebSocket to ${p} timed out`));
          }, timeout);
          const onError = (e: unknown) => {
            clearTimeout(timer);
            reject(new SunabaError("WsFailed", `WebSocket to ${p} failed: ${String(e)}`, e));
          };
          ws.once("error", onError);
          ws.once("unexpected-response", (req, res) => {
            const statusCode = res.statusCode;
            req.destroy();
            res.destroy();
            onError(Object.assign(new Error(`unexpected HTTP ${statusCode}`), { statusCode }));
          });
          ws.once("open", () => {
            clearTimeout(timer);
            ws.removeListener("error", onError);
            resolve();
          });
        });
        return ws;
      } catch (e) {
        ws.close();
        throw e;
      }
    };
    try {
      return await attempt();
    } catch (e) {
      // A handshake rejected for auth means the cached token died early —
      // same invalidate + single-retry contract as request()/exec().
      const status = (e as { cause?: { statusCode?: number } }).cause?.statusCode;
      if (e instanceof SunabaError && e.code === "WsFailed" && (status === 401 || status === 403)) {
        this.auth.invalidate();
        return attempt();
      }
      throw e;
    }
  }

  /**
   * Run a command over the managed PTY shell (needs SHELL_INGRESS).
   * Retries once with a fresh token only when the connection itself fails
   * (never re-runs a command that already started executing).
   */
  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const attempt = () =>
      this.shellAuth.get().then((token) =>
        execOverShell({
          endpoint: this.endpoint,
          url: opts.urlOverride,
          token,
          command,
          timeoutMs: opts.timeoutMs,
          cwd: opts.cwd,
          maxOutputBytes: opts.maxOutputBytes,
        }),
      );
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof SunabaError && e.code === "ShellConnectFailed") {
        this.shellAuth.invalidate();
        return attempt();
      }
      throw e;
    }
  }

  /** Interactive PTY attached to stdio (used by `sunaba shell`). */
  async interactiveShell(opts: { urlOverride?: string } = {}): Promise<void> {
    const attempt = async () => {
      const token = await this.shellAuth.get();
      const ws = await openShellSocket({
        endpoint: this.endpoint,
        url: opts.urlOverride,
        token,
      });
      await pipeInteractive(ws);
    };
    try {
      await attempt();
    } catch (e) {
      // Same contract as exec(): a stale shell token earns one retry.
      if (e instanceof SunabaError && e.code === "ShellConnectFailed") {
        this.shellAuth.invalidate();
        return attempt();
      }
      throw e;
    }
  }

  /** Write a file inside the MicroVM (base64 over shell). */
  async writeFile(path: string, data: string | Uint8Array, opts: ExecOptions = {}): Promise<void> {
    const b64 = Buffer.from(data as string | Uint8Array).toString("base64");
    const r = await this.exec(`printf %s '${b64}' | base64 -d > ${shellQuote(path)}`, {
      timeoutMs: 60_000,
      ...opts,
    });
    if (r.exitCode !== 0) {
      throw new SunabaError("WriteFailed", `write to ${path} failed: ${r.output}`);
    }
  }

  /** Read a file inside the MicroVM (base64 over shell, chunked for large files). */
  async readFile(path: string, opts: ExecOptions = {}): Promise<Buffer> {
    // The shell keeps at most maxOutputBytes (default 16 MiB) and drops the
    // HEAD — a naive `base64` read would silently corrupt files over ~12 MiB.
    // Stat first, then read in dd-sized chunks under the cap.
    const cap = (opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) - 1024; // marker margin
    const stat = await this.exec(`wc -c < ${shellQuote(path)}`, {
      timeoutMs: 30_000,
      ...opts,
    });
    const size = Number.parseInt(stat.output.trim(), 10);
    if (stat.exitCode !== 0 || !Number.isFinite(size)) {
      throw new SunabaError("ReadFailed", `cannot stat ${path}: ${stat.output}`);
    }
    // GNU base64 wraps at 76 columns: wrapped(n) ≈ enc(n) * 77/76 where
    // enc(n) = ceil(n/3)*4 — plus slack for the trailing newline.
    const chunkBytes = Math.floor((cap * 76) / 77 / 4) * 3 - 3;
    if (chunkBytes < 1) {
      throw new SunabaError(
        "ReadFailed",
        `maxOutputBytes ${opts.maxOutputBytes} is too small for file reads`,
      );
    }
    const decode = (output: string) => Buffer.from(output.replace(/\s+/g, ""), "base64");
    if (size <= chunkBytes) {
      const r = await this.exec(`base64 ${shellQuote(path)}`, { timeoutMs: 60_000, ...opts });
      if (r.exitCode !== 0) {
        throw new SunabaError("ReadFailed", `read ${path} failed: ${r.output}`);
      }
      const buf = decode(r.output);
      if (buf.length !== size) {
        throw new SunabaError(
          "ReadFailed",
          `read ${path}: expected ${size} bytes, got ${buf.length}`,
        );
      }
      return buf;
    }
    const parts: Buffer[] = [];
    for (let offset = 0; offset < size; offset += chunkBytes) {
      const r = await this.exec(
        `dd if=${shellQuote(path)} bs=${chunkBytes} skip=${Math.floor(offset / chunkBytes)} count=1 2>/dev/null | base64`,
        { timeoutMs: 60_000, ...opts },
      );
      if (r.exitCode !== 0) {
        throw new SunabaError("ReadFailed", `read ${path} failed at offset ${offset}: ${r.output}`);
      }
      parts.push(decode(r.output));
    }
    const out = Buffer.concat(parts);
    if (out.length !== size) {
      throw new SunabaError(
        "ReadFailed",
        `read ${path}: expected ${size} bytes, got ${out.length}`,
      );
    }
    return out;
  }

  async suspend(): Promise<void> {
    await this.sendLifecycle(new SuspendMicrovmCommand({ microvmIdentifier: this.microvmId }), [
      "SUSPENDED",
      "SUSPENDING",
    ]);
    const info = await waitForMicrovmState(this.client, this.microvmId, "SUSPENDED");
    this.state = info.state ?? "SUSPENDED";
  }

  async resume(): Promise<void> {
    await this.sendLifecycle(new ResumeMicrovmCommand({ microvmIdentifier: this.microvmId }), [
      "RUNNING",
    ]);
    const info = await waitForMicrovmState(this.client, this.microvmId, "RUNNING");
    this.state = info.state ?? "RUNNING";
    if (info.endpoint) this.endpoint = info.endpoint;
  }

  async terminate(): Promise<void> {
    await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: this.microvmId }));
    this.state = "TERMINATING";
  }

  /**
   * Send a lifecycle command; on ConflictException re-read the state — if
   * the VM already reached (or is heading to) a goal state, that's success.
   */
  private async sendLifecycle(command: object, goalStates: readonly string[]): Promise<void> {
    try {
      await this.client.send(command);
    } catch (e) {
      if ((e as { name?: string }).name !== "ConflictException") throw e;
      const info = await getMicrovm(this.client, this.microvmId);
      if (!info.state || !goalStates.includes(info.state)) throw e;
    }
  }
}

/** Resolve an image name to its ARN. ARNs pass through. */
export async function resolveImageArn(
  client: LambdaMicrovmsClientLike,
  image: string,
): Promise<string> {
  if (image.startsWith("arn:")) return image;
  let nextToken: string | undefined;
  do {
    const res = (await client.send(
      new ListMicrovmImagesCommand({
        // Server-side contains-filter narrows the scan; we still exact-match.
        nameFilter: image,
        ...(nextToken ? { nextToken } : {}),
      }),
    )) as {
      items?: { imageArn?: string; name?: string }[];
      nextToken?: string;
    };
    const hit = (res.items ?? []).find((i) => i.name === image);
    if (hit?.imageArn) return hit.imageArn;
    nextToken = res.nextToken;
  } while (nextToken);
  throw new SunabaError("ImageNotFound", `no MicroVM image named '${image}'`);
}

/** Latest ACTIVE image version by createdAt, or undefined (service default). */
export async function latestActiveVersion(
  client: LambdaMicrovmsClientLike,
  imageArn: string,
): Promise<string | undefined> {
  // AWS-managed base images use `ListManagedMicrovmImageVersions` instead;
  // leave version selection to the service default for those.
  if (imageArn.includes(":aws:microvm-image:")) return undefined;
  let nextToken: string | undefined;
  const active: { imageVersion?: string; state?: string; createdAt?: Date }[] = [];
  do {
    const res = (await client.send(
      new ListMicrovmImageVersionsCommand({
        imageIdentifier: imageArn,
        ...(nextToken ? { nextToken } : {}),
      }),
    )) as {
      items?: { imageVersion?: string; status?: string; state?: string; createdAt?: Date }[];
      nextToken?: string;
    };
    for (const i of res.items ?? []) {
      // ACTIVE status plus a finished build (state may be absent on summaries).
      if (i.status === "ACTIVE" && (!i.state || i.state === "SUCCESSFUL")) {
        active.push(i);
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);
  active.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return active[0]?.imageVersion;
}

/** List MicroVMs in the account (optionally filtered by image). */
export async function listMicrovms(
  opts: ClientOptions & { image?: string; imageVersion?: string } = {},
): Promise<
  {
    microvmId?: string;
    state?: MicrovmState;
    imageArn?: string;
    imageVersion?: string;
    startedAt?: Date;
  }[]
> {
  const client = resolveClient(opts);
  const out: Awaited<ReturnType<typeof listMicrovms>> = [];
  let nextToken: string | undefined;
  do {
    const res = (await client.send(
      new ListMicrovmsCommand({
        ...(opts.image ? { imageIdentifier: opts.image } : {}),
        ...(opts.imageVersion ? { imageVersion: opts.imageVersion } : {}),
        ...(nextToken ? { nextToken } : {}),
      }),
    )) as {
      items?: {
        microvmId?: string;
        state?: MicrovmState;
        imageArn?: string;
        imageVersion?: string;
        startedAt?: Date;
      }[];
      nextToken?: string;
    };
    out.push(...(res.items ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}
