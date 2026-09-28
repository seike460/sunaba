import { afterEach, describe, expect, it, vi } from "vitest";
import { StateError, TimeoutError } from "../src/errors.js";
import { waitForImageVersion, waitForMicrovmState } from "../src/waiters.js";
import { FakeMicrovmsClient } from "./helpers.js";

const notFound = () =>
  Object.assign(new Error("MicroVM not found"), { name: "ResourceNotFoundException" });

afterEach(() => {
  vi.useRealTimers();
});

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

  it("throws TimeoutError when the target state never arrives", async () => {
    const client = new FakeMicrovmsClient(() => ({ microvmId: "mvm-1", state: "PENDING" }));
    await expect(
      waitForMicrovmState(client, "mvm-1", "RUNNING", { intervalMs: 1, timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(client.calls.length).toBeGreaterThan(1);
  });

  it("tolerates NotFound right after creation, then resolves", async () => {
    let n = 0;
    const client = new FakeMicrovmsClient(() => {
      if (n++ === 0) throw notFound();
      return { microvmId: "mvm-1", state: "RUNNING" };
    });
    const info = await waitForMicrovmState(client, "mvm-1", "RUNNING", { intervalMs: 1 });
    expect(info.state).toBe("RUNNING");
    expect(client.calls).toHaveLength(2);
  });

  it("rethrows NotFound once the grace period has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const err = notFound();
    let n = 0;
    const client = new FakeMicrovmsClient(() => {
      // Past the 10s grace from the second poll on.
      if (n++ > 0) vi.setSystemTime(Date.now() + 10_001);
      throw err;
    });
    const waiting = waitForMicrovmState(client, "mvm-1", "RUNNING", { intervalMs: 1 });
    await expect(waiting).rejects.toBe(err);
    expect(client.calls).toHaveLength(2);
  });

  it("treats NotFound as TERMINATED when that is the target (record purged)", async () => {
    const client = new FakeMicrovmsClient(() => {
      throw notFound();
    });
    const info = await waitForMicrovmState(client, "mvm-1", "TERMINATED", { intervalMs: 1 });
    expect(info.state).toBe("TERMINATED");
  });

  it("stops with an Aborted error, not a TimeoutError, when already aborted", async () => {
    const client = new FakeMicrovmsClient(() => ({ microvmId: "mvm-1", state: "PENDING" }));
    const ac = new AbortController();
    const reason = new Error("caller gave up");
    ac.abort(reason);
    const err = await waitForMicrovmState(client, "mvm-1", "RUNNING", {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ code: "Aborted", cause: reason });
    expect(client.calls).toHaveLength(0);
  });

  it("aborts during the sleep between polls instead of waiting it out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = new FakeMicrovmsClient(() => ({ microvmId: "mvm-1", state: "PENDING" }));
    const ac = new AbortController();
    const waiting = waitForMicrovmState(client, "mvm-1", "RUNNING", {
      intervalMs: 60_000,
      signal: ac.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // the first poll is done; now sleeping
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ code: "Aborted" });
    expect(client.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
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

  it("tolerates NotFound for a just-created version", async () => {
    let n = 0;
    const client = new FakeMicrovmsClient(() => {
      if (n++ === 0) throw notFound();
      return { state: "SUCCESSFUL", status: "ACTIVE", imageVersion: "1.0" };
    });
    const info = await waitForImageVersion(client, "arn:img", "1.0", { intervalMs: 1 });
    expect(info.state).toBe("SUCCESSFUL");
    expect(client.calls).toHaveLength(2);
  });

  it("throws TimeoutError when the build never finishes", async () => {
    const client = new FakeMicrovmsClient(() => ({ state: "IN_PROGRESS" }));
    await expect(
      waitForImageVersion(client, "arn:img", "1.0", { intervalMs: 1, timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(TimeoutError);
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
