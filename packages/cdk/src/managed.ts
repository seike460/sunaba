import { ArnFormat, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * AWS-managed ingress connectors for Lambda MicroVMs.
 * Expanded to the regional managed connector ARN:
 *   arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:{NAME}
 */
export const ManagedIngressConnector = {
  /** All inbound traffic. Cannot be combined with other ingress connectors. */
  ALL: "ALL_INGRESS",
  /** Inbound HTTPS to the MicroVM endpoint, JWE-authenticated. */
  HTTP: "HTTP_INGRESS",
  /** No inbound connectivity. */
  NONE: "NO_INGRESS",
  /** WebSocket PTY shell access on /shell (port 8022). */
  SHELL: "SHELL_INGRESS",
} as const;
export type ManagedIngressConnector =
  (typeof ManagedIngressConnector)[keyof typeof ManagedIngressConnector];

/** AWS-managed egress connectors. */
export const ManagedEgressConnector = {
  /** Default public internet egress. */
  INTERNET: "INTERNET_EGRESS",
} as const;
export type ManagedEgressConnector =
  (typeof ManagedEgressConnector)[keyof typeof ManagedEgressConnector];

/** AWS-managed base images for MicroVMs. */
export const ManagedBaseImage = {
  /** Amazon Linux 2023 base (version identifier `al2023-1`). */
  AL2023: "al2023-1",
} as const;
export type ManagedBaseImage = (typeof ManagedBaseImage)[keyof typeof ManagedBaseImage];

const MANAGED_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** Managed base image names are lowercase identifiers like `al2023-1`. */
const MANAGED_BASE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Minimal reference a network connector construct exposes to a MicrovmImage. */
export interface IMicrovmNetworkConnector {
  readonly connectorArn: string;
}

/**
 * Connector reference accepted by {@link MicrovmImage} egress connectors:
 * a managed connector name (e.g. `INTERNET_EGRESS`), a full connector ARN,
 * or a connector construct exposing `connectorArn`.
 */
export type MicrovmConnectorRef = string | IMicrovmNetworkConnector;

/** Regional ARN of an AWS-managed network connector. */
export function managedConnectorArn(scope: Construct, name: string): string {
  if (!MANAGED_NAME_RE.test(name)) {
    throw new Error(`invalid managed connector name '${name}'`);
  }
  return Stack.of(scope).formatArn({
    service: "lambda",
    account: "aws",
    resource: "network-connector",
    resourceName: `aws-network-connector:${name}`,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}

/** Regional ARN of an AWS-managed base image (e.g. `al2023-1`). */
export function managedBaseImageArn(scope: Construct, name: string): string {
  if (!MANAGED_BASE_NAME_RE.test(name)) {
    throw new Error(`invalid managed base image name '${name}'`);
  }
  return Stack.of(scope).formatArn({
    service: "lambda",
    account: "aws",
    resource: "microvm-image",
    resourceName: name,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}

/** Resolves connector references to ARNs usable in CloudFormation. */
export function resolveConnectorArns(
  scope: Construct,
  refs: readonly MicrovmConnectorRef[],
): string[] {
  return refs.map((ref) => {
    if (typeof ref !== "string") {
      if (ref == null || !ref.connectorArn) {
        throw new Error("connector reference must expose a connectorArn");
      }
      return ref.connectorArn;
    }
    if (ref.startsWith("arn:")) return ref;
    return managedConnectorArn(scope, ref);
  });
}
