import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentServers, envHookHandlers, startAgent } from "../src/index.js";

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
    const res = await post(apiPort, "/exec", { command: "sleep 10 & echo done" });
    const out = (await res.json()) as {
      exitCode: number;
      stdout: string;
      outputIncomplete?: boolean;
    };
    expect(out.exitCode).toBe(0);
    expect(Buffer.from(out.stdout, "base64").toString()).toBe("done\n");
    expect(out.outputIncomplete).toBe(true);
    expect(Date.now() - start).toBeLessThan(15_000);
  });

  it("rejects malformed requests", async () => {
    expect((await post(apiPort, "/exec", {})).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: [] })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["a"], command: "x" })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], timeoutMs: -1 })).status).toBe(400);
    expect((await post(apiPort, "/exec", { argv: ["echo"], timeoutMs: 0 })).status).toBe(400);
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
    const { execFileSync } = await import("node:child_process");
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

  it("env hooks return promptly when the command backgrounds a process", async () => {
    const prev = process.env.SUNABA_HOOK_READY;
    process.env.SUNABA_HOOK_READY = "sleep 30 & echo ok";
    try {
      const s = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: envHookHandlers() });
      await new Promise((r) => setImmediate(r));
      const hp = addr(s.hooks as Server);
      const start = Date.now();
      const res = await post(hp, "/aws/lambda-microvms/runtime/v1/ready", {});
      expect(res.status).toBe(200);
      expect(Date.now() - start).toBeLessThan(15_000);
      await s.close();
    } finally {
      if (prev === undefined) delete process.env.SUNABA_HOOK_READY;
      else process.env.SUNABA_HOOK_READY = prev;
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

  it("404s outside the hook prefix", async () => {
    const res = await post(hooksPort, "/nope", {});
    expect(res.status).toBe(404);
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

  it("close() resolves promptly with an in-flight exec and reaps it", async () => {
    const s = startAgent({ port: 0, hooksPort: 0, host: "127.0.0.1", hooks: false });
    await new Promise((r) => setImmediate(r));
    const port = addr(s.api);
    const inflight = post(port, "/exec", { argv: ["sleep", "60"], timeoutMs: 55_000 }).then(
      (r) => r.status,
      (e) => e,
    );
    // Give the request a beat to reach the server, then close.
    await new Promise((r) => setTimeout(r, 100));
    const start = Date.now();
    await s.close();
    expect(Date.now() - start).toBeLessThan(5_000);
    await inflight; // must settle — resolved or fetch-aborted
  });
});
