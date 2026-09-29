import { type ChildProcess, spawn } from "node:child_process";
import { HttpError } from "./http.js";

export interface ExecRequest {
  /** argv form: ["ls", "-la"] (preferred). */
  argv?: string[];
  /** Shell form: executed via `/bin/sh -c`. Exactly one of argv/command required. */
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** base64-encoded stdin piped to the process. */
  stdin?: string;
  /** Kill the process tree after N ms, 1 to 3_600_000. Default 30_000. */
  timeoutMs?: number;
  /** Cap captured stdout/stderr each. Default 16 MiB, max 256 MiB. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  /** null when the process was killed before exiting. */
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  /** base64-encoded stdout/stderr. */
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** True when grandchildren kept stdio open past the drain grace period. */
  outputIncomplete?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_OUT = 16 * 1024 * 1024;
const MAX_OUT_CAP = 256 * 1024 * 1024;
/** After the main process exits, wait this long for stdio EOF before force-closing. */
const DRAIN_GRACE_MS = 2_000;

/** Live children so close()/shutdown can reap them instead of orphaning. */
const liveChildren = new Set<ChildProcess>();

function killProcessTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function killAllExecs(): void {
  for (const child of liveChildren) killProcessTree(child);
}

export async function runExec(req: ExecRequest): Promise<ExecResult> {
  if (req.argv !== undefined && !Array.isArray(req.argv)) {
    throw new HttpError(400, "argv must be an array of strings");
  }
  const argv = Array.isArray(req.argv) && req.argv.length > 0 ? req.argv : undefined;
  const hasArgv = argv !== undefined;
  const hasCmd = typeof req.command === "string" && req.command.length > 0;
  if (hasArgv === hasCmd) {
    throw new HttpError(400, "exactly one of argv or command is required");
  }
  if (hasArgv && argv.some((a) => typeof a !== "string")) {
    throw new HttpError(400, "argv must be an array of strings");
  }
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new HttpError(400, `timeoutMs must be 1..${MAX_TIMEOUT_MS}`);
  }
  const maxOut = req.maxOutputBytes ?? DEFAULT_MAX_OUT;
  if (!Number.isInteger(maxOut) || maxOut <= 0 || maxOut > MAX_OUT_CAP) {
    throw new HttpError(400, `maxOutputBytes must be 1..${MAX_OUT_CAP}`);
  }
  if (req.cwd !== undefined && typeof req.cwd !== "string") {
    throw new HttpError(400, "cwd must be a string");
  }
  if (req.command !== undefined && typeof req.command !== "string") {
    throw new HttpError(400, "command must be a string");
  }
  if (
    req.env !== undefined &&
    (typeof req.env !== "object" ||
      req.env === null ||
      Array.isArray(req.env) ||
      Object.values(req.env).some((v) => typeof v !== "string"))
  ) {
    throw new HttpError(400, "env must be a string map");
  }
  if (req.stdin !== undefined && typeof req.stdin !== "string") {
    throw new HttpError(400, "stdin must be a base64 string");
  }
  if (
    req.stdin !== undefined &&
    (!/^[A-Za-z0-9+/]*={0,2}$/.test(req.stdin) || req.stdin.length % 4 !== 0)
  ) {
    throw new HttpError(400, "stdin is not valid base64");
  }

  const [file, args] = hasArgv
    ? [argv[0] as string, argv.slice(1)]
    : ["/bin/sh", ["-c", req.command as string]];

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: req.cwd,
      env: { ...process.env, ...(req.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      // New process group: lets a timeout kill the whole tree with kill(-pid)
      // instead of orphaning grandchildren inside the MicroVM.
      detached: true,
    });
    liveChildren.add(child);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let outTrunc = false;
    let errTrunc = false;

    const collect = (
      chunks: Buffer[],
      len: number,
      truncated: boolean,
      c: Buffer,
    ): [number, boolean] => {
      if (len < maxOut) {
        const room = maxOut - len;
        chunks.push(c.subarray(0, Math.min(c.length, room)));
        return [len + Math.min(c.length, room), truncated || c.length > room];
      }
      return [len, true];
    };

    child.stdout.on("data", (c: Buffer) => {
      [outLen, outTrunc] = collect(out, outLen, outTrunc, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      [errLen, errTrunc] = collect(err, errLen, errTrunc, c);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    timer.unref();

    let exitCode: number | null | undefined;
    let exitSignal: string | undefined;
    let outputIncomplete = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let closed = false;

    const finish = () => {
      liveChildren.delete(child);
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve({
        exitCode: exitCode ?? null,
        signal: exitSignal,
        timedOut,
        stdout: Buffer.concat(out).toString("base64"),
        stderr: Buffer.concat(err).toString("base64"),
        stdoutTruncated: outTrunc || undefined,
        stderrTruncated: errTrunc || undefined,
        outputIncomplete: outputIncomplete || undefined,
      });
    };

    const maybeFinish = () => {
      // 'close' = process exited AND stdio reached EOF. If grandchildren
      // inherited the pipes, EOF may never come — settle on 'exit' plus a
      // bounded drain grace period instead of hanging forever.
      if (closed && exitCode !== undefined) finish();
    };

    child.on("error", (e: NodeJS.ErrnoException) => {
      // Include syscall/path so a bad cwd is distinguishable from a missing
      // binary. Only spawn-time failure is terminal — a failed spawn leaves
      // pid undefined. 'error' can also fire while the child runs (e.g. an
      // async kill failure): record it for diagnostics but don't clobber
      // state or drop a live child from the registry.
      const detail = e.path ? ` ${e.syscall ?? ""} ${e.path}` : "";
      [errLen, errTrunc] = collect(
        err,
        errLen,
        errTrunc,
        Buffer.from(`${e.code ?? "ERR"}:${detail} ${e.message}`),
      );
      if (exitCode !== undefined || closed || child.pid !== undefined) return;
      // Shell convention: 127 for missing binary, 126 for non-executable.
      exitCode = e.code === "ENOENT" ? 127 : e.code === "EACCES" ? 126 : null;
      closed = true;
      maybeFinish();
    });
    child.on("exit", (code, signal) => {
      // Exited before the deadline — disarm the kill timer so it can't
      // mislabel a timely exit as timedOut while stdio drains.
      clearTimeout(timer);
      exitCode = code;
      exitSignal = signal ?? undefined;
      drainTimer = setTimeout(() => {
        outputIncomplete = true;
        child.stdout.destroy();
        child.stderr.destroy();
        closed = true;
        maybeFinish();
      }, DRAIN_GRACE_MS);
      drainTimer.unref();
    });
    child.on("close", () => {
      closed = true;
      maybeFinish();
    });

    // The child may exit before stdin is consumed — ignore EPIPE. stdout/
    // stderr pipe errors likewise must not become uncaughtException.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    if (req.stdin !== undefined) {
      child.stdin.write(Buffer.from(req.stdin, "base64"));
    }
    child.stdin.end();
  });
}
