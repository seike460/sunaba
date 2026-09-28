import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  App,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_kms as kms,
  RemovalPolicy,
  Stack,
  aws_s3 as s3,
} from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { MicrovmImage, MicrovmImageSources, MicrovmNetworkConnector } from "../src/index.js";

function stackWithImage(props?: Partial<Parameters<typeof MicrovmImage>[2]>) {
  const app = new App();
  const stack = new Stack(app, "TestStack");
  const image = new MicrovmImage(stack, "Image", {
    source: MicrovmImageSources.fromS3Uri("s3://artifacts-bucket/app.zip"),
    ...props,
  } as Parameters<typeof MicrovmImage>[2]);
  return { stack, image, template: Template.fromStack(stack) };
}

describe("MicrovmImage", () => {
  it("synthesizes a MicrovmImage with defaults", () => {
    const { template } = stackWithImage();
    template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      Name: "TestStack-Image",
      CodeArtifact: { Uri: "s3://artifacts-bucket/app.zip" },
      CpuConfigurations: [{ Architecture: "ARM_64" }],
      Resources: [{ MinimumMemoryInMiB: 2048 }],
      EgressNetworkConnectors: Match.arrayWith([
        {
          "Fn::Join": Match.arrayWith([
            "",
            Match.arrayWith([
              "arn:",
              { Ref: "AWS::Partition" },
              ":lambda:",
              { Ref: "AWS::Region" },
              ":aws:network-connector:aws-network-connector:INTERNET_EGRESS",
            ]),
          ]),
        },
      ]),
      BaseImageArn: Match.objectLike({
        "Fn::Join": Match.arrayWith([
          "",
          Match.arrayWith([
            "arn:",
            { Ref: "AWS::Partition" },
            ":lambda:",
            { Ref: "AWS::Region" },
            ":aws:microvm-image:al2023-1",
          ]),
        ]),
      }),
    });
  });

  it("creates a build role with the documented trust conditions", () => {
    const { template } = stackWithImage();
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
  });

  it("grants the build role S3 read on the artifact and log shipping", () => {
    const { template } = stackWithImage();
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
          Match.objectLike({
            Action: Match.arrayWith(["s3:GetObject", "s3:GetObjectVersion"]),
            Resource: Match.objectLike({
              "Fn::Join": Match.arrayWith([
                "",
                Match.arrayWith([
                  "arn:",
                  { Ref: "AWS::Partition" },
                  ":s3:::artifacts-bucket/app.zip",
                ]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  it("uses a caller-provided build role", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    const role = new iam.Role(stack, "MyRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromS3Uri("s3://bkt/k.zip"),
      buildRole: role,
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      BuildRoleArn: stack.resolve(role.roleArn) as Record<string, unknown>,
    });
  });

  it("packages a local directory as an S3 asset", () => {
    const dir = mkdtempSync(join(tmpdir(), "sunaba-asset-"));
    writeFileSync(join(dir, "Dockerfile"), "FROM al2023\n");
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromDirectory(dir),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      CodeArtifact: { Uri: Match.objectLike({ "Fn::Join": Match.anyValue() }) },
    });
    // Read is limited to the uploaded object, not the bootstrap bucket.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["s3:GetObject", "s3:GetObjectVersion"],
            Resource: {
              "Fn::Join": ["", Match.arrayWith([Match.stringLikeRegexp("^/[0-9a-f]{64}\\.zip$")])],
            },
          }),
        ]),
      },
    });
    expect(JSON.stringify(template.toJSON())).not.toMatch(/s3:List|s3:GetBucket/);
  });

  // Staging a directory asset copies it to <outdir>/asset.<hash>/ — synth for
  // real and walk the staged files so exclusion is verified end to end,
  // including nested paths.
  function synthAssetEntries(source: Parameters<typeof MicrovmImage>[2]["source"]) {
    const outdir = mkdtempSync(join(tmpdir(), "sunaba-out-"));
    const app = new App({ outdir });
    const stack = new Stack(app, "TestStack");
    new MicrovmImage(stack, "Image", { source });
    app.synth();
    const assetDir = readdirSync(outdir).find(
      (f) => f.startsWith("asset.") && statSync(join(outdir, f)).isDirectory(),
    );
    expect(assetDir).toBeDefined();
    const walk = (d: string, prefix = ""): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p, `${prefix}${f}/`) : [`${prefix}${f}`];
      });
    return walk(join(outdir, assetDir as string));
  }

  it("keeps secrets and noise out of directory assets by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "sunaba-asset-"));
    writeFileSync(join(dir, "Dockerfile"), "FROM al2023\n");
    writeFileSync(join(dir, "app.js"), "code\n");
    writeFileSync(join(dir, ".env"), "SECRET=x\n");
    writeFileSync(join(dir, "id_rsa"), "PRIVATE KEY\n");
    writeFileSync(join(dir, "cert.pem"), "PEM\n");
    writeFileSync(join(dir, ".npmrc"), "//registry/:_authToken=x\n");
    writeFileSync(join(dir, ".pypirc"), "[pypi]\n");
    writeFileSync(join(dir, "prod.tfstate"), '{"resources":[]}\n');
    writeFileSync(join(dir, "store.jks"), "JKS\n");
    mkdirSync(join(dir, ".ssh"));
    writeFileSync(join(dir, ".ssh", "id_ed25519"), "KEY\n");
    mkdirSync(join(dir, ".aws"));
    writeFileSync(join(dir, ".aws", "credentials"), "[default]\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x\n");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "git\n");
    // Nested secrets must also be excluded, not just top-level ones.
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "keep.js"), "k\n");
    writeFileSync(join(dir, "sub", ".env"), "NESTED=x\n");
    mkdirSync(join(dir, "sub", "node_modules"));
    writeFileSync(join(dir, "sub", "node_modules", "y.js"), "y\n");
    mkdirSync(join(dir, "sub", ".ssh"));
    writeFileSync(join(dir, "sub", ".ssh", "id_ed25519"), "KEY\n");
    writeFileSync(join(dir, "sub", ".env.local"), "NESTED=x\n");
    writeFileSync(join(dir, "sub", "credentials"), "aws_secret=x\n");
    const entries = synthAssetEntries(MicrovmImageSources.fromDirectory(dir));
    expect(entries.sort()).toEqual(["Dockerfile", "app.js", "sub/keep.js"]);
  });

  it("honours a caller-provided exclude list (replaces the defaults)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sunaba-asset-"));
    writeFileSync(join(dir, "Dockerfile"), "FROM al2023\n");
    writeFileSync(join(dir, ".env"), "kept when caller opts out of defaults\n");
    const entries = synthAssetEntries(
      MicrovmImageSources.fromDirectory(dir, { exclude: ["Dockerfile"] }),
    );
    expect(entries.sort()).toEqual([".env"]);
  });

  it("maps environment, memory, description, base image version", () => {
    const { template } = stackWithImage({
      environment: { FOO: "bar" },
      memoryMiB: 1024,
      description: "test image",
      baseImageVersion: "1",
    });
    template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      EnvironmentVariables: [{ Key: "FOO", Value: "bar" }],
      Resources: [{ MinimumMemoryInMiB: 1024 }],
      Description: "test image",
      BaseImageVersion: "1",
    });
  });

  it("passes hooks and logging through", () => {
    const { template } = stackWithImage({
      hooks: {
        port: 9000,
        microvmHooks: { run: "ENABLED", runTimeoutInSeconds: 5 },
      },
      logging: { disabled: true },
    });
    template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      Hooks: { Port: 9000, MicrovmHooks: { Run: "ENABLED", RunTimeoutInSeconds: 5 } },
      Logging: { Disabled: true },
    });
  });

  it("passes full egress connector ARNs through unchanged", () => {
    const { template } = stackWithImage({
      egressConnectors: ["arn:aws:lambda:us-east-1:123456789012:network-connector:my-connector"],
    });
    template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      EgressNetworkConnectors: [
        "arn:aws:lambda:us-east-1:123456789012:network-connector:my-connector",
      ],
    });
  });

  it("accepts a connector construct in egressConnectors", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    const fake = {
      connectorArn: "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:X",
    };
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromS3Uri("s3://bkt/k.zip"),
      egressConnectors: [fake],
    });
    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::MicrovmImage", {
      EgressNetworkConnectors: [fake.connectorArn],
    });
  });

  it("fromBucket source grants read on that key only", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    const bucket = s3.Bucket.fromBucketName(stack, "Bucket", "real-bucket");
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromBucket(bucket, "k.zip"),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      CodeArtifact: { Uri: "s3://real-bucket/k.zip" },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["s3:GetObject", "s3:GetObjectVersion"],
            Resource: {
              "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":s3:::real-bucket/k.zip"]],
            },
          }),
        ]),
      },
    });
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(/s3:List|s3:GetBucket/);
    expect(json).not.toContain('":s3:::real-bucket"');
  });

  it("fromBucket source grants decrypt on the bucket's KMS key", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    const key = new kms.Key(stack, "Key");
    const bucket = s3.Bucket.fromBucketAttributes(stack, "Bucket", {
      bucketName: "real-bucket",
      encryptionKey: key,
    });
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromBucket(bucket, "k.zip"),
    });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "kms:Decrypt",
            Resource: stack.resolve(key.keyArn) as Record<string, unknown>,
          }),
        ]),
      },
    });
  });

  it("fromBucket falls back to the bucket policy for an immutable role", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const bucket = new s3.Bucket(stack, "Bucket");
    const role = iam.Role.fromRoleArn(stack, "Imported", "arn:aws:iam::123456789012:role/ext", {
      mutable: false,
    });
    const image = new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromBucket(bucket, "k.zip"),
      buildRole: role,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: ["s3:GetObject", "s3:GetObjectVersion"],
            Principal: { AWS: "arn:aws:iam::123456789012:role/ext" },
          }),
        ],
      },
    });
    const policyIds = Object.keys(template.findResources("AWS::S3::BucketPolicy"));
    const resource = Object.values(template.findResources("AWS::Lambda::MicrovmImage"))[0] as {
      DependsOn?: string[];
    };
    expect(resource.DependsOn ?? []).toEqual(expect.arrayContaining(policyIds));
    expect(image.node.metadata.filter((m) => m.type === "aws:cdk:warning")).toHaveLength(0);
  });

  it("applies a custom removal policy", () => {
    const { template } = stackWithImage({ removalPolicy: RemovalPolicy.RETAIN });
    const resources = template.findResources("AWS::Lambda::MicrovmImage");
    expect(Object.values(resources)[0]?.DeletionPolicy).toBe("Retain");
  });

  it("image resource depends on the build role's default policy", () => {
    const { stack } = stackWithImage();
    const template = Template.fromStack(stack);
    const images = template.findResources("AWS::Lambda::MicrovmImage");
    const image = Object.values(images)[0] as { DependsOn?: string[] };
    const policyIds = Object.keys(template.findResources("AWS::IAM::Policy"));
    expect(image.DependsOn).toEqual(expect.arrayContaining(policyIds));
  });

  it("image resource depends on the imported role's grant policy", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const role = iam.Role.fromRoleArn(stack, "Imported", "arn:aws:iam::123456789012:role/ext");
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromS3Uri("s3://bkt/k.zip"),
      buildRole: role,
    });
    const template = Template.fromStack(stack);
    const images = template.findResources("AWS::Lambda::MicrovmImage");
    const image = Object.values(images)[0] as { DependsOn?: string[] };
    const policyIds = Object.keys(template.findResources("AWS::IAM::Policy"));
    expect(policyIds.length).toBeGreaterThan(0);
    expect(image.DependsOn ?? []).toEqual(expect.arrayContaining(policyIds));
  });

  it("image resource depends on the grant policy for a directory asset + imported role", () => {
    const dir = mkdtempSync(join(tmpdir(), "sunaba-asset-"));
    writeFileSync(join(dir, "Dockerfile"), "FROM al2023\n");
    const app = new App();
    const stack = new Stack(app, "T");
    const role = iam.Role.fromRoleArn(stack, "Imported", "arn:aws:iam::123456789012:role/ext");
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromDirectory(dir),
      buildRole: role,
    });
    const template = Template.fromStack(stack);
    const image = Object.values(template.findResources("AWS::Lambda::MicrovmImage"))[0] as {
      DependsOn?: string[];
    };
    const policyIds = Object.keys(template.findResources("AWS::IAM::Policy"));
    expect(policyIds.length).toBeGreaterThan(0);
    expect(image.DependsOn ?? []).toEqual(expect.arrayContaining(policyIds));
  });

  it("emits no warning for a same-stack mutable build role", () => {
    const { image } = stackWithImage();
    expect(image.node.metadata.filter((m) => m.type === "aws:cdk:warning")).toHaveLength(0);
  });

  it("resolves a real MicrovmNetworkConnector in egressConnectors", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const vpc = new ec2.Vpc(stack, "Vpc", { natGateways: 0 });
    const conn = new MicrovmNetworkConnector(stack, "Conn", {
      vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromS3Uri("s3://bkt/k.zip"),
      egressConnectors: [conn],
    });
    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::MicrovmImage", {
      EgressNetworkConnectors: [stack.resolve(conn.connectorArn) as Record<string, unknown>],
    });
  });

  it("attaches the artifact grant as a standalone policy for mutable imported roles", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const role = iam.Role.fromRoleArn(stack, "Imported", "arn:aws:iam::123456789012:role/ext");
    new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromS3Uri("s3://bkt/k.zip"),
      buildRole: role,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Policy", {
      Roles: ["ext"],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:GetObject", "s3:GetObjectVersion"]),
          }),
        ]),
      },
    });
  });

  it("warns when the artifact grant is silently dropped by an immutable role", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const role = iam.Role.fromRoleArn(stack, "Imported", "arn:aws:iam::123456789012:role/ext", {
      mutable: false,
    });
    const image = new MicrovmImage(stack, "Image", {
      source: MicrovmImageSources.fromS3Uri("s3://bkt/k.zip"),
      buildRole: role,
    });
    const warnings = image.node.metadata.filter((m) => m.type === "aws:cdk:warning");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects invalid inputs", () => {
    const app = new App();
    const stack = new Stack(app, "T");
    const src = MicrovmImageSources.fromS3Uri("s3://bkt/k.zip");
    expect(() => new MicrovmImage(stack, "I1", { source: src, memoryMiB: 0 })).toThrow(/memoryMiB/);
    expect(() => new MicrovmImage(stack, "I2", { source: src, name: " " })).toThrow(/image name/);
    expect(() => MicrovmImageSources.fromS3Uri("https://b/k")).toThrow(/S3 URI/);
    // IAM wildcards in a key would widen the object-level grant.
    expect(() => MicrovmImageSources.fromS3Uri("s3://bkt/*.zip")).toThrow(/wildcard/);
    const bkt = s3.Bucket.fromBucketName(stack, "Bkt2", "real-bucket");
    expect(() => MicrovmImageSources.fromBucket(bkt, "app-?.zip")).toThrow(/wildcard/);
    // CreateMicrovmImage accepts at most ONE egress connector (AWS API limit).
    expect(
      () =>
        new MicrovmImage(stack, "I3", {
          source: src,
          egressConnectors: ["INTERNET_EGRESS", "INTERNET_EGRESS"],
        }),
    ).toThrow(/at most 1/);
    expect(
      () =>
        new MicrovmImage(stack, "I4", {
          source: src,
          environment: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, "v"])),
        }),
    ).toThrow(/50/);
    expect(
      () => new MicrovmImage(stack, "I5", { source: src, additionalOsCapabilities: ["X"] }),
    ).toThrow(/ALL/);
    expect(
      () => new MicrovmImage(stack, "I6", { source: src, egressConnectors: ["bad name"] }),
    ).toThrow(/managed connector/);
  });
});
