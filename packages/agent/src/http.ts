import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly code: string;
  constructor(
    readonly status: number,
    message: string,
    code?: string,
  ) {
    super(message);
    this.code = code ?? HTTP_ERROR_CODES[status] ?? "Error";
  }
}

const HTTP_ERROR_CODES: Record<number, string> = {
  400: "BadRequest",
  403: "Forbidden",
  404: "NotFound",
  408: "RequestTimeout",
  409: "Conflict",
  413: "BodyTooLarge",
  500: "InternalError",
  503: "ServiceUnavailable",
};

export class BodyTooLarge extends Error {}

const BODY_LIMIT = 32 * 1024 * 1024; // fs payloads can be large files

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
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
  if (exceeded) throw new BodyTooLarge("request body exceeds limit");
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(payload);
}

const ERRNO_STATUS: Record<string, number> = {
  ENOENT: 404,
  ENOTDIR: 400,
  EISDIR: 400,
  ERR_FS_EISDIR: 400,
  ERR_FS_CP_EINVAL: 400,
  ERR_INVALID_ARG_VALUE: 400,
  ENAMETOOLONG: 400,
  ELOOP: 400,
  ENXIO: 400,
  EXDEV: 400,
  EEXIST: 409,
  ENOTEMPTY: 400,
  EACCES: 403,
  EPERM: 403,
};

export function sendError(res: ServerResponse, err: unknown): void {
  // The socket may already be dead (client abort, request timeout) — writing
  // would throw inside the catch path and crash the process.
  if (res.destroyed || res.writableEnded) return;
  try {
    if (err instanceof BodyTooLarge) {
      sendJson(res, 413, { error: { code: "BodyTooLarge", message: err.message } });
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      return;
    }
    const e = err as NodeJS.ErrnoException;
    sendJson(res, ERRNO_STATUS[e?.code ?? ""] ?? 500, {
      error: { code: e?.code ?? "InternalError", message: e?.message ?? String(err) },
    });
  } catch {
    // best-effort error reporting only
  }
}

export type RouteHandler = (
  body: Record<string, unknown>,
  req: IncomingMessage,
  res: ServerResponse,
  /** Wildcard segment when the route key ends in "/*", else undefined. */
  wildcard?: string,
) => Promise<unknown>;

export interface JsonServerOptions {
  /** Route table: "METHOD /path" → handler. */
  routes: Record<string, RouteHandler>;
  port: number;
  host?: string;
  maxBodyBytes?: number;
  onError?: (err: Error) => void;
}

/**
 * Minimal JSON-over-POST HTTP server for the in-guest agent. All handlers
 * receive the parsed JSON body and may return a JSON-serializable value
 * (or write the response themselves and return undefined).
 * Route keys are "METHOD /path"; a key ending in "/*" matches any path
 * under that prefix and passes the remainder to the handler.
 */
export function startJsonServer(opts: JsonServerOptions): Server {
  const server = createServer(async (req, res) => {
    // A client aborting mid-flush (or closeAllConnections) emits 'error' on
    // the response after our write returns — an unhandled 'error' would be
    // an uncaughtException and kill the daemon.
    res.on("error", () => {});
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendError(res, new HttpError(400, "malformed request target"));
      return;
    }
    const key = `${req.method} ${url.pathname}`;
    let handler = opts.routes[key];
    let wildcard: string | undefined;
    if (!handler) {
      for (const [k, h] of Object.entries(opts.routes)) {
        const method = req.method ?? "";
        if (!k.endsWith("/*") || !k.startsWith(`${method} `)) continue;
        const prefix = k.slice(method.length + 1, -1); // "…/" incl. slash
        if (url.pathname.startsWith(prefix)) {
          handler = h;
          wildcard = url.pathname.slice(prefix.length);
          break;
        }
      }
    }
    if (!handler) {
      sendError(res, new HttpError(404, `no route ${req.method} ${url.pathname}`));
      return;
    }
    let body: Record<string, unknown>;
    try {
      // requestTimeout is disabled for long execs, so bound body reception
      // separately — a stalled client must not pin a handler forever.
      let bodyTimer: NodeJS.Timeout | undefined;
      try {
        body = (await Promise.race([
          readJsonBody(req, opts.maxBodyBytes ?? BODY_LIMIT),
          new Promise<never>((_, reject) => {
            bodyTimer = setTimeout(() => {
              req.destroy();
              reject(new HttpError(408, "request body timed out"));
            }, 60_000);
            bodyTimer.unref();
          }),
        ])) as Record<string, unknown>;
      } finally {
        if (bodyTimer) clearTimeout(bodyTimer);
      }
      const out = await handler(body ?? {}, req, res, wildcard);
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
    } catch (err) {
      sendError(res, err);
    }
  });
  server.on("error", (e) => {
    if (opts.onError) opts.onError(e);
    else console.error("[sunaba-agent]", e);
  });
  // The API is long-polling by nature (exec can run up to an hour); Node's
  // default 300s requestTimeout would tear down live requests.
  server.requestTimeout = 0;
  server.listen(opts.port, opts.host ?? "0.0.0.0");
  return server;
}
