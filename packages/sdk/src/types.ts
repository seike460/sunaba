import type {
  CreateMicrovmImageRequest,
  Hooks,
  LambdaMicrovmsClientConfig,
  Logging,
  MicrovmState,
} from "@aws-sdk/client-lambda-microvms";

export type { Hooks, Logging, MicrovmState };

/** Request body accepted by the MicroVM HTTPS endpoint (undici/fetch). */
export type RequestBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream
  | null;

/**
 * Idle policy for automatic suspend/resume.
 * - maxIdleDurationSeconds: suspend after this much endpoint inactivity (max 28800)
 * - suspendedDurationSeconds: terminate after being suspended this long
 * - autoResumeEnabled: resume when traffic arrives at the endpoint
 */
export interface IdlePolicy {
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
  autoResumeEnabled: boolean;
}

export const DEFAULT_IDLE_POLICY: IdlePolicy = {
  maxIdleDurationSeconds: 900,
  suspendedDurationSeconds: 300,
  autoResumeEnabled: true,
};

/** Maximum lifetime of a MicroVM (8 hours). */
export const MAX_MICROVM_DURATION_SECONDS = 28800;

/**
 * Port authorization for endpoint auth tokens.
 * - number: a single port
 * - "all": every port
 * - { from, to }: an inclusive port range
 */
export type PortSpec = number | "all" | { from: number; to: number };

/** Client injection point: a real LambdaMicrovmsClient, config, or test stub. */
export interface ClientOptions {
  /** AWS region. Defaults to AWS_REGION/AWS_DEFAULT_REGION env or the client's. */
  region?: string;
  /** Pre-configured client (useful for tests or custom credentials). */
  client?: LambdaMicrovmsClientLike;
  /** Passed to LambdaMicrovmsClient when `client` is not given. */
  clientConfig?: LambdaMicrovmsClientConfig;
}

/**
 * The single method surface sunaba needs from the AWS SDK client.
 * Structural so tests can inject fakes; a real LambdaMicrovmsClient satisfies it.
 */
export interface LambdaMicrovmsClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface ExecResult {
  /** Combined output emitted between the command and the end marker. */
  output: string;
  /** Shell exit code of the command. */
  exitCode: number;
}

export interface ExecOptions {
  /** Wall-clock budget for the command. Default 120s. */
  timeoutMs?: number;
  /** Working directory inside the MicroVM. */
  cwd?: string;
  /**
   * Override the shell WebSocket URL (ws://...) for local testing/emulators.
   * Default `wss://{endpoint}/shell`.
   */
  urlOverride?: string;
  /** Cap retained shell output (bytes). Default 16 MiB; oldest data drops. */
  maxOutputBytes?: number;
}

export interface RequestOptions {
  /** Target port inside the MicroVM. Default 8080 (the endpoint default). */
  port?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: RequestBody;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /**
   * Allow automatic retries for a non-idempotent method. Off by default:
   * GET/HEAD/PUT/DELETE/OPTIONS/TRACE retry on auth-refresh and 429/5xx,
   * other methods do not (a lost response could re-run a side effect).
   */
  retry?: boolean;
}

export interface SandboxCreateOptions extends ClientOptions {
  /** Image ARN (arn:...:microvm-image:name) or image name to resolve. */
  image: string;
  /** Image version "major.minor". Defaults to the latest ACTIVE version. */
  imageVersion?: string;
  executionRoleArn?: string;
  idlePolicy?: IdlePolicy;
  maximumDurationSeconds?: number;
  /**
   * Ingress connector refs: managed names (HTTP_INGRESS, SHELL_INGRESS,
   * ALL_INGRESS, NO_INGRESS) or full ARNs. ALL_INGRESS cannot be combined
   * with other connectors. Default [HTTP_INGRESS, SHELL_INGRESS] so both
   * request() and exec() work.
   */
  ingress?: readonly string[];
  /**
   * Egress connector refs: INTERNET_EGRESS (default if omitted),
   * or customer-managed VPC egress connector ARNs.
   */
  egress?: readonly string[];
  /** Up to 16 KiB delivered to the /run hook as runHookPayload. */
  runHookPayload?: string;
  logging?: Logging;
  /** Auth token TTL in minutes (max per token). Default 30. */
  tokenTtlMinutes?: number;
  /** Port scope baked into auth tokens. Default "all". */
  allowedPorts?: readonly PortSpec[];
  /** Milliseconds to wait for RUNNING after RunMicrovm. Default 120_000. */
  runTimeoutMs?: number;
  /** Idempotency token forwarded to RunMicrovm. */
  clientToken?: string;
  /**
   * Called synchronously once RunMicrovm succeeds — before the RUNNING
   * wait — so callers can register cleanup (e.g. signal handlers) for a
   * MicroVM that exists but isn't running yet.
   */
  onMicrovmCreated?: (microvmId: string) => void;
}

export interface SandboxConnectOptions extends ClientOptions {
  tokenTtlMinutes?: number;
  allowedPorts?: readonly PortSpec[];
  /**
   * When the target is SUSPENDED, resume it first. Default true.
   */
  resume?: boolean;
  /** Milliseconds to wait for RUNNING when resuming. Default 120_000. */
  runTimeoutMs?: number;
}

export interface MicrovmImageBuildOptions extends ClientOptions {
  /** Image name: 1-64 chars, [a-zA-Z0-9-_]. */
  name: string;
  description?: string;
  /**
   * Source for the code artifact. Exactly one of:
   * - `dir`: directory containing a Dockerfile (zipped with fflate)
   * - `zip`: path to a pre-built zip file
   * - `s3Uri`: existing s3://bucket/key artifact
   */
  source: { dir: string } | { zip: string } | { s3Uri: string };
  /** Bucket for uploads when source is dir/zip. */
  artifactBucket?: string;
  /** S3 key prefix. Default "sunaba/images/". */
  artifactPrefix?: string;
  /** Managed base image ARN, e.g. arn:aws:lambda:{region}:aws:microvm-image:al2023-1 */
  baseImageArn: string;
  /** Pin a managed base image version. Latest when omitted. */
  baseImageVersion?: string;
  buildRoleArn: string;
  /** Baseline memory in MiB: 512 | 1024 | 2048 | 4096 | 8192. Service default is 2048 (2 GB / 1 vCPU) when unset. */
  memoryMiB?: number;
  /** CPU architecture. Currently ARM_64 is the only published value. */
  architecture?: "ARM_64";
  environment?: Record<string, string>;
  /** Build+runtime egress connector ARNs (VPC egress). */
  egressConnectors?: readonly string[];
  hooks?: Hooks;
  logging?: Logging;
  /** Additional OS capabilities. */
  additionalOsCapabilities?: CreateMicrovmImageRequest["additionalOsCapabilities"];
  tags?: Record<string, string>;
  /** Idempotency token forwarded to CreateMicrovmImage. */
  clientToken?: string;
  /** Poll timeout for the version build. Default 900_000 (15 min). */
  buildTimeoutMs?: number;
  /**
   * Injected S3 client for artifact uploads (tests/custom config).
   * Defaults to a client sharing the caller's credentials + region.
   */
  s3Client?: { send(command: unknown): Promise<unknown> };
}

export interface MicrovmImageBuildResult {
  imageArn: string;
  /** The version that was just built ("1.0", "1.1", ...). */
  imageVersion: string;
  state: string;
}
