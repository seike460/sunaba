import { SunabaError } from "./errors.js";

/**
 * AWS-managed network connectors for Lambda MicroVMs.
 *
 * Managed connectors are referenced by ARN:
 *   arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:{NAME}
 *
 * Ingress connectors control inbound traffic to the MicroVM endpoint.
 * Egress connectors control outbound traffic (INTERNET_EGRESS or
 * customer-managed VPC egress connectors created via lambda-core).
 */
export const ManagedIngressConnector = {
  /** Inbound HTTPS to the MicroVM endpoint, JWE-authenticated. */
  ALL: "ALL_INGRESS",
  /** No inbound connectivity. */
  NONE: "NO_INGRESS",
  /** WebSocket PTY shell access on /shell (port 8022). */
  SHELL: "SHELL_INGRESS",
} as const;

export type ManagedIngressConnector =
  (typeof ManagedIngressConnector)[keyof typeof ManagedIngressConnector];

export const ManagedEgressConnector = {
  /** Default public internet egress. */
  INTERNET: "INTERNET_EGRESS",
} as const;

export type ManagedEgressConnector =
  (typeof ManagedEgressConnector)[keyof typeof ManagedEgressConnector];

const MANAGED_INFIX = ":aws:network-connector:aws-network-connector:";

/** AWS partition for a region — commercial "aws" unless gov/cn. */
export function partitionForRegion(region: string): string {
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("cn-")) return "aws-cn";
  return "aws";
}

/** Managed connector names are uppercase constants like ALL_INGRESS. */
const MANAGED_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function isManagedConnectorName(value: string): boolean {
  return !value.startsWith("arn:") && MANAGED_NAME_RE.test(value);
}

/**
 * Resolves a connector reference to an ARN. Managed connector names
 * (ALL_INGRESS, NO_INGRESS, SHELL_INGRESS, INTERNET_EGRESS) are expanded
 * to their regional managed ARN; full ARNs pass through unchanged.
 */
export function connectorArn(ref: string, region?: string): string {
  if (ref.startsWith("arn:")) return ref;
  if (!MANAGED_NAME_RE.test(ref)) {
    throw new SunabaError(
      "BadConnector",
      `invalid connector reference '${ref}': expected a managed name or ARN`,
    );
  }
  if (!region) {
    throw new SunabaError("NoRegion", `a region is required to resolve managed connector '${ref}'`);
  }
  return `arn:${partitionForRegion(region)}:lambda:${region}${MANAGED_INFIX}${ref}`;
}

export function connectorArns(
  refs: readonly string[] | undefined,
  region?: string,
): string[] | undefined {
  return refs?.map((r) => connectorArn(r, region));
}
