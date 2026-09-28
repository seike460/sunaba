import { SunabaError } from "./errors.js";

/** Default cap for retained shell (PTY) output, which merges stdout and stderr. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Resolve after `ms`, or as soon as `signal` aborts (the caller checks it). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Throw BadResponse when a required response field is absent. */
export function required<T>(v: T | undefined | null, name: string): T {
  if (v === undefined || v === null) throw new SunabaError("BadResponse", `missing ${name}`);
  return v;
}

/** POSIX single-quote escaping for embedding a string in a shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** ResourceNotFoundException, or an error string that reads as not-found. */
export function isNotFoundError(e: unknown): boolean {
  const err = e as { name?: string; code?: string } | null;
  // DNS/lookup failures are infra errors, not "the VM is gone" — a bare
  // "getaddrinfo ENOTFOUND" would otherwise match /not.?found/ below.
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") return false;
  const name = err?.name ?? "";
  if (name === "ResourceNotFoundException" || /not.?found/i.test(name)) return true;
  // Message fallback (test fakes, wrapped errors): must read as a *resource*
  // not-found, not a transport/DNS failure carrying "ENOTFOUND" in the text.
  const msg = String(e);
  if (/\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo/.test(msg)) return false;
  return /not.?found/i.test(msg);
}
