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
 * Starts the in-guest agent: exec + filesystem API on `port` (8080) and,
 * unless disabled, a lifecycle hook server on `hooksPort` (9000).
 */
export function startAgent(opts: AgentOptions = {}): AgentServers {
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

  return {
    api,
    hooks: hooksServer,
    close() {
      // Reap in-flight exec children rather than orphaning them in the VM,
      // and drop live connections so close() doesn't wait on long execs.
      killAllExecs();
      const closers = [api, hooksServer].filter((s): s is Server => s !== undefined);
      for (const s of closers) s.closeAllConnections();
      return Promise.all(closers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(
        () => undefined,
      );
    },
  };
}
