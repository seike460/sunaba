import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CreateMicrovmImageCommand,
  ListMicrovmImageVersionsCommand,
} from "@aws-sdk/client-lambda-microvms";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type Zippable, zipSync } from "fflate";
import { connectorArns } from "./connectors.js";
import { SunabaError } from "./errors.js";
import { resolveImageArn } from "./sandbox.js";
import { regionForConnectors, resolveClient, resolveRegion } from "./transport.js";
import type {
  LambdaMicrovmsClientLike,
  MicrovmImageBuildOptions,
  MicrovmImageBuildResult,
} from "./types.js";
import { checkNumber, isNotFoundError, required, sleep } from "./util.js";
import { waitForImageVersion } from "./waiters.js";

const DEFAULT_PREFIX = "sunaba/images/";

/**
 * Build a MicroVM image: zip the source, upload to S3, call
 * CreateMicrovmImage, and wait for the version build to succeed.
 */
export async function buildMicrovmImage(
  opts: MicrovmImageBuildOptions,
): Promise<MicrovmImageBuildResult> {
  // CreateMicrovmImage accepts at most ONE egress connector (unlike
  // RunMicrovm, which allows 10).
  if ((opts.egressConnectors ?? []).length > 1) {
    throw new SunabaError(
      "TooManyConnectors",
      "MicroVM image builds support at most 1 egress connector",
    );
  }
  // Checked before the upload and CreateMicrovmImage: a NaN memoryMiB was
  // dropped without a word, and a bad buildTimeoutMs found later would
  // abandon a build that has already started.
  if (opts.memoryMiB !== undefined) {
    checkNumber(opts.memoryMiB, "memoryMiB", "BadMemory", { min: 1, integer: true });
  }
  if (opts.buildTimeoutMs !== undefined) {
    checkNumber(opts.buildTimeoutMs, "buildTimeoutMs", "BadTimeout", { min: 1 });
  }
  const client = resolveClient(opts);
  // Region is only needed to expand managed connector names; the S3
  // client resolves its own region from config/env when absent.
  const region = await regionForConnectors(opts, opts.egressConnectors ?? []);

  const s3Uri = await resolveArtifactUri(opts, region);
  // Snapshot existing versions BEFORE create: if the response omits
  // imageVersion, the fallback below must wait for a version it hasn't seen.
  const preExisting = new Set(
    // imageIdentifier wants an ARN/ID — resolve the name first when it
    // exists; only a brand-new (not found) image yields an empty snapshot.
    // Other errors (throttling, AccessDenied) must surface — an empty
    // snapshot would let the fallback return an older version.
    (
      await resolveImageArn(client, opts.name)
        .then((arn) => listAllVersions(client, arn))
        .catch((e) => {
          if ((e instanceof SunabaError && e.code === "ImageNotFound") || isNotFoundError(e)) {
            return [];
          }
          throw e;
        })
    ).map((v) => v.imageVersion),
  );
  const res = (await client.send(
    new CreateMicrovmImageCommand({
      name: opts.name,
      ...(opts.description ? { description: opts.description } : {}),
      baseImageArn: opts.baseImageArn,
      ...(opts.baseImageVersion ? { baseImageVersion: opts.baseImageVersion } : {}),
      buildRoleArn: opts.buildRoleArn,
      codeArtifact: { uri: s3Uri },
      ...(opts.memoryMiB ? { resources: [{ minimumMemoryInMiB: opts.memoryMiB }] } : {}),
      ...(opts.environment ? { environmentVariables: opts.environment } : {}),
      ...(opts.egressConnectors
        ? { egressNetworkConnectors: connectorArns(opts.egressConnectors, region) }
        : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.logging ? { logging: opts.logging } : {}),
      ...(opts.architecture ? { cpuConfigurations: [{ architecture: opts.architecture }] } : {}),
      ...(opts.additionalOsCapabilities
        ? { additionalOsCapabilities: opts.additionalOsCapabilities }
        : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.clientToken ? { clientToken: opts.clientToken } : {}),
    }),
  )) as { imageArn?: string; imageVersion?: string };

  const imageArn = required(res.imageArn, "imageArn");
  // CreateMicrovmImage returns the new version directly; only fall back to
  // polling the version list when the field is absent.
  const imageVersion =
    res.imageVersion || (await waitForVersionToAppear(client, imageArn, 30_000, preExisting));
  const info = await waitForImageVersion(client, imageArn, imageVersion, {
    timeoutMs: opts.buildTimeoutMs ?? 900_000,
  });
  return { imageArn, imageVersion, state: String(info.state ?? "SUCCESSFUL") };
}

async function resolveArtifactUri(
  opts: MicrovmImageBuildOptions,
  region?: string,
): Promise<string> {
  const src = opts.source;
  if ("s3Uri" in src) return src.s3Uri;
  if (!opts.artifactBucket) {
    throw new SunabaError(
      "MissingBucket",
      "artifactBucket is required when source is a dir or zip path",
    );
  }
  const zip =
    "dir" in src ? await zipDirectory(src.dir) : new Uint8Array(await fs.readFile(src.zip));
  const hash = createHash("sha256").update(zip).digest("hex").slice(0, 16);
  const key = `${opts.artifactPrefix ?? DEFAULT_PREFIX}${opts.name}/${hash}.zip`;
  // An injected Lambda client carries its own credentials/region providers
  // — reuse them for S3 so a custom-configured client isn't silently
  // bypassed. `s3Client` wins over everything for tests.
  type S3Config = NonNullable<ConstructorParameters<typeof S3Client>[0]>;
  const injectedCfg = (opts.client as { config?: { credentials?: unknown } } | undefined)?.config;
  const credentials = (opts.clientConfig?.credentials ?? injectedCfg?.credentials) as
    | S3Config["credentials"]
    | undefined;
  // Prefer the caller's own region (incl. an injected client's provider)
  // over the connector-derived one; when none resolves, let the S3 client
  // fall back to its own chain (~/.aws/config etc.). An explicit s3Client
  // is already configured — skip region resolution entirely so a broken
  // Lambda-side provider can't fail an otherwise-working upload.
  const s3Region = opts.s3Client
    ? undefined
    : ((await resolveRegion(opts).catch((e) => {
        if (e instanceof SunabaError && e.code === "NoRegion") return undefined;
        throw e;
      })) ?? region);
  const s3 =
    opts.s3Client ??
    new S3Client({
      ...(credentials ? { credentials } : {}),
      ...(s3Region ? { region: s3Region } : {}),
    });
  await s3.send(
    new PutObjectCommand({
      Bucket: opts.artifactBucket,
      Key: key,
      Body: zip,
      ContentType: "application/zip",
    }),
  );
  return `s3://${opts.artifactBucket}/${key}`;
}

/**
 * Entries that must never be baked into a MicroVM image (secrets).
 * Each RegExp is tested against a single path segment: every walked
 * entry's name, and every segment of a symlink's resolved target.
 *
 * The secret entries mirror sunaba-cdk's DEFAULT_EXCLUDE_PATTERNS; keep
 * them in sync. The lists still differ: most entries here ignore case
 * (the CDK globs do not), and only this list drops .dockerignore,
 * .gitignore and .gitmodules, which are not secrets.
 */
const SECRET_DENYLIST: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /^\.aws$/,
  /^\.ssh$/,
  /^\.gnupg$/,
  /^\.kube$/,
  /^\.docker$/,
  /^\.terraform$/,
  /^\.dockerignore$/,
  /^\.git$/i,
  /^\.gitignore$/i,
  /^\.gitmodules$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.(p12|pfx|keystore|jks)$/i,
  /^id_rsa/i,
  /^id_dsa/i,
  /^id_ecdsa/i,
  /^id_ed25519/i,
  /^credentials$/i,
  // Terraform state carries plaintext secrets — including backups
  // (terraform.tfstate.backup, .tfstate~).
  /\.tfstate/i,
  // PuTTY private keys.
  /\.ppk$/i,
  // Not a secret — a zip-safety exclusion: fflate's fltn() writes entries
  // into a plain {} where "__proto__" hits the prototype setter, which
  // corrupts the archive (for-in then iterates the prototype's keys).
  /^__proto__$/,
];

const isDenied = (name: string) => SECRET_DENYLIST.some((re) => re.test(name));

/**
 * Zip a directory into a MicroVM code artifact.
 * Requires a Dockerfile at the root. Skips node_modules/.git and a
 * denylist of secret-looking files (env files, keys, credentials).
 */
export async function zipDirectory(dir: string): Promise<Uint8Array> {
  // Canonicalize once: symlink containment checks compare realpaths.
  const root = await fs.realpath(path.resolve(dir));
  // Null-prototype map: a file literally named "__proto__" would trigger
  // the prototype setter on a plain {}, and fflate's `for k in` would
  // pick up the inherited entry.
  const files: Zippable = Object.create(null);
  await walk(root, root, files, new Set());
  if (!("Dockerfile" in files)) {
    throw new SunabaError(
      "NoDockerfile",
      `${root} has no Dockerfile at its root (required for MicroVM images)`,
    );
  }
  // STORE (level 0) is deliberate: Lambda only needs a valid zip artifact,
  // and the image build doesn't decompress smaller with DEFLATE.
  return zipSync(files, { level: 0 });
}

/** Store entry data plus its Unix mode so exec bits survive the zip. */
function entry(data: Uint8Array, mode: number): Zippable[string] {
  return [data, { attrs: mode << 16, os: 3 }];
}

async function walk(dir: string, root: string, out: Zippable, stack: Set<string>): Promise<void> {
  // Cycle detection tracks realpaths on the current recursion path only:
  // two different names aliasing the same dir are both legitimate entries.
  const real = await fs.realpath(dir);
  if (stack.has(real)) return;
  stack.add(real);
  try {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (isDenied(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.realpath(full);
        } catch {
          throw new SunabaError("BadSymlink", `dangling symlink ${full}`);
        }
        // Check every path segment, not just the basename — a link named
        // "config" could alias .aws/sso/cache/token.json and smuggle a
        // credential file into the artifact.
        if (target.split(path.sep).some((seg) => isDenied(seg))) continue;
        const rel = path.relative(root, target);
        if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          throw new SunabaError(
            "UnsafeSymlink",
            `symlink ${full} points outside the source directory`,
          );
        }
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
          await walk(full, root, out, stack);
        } else if (stat.isFile()) {
          const relName = path.relative(root, full).split(path.sep).join("/");
          out[relName] = entry(new Uint8Array(await fs.readFile(full)), stat.mode);
        }
        continue;
      }
      if (ent.isDirectory()) {
        const lower = ent.name.toLowerCase();
        if (lower === "node_modules" || lower === ".git") continue;
        await walk(full, root, out, stack);
      } else if (ent.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        const stat = await fs.stat(full);
        out[rel] = entry(new Uint8Array(await fs.readFile(full)), stat.mode);
      }
    }
  } finally {
    stack.delete(real);
  }
}

interface VersionItem {
  imageVersion?: string;
  createdAt?: Date;
}

/** All image versions across pages. */
async function listAllVersions(
  client: LambdaMicrovmsClientLike,
  imageArn: string,
): Promise<VersionItem[]> {
  let nextToken: string | undefined;
  const items: VersionItem[] = [];
  do {
    const res = (await client.send(
      new ListMicrovmImageVersionsCommand({
        imageIdentifier: imageArn,
        ...(nextToken ? { nextToken } : {}),
      }),
    )) as { items?: VersionItem[]; nextToken?: string };
    items.push(...(res.items ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return items;
}

/**
 * Poll until a version appears that wasn't listed at call time (eventual
 * consistency), then return the newest such version.
 */
async function waitForVersionToAppear(
  client: LambdaMicrovmsClientLike,
  imageArn: string,
  timeoutMs: number,
  preExisting: ReadonlySet<string | undefined>,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fresh = (await listAllVersions(client, imageArn)).filter(
      (v) => v.imageVersion && !preExisting.has(v.imageVersion),
    );
    const newest = fresh
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .at(0);
    if (newest?.imageVersion) return newest.imageVersion;
    if (Date.now() > deadline) {
      throw new SunabaError("NoVersion", `no version reported for ${imageArn}`);
    }
    await sleep(1_000);
  }
}
