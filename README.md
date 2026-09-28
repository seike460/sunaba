# sunaba (砂場)

TypeScript toolkit for **AWS Lambda MicroVMs** — Firecracker-backed,
session-scoped, stateful sandboxes. Sandboxes in English; "sunaba" is the
sandbox you build things in.

AWS gives you the raw `lambda-microvms` API. sunaba gives you the layer on
top that every application ends up needing:

| pain with the raw API | what sunaba does |
|---|---|
| JWE token minting, expiry, refresh | `AuthTokenManager` / `ShellTokenManager` — auto-refresh, port-scoped |
| WebSocket PTY handshake (`create-microvm-shell-auth-token` + subprotocols) | `Sandbox.exec()` / `interactiveShell()` — agent-free commands over `SHELL_INGRESS` |
| suspend/resume waits, reconnects | `Sandbox.suspend()/resume()/connect()` — state-aware, auto-resume |
| image build pipeline (zip → S3 → create → SUCCESSFUL poll) | `buildMicrovmImage()` + `sunaba build` |
| CloudFormation only models the image | `sunaba-cdk` L2 constructs for image, network connectors, IAM roles |
| no high-level TypeScript SDK at all | `sunaba-sdk` — the missing one |

## Packages

| package | description |
|---|---|
| `sunaba-sdk` | `Sandbox` lifecycle, agent-free exec over the managed shell, fs helpers, waiters, auth token managers, image builder |
| `sunaba-cdk` | CDK L2 constructs: `MicrovmImage`, `MicrovmNetworkConnector`, `MicrovmBuildRole` / `MicrovmExecutionRole` / `NetworkConnectorOperatorRole` |
| `sunaba-agent` | Optional in-VM guest agent: HTTP exec/fs API on `:8080`, lifecycle hooks on `:9000` |
| `sunaba-cli` | `sunaba` command line: `init build run exec shell ls suspend resume rm logs images status` |

## Requirements

- Node.js ≥ 20
- AWS credentials with Lambda MicroVMs permissions
- A region where Lambda MicroVMs is available (e.g. `us-east-1`, `ap-northeast-1`)

## Quick start

```bash
npm install -g sunaba-cli        # once published; locally: node packages/cli/dist/main.js

cd my-image
sunaba init                      # writes sunaba.json + Dockerfile
# edit sunaba.json: name, artifactBucket, buildRoleArn, executionRoleArn
sunaba build                     # zip → S3 → CreateMicrovmImage → SUCCESSFUL
sunaba run --rm --exec "uname -a"  # run a command; --rm deletes the VM after
sunaba run --shell               # interactive PTY shell
sunaba ls                        # list MicroVMs (non-terminated; --all for all)
sunaba logs <id> --follow        # tail CloudWatch logs
sunaba suspend <id>              # pause; auto-terminates after the VM's
                                 # suspendedDurationSeconds (default 300 s —
                                 # set --suspended at `sunaba run`, max 8 h)
sunaba resume <id>
sunaba rm <id>                   # terminate
```

`sunaba run` attaches the managed `HTTP_INGRESS` + `SHELL_INGRESS`
connectors (`ALL_INGRESS` cannot be combined with other connectors),
so `exec`/`shell` work with **no agent inside the image**.

## SDK

```ts
import { Sandbox } from "sunaba-sdk";

const sb = await Sandbox.create({
  image: "demo",                    // name resolves to the latest ACTIVE image
  ingress: ["SHELL_INGRESS"],       // managed connector
  egress: ["INTERNET_EGRESS"],
  idlePolicy: {
    maxIdleDurationSeconds: 900,
    suspendedDurationSeconds: 300,
    autoResumeEnabled: true,
  },
});

const r = await sb.exec("echo hello");
console.log(r.output, r.exitCode);

await sb.writeFile("/tmp/a.txt", "data");
await sb.suspend();                 // snapshot kept
await sb.resume();
await sb.terminate();
```

Attach to an existing (or suspended) MicroVM:

```ts
const sb = await Sandbox.connect("m-abc123");   // auto-resumes if SUSPENDED
```

Talk HTTP to an app inside the VM (e.g. the guest agent or your server):

```ts
const res = await sb.request("/exec", {
  method: "POST",
  port: 8080,
  body: JSON.stringify({ command: "uname -a" }),
});
```

## CDK

```ts
import {
  MicrovmBuildRole,
  MicrovmExecutionRole,
  MicrovmImage,
  MicrovmImageSources,
} from "sunaba-cdk";

// IAM role the image build assumes (zip → S3 → CreateMicrovmImage).
const buildRole = new MicrovmBuildRole(this, "BuildRole");

// Directory source is uploaded as a CDK asset automatically.
const image = new MicrovmImage(this, "Image", {
  name: "demo",
  source: MicrovmImageSources.fromDirectory("./image"),
  buildRole,
});

// Execution role you pass to RunMicrovm (least-privilege logging scope).
const execRole = new MicrovmExecutionRole(this, "ExecRole");
```

## Guest agent (optional)

`sunaba-agent` runs **inside** the MicroVM and exposes a JSON POST API:

- `POST /exec` — run a command, get stdout/stderr/exit code
- `POST /fs/{read,write,list,stat,mkdir,remove,rename,copy}` — filesystem ops
- lifecycle hooks (`SUNABA_HOOK_*` env → shell commands) on `:9000`

You only need it if you want HTTP semantics or run-hooks. For plain
command execution, the managed shell (`Sandbox.exec`) needs nothing in
the image. To serve the lifecycle hooks from your own app instead, use
`startHooksServer` from `sunaba-sdk/guest`.

## Configuration

`sunaba.json` (written by `sunaba init`):

```json
{
  "name": "demo",
  "sourceDir": ".",
  "artifactBucket": "my-artifacts-bucket",
  "buildRoleArn": "arn:aws:iam::123456789012:role/microvm-build",
  "executionRoleArn": "arn:aws:iam::123456789012:role/microvm-exec"
}
```

Global flags: `--region`, `--profile`. `--json` is per-command
(`run`, `exec`, `ls`, `images`, `status`). Region precedence:
flag → `AWS_REGION`/SDK default chain.

## Development

```bash
npm install
npm run build        # sdk → agent,cdk,cli (dependency order)
npm test             # vitest across workspaces (offline, fake AWS clients)
npm run check        # biome
```

## Status

Early — built against the Lambda MicroVMs GA API surface
(`@aws-sdk/client-lambda-microvms`). Feedback welcome via issues.

## License

Apache-2.0
