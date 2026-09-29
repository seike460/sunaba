# sunaba-cli

`sunaba` — command line for **AWS Lambda MicroVMs** sandboxes.

```bash
npm install -g sunaba-cli

sunaba init            # scaffold sunaba.json + Dockerfile
sunaba build           # zip → S3 → CreateMicrovmImage → SUCCESSFUL
sunaba run --exec "uname -a"      # launch a MicroVM, run a command
sunaba run --shell                # interactive PTY shell
sunaba exec <id> -- ls -la        # exec in an existing MicroVM
sunaba ls                         # list MicroVMs (--all, --json, --image)
sunaba images                     # list MicroVM images
sunaba logs <id> --follow         # CloudWatch logs
sunaba suspend|resume|rm <id>...  # lifecycle
sunaba status <id>                # state + endpoint
```

Global flags: `--region`, `--profile`, `-v/--version` (top-level only — `run`/`ls` take `--image-version`), `-h/--help`.
`--json` is per-command (`run`, `exec`, `ls`, `images`, `status`).
Project defaults live in `sunaba.json` (`name`, `sourceDir`,
`artifactBucket`, `buildRoleArn`, `baseImage`, `executionRoleArn`).

Docs: https://github.com/seike460/sunaba#readme

License: Apache-2.0
