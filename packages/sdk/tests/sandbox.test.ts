import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { latestActiveVersion, Sandbox } from "../src/sandbox.js";
import { ARN, FakeMicrovmsClient } from "./helpers.js";

function makeClient(overrides: Record<string, unknown> = {}) {
  return new FakeMicrovmsClient((cmd: any) => {
    const name = cmd.constructor.name as string;
    if (name === "ListMicrovmImagesCommand") {
      return { items: [{ imageArn: ARN, name: "demo" }] };
    }
    if (name === "ListMicrovmImageVersionsCommand") {
      return { items: [{ imageVersion: "1.0", status: "ACTIVE" }] };
    }
    if (name === "RunMicrovmCommand") {
      return { microvmId: "mvm-1", endpoint: "vm.example", state: "PENDING" };
    }
    if (name === "GetMicrovmCommand") {
      return {
        microvmId: "mvm-1",
        endpoint: "vm.example",
        state: "RUNNING",
        imageArn: ARN,
        imageVersion: "1.0",
      };
    }
    if (name === "CreateMicrovmAuthTokenCommand") {
      return { authToken: { "X-aws-proxy-auth": "TOK" } };
    }
    if (name === "CreateMicrovmShellAuthTokenCommand") {
      return { authToken: { "X-aws-proxy-auth": "SHELLTOK" } };
    }
    return overrides[name] ?? {};
  });
}

describe("Sandbox.create", () => {
  it("resolves image name, runs, and waits for RUNNING", async () => {
    const client = makeClient();
    const sbx = await Sandbox.create({
      image: "demo",
      client,
      region: "us-east-1",
      executionRoleArn: "arn:aws:iam::123456789012:role/exec",
    });
    expect(sbx.microvmId).toBe("mvm-1");
    expect(sbx.endpoint).toBe("vm.example");
    const run = client.callsOf("RunMicrovmCommand")[0];
    expect(run.input.imageIdentifier).toBe(ARN);
    expect(run.input.imageVersion).toBe("1.0");
    // Default ingress is HTTP+SHELL — ALL_INGRESS cannot be combined
    // with other connectors (rejected by the Lambda MicroVMs API).
    expect(run.input.ingressNetworkConnectors).toContain(
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS",
    );
    expect(run.input.ingressNetworkConnectors).toContain(
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:SHELL_INGRESS",
    );
    expect(run.input.ingressNetworkConnectors).not.toContain(
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
    );
    expect(run.input.egressNetworkConnectors).toEqual([
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
    ]);
  });
});

describe("Sandbox.request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends auth + port headers and retries once on 403", async () => {
    const client = makeClient();
    const sbx = await Sandbox.create({ image: ARN, client, region: "us-east-1" });

    const seen: Record<string, string>[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      calls += 1;
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(calls === 1 ? "forbidden" : "ok", {
        status: calls === 1 ? 403 : 200,
      });
    });
    const res = await sbx.request("/health", { port: 9000 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(seen[0]?.["x-aws-proxy-port"]).toBe("9000");
    expect(seen[0]?.["x-aws-proxy-auth"]).toBe("TOK");
  });

  it("never auto-retries a non-idempotent POST (lost-response double-execute)", async () => {
    const sbx = await Sandbox.create({
      image: ARN,
      client: makeClient(),
      region: "us-east-1",
    });
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    });
    const res = await sbx.request("/exec", { method: "POST", body: "{}" });
    expect(res.status).toBe(500);
    expect(calls).toBe(1);
  });

  it("auto-retries idempotent GET on 5xx", async () => {
    const sbx = await Sandbox.create({
      image: ARN,
      client: makeClient(),
      region: "us-east-1",
    });
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response(calls < 2 ? "err" : "ok", { status: calls < 2 ? 500 : 200 });
    });
    const res = await sbx.request("/health");
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it.each([
    "https://idp.example/login",
    "http://vm.example/login", // same host, but a TLS downgrade is another origin
  ])("returns a redirect to %s unfollowed so the token stays on the endpoint", async (location) => {
    const sbx = await Sandbox.create({ image: ARN, client: makeClient(), region: "us-east-1" });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location } });
    });
    const res = await sbx.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(location);
    expect(urls).toEqual(["https://vm.example/"]);
  });

  it("follows a same-origin redirect with the auth and port headers", async () => {
    const sbx = await Sandbox.create({ image: ARN, client: makeClient(), region: "us-east-1" });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) });
      return seen.length === 1
        ? new Response(null, { status: 301, headers: { location: "/docs/" } })
        : new Response("ok");
    });
    const res = await sbx.request("/docs", { port: 3000 });
    expect(await res.text()).toBe("ok");
    expect(seen.map((s) => s.url)).toEqual(["https://vm.example/docs", "https://vm.example/docs/"]);
    expect(seen[1]?.headers["x-aws-proxy-auth"]).toBe("TOK");
    expect(seen[1]?.headers["x-aws-proxy-port"]).toBe("3000");
  });

  it("turns a POST into a body-less GET on a same-origin 303, like fetch()", async () => {
    const sbx = await Sandbox.create({ image: ARN, client: makeClient(), region: "us-east-1" });
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return seen.length === 1
        ? new Response(null, { status: 303, headers: { location: "/result" } })
        : new Response("done");
    });
    await sbx.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.body).toBeUndefined();
    expect(new Headers(seen[1]?.headers).has("content-type")).toBe(false);
    expect(new Headers(seen[1]?.headers).get("x-aws-proxy-auth")).toBe("TOK");
  });
});

describe("latestActiveVersion", () => {
  it("picks the newest ACTIVE version and ignores FAILED/INACTIVE", async () => {
    const client = new FakeMicrovmsClient(() => ({
      items: [
        { imageVersion: "1.0", status: "ACTIVE", createdAt: new Date(100) },
        { imageVersion: "1.1", status: "ACTIVE", createdAt: new Date(300) },
        { imageVersion: "1.2", status: "INACTIVE", createdAt: new Date(400) },
        { imageVersion: "2.0", status: "FAILED", createdAt: new Date(500) },
      ],
    }));
    expect(await latestActiveVersion(client, ARN)).toBe("1.1");
  });

  it("returns undefined when nothing is ACTIVE", async () => {
    const client = new FakeMicrovmsClient(() => ({
      items: [{ imageVersion: "2.0", status: "FAILED", createdAt: new Date(1) }],
    }));
    expect(await latestActiveVersion(client, ARN)).toBeUndefined();
  });
});

describe("Sandbox.connect", () => {
  it("resumes a suspended MicroVM", async () => {
    let state = "SUSPENDED";
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "GetMicrovmCommand") {
        const s = state;
        if (s === "SUSPENDED") state = "RUNNING";
        return { microvmId: "mvm-2", endpoint: "vm.example", state: s, imageArn: ARN };
      }
      return {};
    });
    const sbx = await Sandbox.connect("mvm-2", { client, region: "us-east-1" });
    expect(client.callsOf("ResumeMicrovmCommand")).toHaveLength(1);
    expect(sbx.state).toBe("RUNNING");
  });

  it("works with an injected client and no region", async () => {
    const client = new FakeMicrovmsClient(() => ({
      microvmId: "mvm-3",
      endpoint: "vm.example",
      state: "RUNNING",
      imageArn: ARN,
    }));
    const sbx = await Sandbox.connect("mvm-3", { client });
    expect(sbx.state).toBe("RUNNING");
  });

  it("waits for a PENDING MicroVM to reach RUNNING", async () => {
    let gets = 0;
    const client = new FakeMicrovmsClient(() => ({
      microvmId: "mvm-4",
      endpoint: "vm.example",
      state: ++gets === 1 ? "PENDING" : "RUNNING",
      imageArn: ARN,
    }));
    const sbx = await Sandbox.connect("mvm-4", { client, runTimeoutMs: 5_000 });
    expect(sbx.state).toBe("RUNNING");
  });

  it("rejects a terminated MicroVM", async () => {
    const client = new FakeMicrovmsClient(() => ({
      microvmId: "mvm-5",
      state: "TERMINATED",
      imageArn: ARN,
    }));
    await expect(Sandbox.connect("mvm-5", { client })).rejects.toThrow(/TERMINATED/);
  });
});

describe("Sandbox.create failure cleanup", () => {
  it("terminates the MicroVM when the RUNNING wait fails", async () => {
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "RunMicrovmCommand") {
        return { microvmId: "mvm-9", endpoint: "vm.example", state: "PENDING" };
      }
      if (name === "GetMicrovmCommand") {
        return { microvmId: "mvm-9", state: "TERMINATED", stateReason: "boom" };
      }
      return {};
    });
    await expect(
      Sandbox.create({ image: ARN, client, region: "us-east-1", runTimeoutMs: 5_000 }),
    ).rejects.toThrow();
    expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(1);
  });

  it("retries the cleanup terminate once on a transient failure", async () => {
    let terminateCalls = 0;
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "RunMicrovmCommand") {
        return { microvmId: "mvm-9", endpoint: "vm.example", state: "PENDING" };
      }
      if (name === "GetMicrovmCommand") {
        return { microvmId: "mvm-9", state: "TERMINATED", stateReason: "boom" };
      }
      if (name === "TerminateMicrovmCommand" && ++terminateCalls === 1) {
        throw new Error("throttled");
      }
      return {};
    });
    await expect(
      Sandbox.create({ image: ARN, client, region: "us-east-1", runTimeoutMs: 5_000 }),
    ).rejects.toThrow();
    expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(2);
  });

  it("terminates the MicroVM when onMicrovmCreated throws", async () => {
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "RunMicrovmCommand") {
        return { microvmId: "mvm-9", endpoint: "vm.example", state: "PENDING" };
      }
      if (name === "GetMicrovmCommand") {
        return { microvmId: "mvm-9", state: "RUNNING", endpoint: "vm.example" };
      }
      return {};
    });
    await expect(
      Sandbox.create({
        image: ARN,
        client,
        region: "us-east-1",
        onMicrovmCreated: () => {
          throw new Error("callback blew up");
        },
      }),
    ).rejects.toThrow("callback blew up");
    expect(client.callsOf("TerminateMicrovmCommand")).toHaveLength(1);
  });
});

describe("Sandbox.exec via fake shell", () => {
  it("runs the command over the WS shell and returns output/exit code", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(data.toString());
        if (m) ws.send(`exec-out\n__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      const client = makeClient();
      const sbx = await Sandbox.create({ image: ARN, client, region: "us-east-1" });
      const res = await sbx.exec("echo hi", {
        urlOverride: `ws://127.0.0.1:${port}`,
      });
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("exec-out");
      expect(client.callsOf("CreateMicrovmShellAuthTokenCommand")).toHaveLength(1);
    } finally {
      wss.close();
    }
  });

  // Commands arrive base64-wrapped (eval "$(printf %s '<b64>' | base64 -d)")
  // and may span several ws frames — accumulate until the done marker lands.
  const decodeCmd = (buf: string) => {
    const b64 = /printf %s '([A-Za-z0-9+/=\n]+)' \| base64 -d/.exec(buf)?.[1];
    return b64 ? Buffer.from(b64.replace(/\s/g, ""), "base64").toString() : "";
  };

  it("writeFile/readFile round-trip through the shell", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      let buf = "";
      ws.on("message", (data: Buffer) => {
        buf += data.toString();
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(buf);
        if (!m) return;
        const cmd = decodeCmd(buf);
        buf = "";
        const out = cmd.includes("wc -c")
          ? "11\n"
          : cmd.includes("base64 ")
            ? "aGVsbG8gd29ybGQ=\n"
            : "";
        ws.send(`${out}__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      const sbx = await Sandbox.create({
        image: ARN,
        client: makeClient(),
        region: "us-east-1",
      });
      const override = { urlOverride: `ws://127.0.0.1:${port}` };
      await sbx.writeFile("/tmp/x.txt", "hello world", override);
      const back = await sbx.readFile("/tmp/x.txt", override);
      expect(back.toString()).toBe("hello world");
    } finally {
      wss.close();
    }
  });

  it("readFile feeds the path to base64 on stdin, so a leading '-' is not an option", async () => {
    const cmds: string[] = [];
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      let buf = "";
      ws.on("message", (data: Buffer) => {
        buf += data.toString();
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(buf);
        if (!m) return;
        const cmd = decodeCmd(buf);
        buf = "";
        cmds.push(cmd);
        const out = cmd.startsWith("wc -c") ? "2\n" : "aGk=\n";
        ws.send(`${out}__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      const sbx = await Sandbox.create({ image: ARN, client: makeClient(), region: "us-east-1" });
      const back = await sbx.readFile("-data.bin", { urlOverride: `ws://127.0.0.1:${port}` });
      expect(back.toString()).toBe("hi");
      expect(cmds).toEqual(["wc -c < '-data.bin'", "base64 < '-data.bin'"]);
    } finally {
      wss.close();
    }
  });

  it("retries exec once with a fresh shell token when the connection is refused", async () => {
    let handshakes = 0;
    const wss = new WebSocketServer({
      port: 0,
      verifyClient: (_info, cb) => {
        handshakes += 1;
        if (handshakes === 1) cb(false, 403);
        else cb(true);
      },
    });
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(data.toString());
        if (m) ws.send(`ok\n__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      const client = makeClient();
      const sbx = await Sandbox.create({ image: ARN, client, region: "us-east-1" });
      const res = await sbx.exec("true", { urlOverride: `ws://127.0.0.1:${port}` });
      expect(res.output).toBe("ok");
      expect(handshakes).toBe(2);
      expect(client.callsOf("CreateMicrovmShellAuthTokenCommand")).toHaveLength(2);
    } finally {
      wss.close();
    }
  });

  it("readFile chunks large files via dd (no silent truncation)", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      let buf = "";
      ws.on("message", (data: Buffer) => {
        buf += data.toString();
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(buf);
        if (!m) return;
        const cmd = decodeCmd(buf);
        buf = "";
        let out = "";
        if (cmd.includes("wc -c")) {
          out = "5000\n";
        } else if (cmd.includes("dd if=")) {
          // chunkBytes = floor((4096-1024)*76/77/4)*3 - 3 = 2271 →
          // wrapped b64 (3028 + 39 wrap NLs) stays under the 3072 cap.
          const bs = Number(/bs=(\d+)/.exec(cmd)?.[1] ?? 0);
          const skip = Number(/skip=(\d+)/.exec(cmd)?.[1] ?? 0);
          const n = Math.min(bs, 5000 - skip * bs);
          // GNU base64 wraps at 76 columns — emulate that faithfully.
          const b64 = Buffer.from("A".repeat(n)).toString("base64");
          out = `${(b64.match(/.{1,76}/g) ?? []).join("\n")}\n`;
        }
        // Emulate the real shell buffer: only the last maxOutputBytes
        // survive — an oversized chunk would lose its head here.
        const MAX = 4096;
        if (out.length > MAX) out = out.slice(out.length - MAX);
        ws.send(`${out}__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      const sbx = await Sandbox.create({
        image: ARN,
        client: makeClient(),
        region: "us-east-1",
      });
      // cap 3072 → chunkBytes 2304 < 5000 → dd path (3 chunks)
      const buf = await sbx.readFile("/big.bin", {
        urlOverride: `ws://127.0.0.1:${port}`,
        maxOutputBytes: 4096,
      });
      expect(buf.length).toBe(5000);
      expect(buf.toString()).toBe("A".repeat(5000));
    } finally {
      wss.close();
    }
  });

  it("readFile chunk sizing keeps wrapped base64 under the output cap", async () => {
    // chunkBytes boundary: size == chunkBytes takes the single-shot path;
    // chunkBytes + 1 must switch to dd. Both wrapped outputs must fit cap.
    const wrapLen = (n: number) => {
      const enc = Math.ceil(n / 3) * 4;
      return enc + Math.ceil(enc / 76);
    };
    const cap = 4096 - 1024;
    const chunkBytes = Math.floor((cap * 76) / 77 / 4) * 3 - 3;
    expect(wrapLen(chunkBytes)).toBeLessThanOrEqual(cap);

    let curSize = 0;
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      let buf = "";
      ws.on("message", (data: Buffer) => {
        buf += data.toString();
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(buf);
        if (!m) return;
        const cmd = decodeCmd(buf);
        buf = "";
        let out = "";
        if (cmd.includes("wc -c")) {
          out = `${curSize}\n`;
        } else if (cmd.includes("dd if=")) {
          const bs = Number(/bs=(\d+)/.exec(cmd)?.[1] ?? 0);
          const skip = Number(/skip=(\d+)/.exec(cmd)?.[1] ?? 0);
          const n = Math.max(0, Math.min(bs, curSize - skip * bs));
          const b64 = Buffer.alloc(n, 0x41).toString("base64");
          out = `${(b64.match(/.{1,76}/g) ?? []).join("\n")}\n`;
        } else if (cmd.includes("base64")) {
          const b64 = Buffer.alloc(curSize, 0x41).toString("base64");
          out = `${(b64.match(/.{1,76}/g) ?? []).join("\n")}\n`;
        }
        // Emulate the real shell buffer cap — oversize output loses its head.
        const MAX = 4096;
        if (out.length > MAX) out = out.slice(out.length - MAX);
        ws.send(`${out}__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      const sbx = await Sandbox.create({
        image: ARN,
        client: makeClient(),
        region: "us-east-1",
      });
      const opts = {
        urlOverride: `ws://127.0.0.1:${port}`,
        maxOutputBytes: 4096,
      };
      // Boundary: exactly chunkBytes — single-shot base64, wrapped ≤ cap.
      curSize = chunkBytes;
      const exact = await sbx.readFile("/b", opts);
      expect(exact.length).toBe(chunkBytes);
      // One byte over — must chunk; dd bs=<chunkBytes> skip=1 reads 1 byte.
      curSize = chunkBytes + 1;
      const over = await sbx.readFile("/b", opts);
      expect(over.length).toBe(chunkBytes + 1);
    } finally {
      wss.close();
    }
  });

  it("readFile rejects a too-small maxOutputBytes instead of looping", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        const text = data.toString();
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(text);
        if (m) ws.send(`5\n__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      const sbx = await Sandbox.create({
        image: ARN,
        client: makeClient(),
        region: "us-east-1",
      });
      await expect(
        sbx.readFile("/x", {
          urlOverride: `ws://127.0.0.1:${port}`,
          maxOutputBytes: 1024,
        }),
      ).rejects.toThrow(/too small/);
    } finally {
      wss.close();
    }
  });

  it("readFile throws when chunks come back short (truncation is not silent)", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      let buf = "";
      ws.on("message", (data: Buffer) => {
        buf += data.toString();
        const m = /__SUNABA_DONE_([a-z0-9]+)_%d__/.exec(buf);
        if (!m) return;
        const cmd = decodeCmd(buf);
        buf = "";
        let out = "";
        if (cmd.includes("wc -c")) out = "5000\n";
        else if (cmd.includes("dd if=")) out = `${Buffer.from("short").toString("base64")}\n`;
        ws.send(`${out}__SUNABA_DONE_${m[1]}_0__\n`);
      });
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      const sbx = await Sandbox.create({
        image: ARN,
        client: makeClient(),
        region: "us-east-1",
      });
      await expect(
        sbx.readFile("/big.bin", {
          urlOverride: `ws://127.0.0.1:${port}`,
          maxOutputBytes: 4096,
        }),
      ).rejects.toThrow(/expected 5000 bytes, got 15/);
    } finally {
      wss.close();
    }
  });
});

describe("Sandbox lifecycle", () => {
  it("suspend and terminate call the right commands", async () => {
    const client = new FakeMicrovmsClient((cmd: any) => {
      const name = cmd.constructor.name as string;
      if (name === "GetMicrovmCommand") {
        return { microvmId: "mvm-1", endpoint: "vm.example", state: "SUSPENDED", imageArn: ARN };
      }
      return {};
    });
    const sbx = await Sandbox.connect("mvm-1", {
      client,
      region: "us-east-1",
      resume: false,
    });
    await sbx.suspend();
    expect(client.callsOf("SuspendMicrovmCommand")).toHaveLength(1);
    await sbx.terminate();
    const t = client.callsOf("TerminateMicrovmCommand")[0];
    expect(t.input.microvmIdentifier).toBe("mvm-1");
  });

  it("suspend/resume absorb ConflictException when the goal is already reached", async () => {
    const conflict = Object.assign(new Error("transition in progress"), {
      name: "ConflictException",
    });
    let suspendCalls = 0;
    let resumeCalls = 0;
    const client = new FakeMicrovmsClient((cmd: any) => {
      const n = cmd.constructor.name as string;
      if (n === "SuspendMicrovmCommand") {
        suspendCalls++;
        if (suspendCalls === 1) throw conflict;
      }
      if (n === "ResumeMicrovmCommand") {
        resumeCalls++;
        if (resumeCalls === 1) throw conflict;
      }
      if (n === "GetMicrovmCommand") {
        // Post-conflict reads report the goal already reached.
        return {
          microvmId: "mvm-1",
          endpoint: "vm.example",
          state: suspendCalls > resumeCalls ? "SUSPENDED" : "RUNNING",
          imageArn: ARN,
        };
      }
      return {};
    });
    const sbx = await Sandbox.connect("mvm-1", { client, region: "us-east-1" });
    await sbx.suspend();
    await sbx.resume();
    expect(client.callsOf("SuspendMicrovmCommand")).toHaveLength(1);
    expect(client.callsOf("ResumeMicrovmCommand")).toHaveLength(1);
  });

  it("connect() tolerates another client resuming first (Conflict → RUNNING)", async () => {
    const conflict = Object.assign(new Error("transition in progress"), {
      name: "ConflictException",
    });
    let resumed = false;
    const client = new FakeMicrovmsClient((cmd: any) => {
      const n = cmd.constructor.name as string;
      if (n === "ResumeMicrovmCommand") {
        resumed = true;
        throw conflict;
      }
      if (n === "GetMicrovmCommand") {
        // First read SUSPENDED; after the conflict someone else resumed.
        return {
          microvmId: "mvm-2",
          endpoint: "vm.example",
          state: resumed ? "RUNNING" : "SUSPENDED",
          imageArn: ARN,
        };
      }
      return {};
    });
    const sbx = await Sandbox.connect("mvm-2", { client, region: "us-east-1" });
    expect(sbx.state).toBe("RUNNING");
  });
});
