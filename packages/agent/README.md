# sunaba-agent

Optional guest agent for **AWS Lambda MicroVMs** — runs inside the VM.

- `POST /exec` — run a command; returns `exitCode` and base64-encoded
  `stdout`/`stderr` (default `timeoutMs`: 30 s)
- `POST /fs/{read,write,list,stat,mkdir,remove,rename,copy}` — filesystem ops
- lifecycle hooks on `:9000` (`SUNABA_HOOK_*` env vars → shell commands)

You only need this if you want HTTP semantics or run-hooks. Plain command
execution works agent-free via the managed `SHELL_INGRESS` connector
(`Sandbox.exec` in `sunaba-sdk`).

```dockerfile
RUN npm install -g sunaba-agent
EXPOSE 8080 9000
CMD ["sunaba-agentd"]
```

The agent has no authentication of its own and listens on `0.0.0.0`. It
relies on the MicroVM endpoint, which requires an endpoint token
(`X-aws-proxy-auth`) on every request. Anyone who reaches `:8080` can run
commands in the VM, so do not expose `:8080` or `:9000` any other way, and
scope the endpoint token with `allowedPorts` in `sunaba-sdk`.

Docs: https://github.com/seike460/sunaba#readme

License: Apache-2.0
