import {
  GetMicrovmCommand,
  GetMicrovmImageVersionCommand,
  type MicrovmImageVersionState,
  type MicrovmState,
} from "@aws-sdk/client-lambda-microvms";
import { StateError, SunabaError, TimeoutError } from "./errors.js";
import type { LambdaMicrovmsClientLike } from "./types.js";
import { isNotFoundError, sleep } from "./util.js";

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Stops the wait with a SunabaError whose code is "Aborted". */
  signal?: AbortSignal;
}

async function poll<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  opts: WaitOptions,
): Promise<T> {
  const timeout = opts.timeoutMs ?? 120_000;
  const interval = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (opts.signal?.aborted) {
      throw new SunabaError("Aborted", "wait aborted", opts.signal.reason);
    }
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new TimeoutError(`timed out after ${timeout}ms waiting for condition`);
    }
    await sleep(Math.min(interval, Math.max(50, deadline - Date.now())), opts.signal);
  }
}

export interface MicrovmInfo {
  microvmId?: string;
  state?: MicrovmState;
  endpoint?: string;
  imageArn?: string;
  imageVersion?: string;
  executionRoleArn?: string;
  maximumDurationInSeconds?: number;
  startedAt?: Date;
  terminatedAt?: Date;
  stateReason?: string;
}

/** GET the current MicroVM record. */
export async function getMicrovm(
  client: LambdaMicrovmsClientLike,
  microvmId: string,
): Promise<MicrovmInfo> {
  return (await client.send(
    new GetMicrovmCommand({ microvmIdentifier: microvmId }),
  )) as MicrovmInfo;
}

const TERMINAL: ReadonlySet<MicrovmState> = new Set(["TERMINATED", "TERMINATING"]);

/** Fresh resources may 404 briefly — tolerate NotFound for this long. */
const NOT_FOUND_GRACE_MS = 10_000;
const withinNotFoundGrace = (started: number) => Date.now() - started < NOT_FOUND_GRACE_MS;

/** Wait until a MicroVM reaches the target state. Throws on TERMINATED. */
export async function waitForMicrovmState(
  client: LambdaMicrovmsClientLike,
  microvmId: string,
  target: MicrovmState,
  opts: WaitOptions = {},
): Promise<MicrovmInfo> {
  // A just-created MicroVM may not be visible to GetMicrovm for a few
  // seconds (eventual consistency) — tolerate NotFound briefly.
  const started = Date.now();
  const get = async (): Promise<MicrovmInfo> => {
    try {
      return await getMicrovm(client, microvmId);
    } catch (e) {
      if (isNotFoundError(e)) {
        // Purged records mean the VM is gone — success when that's the target.
        if (target === "TERMINATED") return { state: "TERMINATED" };
        if (withinNotFoundGrace(started)) return { state: "PENDING" as MicrovmState };
      }
      throw e;
    }
  };
  return poll(
    get,
    (info) => {
      if (info.state === target) return true;
      // Waiting for TERMINATING: TERMINATED is the natural conclusion.
      if (target === "TERMINATING" && info.state === "TERMINATED") return true;
      // Waiting for TERMINATED: TERMINATING always precedes it — keep polling.
      if (target === "TERMINATED" && info.state === "TERMINATING") return false;
      if (TERMINAL.has(info.state as MicrovmState)) {
        throw new StateError(
          target,
          String(info.state),
          `MicroVM ${microvmId} reached ${info.state} while waiting for ${target}: ${info.stateReason ?? "no reason"}`,
        );
      }
      return false;
    },
    { intervalMs: 800, ...opts },
  );
}

export interface ImageVersionInfo {
  imageArn?: string;
  imageVersion?: string;
  state?: MicrovmImageVersionState;
  status?: string;
  stateReason?: string;
}

/** Wait until an image version build finishes. Returns final state info. */
export async function waitForImageVersion(
  client: LambdaMicrovmsClientLike,
  imageIdentifier: string,
  imageVersion: string,
  opts: WaitOptions = {},
): Promise<ImageVersionInfo> {
  // A just-created version may 404 briefly (eventual consistency).
  const started = Date.now();
  const get = async (): Promise<ImageVersionInfo> => {
    try {
      return (await client.send(
        new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }),
      )) as ImageVersionInfo;
    } catch (e) {
      if (isNotFoundError(e) && withinNotFoundGrace(started)) return { state: "PENDING" };
      throw e;
    }
  };
  const info = await poll(
    get,
    (v) =>
      v.state === "SUCCESSFUL" ||
      v.state === "FAILED" ||
      v.state === "DELETING" ||
      v.state === "DELETED" ||
      v.state === "DELETE_FAILED",
    { intervalMs: 3_000, timeoutMs: 900_000, ...opts },
  );
  if (info.state !== "SUCCESSFUL") {
    throw new StateError(
      "SUCCESSFUL",
      String(info.state),
      `image version ${imageVersion} build ended in ${info.state}: ${info.stateReason ?? "no reason"}`,
    );
  }
  return info;
}
