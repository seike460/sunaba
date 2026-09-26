import { describe, expect, it } from "vitest";
import { AuthTokenManager, ShellTokenManager } from "../src/tokens.js";
import { FakeMicrovmsClient } from "./helpers.js";

const ok = { authToken: { "X-aws-proxy-auth": "TOKEN-1" } };

describe("AuthTokenManager", () => {
  it("mints once and caches within TTL", async () => {
    const client = new FakeMicrovmsClient(() => ok);
    const tm = new AuthTokenManager(client, "mvm-1", {
      expirationInMinutes: 30,
      allowedPorts: ["all"],
    });
    expect(await tm.get()).toBe("TOKEN-1");
    expect(await tm.get()).toBe("TOKEN-1");
    expect(client.callsOf("CreateMicrovmAuthTokenCommand")).toHaveLength(1);
  });

  it("sends allowedPorts as PortSpecification union members", async () => {
    const client = new FakeMicrovmsClient(() => ok);
    const tm = new AuthTokenManager(client, "mvm-1", {
      expirationInMinutes: 30,
      allowedPorts: [8080, "all", { from: 8000, to: 9000 }],
    });
    await tm.get();
    const cmd = client.callsOf("CreateMicrovmAuthTokenCommand")[0];
    expect(cmd.input.microvmIdentifier).toBe("mvm-1");
    expect(cmd.input.expirationInMinutes).toBe(30);
    expect(cmd.input.allowedPorts).toEqual([
      { port: 8080 },
      { allPorts: {} },
      { range: { startPort: 8000, endPort: 9000 } },
    ]);
  });

  it("re-mints after invalidate", async () => {
    const client = new FakeMicrovmsClient(() => ok);
    const tm = new AuthTokenManager(client, "mvm-1", {
      expirationInMinutes: 30,
      allowedPorts: ["all"],
    });
    await tm.get();
    tm.invalidate();
    await tm.get();
    expect(client.callsOf("CreateMicrovmAuthTokenCommand")).toHaveLength(2);
  });

  it("throws when the response lacks the token", async () => {
    const client = new FakeMicrovmsClient(() => ({ authToken: {} }));
    const tm = new AuthTokenManager(client, "mvm-1", {
      expirationInMinutes: 30,
      allowedPorts: ["all"],
    });
    await expect(tm.get()).rejects.toThrow(/X-aws-proxy-auth/);
  });
});

describe("ShellTokenManager", () => {
  it("mints a shell token via CreateMicrovmShellAuthToken", async () => {
    const client = new FakeMicrovmsClient(() => ok);
    const tm = new ShellTokenManager(client, "mvm-9", 15);
    expect(await tm.get()).toBe("TOKEN-1");
    const cmd = client.callsOf("CreateMicrovmShellAuthTokenCommand")[0];
    expect(cmd.input.microvmIdentifier).toBe("mvm-9");
    expect(cmd.input.expirationInMinutes).toBe(15);
  });
});
