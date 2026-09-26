# sunaba-agent

Optional guest agent for **AWS Lambda MicroVMs** — runs inside the VM.

- `POST /exec` — run a command, returns stdout/stderr/exit code
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

Docs: https://github.com/seike460/sunaba#readme

License: Apache-2.0
