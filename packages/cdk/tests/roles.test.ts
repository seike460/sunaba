import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { MicrovmBuildRole, MicrovmExecutionRole, microvmLogGroupArn } from "../src/index.js";

describe("MicrovmExecutionRole", () => {
  it("has the documented trust policy and log shipping permissions", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    new MicrovmExecutionRole(stack, "Role");
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRole",
            Principal: { Service: "lambda.amazonaws.com" },
            Condition: {
              StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
              ArnLike: {
                "aws:SourceArn": Match.objectLike({
                  "Fn::Join": Match.arrayWith([
                    "",
                    Match.arrayWith([{ Ref: "AWS::AccountId" }, ":microvm-image:*"]),
                  ]),
                }),
              },
            },
          }),
          Match.objectLike({ Action: "sts:TagSession" }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ]),
          }),
        ]),
      },
    });
  });
});

describe("MicrovmBuildRole", () => {
  it("optionally grants private ECR pull permissions", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    new MicrovmBuildRole(stack, "Role", { privateEcrAccess: true });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ecr:GetAuthorizationToken", "ecr:BatchGetImage"]),
            Resource: "*",
          }),
        ]),
      },
    });
  });
});

describe("microvmLogGroupArn", () => {
  it("resolves the /aws/lambda-microvms/* log-group ARN", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const resolved = stack.resolve(microvmLogGroupArn(stack));
    expect(JSON.stringify(resolved)).toContain("log-group:/aws/lambda-microvms/*");
    expect(JSON.stringify(resolved)).not.toContain("log-group//");
    expect(JSON.stringify(resolved)).toContain('"Ref":"AWS::Partition"');
  });
});
