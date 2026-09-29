import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { TimeoutError } from "../src/errors.js";
import { execOverShell, microvmSubprotocols, openShellSocket, tailBytes } from "../src/shell.js";

/** Fake PTY end: extracts the nonce from the marker in the payload and answers. */
function fakeShellServer(script: (nonce: string) => string) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    ws.on("message", (data: Buffer) => {
      const text = data.toString();
      const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(text);
      if (m) ws.send(script(m[1] ?? ""));
    });
  });
  return wss;
}

function port(wss: WebSocketServer): number {
  return (wss.address() as AddressInfo).port;
}

describe("microvmSubprotocols", () => {
  it("emits the documented subprotocol trio", () => {
    expect(microvmSubprotocols("TOK", 9000)).toEqual([
      "lambda-microvms",
      "lambda-microvms.authentication.TOK",
      "lambda-microvms.port.9000",
    ]);
  });
});

describe("tailBytes", () => {
  it("encodes only the tail, never the whole input", () => {
    const spy = vi.spyOn(Buffer, "from");
    try {
      expect(tailBytes(`${"x".repeat(1_000_000)}abc`, 3)).toBe("abc");
      const encoded = spy.mock.calls.map((c) => (typeof c[0] === "string" ? c[0].length : 0));
      expect(Math.max(0, ...encoded)).toBeLessThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps whole characters and never starts with half a surrogate pair", () => {
    expect(tailBytes("a😀b", 5)).toBe("😀b");
    expect(tailBytes("a😀b", 4)).toBe("b");
    expect(tailBytes("xx😀", 3)).toBe("");
    expect(tailBytes("x😀", 1)).toBe("");
    expect(tailBytes("abc", 0)).toBe("");
  });
});

describe("execOverShell", () => {
  let wss: WebSocketServer | undefined;
  afterEach(() => wss?.close());

  it("returns command output and exit code", async () => {
    wss = fakeShellServer((n) => `hello-output\nline two\n__SUNABA_DONE_${n}_0__\n`);
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "echo hi",
      timeoutMs: 5_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("hello-output");
    expect(res.output).toContain("line two");
    expect(res.output).not.toContain("__SUNABA_DONE_");
  });

  it("propagates a non-zero exit code", async () => {
    wss = fakeShellServer((n) => `boom\n__SUNABA_DONE_${n}_42__\n`);
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "exit 42",
      timeoutMs: 5_000,
    });
    expect(res.exitCode).toBe(42);
    expect(res.output).toContain("boom");
  });

  it("strips echoed input, CR noise and ANSI escapes", async () => {
    const E = String.fromCharCode(0x1b);
    wss = fakeShellServer(
      (n) =>
        `${E}[32msh#${E}[0m eval "$(printf %s 'abcdef'\r\nreal-output\r\n__SUNABA_DONE_${n}_0__\r\n`,
    );
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
      timeoutMs: 5_000,
    });
    expect(res.output).toBe("real-output");
  });

  it("keeps every typed input line short (canonical-mode safe)", async () => {
    const sent: string[] = [];
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        sent.push(data.toString());
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(sent.join(""));
        if (m) ws.send(`__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const p = port(wss);
    await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      // ~6 KB of command → base64 payload far above the ~4 KB line limit.
      command: `echo ${"x".repeat(6_000)}`,
      timeoutMs: 5_000,
    });
    const lines = sent.join("").split("\n").filter(Boolean);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(2_048);
      if (line.includes("printf %s")) {
        // First wrapped line: prefix + one 76-char b64 chunk.
        expect(line.length).toBeLessThan(140);
      }
    }
  });

  it("drops echoed PS2 continuation prompts from output", async () => {
    const b64chunk = "A".repeat(72); // realistic wrapped base64 echo
    wss = fakeShellServer(
      (n) => `> eval "$(printf %s 'abc'\n> ${b64chunk}\nreal\n__SUNABA_DONE_${n}_0__\n`,
    );
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
      timeoutMs: 5_000,
    });
    expect(res.output).toBe("real");
  });

  it("drops bare base64 continuation lines of an echoed payload (PS2='')", async () => {
    const b64chunk = "A".repeat(72);
    wss = fakeShellServer(
      (n) =>
        `eval "$(printf %s 'abc'\n${b64chunk}\n${b64chunk}' | base64 -d)"; printf '__SUNABA_DONE_${n}_%d__\\n' $?\n` +
        `real\n${b64chunk}\n__SUNABA_DONE_${n}_0__\n`,
    );
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
      timeoutMs: 5_000,
    });
    // Payload chunks are stripped; a genuine bare-base64 output line after
    // the echo's closing fragment is kept.
    expect(res.output).toBe(`real\n${b64chunk}`);
  });

  it("rejects with ShellClosed when the socket dies mid-command", async () => {
    wss = fakeShellServer(() => {
      // Server closes without answering.
      return "";
    });
    wss.on("connection", (ws) => {
      ws.on("message", () => ws.close());
    });
    const p = port(wss);
    await expect(
      execOverShell({
        endpoint: `127.0.0.1:${p}`,
        url: `ws://127.0.0.1:${p}`,
        token: "tok",
        command: "sleep 60",
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "ShellClosed" });
  });

  it("rejects with TimeoutError when the command never finishes", async () => {
    wss = new WebSocketServer({ port: 0 }); // accepts input, never answers
    const p = port(wss);
    const err = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "sleep 60",
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ code: "Timeout" });
  });

  it("prefixes the command with a quoted cd when cwd is set", async () => {
    let script = "";
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      let buf = "";
      ws.on("message", (data: Buffer) => {
        buf += data.toString();
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(buf);
        if (!m) return;
        const b64 = /printf %s '([A-Za-z0-9+/=\n]+)' \| base64 -d/.exec(buf)?.[1] ?? "";
        script = Buffer.from(b64.replace(/\s/g, ""), "base64").toString();
        ws.send(`__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const p = port(wss);
    await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "ls",
      cwd: "/srv/it's here",
      timeoutMs: 5_000,
    });
    expect(script).toBe("cd '/srv/it'\\''s here' && ls");
  });

  it("caps retained output in UTF-8 bytes and keeps the tail", async () => {
    const head = "x".repeat(200);
    const tail = "あ".repeat(100); // 300 bytes, 100 UTF-16 code units
    wss = fakeShellServer((n) => `${head}\n${tail}\n__SUNABA_DONE_${n}_0__\n`);
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
      timeoutMs: 5_000,
      maxOutputBytes: 120,
    });
    expect(res.exitCode).toBe(0);
    expect(res.output).toMatch(/^あ+$/);
    expect(Buffer.byteLength(res.output)).toBeLessThanOrEqual(120);
  });

  it("rejects a maxOutputBytes or timeoutMs that would disable the cap or the timer", async () => {
    let connections = 0;
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", () => connections++);
    const p = port(wss);
    const base = {
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
    };
    for (const maxOutputBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      await expect(execOverShell({ ...base, maxOutputBytes })).rejects.toMatchObject({
        code: "BadMaxOutputBytes",
      });
    }
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, 0.5, -5, 2 ** 31]) {
      await expect(execOverShell({ ...base, timeoutMs })).rejects.toMatchObject({
        code: "BadTimeout",
      });
    }
    expect(connections).toBe(0); // rejected before connecting
  });

  it("rejects a connectTimeoutMs that would fire at once, before connecting", async () => {
    let connections = 0;
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", () => connections++);
    const p = port(wss);
    const base = { endpoint: `127.0.0.1:${p}`, url: `ws://127.0.0.1:${p}`, token: "tok" };
    for (const connectTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, 0.5, -5, 2 ** 31]) {
      await expect(openShellSocket({ ...base, connectTimeoutMs })).rejects.toMatchObject({
        code: "BadTimeout",
      });
      await expect(
        execOverShell({ ...base, command: "true", connectTimeoutMs }),
      ).rejects.toMatchObject({ code: "BadTimeout" });
    }
    expect(connections).toBe(0);
  });

  it("finishes when maxOutputBytes is smaller than the done marker", async () => {
    wss = fakeShellServer((n) => `hello world\n__SUNABA_DONE_${n}_3__\n`);
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
      timeoutMs: 2_000,
      maxOutputBytes: 4,
    });
    expect(res.exitCode).toBe(3);
    expect(Buffer.byteLength(res.output)).toBeLessThanOrEqual(4);
    expect("hello world".endsWith(res.output)).toBe(true);
  });

  it("caps a single frame far larger than maxOutputBytes, keeping whole characters", async () => {
    const big = `${"x".repeat(2_000_000)}${"😀".repeat(10)}`;
    wss = fakeShellServer((n) => `${big}\n__SUNABA_DONE_${n}_0__\n`);
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
      timeoutMs: 5_000,
      maxOutputBytes: 11, // 2 whole emoji (8 bytes) + "\n"; a third would be split
    });
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe("😀😀");
  });

  it("keeps the done marker when more output follows it in the same frame", async () => {
    // A background job may keep writing after the command finished.
    wss = fakeShellServer((n) => `out\n__SUNABA_DONE_${n}_0__\n${"z".repeat(500)}`);
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
      timeoutMs: 2_000,
      maxOutputBytes: 64,
    });
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe("out");
  });

  it("decodes a multi-byte character split across binary frames", async () => {
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(data.toString());
        if (!m) return;
        const out = Buffer.from(`日本語\n__SUNABA_DONE_${m[1]}_0__\n`);
        ws.send(out.subarray(0, 4), { binary: true }); // cuts "本" after its first byte
        ws.send(out.subarray(4), { binary: true });
      });
    });
    const p = port(wss);
    const res = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "echo 日本語",
      timeoutMs: 5_000,
    });
    expect(res.output).toBe("日本語");
  });
});

describe("execOverShell connection failures", () => {
  let tcp: Server | undefined;
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const s of sockets) s.destroy();
    tcp?.close();
  });

  it("reports a connect timeout as ShellConnectFailed, so Sandbox.exec may retry it", async () => {
    // Accepts TCP but never answers the WebSocket upgrade.
    tcp = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => tcp?.listen(0, "127.0.0.1", r));
    const p = (tcp.address() as AddressInfo).port;
    const err = await execOverShell({
      endpoint: `127.0.0.1:${p}`,
      url: `ws://127.0.0.1:${p}`,
      token: "tok",
      command: "true",
      connectTimeoutMs: 100,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ShellConnectFailed" });
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(TimeoutError);
  });
});
