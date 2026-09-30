import { describe, expect, it, vi } from "vitest";
import { API_VERSIONS, capabilitiesUpTo, probeCapabilities } from "./capabilities";

function host(max: string) {
  const supported = new Set(API_VERSIONS.slice(0, API_VERSIONS.indexOf(max as (typeof API_VERSIONS)[number]) + 1));
  return { isSetSupported: vi.fn((name: string, v?: string) => name === "PowerPointApi" && v !== undefined && supported.has(v as never)) };
}

describe("capabilities", () => {
  it("probes PowerPointApi 1.3–1.10 exactly once each", () => {
    const req = host("1.10");
    const caps = probeCapabilities(req);
    expect(req.isSetSupported).toHaveBeenCalledTimes(API_VERSIONS.length);
    for (const v of API_VERSIONS) expect(req.isSetSupported).toHaveBeenCalledWith("PowerPointApi", v);
    caps.supports("hyperlinkRemove");
    caps.explain("themeColors");
    expect(req.isSetSupported).toHaveBeenCalledTimes(API_VERSIONS.length);
    expect(caps.highest).toBe("1.10");
  });

  it("maps feature flags to their minimum API versions", () => {
    const c14 = probeCapabilities(host("1.4"));
    expect(c14.flags).toMatchObject({
      navigateSlide: true,
      selectSlides: false,
      selectShapes: false,
      replaceFonts: true,
      replaceColors: true,
      deleteShapes: true,
      tablesGroups: false,
      hyperlinkEdit: false,
      hyperlinkRemove: false,
      shapeVisible: false,
      themeColors: false,
    });
    const c15 = probeCapabilities(host("1.5"));
    expect(c15.flags.selectSlides).toBe(true);
    expect(c15.flags.selectShapes).toBe(true);
    const c110 = probeCapabilities(host("1.10"));
    expect(Object.values(c110.flags).every(Boolean)).toBe(true);
    expect(c110.explain("hyperlinkRemove")).toBeNull();
  });

  it("covers AE4: a 1.8 host lists links but cannot remove them, with an explanation", () => {
    const caps = probeCapabilities(host("1.8"));
    expect(caps.flags.tablesGroups).toBe(true);
    expect(caps.flags.hyperlinkEdit).toBe(true);
    expect(caps.supports("hyperlinkRemove")).toBe(false);
    expect(caps.explain("hyperlinkRemove")).toBe("Requires a newer version of PowerPoint (PowerPointApi 1.10)");
    expect(caps.explain("selectShapes")).toBeNull();
  });

  it("treats a missing requirements object (tests, non-Office) as nothing supported", () => {
    const caps = probeCapabilities(undefined);
    expect(caps.highest).toBeNull();
    expect(caps.supports("navigateSlide")).toBe(false);
  });

  it("isSetSupported throwing counts as unsupported", () => {
    const caps = probeCapabilities({
      isSetSupported: () => {
        throw new Error("boom");
      },
    });
    expect(caps.highest).toBeNull();
  });

  it("capabilitiesUpTo builds a host for tests", () => {
    expect(capabilitiesUpTo("1.8").supports("hyperlinkRemove")).toBe(false);
    expect(capabilitiesUpTo("1.10").supports("hyperlinkRemove")).toBe(true);
  });
});
