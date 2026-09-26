import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILE = "sunaba.json";

/** Project-level defaults written by `sunaba init`, read by other commands. */
export interface SunabaConfig {
  /** Image name used by `sunaba build` / `sunaba run`. */
  name?: string;
  /** Directory containing the image source (Dockerfile etc.). */
  sourceDir?: string;
  /** S3 bucket for code artifacts. */
  artifactBucket?: string;
  /** IAM role the image build assumes. */
  buildRoleArn?: string;
  /** Managed base image name (e.g. "al2023-1") or full ARN. */
  baseImage?: string;
  /** Execution role ARN for `sunaba run`. */
  executionRoleArn?: string;
}

export function configPath(dir = process.cwd()): string {
  return path.join(dir, CONFIG_FILE);
}

const STRING_FIELDS = new Set([
  "name",
  "sourceDir",
  "artifactBucket",
  "buildRoleArn",
  "baseImage",
  "executionRoleArn",
]);

export function loadConfig(dir = process.cwd()): SunabaConfig {
  const p = configPath(dir);
  if (!existsSync(p)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object`);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (STRING_FIELDS.has(k) && typeof v !== "string") {
      throw new Error(`${CONFIG_FILE}: "${k}" must be a string`);
    }
  }
  // `sunaba init` writes "" placeholders for keys to fill in — treat them
  // as unset so `?? cfg.x` chains never leak "" into an API request.
  // Assignments are restricted to known field names: an out[k]=v copy of
  // arbitrary keys would let a "__proto__" entry in the JSON write to the
  // result's prototype, smuggling an unvalidated value past the check.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!STRING_FIELDS.has(k) || typeof v !== "string" || v === "") continue;
    out[k] = v;
  }
  return out as SunabaConfig;
}

export function writeConfig(cfg: SunabaConfig, dir = process.cwd()): string {
  const p = configPath(dir);
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return p;
}
