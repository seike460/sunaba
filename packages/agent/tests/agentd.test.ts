import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";

/**
 * Run the `sunaba-agentd` entry point with `argv`; agentd.ts parses its
 * arguments on import. Only invalid arguments or settings are passed, so
 * agentd exits before any server starts.
 */
async function agentd(...argv: string[]) {
  const err: string[] = [];
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  const error = vi.spyOn(console, "error").mockImplementation((l) => void err.push(String(l)));
  const prevArgv = process.argv;
  process.argv = ["node", "sunaba-agentd", ...argv];
  vi.resetModules();
  try {
    const exited = await import("../src/agentd.js").then(
      () => "no exit",
      (e: Error) => e.message,
    );
    return { exited, err };
  } finally {
    process.argv = prevArgv;
    exit.mockRestore();
    error.mockRestore();
  }
}

describe("sunaba-agentd arguments", () => {
  it("exits 2 on a port outside 1..65535", async () => {
    expect(await agentd("--port", "0")).toEqual({
      exited: "exit 2",
      err: ["invalid --port: 0"],
    });
    expect(await agentd("--port", "8080.5")).toEqual({
      exited: "exit 2",
      err: ["invalid --port: 8080.5"],
    });
    expect(await agentd("--hooks-port", "65536")).toEqual({
      exited: "exit 2",
      err: ["invalid --hooks-port: 65536"],
    });
  });

  it("exits 2 on an invalid SUNABA_HOOK_TIMEOUT_MS", async () => {
    const prev = process.env.SUNABA_HOOK_TIMEOUT_MS;
    process.env.SUNABA_HOOK_TIMEOUT_MS = "5m";
    try {
      expect(await agentd("--host", "127.0.0.1")).toEqual({
        exited: "exit 2",
        err: ["SUNABA_HOOK_TIMEOUT_MS must be a positive number of ms, got '5m'"],
      });
    } finally {
      if (prev === undefined) delete process.env.SUNABA_HOOK_TIMEOUT_MS;
      else process.env.SUNABA_HOOK_TIMEOUT_MS = prev;
    }
  });

  it("exits 2 on a missing value or an unknown argument", async () => {
    expect(await agentd("--port")).toEqual({ exited: "exit 2", err: ["--port requires a value"] });
    expect(await agentd("--host", "--no-hooks")).toEqual({
      exited: "exit 2",
      err: ["--host requires a value"],
    });
    expect(await agentd("--bogus")).toEqual({
      exited: "exit 2",
      err: ["unknown argument: --bogus"],
    });
  });
});

/** A server holding a port on 127.0.0.1, as another process would. */
async function occupy(): Promise<{ port: number; release(): Promise<void> }> {
  const blocker = createServer().listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const { port } = blocker.address() as AddressInfo;
  return { port, release: () => new Promise<void>((r) => blocker.close(() => r())) };
}

/** A TCP port nothing listens on right now. */
async function freePort(): Promise<number> {
  const taken = await occupy();
  await taken.release();
  return taken.port;
}

/**
 * Start `sunaba-agentd` with `argv` in this process. process.exit only
 * records the code in `exitCode`; `sigterm()` runs its SIGTERM handler.
 * `restore()` undoes the mocks and removes the signal handlers it added.
 */
async function startAgentd(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const before = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
  const added = (name: "SIGTERM" | "SIGINT") =>
    process.listeners(name).filter((l) => !before[name].includes(l));
  let exited: (code: unknown) => void = () => {};
  const exitCode = new Promise<unknown>((r) => {
    exited = r;
  });
  const mocks = [
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      exited(c);
    }) as typeof process.exit),
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" "))),
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.map(String).join(" "))),
  ];
  const prevArgv = process.argv;
  process.argv = ["node", "sunaba-agentd", ...argv];
  vi.resetModules();
  try {
    await import("../src/agentd.js");
  } finally {
    process.argv = prevArgv;
  }
  return {
    out,
    err,
    exitCode,
    sigterm: () => {
      for (const l of added("SIGTERM")) (l as () => void)();
    },
    restore: () => {
      for (const m of mocks) m.mockRestore();
      for (const name of ["SIGTERM", "SIGINT"] as const) {
        for (const l of added(name)) process.off(name, l);
      }
    },
  };
}

describe("sunaba-agentd startup", () => {
  it.each(["--port", "--hooks-port"])(
    "exits 1 with the listen error, and never says listening, when %s is in use",
    async (flag) => {
      const taken = await occupy();
      const ports: Record<string, number> = {
        "--port": await freePort(),
        "--hooks-port": await freePort(),
        [flag]: taken.port,
      };
      const agentd = await startAgentd(
        ...["--host", "127.0.0.1", "--port", String(ports["--port"])],
        ...["--hooks-port", String(ports["--hooks-port"])],
      );
      try {
        expect(await agentd.exitCode).toBe(1);
        expect(agentd.err.join("\n")).toContain(
          `listen EADDRINUSE: address already in use 127.0.0.1:${taken.port}`,
        );
        // Give a late "listening" log the chance to show up.
        await new Promise((r) => setTimeout(r, 50));
        expect(agentd.out).toEqual([]);
      } finally {
        agentd.restore();
        await taken.release();
      }
    },
  );

  it("says listening only once both servers are, and frees both ports on SIGTERM", async () => {
    const port = await freePort();
    const hooksPort = await freePort();
    const agentd = await startAgentd(
      ...["--host", "127.0.0.1", "--port", String(port), "--hooks-port", String(hooksPort)],
    );
    try {
      expect(agentd.out).toEqual([]);
      await vi.waitFor(() =>
        expect(agentd.out).toEqual([
          `[sunaba-agentd] api listening on 127.0.0.1:${port}, hooks on :${hooksPort}`,
        ]),
      );
      // shutdown arms a 3 s fallback exit; keep it from firing in this process.
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      agentd.sigterm();
      expect(await agentd.exitCode).toBe(0);
      for (const p of [port, hooksPort]) {
        const again = createServer().listen(p, "127.0.0.1");
        await once(again, "listening"); // rejects with EADDRINUSE if left open
        await new Promise<void>((r) => again.close(() => r()));
      }
    } finally {
      vi.useRealTimers();
      agentd.restore();
    }
  });
});
