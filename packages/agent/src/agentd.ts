#!/usr/bin/env node
/**
 * sunaba-agentd — in-guest agent for AWS Lambda MicroVMs.
 *
 * Serves exec + filesystem API on port 8080 (the endpoint proxy's default
 * target) and lifecycle hooks on port 9000. Hook commands come from
 * SUNABA_HOOK_{READY,RUN,RESUME,SUSPEND,TERMINATE,VALIDATE} env vars.
 *
 * Usage: sunaba-agentd [--port 8080] [--hooks-port 9000] [--no-hooks] [--host 0.0.0.0]
 */
import { startAgent } from "./index.js";

function parseArgs(argv: string[]): {
  port: number;
  hooksPort: number;
  hooks: boolean;
  host: string;
} {
  const out = { port: 8080, hooksPort: 9000, hooks: true, host: "0.0.0.0" };
  const value = (argv: string[], i: number, flag: string): string => {
    const v = argv[i];
    if (!v || v.startsWith("--")) {
      console.error(`${flag} requires a value`);
      process.exit(2);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(value(argv, ++i, a));
    else if (a === "--hooks-port") out.hooksPort = Number(value(argv, ++i, a));
    else if (a === "--host") out.host = value(argv, ++i, a);
    else if (a === "--no-hooks") out.hooks = false;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: sunaba-agentd [--port 8080] [--hooks-port 9000] [--host 0.0.0.0] [--no-hooks]",
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    console.error(`invalid --port: ${out.port}`);
    process.exit(2);
  }
  if (!Number.isInteger(out.hooksPort) || out.hooksPort < 1 || out.hooksPort > 65535) {
    console.error(`invalid --hooks-port: ${out.hooksPort}`);
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
let servers: ReturnType<typeof startAgent>;
try {
  servers = startAgent({
    port: args.port,
    host: args.host,
    hooks: args.hooks ? "env" : false,
    hooksPort: args.hooksPort,
    onError: (e) => {
      console.error("[sunaba-agentd]", e);
      process.exit(1);
    },
  });
} catch (e) {
  // A bad SUNABA_HOOK_TIMEOUT_MS is a configuration error, like a bad flag.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

// Say "listening" only once both servers are: a port in use fails later,
// through onError, which exits 1.
servers.ready.then(
  () =>
    console.log(
      `[sunaba-agentd] api listening on ${args.host}:${args.port}` +
        (servers.hooks ? `, hooks on :${args.hooksPort}` : ""),
    ),
  () => {},
);

const shutdown = () => {
  servers.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
