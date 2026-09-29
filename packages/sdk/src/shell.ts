import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";
import { SunabaError, TimeoutError } from "./errors.js";
import type { ExecOptions, ExecResult } from "./types.js";
import { DEFAULT_MAX_OUTPUT_BYTES, shellQuote, sleep } from "./util.js";

/** The managed shell listens inside the MicroVM on this port. */
export const SHELL_PORT = 8022;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const doneRe = (nonce: string) => new RegExp(`__SUNABA_DONE_${nonce}_(-?\\d+)__`);

/**
 * Bytes kept beyond `maxOutputBytes` so the done marker (~40 bytes) is never
 * cut off, even when the cap is smaller than the marker itself.
 */
const MARKER_RESERVE = 128;

/** The last `n` UTF-8 bytes of `s`, cut on a character boundary. */
function tailBytes(s: string, n: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= n) return s;
  let start = Math.max(0, buf.length - n);
  // Skip UTF-8 continuation bytes so no character is split.
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return buf.toString("utf8", start);
}

// ANSI/VT escape sequences a PTY may emit: CSI, OSC, and single-ESC sequences.
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-9;?]*[a-zA-Z]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-_]`,
  "g",
);

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * WebSocket subprotocols required by the Lambda MicroVMs endpoint.
 * The endpoint authenticates via a token subprotocol and routes to a
 * target port via `lambda-microvms.port.N`.
 */
export function microvmSubprotocols(token: string, port: number): string[] {
  return [
    "lambda-microvms",
    `lambda-microvms.authentication.${token}`,
    `lambda-microvms.port.${port}`,
  ];
}

export interface ShellSocketOptions {
  endpoint: string;
  token: string;
  /** Connect timeout. Default 15s. */
  connectTimeoutMs?: number;
  /**
   * Override the full WebSocket URL (for tests / non-TLS endpoints).
   * Default `wss://{endpoint}/shell`.
   */
  url?: string;
}

/**
 * Open the managed PTY shell of a MicroVM (requires SHELL_INGRESS).
 * Returns the raw WebSocket; data is a bidirectional byte stream to the shell.
 */
export async function openShellSocket(opts: ShellSocketOptions): Promise<WebSocket> {
  const url = opts.url ?? `wss://${opts.endpoint}/shell`;
  const ws = new WebSocket(url, microvmSubprotocols(opts.token, SHELL_PORT));
  const timeout = opts.connectTimeoutMs ?? 15_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new TimeoutError(`timed out connecting to shell on ${opts.endpoint}`));
    }, timeout);
    const onError = (err: unknown) => {
      clearTimeout(timer);
      reject(
        new SunabaError(
          "ShellConnectFailed",
          `shell WebSocket failed for ${opts.endpoint}: ${String(err)}`,
          err,
        ),
      );
    };
    ws.once("error", onError);
    ws.once("unexpected-response", (req, res) => {
      req.destroy();
      res.destroy();
      onError(new Error(`unexpected HTTP ${res.statusCode}`));
    });
    ws.once("open", () => {
      clearTimeout(timer);
      ws.removeListener("error", onError);
      resolve();
    });
  });
  return ws;
}

export interface ShellExecOptions extends ShellSocketOptions, ExecOptions {
  /** The command line to run inside the MicroVM. */
  command: string;
}

const INIT_COMMAND = "stty -echo 2>/dev/null; export PS1=''; export PS2=''\n";

/** PTY input is chunked so long lines survive canonical-mode buffers. */
const INPUT_CHUNK = 2048;

async function sendChunked(ws: WebSocket, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += INPUT_CHUNK) {
    ws.send(text.slice(i, i + INPUT_CHUNK));
    // Pace writes: the remote canonical input queue is ~4 KB and drops
    // bytes if the shell reads slower than we send.
    if (i + INPUT_CHUNK < text.length) await sleep(5);
  }
}

/**
 * Run a command inside the MicroVM over the managed PTY shell and collect
 * its output and exit code.
 *
 * The command is base64-encoded to survive shell quoting. Output is the
 * combined stdout+stderr stream (the PTY merges them).
 */
export async function execOverShell(opts: ShellExecOptions): Promise<ExecResult> {
  const timeout = opts.timeoutMs ?? 120_000;
  let ws: WebSocket;
  try {
    ws = await openShellSocket(opts);
  } catch (e) {
    // A connect timeout is still "connection never established" — callers
    // may safely retry it like any other ShellConnectFailed.
    if (e instanceof TimeoutError) {
      throw new SunabaError("ShellConnectFailed", e.message, e);
    }
    throw e;
  }
  const nonce = Math.random().toString(36).slice(2, 10);
  try {
    const encoded = Buffer.from(commandScript(opts), "utf8").toString("base64");
    // The payload is typed into a canonical-mode PTY whose line buffer is
    // ~4 KB. Break the base64 into short lines inside the quoted string —
    // `base64 -d` ignores the newlines, so the decoded script is identical.
    const wrapped = encoded.match(/.{1,76}/g)?.join("\n") ?? encoded;
    const marker = `printf '__SUNABA_DONE_${nonce}_%d__\\n' $?`;
    const payload = `eval "$(printf %s '${wrapped}' | base64 -d)"; ${marker}\n`;

    let text = "";
    let textBytes = 0;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const done = doneRe(nonce);
    // One decoder for the whole stream: a multi-byte character split across
    // two binary frames would otherwise decode to U+FFFD twice.
    const decoder = new StringDecoder("utf8");
    ws.on("message", (d: Buffer) => {
      // Once the marker is in, the buffer is final: later frames (a
      // background job still writing to the PTY) must not push it out.
      if (done.test(text)) return;
      const chunk = decoder.write(d);
      text += chunk;
      textBytes += Buffer.byteLength(chunk);
      // Keep the tail: the done marker always arrives at the end, and an
      // unbounded buffer turns output-heavy commands into O(n^2) scans.
      if (textBytes > maxOutputBytes + MARKER_RESERVE && !done.test(text)) {
        text = tailBytes(text, maxOutputBytes + MARKER_RESERVE);
        textBytes = Buffer.byteLength(text);
      }
    });

    // Attach completion listeners before sending anything so a socket that
    // dies mid-setup still rejects instead of hanging.
    const donePromise = waitForDone(ws, () => text, nonce, maxOutputBytes);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_r, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`exec timed out after ${timeout}ms`)),
        timeout,
      );
    });
    const resultPromise = Promise.race([donePromise, timeoutPromise]);
    // Pre-mark as handled: a socket dying during the setup window below must
    // not surface as an unhandled rejection before we `await` the race.
    resultPromise.catch(() => {});

    try {
      ws.send(INIT_COMMAND);
      // Let `stty -echo` land before the payload so it isn't echoed back.
      await sleep(50);
      await sendChunked(ws, payload);
      return await resultPromise;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    ws.close();
  }
}

function commandScript(opts: ShellExecOptions): string {
  const cwd = opts.cwd ? `cd ${shellQuote(opts.cwd)} && ` : "";
  return cwd + opts.command;
}

/**
 * Reads WebSocket data until the done marker appears.
 * Everything before the marker (minus echoed input and ANSI noise) is output.
 */
function waitForDone(
  ws: WebSocket,
  getText: () => string,
  nonce: string,
  maxOutputBytes: number,
): Promise<ExecResult> {
  const re = doneRe(nonce);
  return new Promise<ExecResult>((resolve, reject) => {
    const check = () => {
      const text = getText();
      const m = re.exec(text);
      if (!m) return false;
      const raw = tailBytes(text.slice(0, m.index), maxOutputBytes);
      resolve({
        output: cleanOutput(raw, nonce),
        exitCode: Number(m[1]),
      });
      return true;
    };
    const onData = () => {
      check();
    };
    const onErr = (e: unknown) => reject(new SunabaError("ShellExecFailed", String(e), e));
    ws.on("message", onData);
    ws.on("error", onErr);
    ws.once("close", () => {
      if (!check()) reject(new SunabaError("ShellClosed", "shell closed before command finished"));
    });
  });
}

/** Drop echoed input lines, CR noise and terminal escapes from captured output. */
function cleanOutput(raw: string, nonce: string): string {
  const normalized = stripAnsi(raw.replace(/\r\n/g, "\n").replace(/\r/g, ""));
  const out: string[] = [];
  // While inside the echoed payload, wrapped base64 continuation chunks are
  // bare lines (INIT sets PS2='') — only a "> " prefix survives if a prompt
  // leaked. Track the block so bare chunks are dropped too.
  let inPayload = false;
  for (const line of normalized.split("\n")) {
    // Echoed commands we sent (prompt is disabled, but stty may be unsupported).
    // A leftover prompt may precede the echo on the same line, so match anywhere.
    if (inPayload && line.includes("| base64 -d")) {
      inPayload = false;
      continue;
    }
    if (line.includes(`__SUNABA_DONE_${nonce}`)) continue;
    if (line.includes('eval "$(printf %s ')) {
      inPayload = true;
      continue;
    }
    if (line.includes("stty -echo")) continue;
    if (inPayload && /^>? ?[A-Za-z0-9+/=]{20,}$/.test(line)) continue;
    // PS2 continuation prompts echoed for wrapped payload lines — they look
    // like "> <base64-chunk>". A genuine "> text" line survives the filter.
    if (/^> ?[A-Za-z0-9+/=]{20,}$/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

/** Attach the raw shell to local stdio (interactive use). */
export async function pipeInteractive(ws: WebSocket): Promise<void> {
  const { stdin, stdout } = process;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const onData = (d: Buffer) => {
    try {
      ws.send(d);
    } catch {
      // Socket raced closed between 'close' and listener removal — drop.
    }
  };
  const onMsg = (d: Buffer) => stdout.write(d);
  // Without an 'error' listener a post-open socket error crashes the process.
  const onErr = () => ws.close();
  stdin.on("data", onData);
  ws.on("message", onMsg);
  ws.on("error", onErr);
  try {
    // The socket may have closed between open and listener attach.
    if (ws.readyState === WebSocket.CLOSED) return;
    await once(ws, "close").catch(() => {});
  } finally {
    stdin.off("data", onData);
    ws.off("error", onErr);
    // Always restore the terminal, even on abnormal teardown.
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  }
}
