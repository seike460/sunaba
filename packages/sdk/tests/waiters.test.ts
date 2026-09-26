import { describe, expect, it } from "vitest";
import { StateError } from "../src/errors.js";
import { waitForImageVersion, waitForMicrovmState } from "../src/waiters.js";
import { FakeMicrovmsClient } from "./helpers.js";

describe("waitForMicrovmState", () => {
  it("resolves when the target state is reached", async () => {
    let n = 0;
    const client = new FakeMicrovmsClient(() => ({
      microvmId: "mvm-1",
      state: n++ === 0 ? "PENDING" : "RUNNING",
      endpoint: "host.example",
    }));
    const info = await waitForMicrovmState(client, "mvm-1", "RUNNING", {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(info.state).toBe("RUNNING");
    expect(info.endpoint).toBe("host.example");
  });

  it("throws StateError on terminal states", async () => {
    const client = new FakeMicrovmsClient(() => ({
      microvmId: "mvm-1",
      state: "TERMINATED",
      stateReason: "oops",
    }));
    await expect(
      waitForMicrovmState(client, "mvm-1", "RUNNING", { intervalMs: 1 }),
    ).rejects.toBeInstanceOf(StateError);
  });

  it("waits through TERMINATING when the target is TERMINATED", async () => {
    let n = 0;
    const client = new FakeMicrovmsClient(() => ({
      microvmId: "mvm-1",
      state: n++ === 0 ? "TERMINATING" : "TERMINATED",
    }));
    const info = await waitForMicrovmState(client, "mvm-1", "TERMINATED", {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(info.state).toBe("TERMINATED");
  });

  it("accepts TERMINATED when the target is TERMINATING", async () => {
    const client = new FakeMicrovmsClient(() => ({
      microvmId: "mvm-1",
      state: "TERMINATED",
    }));
    const info = await waitForMicrovmState(client, "mvm-1", "TERMINATING", {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(info.state).toBe("TERMINATED");
  });
});

describe("waitForImageVersion", () => {
  it("resolves on SUCCESSFUL", async () => {
    const client = new FakeMicrovmsClient(() => ({
      state: "SUCCESSFUL",
      status: "ACTIVE",
      imageVersion: "1.0",
    }));
    const info = await waitForImageVersion(client, "arn:img", "1.0", { intervalMs: 1 });
    expect(info.state).toBe("SUCCESSFUL");
  });

  it("throws on FAILED", async () => {
    const client = new FakeMicrovmsClient(() => ({
      state: "FAILED",
      stateReason: "build exploded",
    }));
    await expect(waitForImageVersion(client, "arn:img", "1.0", { intervalMs: 1 })).rejects.toThrow(
      /build exploded/,
    );
  });
});
