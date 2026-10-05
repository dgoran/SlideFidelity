import path from "node:path";
import { webcrypto } from "node:crypto";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  // Fresh Ed25519 key per test run; tests read the public half from the private JWK.
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
            ENTITLEMENT_PRIVATE_KEY: JSON.stringify(privateJwk),
            PADDLE_WEBHOOK_SECRET: "pdl_ntfset_test_secret",
            PADDLE_API_KEY: "test-paddle-key",
            EMAIL_API_KEY: "test-email-key",
            REVIEWER_CODE: "reviewer-static-code-42",
            ALLOWED_ORIGINS: "https://app.slidefidelity.test,https://slidefidelity.test",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
