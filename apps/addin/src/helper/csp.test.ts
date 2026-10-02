// @vitest-environment node
/**
 * Production CSP (helper plan U12): `connect-src` reaches localhost only on the helper's three
 * ports, with no wildcard; development keeps its localhost allowances.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { contentSecurityPolicy } = require("../../webpack.config.js") as { contentSecurityPolicy: (dev: boolean) => string };

const connectSrc = (csp: string) => csp.split("; ").find((d) => d.startsWith("connect-src "))!.split(" ").slice(1);

describe("task pane CSP", () => {
  it("production: exactly the three helper ports on localhost, no wildcard", () => {
    const connect = connectSrc(contentSecurityPolicy(false));
    expect(connect).toEqual(["'self'", "https://api.slidecheck.io", "https://localhost:47317", "https://localhost:47318", "https://localhost:47319"]);
    expect(contentSecurityPolicy(false)).not.toMatch(/localhost:\*/);
    expect(contentSecurityPolicy(false)).not.toContain("wss:");
  });

  it("development keeps any localhost port", () => {
    const connect = connectSrc(contentSecurityPolicy(true));
    expect(connect).toEqual(expect.arrayContaining(["https://localhost:*", "wss://localhost:*"]));
  });
});
