# sunaba v0.1.0 — initial release

AWS Lambda MicroVM 上で動くサンドボックスを TypeScript から扱うための
SDK / CDK constructs / ゲストエージェント / CLI の初回リリースです。

## Packages

| Package | Description |
|---|---|
| `sunaba-sdk` | Sandbox ライフサイクル・exec/shell/fs・managed connectors・guest hooks |
| `sunaba-cli` | `sunaba` コマンド（init/build/run/exec/shell/logs/suspend/resume/rm/status/images/ls） |
| `sunaba-cdk` | MicrovmImage / NetworkConnector / IAM roles / managed sandbox constructs |
| `sunaba-agent` | ゲスト内 HTTP エージェント `sunaba-agentd`（exec/fs/hooks API） |

## Requirements

- Node.js >= 20（TypeScript strict / NodeNext）
- AWS credentials（`AWS_REGION` / `AWS_DEFAULT_REGION`、または AWS provider chain:
  `~/.aws/config`・profile・SSO・IMDS・container metadata に対応）
- GovCloud（`aws-us-gov`）・China（`aws-cn`）パーティションの ARN 生成に対応

## Quick Start

```sh
npm install -g sunaba-cli
cd examples/demo-image && sunaba build
sunaba run --rm -- echo "hello from microvm"
```

詳細は README.md と examples/quickstart を参照してください。
