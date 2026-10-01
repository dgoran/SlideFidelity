import { describe, expect, it } from "vitest";
import { devUnlockActive, effectivePlan, isLocalHostname } from "./devUnlock";

describe("development unlock", () => {
  it("recognizes only loopback host names", () => {
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("127.0.0.1")).toBe(true);
    expect(isLocalHostname("[::1]")).toBe(true);
    expect(isLocalHostname("app.slidecheck.io")).toBe(false);
    expect(isLocalHostname("localhost.evil.example")).toBe(false);
    expect(isLocalHostname("192.168.1.196")).toBe(false);
  });

  it("is active only in a development build served from localhost", () => {
    expect(devUnlockActive({ devBuild: true, hostname: "localhost" })).toBe(true);
    expect(devUnlockActive({ devBuild: false, hostname: "localhost" })).toBe(false);
    expect(devUnlockActive({ devBuild: true, hostname: "app.slidecheck.io" })).toBe(false);
  });

  it("forces Pro while active and passes the real plan through otherwise", () => {
    expect(effectivePlan("anonymous", true)).toBe("pro");
    expect(effectivePlan("expired", true)).toBe("pro");
    expect(effectivePlan("anonymous", false)).toBe("anonymous");
    expect(effectivePlan("trial", false)).toBe("trial");
  });
});
