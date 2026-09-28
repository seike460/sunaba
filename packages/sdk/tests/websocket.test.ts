import { afterEach, describe, expect, it, vi } from "vitest";
import { Sandbox } from "../src/sandbox.js";
import { ARN, FakeMicrovmsClient } from "./helpers.js";

// Sandbox.websocket() always dials wss://{endpoint}; stand in for the ws
// client so each handshake's outcome (open, or an HTTP status) is scripted.
const handshake = vi.hoisted(() => ({
  outcomes: [] as ("open" | number)[],
  dialed: [] as { url: string; protocols: string[] }[],
}));

vi.mock("ws", async (importOriginal) => {
  const orig = await importOriginal<typeof import("ws")>();
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    constructor(url: string, protocols: string[]) {
      super();
      handshake.dialed.push({ url, protocols });
      const outcome = handshake.outcomes.shift() ?? "open";
      queueMicrotask(() => {
        if (outcome === "open") this.emit("open");
        else {
          const destroy = () => {};
          this.emit("unexpected-response", { destroy }, { statusCode: outcome, destroy });
        }
      });
    }
    close() {}
  }
  return { ...orig, default: FakeWebSocket, WebSocket: FakeWebSocket };
});

async function connect() {
  let mints = 0;
  const client = new FakeMicrovmsClient((cmd: any) => {
    const name = cmd.constructor.name as string;
    if (name === "CreateMicrovmAuthTokenCommand") {
      return { authToken: { "X-aws-proxy-auth": `TOK-${++mints}` } };
    }
    return { microvmId: "mvm-1", endpoint: "vm.example", state: "RUNNING", imageArn: ARN };
  });
  return { client, sbx: await Sandbox.connect("mvm-1", { client }) };
}

describe("Sandbox.websocket", () => {
  afterEach(() => {
    handshake.outcomes = [];
    handshake.dialed = [];
  });

  it("carries the token and port as subprotocols ahead of the caller's own", async () => {
    const { sbx } = await connect();
    await sbx.websocket("ws", { port: 3000, protocols: ["chat"] });
    expect(handshake.dialed).toEqual([
      {
        url: "wss://vm.example/ws",
        protocols: [
          "lambda-microvms",
          "lambda-microvms.authentication.TOK-1",
          "lambda-microvms.port.3000",
          "chat",
        ],
      },
    ]);
  });

  it("re-mints the token and retries once when the handshake gets 403", async () => {
    handshake.outcomes = [403, "open"];
    const { client, sbx } = await connect();
    await sbx.websocket("/ws");
    expect(handshake.dialed.map((d) => d.protocols[1])).toEqual([
      "lambda-microvms.authentication.TOK-1",
      "lambda-microvms.authentication.TOK-2",
    ]);
    expect(handshake.dialed[1]?.protocols[2]).toBe("lambda-microvms.port.8080");
    expect(client.callsOf("CreateMicrovmAuthTokenCommand")).toHaveLength(2);
  });

  it("gives up after that one retry", async () => {
    handshake.outcomes = [401, 401];
    const { sbx } = await connect();
    await expect(sbx.websocket("/ws")).rejects.toMatchObject({ code: "WsFailed" });
    expect(handshake.dialed).toHaveLength(2);
  });

  it("does not retry a handshake that failed for another reason", async () => {
    handshake.outcomes = [502];
    const { client, sbx } = await connect();
    await expect(sbx.websocket("/ws")).rejects.toMatchObject({ code: "WsFailed" });
    expect(handshake.dialed).toHaveLength(1);
    expect(client.callsOf("CreateMicrovmAuthTokenCommand")).toHaveLength(1);
  });
});
