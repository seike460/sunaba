import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { checkNumber } from "../util.js";

/**
 * Lifecycle hook contract for Lambda MicroVMs.
 *
 * Lambda POSTs to `/aws/lambda-microvms/runtime/v1/{hook}` on the hooks port
 * configured on the image. Implementing hooks lets your app initialize
 * per-MicroVM state, drain work before suspend, refresh on resume, etc.
 */
// Mirrored in sunaba-agent/src/hooks.ts (dependency-free copy) — keep in sync.
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

/** JSON body delivered to the /run hook. */
export interface RunHookBody {
  microvmId?: string;
  runHookPayload?: string;
}

export type HookHandler = (body: unknown) => void | Promise<void>;

export interface HooksHandlers {
  /** Build time: report readiness (return 200 when initialized). */
  ready?: HookHandler;
  /** After run-from-snapshot: init per-VM state; body is RunHookBody. */
  run?: HookHandler;
  /** SUSPENDED -> RUNNING: refresh credentials, reconnect. */
  resume?: HookHandler;
  /** Before suspend: flush writes, close connections. */
  suspend?: HookHandler;
  /** Before terminate: persist state, deregister. */
  terminate?: HookHandler;
  /** After build, on the validation run: smoke-test the snapshot. */
  validate?: HookHandler;
}

export interface HooksServerOptions {
  /** Port the hook server listens on (must match image hooks.port). Default 9000. */
  port?: number;
  host?: string;
  /** Called on listen errors (e.g. EADDRINUSE) instead of crashing. */
  onError?: (err: Error) => void;
  /**
   * Max accepted body size in bytes, a non-negative integer (else a
   * SunabaError "BadMaxBodyBytes"). Default 1 MiB.
   */
  maxBodyBytes?: number;
}

/**
 * Starts a node:http server that implements the MicroVM lifecycle hooks.
 * Returns the Server (caller may also keep a reference for shutdown).
 * A handler that throws gets 503 (the error goes to console.error); a
 * body that isn't valid JSON gets 400 without invoking the handler.
 */
export function startHooksServer(handlers: HooksHandlers, opts: HooksServerOptions = {}): Server {
  const maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  // NaN or Infinity never trips `size > maxBytes`: bodies would buffer
  // without limit.
  checkNumber(maxBodyBytes, "maxBodyBytes", "BadMaxBodyBytes", { min: 0, integer: true });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // A malformed Host header makes `new URL` throw — answer 400, never crash.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const prefix = `${HOOK_PATH_PREFIX}/`;
    if (req.method !== "POST" || !url.pathname.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const name = url.pathname.slice(prefix.length) as HookNameValue;
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!handler) {
      // Hooks are opt-in: acknowledge unknown/unhandled hooks with 200.
      res.writeHead(200).end();
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req, maxBodyBytes);
    } catch (e) {
      const status = e instanceof BodyTooLarge ? 413 : e instanceof InvalidJson ? 400 : 503;
      res.writeHead(status).end();
      return;
    }
    try {
      await handler(body);
    } catch (e) {
      res.writeHead(503).end();
      console.error("[sunaba-hooks]", `hook ${name} failed:`, e);
      return;
    }
    res.writeHead(200).end();
  });
  server.on("error", (e) => {
    if (opts.onError) opts.onError(e);
    else console.error("[sunaba-hooks]", e);
  });
  server.listen(opts.port ?? 9000, opts.host ?? "0.0.0.0");
  return server;
}

class BodyTooLarge extends Error {}
class InvalidJson extends Error {}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  // Consume to natural end-of-stream so the socket survives for the 413
  // response — an early `for await` exit would destroy it.
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) exceeded = true;
    else if (!exceeded) chunks.push(c as Buffer);
  }
  if (exceeded) throw new BodyTooLarge("hook body exceeds limit");
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJson("hook body is not valid JSON");
  }
}
