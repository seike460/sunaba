import { App, aws_ec2 as ec2, aws_iam as iam, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { MicrovmNetworkConnector } from "../src/index.js";

function stackWithConnector(
  props?: Partial<ConstructorParameters<typeof MicrovmNetworkConnector>[2]>,
) {
  const app = new App();
  const stack = new Stack(app, "TestStack");
  const vpc = new ec2.Vpc(stack, "Vpc", { maxAzs: 2 });
  const connector = new MicrovmNetworkConnector(stack, "Conn", { vpc, ...props });
  return { stack, connector, vpc, template: Template.fromStack(stack) };
}

/** Isolated-subnet VPC usable without NAT gateways. */
function isolatedVpc(stack: Stack, id = "Vpc") {
  return new ec2.Vpc(stack, id, {
    natGateways: 0,
    subnetConfiguration: [
      { name: "iso", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    ],
  });
}
const ISO = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

describe("MicrovmNetworkConnector", () => {
  it("synthesizes a VPC egress connector", () => {
    const { template } = stackWithConnector();
    template.hasResourceProperties("AWS::Lambda::NetworkConnector", {
      Configuration: {
        VpcEgressConfiguration: Match.objectLike({
          AssociatedComputeResourceTypes: ["MicroVm"],
          NetworkProtocol: "IPv4",
        }),
      },
    });
    const resources = template.findResources("AWS::Lambda::NetworkConnector");
    const cfg = Object.values(resources)[0]?.Properties?.Configuration?.VpcEgressConfiguration as {
      SubnetIds?: unknown[];
    };
    expect(cfg?.SubnetIds).toHaveLength(2);
  });

  it("creates an operator role with the ENI managed policy", () => {
    const { template } = stackWithConnector();
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "lambda.amazonaws.com" },
            Condition: {
              StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
              ArnLike: {
                "aws:SourceArn": Match.objectLike({
                  "Fn::Join": Match.arrayWith([
                    "",
                    Match.arrayWith([{ Ref: "AWS::AccountId" }, ":network-connector:*"]),
                  ]),
                }),
              },
            },
          }),
          Match.objectLike({ Action: "sts:TagSession" }),
        ]),
      },
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          "Fn::Join": Match.arrayWith([
            "",
            Match.arrayWith([
              "arn:",
              { Ref: "AWS::Partition" },
              ":iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
            ]),
          ]),
        }),
      ]),
    });
  });

  it("maps security groups, name and protocol", () => {
    const app = new App();
    const stack = new Stack(app, "T2");
    const vpc = isolatedVpc(stack);
    const sg = new ec2.SecurityGroup(stack, "Sg", { vpc });
    new MicrovmNetworkConnector(stack, "Conn", {
      vpc,
      subnets: ISO,
      securityGroups: [sg],
      name: "my-conn",
      networkProtocol: "DualStack",
    });
    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::NetworkConnector", {
      Name: "my-conn",
      Configuration: {
        VpcEgressConfiguration: Match.objectLike({
          NetworkProtocol: "DualStack",
          SecurityGroupIds: [stack.resolve(sg.securityGroupId) as Record<string, unknown>],
        }),
      },
    });
  });

  it("uses a caller-provided operator role", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const vpc = isolatedVpc(stack);
    const role = new iam.Role(stack, "Op", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    new MicrovmNetworkConnector(stack, "Conn", { vpc, subnets: ISO, operatorRole: role });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.hasResourceProperties("AWS::Lambda::NetworkConnector", {
      OperatorRole: stack.resolve(role.roleArn) as Record<string, unknown>,
    });
  });

  it("exposes the connector ARN and satisfies the image ref interface", () => {
    const { connector } = stackWithConnector();
    expect(connector.connectorArn).toBeDefined();
  });

  it("connector resource depends on the operator role's policies", () => {
    const { template } = stackWithConnector();
    const resources = template.findResources("AWS::Lambda::NetworkConnector");
    const connector = Object.values(resources)[0] as { DependsOn?: string[] };
    // The role construct contains no AWS::IAM::Policy (managed policy only),
    // so the dependency resolves to the role itself.
    const roleIds = Object.keys(template.findResources("AWS::IAM::Role"));
    expect(connector.DependsOn).toEqual(expect.arrayContaining(roleIds));
  });

  it("rejects invalid names and too many security groups", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const vpc = isolatedVpc(stack);
    expect(
      () => new MicrovmNetworkConnector(stack, "C1", { vpc, subnets: ISO, name: "bad name!" }),
    ).toThrow(/connector name/);
    const sgs = Array.from(
      { length: 6 },
      (_, i) => new ec2.SecurityGroup(stack, `Sg${i}`, { vpc }),
    );
    expect(
      () => new MicrovmNetworkConnector(stack, "C2", { vpc, subnets: ISO, securityGroups: sgs }),
    ).toThrow(/5 security groups/);
  });
});
