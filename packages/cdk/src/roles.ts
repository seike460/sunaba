import { ArnFormat, aws_iam as iam, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * Service principal `lambda.amazonaws.com` scoped to the stack's account and
 * the given Lambda resource type, per the documented confused-deputy
 * protection for MicroVM roles.
 */
function lambdaMicrovmPrincipal(scope: Construct, sourceResource: string): iam.IPrincipal {
  const stack = Stack.of(scope);
  return new iam.ServicePrincipal("lambda.amazonaws.com").withConditions({
    StringEquals: { "aws:SourceAccount": stack.account },
    ArnLike: {
      "aws:SourceArn": stack.formatArn({
        service: "lambda",
        resource: sourceResource,
        resourceName: "*",
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
    },
  });
}

/** `/aws/lambda-microvms/*` log-group ARN for the current stack. */
export function microvmLogGroupArn(scope: Construct): string {
  return Stack.of(scope).formatArn({
    service: "logs",
    resource: "log-group",
    resourceName: "/aws/lambda-microvms/*",
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}

const LOG_ACTIONS = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"];

/**
 * AWS's MicroVM IAM examples list `sts:TagSession` alongside `sts:AssumeRole`
 * in the trust policy; `ServicePrincipal` can only emit sts:AssumeRole, so
 * tag-session is added to the assume-role document post-creation.
 */
function allowTagSession(role: iam.Role, scope: Construct, sourceResource: string): void {
  role.assumeRolePolicy?.addStatements(
    new iam.PolicyStatement({
      actions: ["sts:TagSession"],
      principals: [lambdaMicrovmPrincipal(scope, sourceResource)],
    }),
  );
}

export interface MicrovmBuildRoleProps extends Omit<iam.RoleProps, "assumedBy"> {
  /**
   * Grant the build role permissions to pull base images from private ECR
   * repositories (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, ...).
   * @default false
   */
  readonly privateEcrAccess?: boolean;
}

/**
 * IAM role assumed by Lambda during a MicroVM image build. Carries the
 * documented minimum permissions (CloudWatch build logs); the MicrovmImage
 * construct additionally grants S3 read access to the code artifact.
 */
export class MicrovmBuildRole extends iam.Role {
  constructor(scope: Construct, id: string, props: MicrovmBuildRoleProps = {}) {
    const { privateEcrAccess, ...roleProps } = props;
    super(scope, id, {
      ...roleProps,
      assumedBy: lambdaMicrovmPrincipal(scope, "microvm-image"),
    });
    allowTagSession(this, scope, "microvm-image");
    this.addToPolicy(
      new iam.PolicyStatement({
        actions: LOG_ACTIONS,
        resources: [microvmLogGroupArn(this)],
      }),
    );
    if (privateEcrAccess) {
      this.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "ecr:GetAuthorizationToken",
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
          ],
          resources: ["*"],
        }),
      );
    }
  }
}

/**
 * IAM role assumed by a running MicroVM (`executionRoleArn`). Carries the
 * documented minimum permissions needed for Lambda to ship application
 * stdout to CloudWatch; grant application permissions on top as needed.
 */
export class MicrovmExecutionRole extends iam.Role {
  constructor(scope: Construct, id: string, props: Omit<iam.RoleProps, "assumedBy"> = {}) {
    super(scope, id, {
      ...props,
      assumedBy: lambdaMicrovmPrincipal(scope, "microvm-image"),
    });
    allowTagSession(this, scope, "microvm-image");
    this.addToPolicy(
      new iam.PolicyStatement({
        actions: LOG_ACTIONS,
        resources: [microvmLogGroupArn(this)],
      }),
    );
  }
}

/**
 * IAM role assumed by Lambda to manage ENIs for a VPC egress network
 * connector. Uses the AWS-managed `AWSLambdaVPCAccessExecutionRole` policy,
 * which contains the required `ec2:*NetworkInterface` permissions.
 */
export class NetworkConnectorOperatorRole extends iam.Role {
  constructor(scope: Construct, id: string, props: Omit<iam.RoleProps, "assumedBy"> = {}) {
    super(scope, id, {
      ...props,
      assumedBy: lambdaMicrovmPrincipal(scope, "network-connector"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
        ...(props.managedPolicies ?? []),
      ],
    });
    allowTagSession(this, scope, "network-connector");
  }
}
