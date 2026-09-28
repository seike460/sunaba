import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthTokenManager, ShellTokenManager } from "../src/tokens.js";
import { FakeMicrovmsClient } from "./helpers.js";

const ok = { authToken: { "X-aws-proxy-auth": "TOKEN-1" } };

afterEach(() => {
  vi.useRealTimers();
});

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

  it("re-mints once 80% of the TTL has elapsed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const client = new FakeMicrovmsClient(() => ok);
    const tm = new AuthTokenManager(client, "mvm-1", {
      expirationInMinutes: 10,
      allowedPorts: ["all"],
    });
    await tm.get();
    vi.setSystemTime(8 * 60_000 - 1);
    await tm.get();
    expect(client.callsOf("CreateMicrovmAuthTokenCommand")).toHaveLength(1);
    vi.setSystemTime(8 * 60_000);
    await tm.get();
    expect(client.callsOf("CreateMicrovmAuthTokenCommand")).toHaveLength(2);
  });

  it("de-duplicates concurrent get() calls into one mint", async () => {
    const client = new FakeMicrovmsClient(() => ok);
    const tm = new AuthTokenManager(client, "mvm-1", {
      expirationInMinutes: 30,
      allowedPorts: ["all"],
    });
    expect(await Promise.all([tm.get(), tm.get(), tm.get()])).toEqual([
      "TOKEN-1",
      "TOKEN-1",
      "TOKEN-1",
    ]);
    expect(client.callsOf("CreateMicrovmAuthTokenCommand")).toHaveLength(1);
  });

  it.each([0, 61, 1.5])("rejects expirationInMinutes %s with BadTokenTtl", (minutes) => {
    const client = new FakeMicrovmsClient(() => ok);
    expect(
      () =>
        new AuthTokenManager(client, "mvm-1", {
          expirationInMinutes: minutes,
          allowedPorts: ["all"],
        }),
    ).toThrow(expect.objectContaining({ code: "BadTokenTtl" }));
  });

  it.each([0, 70000, 1.5, { from: 9, to: 8 }, { from: 0, to: 80 }])(
    "rejects allowedPorts %o with BadPort before calling the service",
    async (port) => {
      const client = new FakeMicrovmsClient(() => ok);
      const tm = new AuthTokenManager(client, "mvm-1", {
        expirationInMinutes: 30,
        allowedPorts: [port],
      });
      await expect(tm.get()).rejects.toMatchObject({ code: "BadPort" });
      expect(client.calls).toHaveLength(0);
    },
  );

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

  it.each([0, 61])("rejects expirationInMinutes %s with BadTokenTtl", (minutes) => {
    const client = new FakeMicrovmsClient(() => ok);
    expect(() => new ShellTokenManager(client, "mvm-9", minutes)).toThrow(
      expect.objectContaining({ code: "BadTokenTtl" }),
    );
  });
});
