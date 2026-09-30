// Generates an Ed25519 entitlement signing key.
//   node scripts/generate-entitlement-key.mjs [kid]
// Prints the private JWK (store with `wrangler secret put ENTITLEMENT_PRIVATE_KEY`) and the public
// values the add-in embeds (base64url raw key `x`, plus the kid to put in ENTITLEMENT_KID).
import { webcrypto } from "node:crypto";
import process from "node:process";

const kid = process.argv[2] ?? `ent-${new Date().toISOString().slice(0, 7)}`;
const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);

process.stdout.write(
  [
    `ENTITLEMENT_KID=${kid}`,
    "",
    "# Secret (do not commit): wrangler secret put ENTITLEMENT_PRIVATE_KEY",
    JSON.stringify(privateJwk),
    "",
    "# Public key for the add-in (base64url raw 32 bytes, JWK x):",
    JSON.stringify({ kid, kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: publicJwk.x }),
    "",
  ].join("\n"),
);
