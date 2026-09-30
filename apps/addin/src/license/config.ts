/**
 * Licensing configuration (KTD7, KTD8): where the license API lives and which Ed25519 public keys
 * may sign entitlement tokens.
 *
 * Keys are embedded, never fetched: a key served by the network could be swapped by whoever controls
 * the network, which would defeat offline verification. Rotate by shipping a build that lists both
 * the old and the new `kid` for at least one token lifetime (7 days of grace).
 */

export interface EntitlementPublicKey {
  /** Matches the `kid` in the token header and payload (ENTITLEMENT_KID on the Worker). */
  kid: string;
  /** Base64url raw 32-byte Ed25519 public key: the JWK `x` from GET /.well-known/entitlement-keys. */
  x: string;
}

export interface LicenseConfig {
  /** License API origin, no trailing slash. */
  apiBase: string;
  /** Website origin; `/account.html` is the manage-subscription fallback when the API is unreachable. */
  siteUrl: string;
  /** Keys accepted for entitlement tokens. */
  keys: readonly EntitlementPublicKey[];
}

export const PROD_API_BASE = "https://api.slidecheck.io";
export const PROD_SITE_URL = "https://slidecheck.io";

/**
 * REPLACE before release: the production key from `GET https://api.slidecheck.io/.well-known/entitlement-keys`.
 * Until replaced, no token verifies, so every signed-in user is treated as a free account (fail closed).
 */
export const ENTITLEMENT_PUBLIC_KEYS: readonly EntitlementPublicKey[] = [
  { kid: "REPLACE_WITH_PRODUCTION_KID", x: "REPLACE_WITH_BASE64URL_ED25519_PUBLIC_KEY_X" },
];

/** localStorage key a developer can set on a local build to point the add-in at another API. */
export const API_BASE_OVERRIDE_KEY = "slidecheck:apiBase";

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * The API base for this page. A dev override is honoured only when the add-in itself is served from
 * localhost, so a production build can never be redirected to another API through storage.
 */
export function resolveApiBase(env: { hostname?: string; readOverride?: () => string | null } = {}): string {
  const hostname = env.hostname ?? (typeof location === "undefined" ? "" : location.hostname);
  if (!DEV_HOSTS.has(hostname)) return PROD_API_BASE;
  let override: string | null = null;
  try {
    override = env.readOverride ? env.readOverride() : localStorage.getItem(API_BASE_OVERRIDE_KEY);
  } catch {
    override = null;
  }
  if (override && /^https?:\/\/[^\s]+$/.test(override)) return trimSlash(override);
  return PROD_API_BASE;
}

/** Production config, with overrides for tests (inject `keys`) and local development (`apiBase`). */
export function createLicenseConfig(overrides: Partial<LicenseConfig> = {}): LicenseConfig {
  return {
    apiBase: trimSlash(overrides.apiBase ?? resolveApiBase()),
    siteUrl: trimSlash(overrides.siteUrl ?? PROD_SITE_URL),
    keys: overrides.keys ?? ENTITLEMENT_PUBLIC_KEYS,
  };
}
