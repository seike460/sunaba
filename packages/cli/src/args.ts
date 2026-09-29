export interface ParsedArgs {
  /** Positional arguments before `--`. */
  _: string[];
  /** Arguments after `--` (raw, e.g. the command for `exec`). */
  cmd: string[];
  flags: Record<string, string | true>;
}

/**
 * Minimal argv parser: `--flag`, `--key value`, `--key=value`, `-h`,
 * `--` terminates flag parsing (rest lands in `cmd`).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [], cmd: [], flags: {} };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--") {
      out.cmd = argv.slice(i + 1);
      break;
    }
    if (a === "-h") {
      out.flags.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          out.flags[a.slice(2)] = next;
          i++;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}

export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  // A bare "--timeout" (no value) silently fell back to defaults — that's a
  // typo, not a boolean flag. Boolean flags read via flagBool, which
  // accepts `true`.
  if (v === true) throw new Error(`--${name} requires a value`);
  return v;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const v = args.flags[name];
  if (v === undefined) return false;
  if (v === true || v === "true") return true;
  if (v === "false") return false;
  // A boolean flag swallowed a positional ("--rm myname") — that's a
  // usage error, not a value.
  throw new Error(`--${name} doesn't take a value`);
}

export function flagInt(
  args: ParsedArgs,
  name: string,
  bounds: { min: number; max: number },
): number | undefined {
  const v = flagStr(args, name);
  if (v === undefined) return undefined;
  // Plain decimal digits only: Number("") is 0 and Number("0x10") is 16.
  const n = /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
    throw new Error(`--${name} must be an integer in ${bounds.min}..${bounds.max}`);
  }
  return n;
}

/** Flags accepted by every command (handled globally or ignored uniformly). */
const GLOBAL_FLAGS = new Set(["region", "profile", "help"]);

/** Reject `--flags` outside the command's allowlist so typos fail loudly. */
export function assertFlags(args: ParsedArgs, allowed: readonly string[]): void {
  for (const name of Object.keys(args.flags)) {
    if (!GLOBAL_FLAGS.has(name) && !allowed.includes(name)) {
      throw new Error(`unknown flag --${name}`);
    }
  }
}
