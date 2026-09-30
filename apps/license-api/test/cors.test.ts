import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, resetDb } from "./helpers";

beforeEach(resetDb);

const preflight = (origin: string) => ({
  method: "OPTIONS",
  headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
});

describe("CORS (KTD8)", () => {
  it("a preflight from an unlisted origin gets no allow header", async () => {
    const h = makeHarness();
    const res = await h.request("/linkcheck", preflight("https://evil.example"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("a preflight from a listed origin is allowed", async () => {
    const h = makeHarness();
    const res = await h.request("/linkcheck", preflight("https://app.slidecheck.test"));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.slidecheck.test");
    expect(res.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("authorization");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("actual responses only echo listed origins", async () => {
    const h = makeHarness();
    const ok = await h.request("/health", { headers: { Origin: "https://slidecheck.test" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://slidecheck.test");
    const bad = await h.request("/health", { headers: { Origin: "https://slidecheck.test.evil.example" } });
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
