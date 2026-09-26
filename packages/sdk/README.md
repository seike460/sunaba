# sunaba-sdk

High-level TypeScript SDK for **AWS Lambda MicroVMs** — session-scoped,
stateful Firecracker sandboxes.

```ts
import { Sandbox } from "sunaba-sdk";

const sb = await Sandbox.create({ image: "demo" });   // name or ARN
const r = await sb.exec("echo hello");                // agent-free PTY exec
console.log(r.output, r.exitCode);

await sb.writeFile("/tmp/a.txt", "data");
await sb.suspend();                                   // snapshot kept
await sb.resume();
await sb.terminate();
```

- `Sandbox.create / connect` — launch or attach (auto-resumes SUSPENDED)
- `sb.exec / sb.interactiveShell` — managed `SHELL_INGRESS` WebSocket PTY, no guest agent needed
- `sb.writeFile / readFile / request` — fs helpers + authenticated HTTP to in-VM ports
- `buildMicrovmImage` — zip → S3 → `CreateMicrovmImage` → `SUCCESSFUL` wait
- `AuthTokenManager` / `ShellTokenManager` — JWE mint + auto-refresh, port-scoped
- `waitForMicrovmState`, `listMicrovms`, `resolveImageArn`, `latestActiveVersion`

Docs and full API: https://github.com/seike460/sunaba#readme

License: Apache-2.0
