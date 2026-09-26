# sunaba-cdk

AWS CDK L2 constructs for **AWS Lambda MicroVMs** images, network
connectors, and the IAM roles they need.

```ts
import {
  MicrovmBuildRole,
  MicrovmExecutionRole,
  MicrovmImage,
  MicrovmImageSources,
} from "sunaba-cdk";

const buildRole = new MicrovmBuildRole(this, "BuildRole");
const image = new MicrovmImage(this, "Image", {
  name: "demo",
  source: MicrovmImageSources.fromDirectory("./image"),
  buildRole,
});
const execRole = new MicrovmExecutionRole(this, "ExecRole");
```

- `MicrovmImage` — `AWS::Lambda::MicrovmImage` L2 (directory/S3 sources)
- `MicrovmNetworkConnector` — customer-managed VPC egress connectors
- `MicrovmBuildRole` / `MicrovmExecutionRole` / `NetworkConnectorOperatorRole`
- `ManagedBaseImage`, `managedConnectorArn`, `resolveConnectorArns`

Docs: https://github.com/seike460/sunaba#readme

License: Apache-2.0
