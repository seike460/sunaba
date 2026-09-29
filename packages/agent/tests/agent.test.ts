import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type AgentServers,
  envHookHandlers,
  startAgent,
  startHooksServer,
  startJsonServer,
} from "../src/index.js";

let servers: AgentServers;
let apiPort: number;
let hooksPort: number;

function addr(s: Server): number {
  const a = s.address();
  if (!a || typeof a === "string") throw new Error("server not listening");
  return a.port;
}

beforeAll(async () => {
  servers = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: {} });
  await new Promise((r) => setImmediate(r));
  apiPort = addr(servers.api);
  hooksPort = addr(servers.hooks as Server);
});

afterAll(async () => {
  await servers.close();
});

async function post(port: number, route: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Reads the pid a shell command wrote to `file`, waiting until it is complete. */
async function readPid(file: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const m = existsSync(file) ? /^(\d+)\n$/.exec(readFileSync(file, "utf8")) : null;
    if (m) return Number(m[1]);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no pid in ${file}`);
}

/** True once `pid` no longer exists (killed and reaped). */
async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function kill(pid: number): void {
  // Never 0 or negative: those signal the test runner's process group.
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

describe("exec API", () => {
  it("runs argv commands and captures output", async () => {
    const res = await post(apiPort, "/exec", { argv: ["echo", "hello"] });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(Buffer.from(out.stdout, "base64").toString()).toBe("hello\n");
  });

  it("runs shell commands with cwd/env/stdin", async () => {
    const res = await post(apiPort, "/exec", {
      command: "cat; pwd; echo $SUNABA_TEST_VAR >&2",
      cwd: "/tmp",
      env: { SUNABA_TEST_VAR: "v1" },
      stdin: Buffer.from("line-in").toString("base64"),
    });
    const out = (await res.json()) as { exitCode: number; stdout: string; stderr: string };
    expect(out.exitCode).toBe(0);
    const stdout = Buffer.from(out.stdout, "base64").toString();
    expect(stdout).toContain("line-in");
    expect(stdout).toContain("/tmp");
    expect(Buffer.from(out.stderr, "base64").toString()).toContain("v1");
  });

  it("reports exit codes and missing binaries", async () => {
    const res = await post(apiPort, "/exec", { argv: ["sh", "-c", "exit 3"] });
    expect(((await res.json()) as { exitCode: number }).exitCode).toBe(3);

    const missing = await post(apiPort, "/exec", { argv: ["no-such-binary-xyz"] });
    const out = (await missing.json()) as { exitCode: number };
    expect(out.exitCode).toBe(127);
  });

  it("times out long-running commands", async () => {
    const res = await post(apiPort, "/exec", {
      argv: ["sleep", "5"],
      timeoutMs: 100,
    });
    const out = (await res.json()) as { timedOut: boolean; exitCode: number | null };
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBeNull();
  });

  it("kills the whole process tree on timeout", async () => {
    // The shell spawns children that outlive it; group-kill must reap all,
    // which frees the pipes — a surviving grandchild would hold them and
    // set outputIncomplete.
    const res = await post(apiPort, "/exec", {
      command: "sleep 30 & sleep 30 & wait",
      timeoutMs: 200,
    });
    const out = (await res.json()) as { timedOut: boolean; outputIncomplete?: boolean };
    expect(out.timedOut).toBe(true);
    expect(out.outputIncomplete).toBeUndefined();
  });

  it("returns promptly when grandchildren hold the output pipes", async () => {
    // sh exits immediately but the backgrounded sleep inherits stdout — the
    // response must not wait for the grandchild to die.
    const start = Date.now();
    const res = await post(apiPort, "/exec", { command: "sleep 10 & echo $!" });
    const out = (await res.json()) as {
      exitCode: number;
      stdout: string;
      outputIncomplete?: boolean;
    };
    const stdout = Buffer.from(out.stdout, "base64").toString();
    try {
      expect(out.exitCode).toBe(0);
      expect(stdout).toMatch(/^\d+\n$/);
      expect(out.outputIncomplete).toBe(true);
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      kill(Number(stdout));
    }
  });

  it("rejects malformed requests", async () => {
    expect((await post(apiPort, "/exec", {})).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: [] })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["a"], command: "x" })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], timeoutMs: -1 })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], timeoutMs: 0 })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], timeoutMs: 0.5 })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], timeoutMs: 4_000_000 })).status).toBe(
      400,
    );
    expect((await post(apiPort, "/exec", { argv: ["echo"], env: ["A=1"] })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], stdin: "!!!" })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], env: null })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], cwd: 123 })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], stdin: 123 })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], maxOutputBytes: 1e9 })).status).toBe(
      400,
    );
  });

  it("truncates oversized output", async () => {
    const res = await post(apiPort, "/exec", {
      command: "head -c 100000 /dev/zero | tr '\\0' 'a'",
      maxOutputBytes: 1024,
    });
    const out = (await res.json()) as { stdout: string; stdoutTruncated?: boolean };
    expect(out.stdoutTruncated).toBe(true);
    expect(Buffer.from(out.stdout, "base64").length).toBe(1024);
  });
});

describe("fs API", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sunaba-agent-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes, reads, stats and lists files", async () => {
    const file = path.join(dir, "sub", "a.txt");
    const data = Buffer.from("hello world").toString("base64");
    expect((await post(apiPort, "/fs/write", { path: file, data })).status).toBe(200);

    const read = await post(apiPort, "/fs/read", { path: file });
    expect(Buffer.from(((await read.json()) as { data: string }).data, "base64").toString()).toBe(
      "hello world",
    );

    const stat = await post(apiPort, "/fs/stat", { path: file });
    const s = (await stat.json()) as { type: string; size: number };
    expect(s).toMatchObject({ type: "file", size: 11 });

    const list = await post(apiPort, "/fs/list", { path: path.join(dir, "sub") });
    const entries = ((await list.json()) as { entries: { name: string; type: string }[] }).entries;
    expect(entries).toContainEqual({ name: "a.txt", type: "file", size: 11 });
  });

  it("supports utf8 encoding and file modes", async () => {
    const file = path.join(dir, "mode.sh");
    await post(apiPort, "/fs/write", {
      path: file,
      data: "#!/bin/sh\n",
      encoding: "utf8",
      mode: 0o755,
    });
    const stat = await post(apiPort, "/fs/stat", { path: file });
    const s = (await stat.json()) as { mode: number };
    expect(s.mode & 0o777).toBe(0o755);

    const read = await post(apiPort, "/fs/read", { path: file, encoding: "utf8" });
    expect(((await read.json()) as { data: string }).data).toBe("#!/bin/sh\n");
  });

  it("mkdir, rename, copy and remove work", async () => {
    const a = path.join(dir, "mk", "a");
    const b = path.join(dir, "mk", "b");
    await post(apiPort, "/fs/mkdir", { path: a });
    writeFileSync(path.join(a, "f.txt"), "x");
    await post(apiPort, "/fs/rename", { from: a, to: b });
    const st = await post(apiPort, "/fs/stat", { path: path.join(b, "f.txt") });
    expect(st.status).toBe(200);

    const cp = await post(apiPort, "/fs/copy", { from: b, to: path.join(dir, "mk", "c") });
    expect(cp.status).toBe(400); // directory without recursive
    expect(
      (await post(apiPort, "/fs/copy", { from: b, to: path.join(dir, "mk", "c"), recursive: true }))
        .status,
    ).toBe(200);

    // Copying a file creates missing parent dirs, like /fs/write does.
    const nested = path.join(dir, "deep", "deeper", "f.txt");
    const cpNested = await post(apiPort, "/fs/copy", {
      from: path.join(b, "f.txt"),
      to: nested,
    });
    expect(cpNested.status).toBe(200);
    expect(readFileSync(nested, "utf8")).toBe("x");

    // Non-empty dirs are protected without recursive:true.
    expect((await post(apiPort, "/fs/remove", { path: b })).status).toBe(400);
    await post(apiPort, "/fs/remove", { path: b, recursive: true });
    expect((await post(apiPort, "/fs/stat", { path: b })).status).toBe(404);
  });

  it("copy onto itself / a hardlink is rejected without truncating the source", async () => {
    const f = path.join(dir, "selfcopy.txt");
    writeFileSync(f, "precious data");
    // Same path.
    expect((await post(apiPort, "/fs/copy", { from: f, to: f })).status).toBe(400);
    expect(readFileSync(f, "utf8")).toBe("precious data");
    // Hard link — different path, same inode.
    const link = path.join(dir, "selfcopy-hard.txt");
    linkSync(f, link);
    expect((await post(apiPort, "/fs/copy", { from: f, to: link })).status).toBe(400);
    expect(readFileSync(f, "utf8")).toBe("precious data");
    expect(readFileSync(link, "utf8")).toBe("precious data");
  });

  it("copy gives a new or existing destination file the source's mode", async () => {
    const src = path.join(dir, "run.sh");
    writeFileSync(src, "#!/bin/sh\n");
    // Group-writable: a umask of 022 would clear the bit on a plain create.
    chmodSync(src, 0o775);
    const fresh = path.join(dir, "copied", "run.sh");
    expect((await post(apiPort, "/fs/copy", { from: src, to: fresh })).status).toBe(200);
    expect(statSync(fresh).mode & 0o7777).toBe(0o775);

    const existing = path.join(dir, "existing.sh");
    writeFileSync(existing, "old");
    chmodSync(existing, 0o644);
    expect((await post(apiPort, "/fs/copy", { from: src, to: existing })).status).toBe(200);
    expect(statSync(existing).mode & 0o7777).toBe(0o775);
    expect(readFileSync(existing, "utf8")).toBe("#!/bin/sh\n");
  });

  it("maps fs.cp rejections of the source tree to 400", async () => {
    const withFifo = path.join(dir, "cp-fifo");
    mkdirSync(withFifo);
    execFileSync("mkfifo", [path.join(withFifo, "pipe")]);
    const fifo = await post(apiPort, "/fs/copy", {
      from: withFifo,
      to: path.join(dir, "cp-fifo-dst"),
      recursive: true,
    });
    expect(fifo.status).toBe(400);
    expect(((await fifo.json()) as { error: { code: string } }).error.code).toBe(
      "ERR_FS_CP_FIFO_PIPE",
    );

    const tree = path.join(dir, "cp-tree");
    mkdirSync(tree);
    const file = path.join(dir, "cp-onto-file");
    writeFileSync(file, "x");
    const onto = await post(apiPort, "/fs/copy", { from: tree, to: file, recursive: true });
    expect(onto.status).toBe(400);
    expect(((await onto.json()) as { error: { code: string } }).error.code).toBe(
      "ERR_FS_CP_DIR_TO_NON_DIR",
    );
  });

  it("does not write or copy through a symlink", async () => {
    const target = path.join(dir, "symlink-target.txt");
    const link = path.join(dir, "symlink.txt");
    writeFileSync(target, "original");
    symlinkSync(target, link);
    const write = await post(apiPort, "/fs/write", { path: link, data: "new", encoding: "utf8" });
    expect(write.status).toBe(400);
    expect(((await write.json()) as { error: { code: string } }).error.code).toBe("ELOOP");

    const src = path.join(dir, "symlink-src.txt");
    writeFileSync(src, "new");
    expect((await post(apiPort, "/fs/copy", { from: src, to: link })).status).toBe(400);
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  it("refuses reads over the 64 MiB cap with 413", async () => {
    const big = path.join(dir, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, 64 * 1024 * 1024 + 1);
    expect((await post(apiPort, "/fs/read", { path: big })).status).toBe(413);
  });

  it("404s on missing files and 400s on missing args", async () => {
    expect((await post(apiPort, "/fs/read", { path: path.join(dir, "nope") })).status).toBe(404);
    expect((await post(apiPort, "/fs/read", {})).status).toBe(400);
  });

  it("rejects non-regular reads/writes, NUL paths and bad modes", async () => {
    // /dev/null is a character device — must not be read or written via fs API.
    expect((await post(apiPort, "/fs/read", { path: "/dev/null" })).status).toBe(400);
    expect((await post(apiPort, "/fs/write", { path: "/dev/null", data: "eA==" })).status).toBe(
      400,
    );
    expect((await post(apiPort, "/fs/stat", { path: `${dir}/x` })).status).toBe(404);
    expect(
      (await post(apiPort, "/fs/write", { path: `${dir}/bad`, data: "eA==", mode: 493.5 })).status,
    ).toBe(400);
    expect((await post(apiPort, "/fs/write", { path: `${dir}/bad2`, data: "x" })).status).toBe(400);
    const nul = await post(apiPort, "/fs/read", { path: "/tmp/\0x" });
    expect(nul.status).toBe(400);
  });

  it("does not block on FIFOs", async () => {
    const fifo = path.join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    const start = Date.now();
    const res = await post(apiPort, "/fs/read", { path: fifo });
    // O_RDONLY|O_NONBLOCK open + isFile() check → fast 400, never a hang.
    expect(res.status).toBe(400);
    expect(Date.now() - start).toBeLessThan(5_000);
    // The fs API must still serve other routes (no threadpool pin).
    expect((await post(apiPort, "/fs/stat", { path: dir })).status).toBe(200);
  });
});

describe("hooks server", () => {
  it("acks every hook path with 200 when unhandled", async () => {
    const res = await post(hooksPort, "/aws/lambda-microvms/runtime/v1/suspend", {});
    expect(res.status).toBe(200);
  });

  it("acks unknown hook names under the prefix with 200", async () => {
    const res = await post(hooksPort, "/aws/lambda-microvms/runtime/v1/future-hook", {});
    expect(res.status).toBe(200);
  });

  it("acks prototype-chain hook names with 200, not 503", async () => {
    for (const name of ["__proto__", "hasOwnProperty", "valueOf", "constructor"]) {
      const res = await post(hooksPort, `/aws/lambda-microvms/runtime/v1/${name}`, {});
      expect(res.status).toBe(200);
    }
  });

  it("runs explicit hook handlers and maps failures to 503", async () => {
    const s = startAgent({
      port: 0,
      hooksPort: 0,
      host: "127.0.0.1",
      hooks: { run: async () => {}, suspend: () => Promise.reject(new Error("drain failed")) },
    });
    await new Promise((r) => setImmediate(r));
    const hp = addr(s.hooks as Server);
    expect((await post(hp, "/aws/lambda-microvms/runtime/v1/run", {})).status).toBe(200);
    const fail = await post(hp, "/aws/lambda-microvms/runtime/v1/suspend", {});
    expect(fail.status).toBe(503);
    const body = (await fail.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain("drain failed");
    await s.close();
  });

  it("env hooks return promptly and leave a backgrounded process running", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-hooks-"));
    const pidFile = path.join(dir, "pid");
    const prev = process.env.SUNABA_HOOK_READY;
    process.env.SUNABA_HOOK_READY = `sleep 30 & echo $! > "${pidFile}"`;
    let pid = 0;
    try {
      const s = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: envHookHandlers() });
      await new Promise((r) => setImmediate(r));
      const hp = addr(s.hooks as Server);
      const start = Date.now();
      const res = await post(hp, "/aws/lambda-microvms/runtime/v1/ready", {});
      expect(res.status).toBe(200);
      expect(Date.now() - start).toBeLessThan(5_000);
      await s.close();
      // A daemon started by a hook outlives the hook command and close().
      pid = await readPid(pidFile);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      kill(pid);
      if (prev === undefined) delete process.env.SUNABA_HOOK_READY;
      else process.env.SUNABA_HOOK_READY = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env hook timeout above the exec cap is clamped, not rejected", async () => {
    const prev = process.env.SUNABA_HOOK_VALIDATE;
    const prevT = process.env.SUNABA_HOOK_TIMEOUT_MS;
    process.env.SUNABA_HOOK_VALIDATE = "exit 0";
    process.env.SUNABA_HOOK_TIMEOUT_MS = "7200000"; // > MAX_TIMEOUT_MS
    try {
      const s = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: envHookHandlers() });
      await new Promise((r) => setImmediate(r));
      const hp = addr(s.hooks as Server);
      const res = await post(hp, "/aws/lambda-microvms/runtime/v1/validate", {});
      expect(res.status).toBe(200);
      await s.close();
    } finally {
      if (prev === undefined) delete process.env.SUNABA_HOOK_VALIDATE;
      else process.env.SUNABA_HOOK_VALIDATE = prev;
      if (prevT === undefined) delete process.env.SUNABA_HOOK_TIMEOUT_MS;
      else process.env.SUNABA_HOOK_TIMEOUT_MS = prevT;
    }
  });

  it.each(["abc", "5m", "NaN", "Infinity", "0", "0.5", "-5"])(
    "rejects SUNABA_HOOK_TIMEOUT_MS=%s instead of using the default",
    (value) => {
      expect(() => envHookHandlers({ SUNABA_HOOK_TIMEOUT_MS: value })).toThrow(
        new RangeError(`SUNABA_HOOK_TIMEOUT_MS must be a number of ms >= 1, got '${value}'`),
      );
    },
  );

  it("treats an empty SUNABA_HOOK_TIMEOUT_MS as unset", () => {
    const handlers = envHookHandlers({ SUNABA_HOOK_TIMEOUT_MS: "", SUNABA_HOOK_RUN: "true" });
    expect(typeof handlers.run).toBe("function");
  });

  it("env hooks execute shell commands", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-hooks-"));
    const marker = path.join(dir, "hook-ran");
    const prev = process.env.SUNABA_HOOK_RUN;
    process.env.SUNABA_HOOK_RUN = `cat > "${marker}"`;
    try {
      const s = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: envHookHandlers() });
      await new Promise((r) => setImmediate(r));
      const hp = addr(s.hooks as Server);
      const res = await post(hp, "/aws/lambda-microvms/runtime/v1/run", { microvmId: "m-1" });
      expect(res.status).toBe(200);
      await s.close();
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ microvmId: "m-1" });
    } finally {
      if (prev === undefined) delete process.env.SUNABA_HOOK_RUN;
      else process.env.SUNABA_HOOK_RUN = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects hook bodies over 1 MiB with 413 BodyTooLarge", async () => {
    const res = await post(hooksPort, "/aws/lambda-microvms/runtime/v1/ready", {
      pad: "x".repeat(1_048_576),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BodyTooLarge");
  });

  it("404s outside the hook prefix", async () => {
    const res = await post(hooksPort, "/nope", {});
    expect(res.status).toBe(404);
  });
});

/** A TCP port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** A server holding a port on 127.0.0.1, as another process would. */
async function occupy(): Promise<{ port: number; release(): Promise<void> }> {
  const blocker = createServer().listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const { port } = blocker.address() as AddressInfo;
  return { port, release: () => new Promise<void>((r) => blocker.close(() => r())) };
}

/** Resolves when `port` can be bound again, i.e. no server was left on it. */
async function expectFree(port: number): Promise<void> {
  await new Promise((r) => setImmediate(r));
  const again = createServer().listen(port, "127.0.0.1");
  await once(again, "listening"); // rejects with EADDRINUSE otherwise
  await new Promise<void>((r) => again.close(() => r()));
}

describe("server options", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects maxBodyBytes %s before listening",
    (maxBodyBytes) => {
      const started: Server[] = [];
      try {
        const opts = { port: 0, host: "127.0.0.1", maxBodyBytes };
        expect(() => started.push(startJsonServer({ ...opts, routes: {} }))).toThrow(
          new RangeError(`maxBodyBytes must be a non-negative integer, got ${maxBodyBytes}`),
        );
        expect(() => started.push(startHooksServer({}, opts))).toThrow(RangeError);
      } finally {
        for (const s of started) s.close();
      }
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 65_536])(
    "rejects port %s when it starts (listen() validates it)",
    (port) => {
      expect(() => startJsonServer({ routes: {}, port, host: "127.0.0.1" })).toThrow(
        expect.objectContaining({ code: "ERR_SOCKET_BAD_PORT" }),
      );
    },
  );

  it("leaves no API server listening when the hooks server cannot start", async () => {
    const port = await freePort();
    expect(() => startAgent({ port, hooksPort: Number.NaN, host: "127.0.0.1", hooks: {} })).toThrow(
      expect.objectContaining({ code: "ERR_SOCKET_BAD_PORT" }),
    );
    await expectFree(port);
  });

  it.each([
    [
      "startJsonServer",
      (port: number, onError: (e: Error) => void) =>
        startJsonServer({ routes: {}, port, host: "127.0.0.1", onError }),
    ],
    [
      "startHooksServer",
      (port: number, onError: (e: Error) => void) =>
        startHooksServer({}, { port, host: "127.0.0.1", onError }),
    ],
  ])("%s hands a port already in use to onError", async (_name, start) => {
    const taken = await occupy();
    try {
      const onError = vi.fn();
      const server = start(taken.port, onError);
      const [err] = await once(server, "error");
      expect(err).toMatchObject({ code: "EADDRINUSE", port: taken.port });
      expect(onError).toHaveBeenCalledWith(err);
      expect(server.listening).toBe(false);
    } finally {
      await taken.release();
    }
  });

  it("closes the API server when the hooks port is already in use", async () => {
    const taken = await occupy();
    try {
      const port = await freePort();
      const onError = vi.fn();
      const s = startAgent({ port, hooksPort: taken.port, host: "127.0.0.1", hooks: {}, onError });
      await expect(s.ready).rejects.toMatchObject({ code: "EADDRINUSE", port: taken.port });
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "EADDRINUSE" }));
      expect(s.api.listening).toBe(false);
      await expectFree(port);
    } finally {
      await taken.release();
    }
  });

  it("closes the hooks server when the API port is already in use", async () => {
    const taken = await occupy();
    try {
      const hooksPort = await freePort();
      const onError = vi.fn();
      const s = startAgent({ port: taken.port, hooksPort, host: "127.0.0.1", hooks: {}, onError });
      await expect(s.ready).rejects.toMatchObject({ code: "EADDRINUSE", port: taken.port });
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "EADDRINUSE" }));
      expect(s.hooks?.listening).toBe(false);
      await expectFree(hooksPort);
    } finally {
      await taken.release();
    }
  });

  it("checks SUNABA_HOOK_TIMEOUT_MS before the API server listens", async () => {
    const prev = process.env.SUNABA_HOOK_TIMEOUT_MS;
    process.env.SUNABA_HOOK_TIMEOUT_MS = "5m";
    try {
      const port = await freePort();
      expect(() => startAgent({ port, hooksPort: 0, host: "127.0.0.1" })).toThrow(RangeError);
      await expectFree(port);
    } finally {
      if (prev === undefined) delete process.env.SUNABA_HOOK_TIMEOUT_MS;
      else process.env.SUNABA_HOOK_TIMEOUT_MS = prev;
    }
  });
});

describe("agent wiring", () => {
  it("GET /healthz works and close() stops both servers", async () => {
    const s = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: {} });
    await new Promise((r) => setImmediate(r));
    const port = addr(s.api);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    await s.close();
  });

  it("ready resolves once both servers listen", async () => {
    const s = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: {} });
    await s.ready;
    expect(s.api.listening).toBe(true);
    expect(s.hooks?.listening).toBe(true);
    await s.close();
  });

  it("AgentServers still accepts the 0.1.0 shape, without ready", () => {
    // Checked by `npm run typecheck`: a test double or wrapper typed as
    // AgentServers must keep compiling.
    expectTypeOf<{
      api: Server;
      hooks?: Server;
      close(): Promise<void>;
    }>().toExtend<AgentServers>();
    expectTypeOf(startAgent).returns.toExtend<AgentServers>();
    expectTypeOf(startAgent).returns.toHaveProperty("ready").toEqualTypeOf<Promise<void>>();
  });

  it("close() resolves promptly with an in-flight exec and reaps it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sunaba-close-"));
    const pidFile = path.join(dir, "pid");
    const s = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: false });
    let pid = 0;
    try {
      await new Promise((r) => setImmediate(r));
      const port = addr(s.api);
      const inflight = post(port, "/exec", {
        command: `echo $$ > "${pidFile}"; exec sleep 60`,
        timeoutMs: 55_000,
      }).then(
        (r) => r.status,
        (e) => e,
      );
      // Close only once the command is running.
      pid = await readPid(pidFile);
      const start = Date.now();
      await s.close();
      expect(Date.now() - start).toBeLessThan(5_000);
      await inflight; // must settle — resolved or fetch-aborted
      expect(await gone(pid)).toBe(true);
    } finally {
      kill(pid);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers 408 and closes the connection when a request body stalls for 60 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Content-Length promises 10 bytes; only "{" is ever sent. The client
    // asks for keep-alive, so the close must come from the server.
    const client = httpRequest({
      host: "127.0.0.1",
      port: apiPort,
      method: "POST",
      path: "/exec",
      agent: false,
      headers: { connection: "keep-alive", "content-length": "10" },
    });
    try {
      client.on("error", () => {});
      const response = once(client, "response") as Promise<[IncomingMessage]>;
      // The handler arms the body timer synchronously, before this listener runs.
      const request = once(servers.api, "request") as Promise<[IncomingMessage]>;
      client.write("{");
      const [req] = await request;
      const closed = once(req.socket, "close");
      vi.advanceTimersByTime(59_999);
      expect(req.socket.bytesWritten).toBe(0);
      vi.advanceTimersByTime(1);
      const [res] = await response;
      expect(res.statusCode).toBe(408);
      expect(res.headers.connection).toBe("close");
      expect(res.headers["content-type"]).toBe("application/json");
      const body: Buffer[] = [];
      for await (const c of res) body.push(c as Buffer);
      expect(JSON.parse(Buffer.concat(body).toString())).toEqual({
        error: { code: "RequestTimeout", message: "request body timed out" },
      });
      // The server closes the connection by itself once the 408 is out.
      await closed;
    } finally {
      vi.useRealTimers();
      client.destroy();
    }
  });

  it("closes a timed-out connection 5 s after the 408 even if Node keeps it open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sock = connect(apiPort, "127.0.0.1");
    try {
      sock.on("error", () => {});
      const first = new Promise<string>((resolve) => {
        sock.once("data", (c) => resolve(String(c)));
        sock.once("close", () => resolve(""));
      });
      const request = once(servers.api, "request") as Promise<[IncomingMessage]>;
      sock.write("POST /exec HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n{");
      const [req] = await request;
      // Stands in for a client that never reads: the close Node does after
      // the reply is flushed never comes.
      req.socket.destroySoon = () => {};
      vi.advanceTimersByTime(60_000);
      expect(await first).toMatch(/^HTTP\/1\.1 408 /);
      vi.advanceTimersByTime(4_999);
      expect(req.socket.destroyed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(req.socket.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
      sock.destroy();
    }
  });
});
