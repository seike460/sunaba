import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHooksServer } from "../src/guest/hooks.js";

async function listening(server: Server): Promise<number> {
  if (!server.listening) await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

describe("startHooksServer", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function post(port: number, path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("dispatches lifecycle hooks and hands run body to handler", async () => {
    const onRun = vi.fn();
    server = startHooksServer({ run: onRun }, { port: 0, host: "127.0.0.1" });
    const port = await listening(server);
    const res = await post(port, "/aws/lambda-microvms/runtime/v1/run", {
      microvmId: "mvm-1",
      runHookPayload: "tenant-a",
    });
    expect(res.status).toBe(200);
    expect(onRun).toHaveBeenCalledWith({ microvmId: "mvm-1", runHookPayload: "tenant-a" });
  });

  it("returns 200 for unhandled hooks and 404 for other paths", async () => {
    server = startHooksServer({}, { port: 0, host: "127.0.0.1" });
    const port = await listening(server);
    expect((await post(port, "/aws/lambda-microvms/runtime/v1/suspend")).status).toBe(200);
    expect((await post(port, "/nope")).status).toBe(404);
  });

  it("returns 413 for oversized bodies and keeps serving", async () => {
    server = startHooksServer({ run: () => {} }, { port: 0, host: "127.0.0.1" });
    const port = await listening(server);
    const res = await fetch(`http://127.0.0.1:${port}/aws/lambda-microvms/runtime/v1/run`, {
      method: "POST",
      body: Buffer.alloc(1_100_000, 65),
    });
    expect(res.status).toBe(413);
    // Socket stayed alive: a normal request still works.
    expect((await post(port, "/aws/lambda-microvms/runtime/v1/suspend")).status).toBe(200);
  });

  it("does not dispatch prototype properties like 'constructor'", async () => {
    server = startHooksServer({}, { port: 0, host: "127.0.0.1" });
    const port = await listening(server);
    const res = await post(port, "/aws/lambda-microvms/runtime/v1/constructor");
    expect(res.status).toBe(200); // acknowledged, never invoked
  });

  it("returns 503 when a handler throws and reports the error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("not ready");
    server = startHooksServer(
      {
        suspend: () => {
          throw err;
        },
      },
      { port: 0, host: "127.0.0.1" },
    );
    const port = await listening(server);
    try {
      expect((await post(port, "/aws/lambda-microvms/runtime/v1/suspend")).status).toBe(503);
      expect(logged).toHaveBeenCalledWith("[sunaba-hooks]", "hook suspend failed:", err);
    } finally {
      logged.mockRestore();
    }
  });

  it("returns 400 for a malformed JSON body without invoking the handler", async () => {
    const onRun = vi.fn();
    server = startHooksServer({ run: onRun }, { port: 0, host: "127.0.0.1" });
    const port = await listening(server);
    const res = await fetch(`http://127.0.0.1:${port}/aws/lambda-microvms/runtime/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"microvmId":',
    });
    expect(res.status).toBe(400);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("hands an empty body to the handler as {}", async () => {
    const onSuspend = vi.fn();
    server = startHooksServer({ suspend: onSuspend }, { port: 0, host: "127.0.0.1" });
    const port = await listening(server);
    expect((await post(port, "/aws/lambda-microvms/runtime/v1/suspend")).status).toBe(200);
    expect(onSuspend).toHaveBeenCalledWith({});
  });
});
