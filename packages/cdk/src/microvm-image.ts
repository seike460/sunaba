import {
  Annotations,
  ArnFormat,
  aws_iam as iam,
  aws_lambda as lambda,
  RemovalPolicy,
  Stack,
  type aws_s3 as s3,
  aws_s3_assets as s3assets,
  Token,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  ManagedBaseImage,
  ManagedEgressConnector,
  type MicrovmConnectorRef,
  managedBaseImageArn,
  resolveConnectorArns,
} from "./managed.js";
import { MicrovmBuildRole } from "./roles.js";

interface BoundSource {
  readonly uri: string;
  /**
   * Grants the build role read access to the artifact. Returns the grant
   * result when available so callers can detect silent failures (e.g. an
   * imported role with `mutable: false`).
   */
  grantRead(grantee: iam.IGrantable): iam.AddToPrincipalPolicyResult | iam.Grant | undefined;
}

const S3_URI_RE = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+)$/;

/** Where the image build's code artifact (app zip + Dockerfile) lives. */
export interface MicrovmImageSource {
  /** Binds the source inside the image construct (may create resources). */
  bind(scope: Construct): BoundSource;
}

const OBJECT_READ_ACTIONS = ["s3:GetObject", "s3:GetObjectVersion"];

/**
 * Object-level read on one key. `bucket.grantRead(grantee, key)` would also
 * grant `s3:List*` and `s3:GetBucket*` on the bucket itself.
 */
function grantObjectRead(bucket: s3.IBucket, key: string, grantee: iam.IGrantable): iam.Grant {
  bucket.encryptionKey?.grantDecrypt(grantee);
  return iam.Grant.addToPrincipalOrResource({
    grantee,
    actions: OBJECT_READ_ACTIONS,
    resourceArns: [bucket.arnForObjects(key)],
    resource: bucket,
  });
}

/** IAM resource wildcards in a key would widen the artifact grant. */
function assertNoIamWildcard(key: string): void {
  if (/[*?]/.test(key)) {
    throw new Error(
      `code artifact key '${key}' contains an IAM wildcard (* or ?) — the grant would cover other objects`,
    );
  }
}

/**
 * Code artifact source for {@link MicrovmImage}. Use
 * `MicrovmImageSource.fromDirectory()` for local code (uploaded via the CDK
 * bootstrap bucket), `fromS3Uri()`/`fromBucket()` for artifacts already in S3.
 */
export const MicrovmImageSources = {
  /** Package an S3 URI like `s3://bucket/key.zip`. */
  fromS3Uri(uri: string): MicrovmImageSource {
    const m = S3_URI_RE.exec(uri);
    if (!m) {
      throw new Error(`invalid code artifact S3 URI '${uri}' (expected s3://bucket/key)`);
    }
    const bucketName = m[1] as string;
    const key = m[2] as string;
    assertNoIamWildcard(key);
    return {
      bind: (scope) => {
        const objectArn = Stack.of(scope).formatArn({
          service: "s3",
          region: "",
          account: "",
          resource: bucketName,
          resourceName: key,
          arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        });
        return {
          uri,
          grantRead: (grantee) =>
            grantee.grantPrincipal.addToPrincipalPolicy(
              new iam.PolicyStatement({
                actions: OBJECT_READ_ACTIONS,
                resources: [objectArn],
              }),
            ),
        };
      },
    };
  },

  /** Package an S3 bucket object. Read access is scoped to that key only. */
  fromBucket(bucket: s3.IBucket, key: string): MicrovmImageSource {
    requireNonEmpty(key, "code artifact object key");
    assertNoIamWildcard(key);
    return {
      bind: () => ({
        uri: `s3://${bucket.bucketName}/${key}`,
        grantRead: (grantee) => grantObjectRead(bucket, key, grantee),
      }),
    };
  },

  /**
   * Package a local directory containing the Dockerfile and application code.
   * The directory is zipped and uploaded to the CDK bootstrap S3 bucket at
   * deploy time (like `lambda.Code.fromAsset`).
   *
   * `options.exclude` are .gitignore-style patterns REPLACING the safe
   * defaults ({@link DEFAULT_EXCLUDE_PATTERNS}), which keep secrets like
   * `.env` and private keys out of the uploaded artifact.
   */
  fromDirectory(path: string, options?: { exclude?: string[] }): MicrovmImageSource {
    const exclude = options?.exclude ?? [...DEFAULT_EXCLUDE_PATTERNS];
    return {
      bind: (scope) => {
        const asset = new s3assets.Asset(scope, "CodeArtifact", { path, exclude });
        return {
          uri: `s3://${asset.bucket.bucketName}/${asset.s3ObjectKey}`,
          grantRead: (grantee) => grantObjectRead(asset.bucket, asset.s3ObjectKey, grantee),
        };
      },
    };
  },
} as const;

/**
 * Default exclusion patterns for `MicrovmImageSources.fromDirectory` —
 * keeps credentials and VCS metadata out of the build artifact.
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  // VCS / dependency noise.
  ".git",
  "**/.git",
  "node_modules",
  "**/node_modules",
  // Env files.
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".envrc",
  "**/.envrc",
  // Private keys and cert stores.
  "*.pem",
  "**/*.pem",
  "*.key",
  "**/*.key",
  "*.p12",
  "**/*.p12",
  "*.pfx",
  "**/*.pfx",
  "*.ppk",
  "**/*.ppk",
  "id_rsa*",
  "**/id_rsa*",
  "id_ed25519*",
  "**/id_ed25519*",
  "id_ecdsa*",
  "**/id_ecdsa*",
  "id_dsa*",
  "**/id_dsa*",
  // Credential-bearing dotdirs and files.
  ".aws",
  "**/.aws",
  ".ssh",
  "**/.ssh",
  ".gnupg",
  "**/.gnupg",
  ".docker",
  "**/.docker",
  ".kube",
  "**/.kube",
  ".terraform",
  "**/.terraform",
  ".npmrc",
  "**/.npmrc",
  ".netrc",
  "**/.netrc",
  ".pgpass",
  "**/.pgpass",
  ".pypirc",
  "**/.pypirc",
  ".git-credentials",
  "**/.git-credentials",
  "credentials",
  "**/credentials",
  "*.keystore",
  "**/*.keystore",
  "*.jks",
  "**/*.jks",
  // Terraform state carries plaintext secrets — including backups
  // like terraform.tfstate.backup / .tfstate~.
  "*.tfstate*",
  "**/*.tfstate*",
];

export interface MicrovmImageProps {
  /** Code artifact source (app zip + Dockerfile). */
  readonly source: MicrovmImageSource;
  /**
   * Image name, unique per account. Defaults to the construct ID combined
   * with the stack name.
   */
  readonly name?: string;
  /** Human-readable description. */
  readonly description?: string;
  /**
   * Base image ARN. Defaults to the AWS-managed Amazon Linux 2023 image in
   * the stack's region.
   */
  readonly baseImageArn?: string;
  /**
   * Version of the base image. For AWS-managed base images this is a bare
   * integer version (`"0"`, `"1"`, ...) listing the managed base's published
   * versions — CloudFormation requires a value.
   * @default "0" (earliest published managed base version)
   */
  readonly baseImageVersion?: string;
  /**
   * IAM role assumed during the image build. Defaults to a
   * {@link MicrovmBuildRole} with the documented minimum permissions plus
   * read access to the code artifact.
   */
  readonly buildRole?: iam.IRole;
  /** Build-time environment variables. */
  readonly environment?: Record<string, string>;
  /** Minimum memory for MicroVMs launched from this image. */
  readonly memoryMiB?: number;
  /**
   * CPU architecture of the image build. Lambda MicroVMs currently support
   * `ARM_64` only (per CloudFormation validation); exposed for future
   * architectures.
   * @default "ARM_64"
   */
  readonly architecture?: "ARM_64";
  /**
   * Egress connectors for MicroVMs launched from this image. Accepts managed
   * connector names, connector ARNs, or `MicrovmNetworkConnector` constructs.
   * @default [ManagedEgressConnector.INTERNET]
   */
  readonly egressConnectors?: MicrovmConnectorRef[];
  /** Lifecycle hook configuration (enablement, timeouts, port). */
  readonly hooks?: lambda.CfnMicrovmImage.HooksProperty;
  /** Logging configuration. */
  readonly logging?: lambda.CfnMicrovmImage.LoggingProperty;
  /** Extra OS capabilities. */
  readonly additionalOsCapabilities?: string[];
  /**
   * Removal policy applied to the image when the stack is deleted.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

/** CloudFormation `Name` constraints: `^[a-zA-Z0-9-_]+$`, max 64. */
const NAME_RE = /^[a-zA-Z0-9-_]{1,64}$/;
// CreateMicrovmImage accepts at most ONE egress connector per image.
const MAX_EGRESS = 1;
const MAX_ENV = 50;

function requireNonEmpty(value: string, what: string): void {
  if (!value.trim()) throw new Error(`${what} must not be empty`);
}

/**
 * L2 construct for `AWS::Lambda::MicrovmImage` — a MicroVM image built from
 * a code artifact on top of a base image. Bind {@link MicrovmImage#imageArn}
 * into your `run-microvm` calls (e.g. via the `sunaba` SDK or CLI).
 */
export class MicrovmImage extends Construct {
  /** ARN of the MicroVM image (`{ Ref }`-equivalent attribute). */
  readonly imageArn: string;
  /** The build role Lambda assumes while building image versions. */
  readonly buildRole: iam.IRole;
  /** Underlying L1 resource. */
  readonly resource: lambda.CfnMicrovmImage;

  constructor(scope: Construct, id: string, props: MicrovmImageProps) {
    super(scope, id);

    const name = props.name ?? `${Stack.of(this).stackName}-${id}`;
    if (!Token.isUnresolved(name) && !NAME_RE.test(name)) {
      throw new Error(
        `image name '${name}' must match ^[a-zA-Z0-9-_]{1,64}$ (alphanumeric, hyphens, underscores)`,
      );
    }
    if (props.description !== undefined) requireNonEmpty(props.description, "description");

    // CloudFormation requires Resources, so we can't omit it to inherit
    // the service-side default — default to the same 2048 the API applies.
    const memoryMiB = props.memoryMiB ?? 2048;
    if (![512, 1024, 2048, 4096, 8192].includes(memoryMiB)) {
      throw new Error("memoryMiB must be one of 512, 1024, 2048, 4096, 8192");
    }
    if (props.architecture !== undefined && props.architecture !== "ARM_64") {
      throw new Error('architecture currently only supports "ARM_64"');
    }
    if (props.baseImageVersion !== undefined && !/^\S+$/.test(props.baseImageVersion)) {
      throw new Error("baseImageVersion must not contain whitespace");
    }
    const environment = props.environment ?? {};
    if (Object.keys(environment).length > MAX_ENV) {
      throw new Error(`environment supports at most ${MAX_ENV} variables`);
    }
    for (const k of Object.keys(environment)) {
      requireNonEmpty(k, "environment variable key");
    }

    const egress = props.egressConnectors ?? [ManagedEgressConnector.INTERNET];
    if (egress.length > MAX_EGRESS) {
      throw new Error(`egressConnectors supports at most ${MAX_EGRESS} entries`);
    }
    for (const cap of props.additionalOsCapabilities ?? []) {
      if (cap !== "ALL") {
        throw new Error(`additionalOsCapabilities only allows "ALL", got '${cap}'`);
      }
    }
    const bound = props.source.bind(this);
    this.buildRole = props.buildRole ?? new MicrovmBuildRole(this, "BuildRole");
    const grant = bound.grantRead(this.buildRole);
    // A Grant falls back to the artifact's resource policy when the role
    // rejects statements, so only bare principal-policy paths need a drop
    // check. Imported roles wrapped by `mutable: false` report success
    // while discarding principal statements — detect them by class name.
    const immutable =
      !(this.buildRole instanceof iam.Role) &&
      this.buildRole.constructor.name.startsWith("ImmutableRole");
    const grantFailed =
      grant instanceof iam.Grant ? !grant.success : immutable || grant?.statementAdded === false;
    if (grantFailed) {
      Annotations.of(this).addWarning(
        `could not attach code-artifact read permissions to build role '${this.buildRole.roleName}' — grant s3:GetObject on '${bound.uri}' manually`,
      );
    }

    this.resource = new lambda.CfnMicrovmImage(this, "Resource", {
      name,
      description: props.description ?? "",
      baseImageArn: props.baseImageArn ?? managedBaseImageArn(this, ManagedBaseImage.AL2023),
      baseImageVersion: props.baseImageVersion ?? "0",
      buildRoleArn: this.buildRole.roleArn,
      codeArtifact: { uri: bound.uri },
      cpuConfigurations: [{ architecture: props.architecture ?? "ARM_64" }],
      resources: [{ minimumMemoryInMiB: memoryMiB }],
      environmentVariables: Object.entries(environment).map(([key, value]) => ({
        key,
        value,
      })),
      egressNetworkConnectors: resolveConnectorArns(this, egress),
      hooks: props.hooks ?? {},
      logging: props.logging ?? {},
      additionalOsCapabilities: props.additionalOsCapabilities ?? [],
    });
    this.resource.applyRemovalPolicy(props.removalPolicy ?? RemovalPolicy.DESTROY);
    // The image build assumes the build role; depending on the role
    // construct covers every IAM::Policy created beneath it (DefaultPolicy,
    // imported-role Policy children) regardless of when they're added.
    this.resource.node.addDependency(this.buildRole);
    // Grant dependables additionally cover resource-side policies (e.g. a
    // bucket policy) when the principal couldn't take the statement.
    if (grant instanceof iam.Grant) {
      grant.applyBefore(this.resource);
    } else {
      // AddToPrincipalPolicyResult (or duck-typed equivalent) carries the
      // dependable directly.
      const dep = (grant as iam.AddToPrincipalPolicyResult | undefined)?.policyDependable;
      if (dep) this.resource.node.addDependency(dep);
    }
    this.imageArn = this.resource.attrImageArn;
  }
}
