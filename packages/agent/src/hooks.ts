import type { Server } from "node:http";
import { MAX_TIMEOUT_MS, runExec } from "./exec.js";
import { HttpError, startJsonServer } from "./http.js";

// The hook contract (prefix, names, handler types) mirrors
// sunaba-sdk/src/guest/hooks.ts — duplicated deliberately so the in-guest
// agent stays dependency-free. Keep the two copies in sync.
export const HOOK_PATH_PREFIX = "/aws/lambda-microvms/runtime/v1";

export const HookName = {
  READY: "ready",
  RUN: "run",
  RESUME: "resume",
  SUSPEND: "suspend",
  TERMINATE: "terminate",
  VALIDATE: "validate",
} as const;

export type HookNameValue = (typeof HookName)[keyof typeof HookName];

export type HookHandler = (body: unknown) => void | Promise<void>;

export interface HooksHandlers {
  ready?: HookHandler;
  run?: HookHandler;
  resume?: HookHandler;
  suspend?: HookHandler;
  terminate?: HookHandler;
  validate?: HookHandler;
}

/**
 * Derives hook handlers from environment variables:
 * `SUNABA_HOOK_<NAME>` holds a shell command run via `/bin/sh -c`; the hook
 * body is passed to the command on stdin (JSON). A non-zero exit makes the
 * hook request fail with 503 so Lambda sees the failure.
 * `SUNABA_HOOK_TIMEOUT_MS` bounds each command (default 300_000; Lambda
 * enforces its own per-hook deadline regardless).
 */
export function envHookHandlers(env: NodeJS.ProcessEnv = process.env): HooksHandlers {
  const handlers: HooksHandlers = {};
  const parsed = Number(env.SUNABA_HOOK_TIMEOUT_MS ?? 300_000);
  const timeout =
    Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_TIMEOUT_MS) : 300_000;
  for (const name of Object.values(HookName)) {
    const cmd = env[`SUNABA_HOOK_${name.toUpperCase()}`];
    if (!cmd) continue;
    handlers[name] = async (body) => {
      // Reuse the exec machinery: the drain grace keeps a backgrounded
      // process (e.g. a daemon started by the ready hook) from hanging the
      // lifecycle request, and that process keeps running after the command
      // exits. Only a timeout kills the command's whole process group.
      const r = await runExec({
        command: cmd,
        stdin: Buffer.from(JSON.stringify(body ?? {})).toString("base64"),
        timeoutMs: timeout,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      if (r.timedOut || r.exitCode !== 0) {
        // Bound the 503 payload: stderr can be up to maxOutputBytes.
        const stderr = Buffer.from(r.stderr, "base64").toString("utf8").slice(-8192);
        throw new Error(
          `hook command exited ${r.exitCode ?? r.signal ?? "unknown"}${stderr ? `: ${stderr}` : ""}`,
        );
      }
    };
  }
  return handlers;
}

export interface HooksServerOptions {
  port: number;
  host?: string;
  maxBodyBytes?: number;
  onError?: (err: Error) => void;
}

/**
 * Lifecycle hook server: Lambda POSTs `/aws/lambda-microvms/runtime/v1/{name}`.
 * ANY hook name under the prefix is acked with 200 when unhandled (hooks are
 * opt-in; an unhandled hook must not fail the lifecycle event). Handler
 * failures get 503.
 */
export function startHooksServer(handlers: HooksHandlers, opts: HooksServerOptions): Server {
  return startJsonServer({
    routes: {
      [`POST ${HOOK_PATH_PREFIX}/*`]: async (body, _req, _res, wildcard) => {
        const name = wildcard ?? "";
        // hasOwn: "__proto__" et al. must not resolve prototype members.
        const handler =
          Object.hasOwn(handlers, name) && typeof handlers[name as HookNameValue] === "function"
            ? handlers[name as HookNameValue]
            : undefined;
        if (!handler) return {};
        try {
          await handler(body);
          return {};
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new HttpError(503, `hook ${name} failed: ${msg}`);
        }
      },
    },
    port: opts.port,
    host: opts.host,
    // Hook bodies are small lifecycle events — 1 MiB like the SDK guest
    // contract, not http.ts's 32 MiB fs-payload default.
    maxBodyBytes: opts.maxBodyBytes ?? 1_048_576,
    onError: opts.onError,
  });
}
