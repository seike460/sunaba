import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRegion } from "../src/transport.js";
import { FakeMicrovmsClient } from "./helpers.js";

// resolveRegion's last resort constructs the DEFAULT client to tap the
// ambient provider chain (~/.aws/config, IMDS). Intercept that construction:
// `ambient` is what such a chain would resolve (or throw).
const ambient = vi.hoisted(() => ({
  region: undefined as string | undefined,
  error: undefined as Error | undefined,
}));

vi.mock("@aws-sdk/client-lambda-microvms", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@aws-sdk/client-lambda-microvms")>();
  class FakeLambdaMicrovmsClient {
    config = {
      region: async () => {
        if (ambient.error) throw ambient.error;
        if (ambient.region === undefined) throw new Error("Region is missing");
        return ambient.region;
      },
    };
  }
  return { ...orig, LambdaMicrovmsClient: FakeLambdaMicrovmsClient };
});

describe("resolveRegion", () => {
  afterEach(() => {
    ambient.region = undefined;
    ambient.error = undefined;
    vi.unstubAllEnvs();
  });

  it("prefers the explicit region option", async () => {
    ambient.region = "eu-west-1";
    expect(await resolveRegion({ region: "ap-northeast-1" })).toBe("ap-northeast-1");
  });

  it("reads clientConfig.region (string and provider)", async () => {
    expect(await resolveRegion({ clientConfig: { region: "eu-central-1" } })).toBe("eu-central-1");
    expect(await resolveRegion({ clientConfig: { region: async () => "af-south-1" } })).toBe(
      "af-south-1",
    );
  });

  it("reads an injected client's region provider", async () => {
    const client = Object.assign(new FakeMicrovmsClient(), {
      config: { region: async () => "sa-east-1" },
    });
    expect(await resolveRegion({ client })).toBe("sa-east-1");
  });

  it("an injected client's region wins over clientConfig (it executes the calls)", async () => {
    const client = Object.assign(new FakeMicrovmsClient(), {
      config: { region: async () => "sa-east-1" },
    });
    expect(await resolveRegion({ client, clientConfig: { region: "eu-central-1" } })).toBe(
      "sa-east-1",
    );
  });

  it("reads AWS_REGION / AWS_DEFAULT_REGION env", async () => {
    vi.stubEnv("AWS_REGION", "us-west-1");
    expect(await resolveRegion({})).toBe("us-west-1");
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_DEFAULT_REGION", "us-west-2");
    expect(await resolveRegion({})).toBe("us-west-2");
  });

  it("falls back to the default provider chain (e.g. ~/.aws/config)", async () => {
    ambient.region = "eu-west-1";
    expect(await resolveRegion({})).toBe("eu-west-1");
  });

  it("an injected client without a region cannot veto the default chain", async () => {
    ambient.region = "eu-west-1";
    expect(await resolveRegion({ client: new FakeMicrovmsClient() })).toBe("eu-west-1");
  });

  it("throws NoRegion when nothing resolves", async () => {
    ambient.region = undefined;
    await expect(resolveRegion({})).rejects.toMatchObject({ code: "NoRegion" });
  });

  it("rethrows default-chain failures that are not 'Region is missing'", async () => {
    ambient.error = new Error("profile exploded");
    await expect(resolveRegion({})).rejects.toThrow(/profile exploded/);
  });

  it("only exact 'Region is missing' means unresolved, not a substring", async () => {
    ambient.error = new Error("wrapped: Region is missing (inner)");
    await expect(resolveRegion({})).rejects.toThrow(/wrapped:/);
  });
});
