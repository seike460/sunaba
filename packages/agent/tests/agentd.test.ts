import { describe, expect, it, vi } from "vitest";

/**
 * Run the `sunaba-agentd` entry point with `argv`; agentd.ts parses its
 * arguments on import. Only invalid arguments are passed, so parsing exits
 * before any server starts.
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
