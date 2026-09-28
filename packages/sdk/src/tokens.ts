import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmShellAuthTokenCommand,
} from "@aws-sdk/client-lambda-microvms";
import { SunabaError } from "./errors.js";
import type { LambdaMicrovmsClientLike, PortSpec } from "./types.js";

const AUTH_HEADER = "X-aws-proxy-auth";
/** Refresh the token once 80% of its lifetime has elapsed. */
const REFRESH_FRACTION = 0.8;

function toPortSpecifications(ports: readonly PortSpec[]) {
  const valid = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;
  return ports.map((p) => {
    if (p === "all") return { allPorts: {} };
    if (typeof p === "number") {
      if (!valid(p)) {
        throw new SunabaError("BadPort", `port ${p} must be an integer 1-65535`);
      }
      return { port: p };
    }
    if (!valid(p.from) || !valid(p.to) || p.from > p.to) {
      throw new SunabaError(
        "BadPort",
        `invalid port range ${p.from}-${p.to} (must be 1-65535, from<=to)`,
      );
    }
    return { range: { startPort: p.from, endPort: p.to } };
  });
}

function extractToken(authToken: Record<string, string> | undefined): string {
  const value = authToken?.[AUTH_HEADER];
  if (!value) {
    throw new SunabaError("BadTokenResponse", "token response did not contain X-aws-proxy-auth");
  }
  return value;
}

/**
 * Cache around a token-mint call: get() serves the cached value until 80%
 * of its TTL, de-duplicates concurrent mints, invalidate() drops it.
 */
class TokenCache {
  private cached?: { value: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(private readonly mint: () => Promise<{ value: string; ttlMs: number }>) {}

  async get(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.value;
    }
    // De-duplicate concurrent refreshes.
    this.pending ??= this.mint()
      .then(({ value, ttlMs }) => {
        this.cached = { value, expiresAt: Date.now() + ttlMs * REFRESH_FRACTION };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

/**
 * The service caps endpoint token lifetime at 60 minutes. Shell tokens
 * document no maximum and share the same bound.
 */
function checkTtlMinutes(minutes: number, what: string): void {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new SunabaError("BadTokenTtl", `${what} must be an integer 1-60`);
  }
}

/**
 * Mints and caches the JWE endpoint token for a MicroVM.
 * Every request to a MicroVM endpoint must carry `X-aws-proxy-auth`;
 * this manager renews the token before it expires.
 */
export class AuthTokenManager {
  private readonly cache: TokenCache;

  constructor(
    private readonly client: LambdaMicrovmsClientLike,
    private readonly microvmId: string,
    private readonly options: {
      expirationInMinutes: number;
      allowedPorts: readonly PortSpec[];
    },
  ) {
    checkTtlMinutes(options.expirationInMinutes, "expirationInMinutes");
    this.cache = new TokenCache(() => this.mint());
  }

  /** Returns a valid token value for the X-aws-proxy-auth header. */
  get(): Promise<string> {
    return this.cache.get();
  }

  /** Drop the cached token so the next get() mints a fresh one. */
  invalidate(): void {
    this.cache.invalidate();
  }

  private async mint(): Promise<{ value: string; ttlMs: number }> {
    const res = (await this.client.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: this.microvmId,
        expirationInMinutes: this.options.expirationInMinutes,
        allowedPorts: toPortSpecifications(this.options.allowedPorts),
      }),
    )) as { authToken?: Record<string, string> };
    return {
      value: extractToken(res.authToken),
      ttlMs: this.options.expirationInMinutes * 60_000,
    };
  }
}

/**
 * Mints tokens for the SHELL_INGRESS WebSocket shell.
 * Shell tokens have their own API and carry no port scope.
 */
export class ShellTokenManager {
  private readonly cache: TokenCache;

  constructor(
    private readonly client: LambdaMicrovmsClientLike,
    private readonly microvmId: string,
    private readonly expirationInMinutes: number,
  ) {
    checkTtlMinutes(expirationInMinutes, "shell expirationInMinutes");
    this.cache = new TokenCache(() => this.mint());
  }

  get(): Promise<string> {
    return this.cache.get();
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  private async mint(): Promise<{ value: string; ttlMs: number }> {
    const res = (await this.client.send(
      new CreateMicrovmShellAuthTokenCommand({
        microvmIdentifier: this.microvmId,
        expirationInMinutes: this.expirationInMinutes,
      }),
    )) as { authToken?: Record<string, string> };
    return {
      value: extractToken(res.authToken),
      ttlMs: this.expirationInMinutes * 60_000,
    };
  }
}
