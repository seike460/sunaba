import { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import { isManagedConnectorName } from "./connectors.js";
import { SunabaError } from "./errors.js";
import type { ClientOptions, LambdaMicrovmsClientLike } from "./types.js";

export function resolveClient(opts: ClientOptions): LambdaMicrovmsClientLike {
  if (opts.client) return opts.client;
  return new LambdaMicrovmsClient({
    ...(opts.clientConfig ?? {}),
    // An explicit `region` always wins over clientConfig.region.
    ...(opts.region ? { region: opts.region } : {}),
  });
}

export async function resolveRegion(opts: ClientOptions): Promise<string> {
  if (opts.region) return opts.region;
  // An injected client executes the requests, so its region is authoritative
  // — resolveClient ignores clientConfig entirely when client is set, and a
  // clientConfig region would only build ARNs for the wrong partition/region.
  const clientRegion = (opts.client as { config?: { region?: unknown } } | undefined)?.config
    ?.region;
  if (typeof clientRegion === "string") return clientRegion;
  if (typeof clientRegion === "function") {
    const r = await (clientRegion as () => Promise<string>)();
    if (r) return r;
  }
  const cfgRegion = opts.clientConfig?.region;
  if (typeof cfgRegion === "string") return cfgRegion;
  if (typeof cfgRegion === "function") {
    const r = await cfgRegion();
    if (r) return r;
  }
  // `||` so an empty-string AWS_REGION doesn't shadow AWS_DEFAULT_REGION.
  const env = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (env) return env;
  // Last resort: the DEFAULT provider chain (~/.aws/config profiles, SSO,
  // IMDS) via a freshly constructed client. An injected client was already
  // consulted above — building one from clientConfig alone reaches the
  // ambient chain without letting a fake veto it. A client that can't
  // resolve throws "Region is missing" here, which just means "not found".
  const provider = (
    resolveClient({ clientConfig: opts.clientConfig }) as {
      config?: { region?: unknown };
    }
  ).config?.region;
  const resolved =
    typeof provider === "function"
      ? await provider().catch((e: unknown) => {
          if (e instanceof Error && e.message === "Region is missing") return undefined;
          throw e;
        })
      : provider;
  if (typeof resolved === "string" && resolved) return resolved;
  throw new SunabaError(
    "NoRegion",
    "region is required: pass `region`, set AWS_REGION, or configure clientConfig.region",
  );
}

/**
 * Region needed only to expand managed connector names into ARNs.
 * When every connector is already an ARN, no region is required.
 */
export async function regionForConnectors(
  opts: ClientOptions,
  refs: readonly string[],
): Promise<string | undefined> {
  let needsRegion = false;
  for (const r of refs) {
    if (r.startsWith("arn:")) continue;
    if (!isManagedConnectorName(r)) {
      throw new SunabaError(
        "BadConnector",
        `invalid connector reference '${r}': expected a managed name or ARN`,
      );
    }
    needsRegion = true;
  }
  return needsRegion ? resolveRegion(opts) : undefined;
}
