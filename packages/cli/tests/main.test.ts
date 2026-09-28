import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The default client is only reached by the NoRegion test: its region
// provider must fail the same way whatever the ambient AWS config is.
vi.mock("@aws-sdk/client-lambda-microvms", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@aws-sdk/client-lambda-microvms")>();
  class NoRegionClient {
    config = {
      region: async () => {
        throw new Error("Region is missing");
      },
    };
    async send(): Promise<unknown> {
      return {};
    }
  }
  return { ...orig, LambdaMicrovmsClient: NoRegionClient };
});

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Run the `sunaba` entry point with `argv`; main.ts runs on import. */
async function sunaba(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((l) => void out.push(String(l)));
  const error = vi.spyOn(console, "error").mockImplementation((l) => void err.push(String(l)));
  const prevArgv = process.argv;
  process.argv = ["node", "sunaba", ...argv];
  vi.resetModules();
  try {
    await import("../src/main.js");
    return { code: process.exitCode, out, err };
  } finally {
    process.argv = prevArgv;
    process.exitCode = undefined;
    log.mockRestore();
    error.mockRestore();
  }
}

describe("main", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prints the CLI version for --version, -v and `version`", async () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      expect(await sunaba(...argv)).toEqual({ code: 0, out: [VERSION], err: [] });
    }
  });

  it("help exits 0; no command prints the usage and exits 1", async () => {
    for (const argv of [["help"], ["--help"], ["-h"], ["run", "--help"]]) {
      const r = await sunaba(...argv);
      expect(r.code).toBe(0);
      expect(r.out[0]).toContain("usage: sunaba <command>");
    }
    const bare = await sunaba();
    expect(bare.code).toBe(1);
    expect(bare.out[0]).toContain("usage: sunaba <command>");
  });

  it("exits 2 on an unknown command, Object.prototype keys included", async () => {
    for (const name of ["nope", "toString", "constructor"]) {
      const r = await sunaba(name);
      expect(r.code).toBe(2);
      expect(r.err[0]).toBe(`unknown command: ${name}\n`);
    }
  });

  it("exits 1 with a `sunaba: error:` line when the command throws", async () => {
    expect(await sunaba("rm")).toEqual({
      code: 1,
      out: [],
      err: ["sunaba: error: usage: sunaba rm <microvm-id>..."],
    });
  });

  it("--profile sets AWS_PROFILE before the command runs", async () => {
    vi.stubEnv("AWS_PROFILE", undefined);
    expect((await sunaba("rm", "--profile", "dev")).code).toBe(1);
    expect(process.env.AWS_PROFILE).toBe("dev");
  });

  it("adds the CLI flag hint to the SDK's NoRegion error", async () => {
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_DEFAULT_REGION", "");
    const r = await sunaba("run", "--image", "demo");
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(
      /^sunaba: error: region is required: .* \(use --region or AWS_REGION\)$/,
    );
  });
});
