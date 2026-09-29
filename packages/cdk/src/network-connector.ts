import { aws_ec2 as ec2, type aws_iam as iam, aws_lambda as lambda, Token } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { IMicrovmNetworkConnector } from "./managed.js";
import { NetworkConnectorOperatorRole } from "./roles.js";

export type NetworkProtocol = "IPv4" | "DualStack";

export interface MicrovmNetworkConnectorProps {
  /** VPC the connector routes egress traffic through. */
  readonly vpc: ec2.IVpc;
  /**
   * Subnets where Lambda provisions ENIs (1–16, all in the same VPC).
   * @default { subnetType: PRIVATE_WITH_EGRESS }
   */
  readonly subnets?: ec2.SubnetSelection;
  /**
   * Security groups attached to the ENIs (0–5, same VPC as the subnets).
   * @default [] (VPC default security group is used by Lambda)
   */
  readonly securityGroups?: ec2.ISecurityGroup[];
  /**
   * Network protocol for the connector.
   * @default "IPv4"
   */
  readonly networkProtocol?: NetworkProtocol;
  /** Connector name, unique per account and Region (1–64 chars). */
  readonly name?: string;
  /**
   * IAM role Lambda assumes to manage ENIs in your VPC. Defaults to a
   * {@link NetworkConnectorOperatorRole} with the AWS-managed
   * `AWSLambdaVPCAccessExecutionRole` policy.
   */
  readonly operatorRole?: iam.IRole;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * L2 construct for `AWS::Lambda::NetworkConnector` — a VPC egress connector
 * MicroVMs can route outbound traffic through. Pass the construct (or its
 * {@link MicrovmNetworkConnector#connectorArn}) in
 * `MicrovmImageProps#egressConnectors` / `RunMicrovm --egress-network-connectors`.
 */
export class MicrovmNetworkConnector extends Construct implements IMicrovmNetworkConnector {
  /** ARN of the network connector. */
  readonly connectorArn: string;
  /** Role Lambda assumes to manage ENIs in the VPC. */
  readonly operatorRole: iam.IRole;
  /** Underlying L1 resource. */
  readonly resource: lambda.CfnNetworkConnector;

  constructor(scope: Construct, id: string, props: MicrovmNetworkConnectorProps) {
    super(scope, id);

    if (props.name !== undefined && !Token.isUnresolved(props.name) && !NAME_RE.test(props.name)) {
      throw new Error(
        "connector name must be 1-64 alphanumeric characters, hyphens or underscores",
      );
    }

    const subnetSelection = props.subnets ?? {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    };
    const { subnetIds } = props.vpc.selectSubnets(subnetSelection);
    if (subnetIds.length === 0 || subnetIds.length > 16) {
      throw new Error("VPC egress connectors require between 1 and 16 subnets");
    }
    const securityGroupIds = (props.securityGroups ?? []).map((sg) => sg.securityGroupId);
    if (securityGroupIds.length > 5) {
      throw new Error("VPC egress connectors support at most 5 security groups");
    }
    const protocol = props.networkProtocol ?? "IPv4";
    if (protocol !== "IPv4" && protocol !== "DualStack") {
      throw new Error(`networkProtocol must be "IPv4" or "DualStack", got '${protocol}'`);
    }

    this.operatorRole =
      props.operatorRole ?? new NetworkConnectorOperatorRole(this, "OperatorRole");

    this.resource = new lambda.CfnNetworkConnector(this, "Resource", {
      name: props.name,
      operatorRole: this.operatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ["MicroVm"],
          networkProtocol: protocol,
          subnetIds,
          securityGroupIds,
        },
      },
    });
    // Lambda assumes the operator role to manage ENIs; depending on the
    // role construct covers its DefaultPolicy plus any imported-role
    // Policy children, whenever they're created.
    this.resource.node.addDependency(this.operatorRole);
    this.connectorArn = this.resource.networkConnectorRef.networkConnectorArn;
  }
}
