import type { Server } from "node:http";
import { type ExecRequest, killAllExecs, runExec } from "./exec.js";
import { fsRoutes } from "./fs.js";
import { envHookHandlers, type HooksHandlers, startHooksServer } from "./hooks.js";
import { startJsonServer } from "./http.js";

export * from "./exec.js";
export * from "./fs.js";
export * from "./hooks.js";
export { HttpError, startJsonServer } from "./http.js";

export interface AgentOptions {
  /** Exec/fs API port. Default 8080 (the proxy's default target). */
  port?: number;
  host?: string;
  /**
   * Lifecycle hooks. Pass handlers, or `env` (default) to derive them from
   * `SUNABA_HOOK_*` env vars, or `false` to not start a hooks server.
   */
  hooks?: HooksHandlers | "env" | false;
  /** Hooks server port. Default 9000 (must match image hooks.port). */
  hooksPort?: number;
  hooksHost?: string;
  /** Called on listen errors instead of crashing. */
  onError?: (err: Error) => void;
}

export interface AgentServers {
  api: Server;
  hooks?: Server;
  close(): Promise<void>;
}

/**
 * What {@link startAgent} returns. `ready` lives here, not on
 * {@link AgentServers}, so values built to the 0.1.0 shape still type-check.
 */
export interface AgentServersWithReady extends AgentServers {
  /**
   * Resolves once every server listens. If one fails to listen (e.g.
   * EADDRINUSE), the others are closed first, then it rejects with that
   * error. The error still goes to `onError` too.
   */
  ready: Promise<void>;
}

/**
 * Starts the in-guest agent: exec + filesystem API on `port` (8080) and,
 * unless disabled, a lifecycle hook server on `hooksPort` (9000).
 * The servers listen asynchronously; await `ready` to know they do.
 */
export function startAgent(opts: AgentOptions = {}): AgentServersWithReady {
  // Resolve the hooks first: a bad SUNABA_HOOK_TIMEOUT_MS must throw
  // before any server is listening.
  const handlers =
    opts.hooks === false
      ? undefined
      : opts.hooks === "env" || opts.hooks === undefined
        ? envHookHandlers()
        : opts.hooks;
  const api = startJsonServer({
    port: opts.port ?? 8080,
    host: opts.host,
    onError: opts.onError,
    routes: {
      "GET /healthz": async () => ({ ok: true }),
      "POST /exec": (body) => runExec(body as unknown as ExecRequest),
      ...fsRoutes,
    },
  });

  let hooksServer: Server | undefined;
  if (handlers) {
    try {
      hooksServer = startHooksServer(handlers, {
        port: opts.hooksPort ?? 9000,
        host: opts.hooksHost ?? opts.host,
        onError: opts.onError,
      });
    } catch (e) {
      // e.g. listen() rejecting the hooks port: don't leave the API listening.
      api.close();
      throw e;
    }
  }

  const servers = [api, hooksServer].filter((s): s is Server => s !== undefined);
  const closeServers = () => {
    for (const s of servers) s.closeAllConnections();
    return Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(
      () => undefined,
    );
  };
  // listen() reports a port in use asynchronously, through 'error': the
  // try/catch above only sees what it throws synchronously.
  const ready = Promise.allSettled(servers.map(listenOutcome)).then(async (outcomes) => {
    const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
    if (!failed) return;
    // Don't leave the other server listening; free its port, then reject.
    await closeServers();
    throw failed.reason;
  });
  // onError reports the failure as well; awaiting `ready` is optional.
  ready.catch(() => {});

  return {
    api,
    hooks: hooksServer,
    ready,
    close() {
      // Reap in-flight exec children rather than orphaning them in the VM,
      // and drop live connections so close() doesn't wait on long execs.
      killAllExecs();
      return closeServers();
    },
  };
}

/** Resolves when `server` listens; rejects with its listen error. */
function listenOutcome(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const settle = (err?: Error) => {
      server.off("listening", onListening).off("error", settle).off("close", onClose);
      if (err) reject(err);
      else resolve();
    };
    const onListening = () => settle();
    // close() before the listen completed: 'listening' never comes.
    const onClose = () => settle(new Error("server closed before listening"));
    server.once("listening", onListening).once("error", settle).once("close", onClose);
  });
}
