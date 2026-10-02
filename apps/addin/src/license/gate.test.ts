import { describe, expect, it } from "vitest";
import {
  FEATURES,
  PLANS,
  areaAccess,
  ctaLabel,
  featureForFinding,
  PROBLEMS_FEATURES,
  viewAccess,
  isAllowed,
  lockAction,
  type Feature,
  type Plan,
} from "./gate";

const FREE_FEATURES: Feature[] = ["overview.counts", "area.fonts.list", "area.media.sizes"];

describe("gate: feature matrix (D7, D13, R19)", () => {
  it.each<Plan>(["anonymous", "free", "expired"])("%s gets only the overview, font list, and media sizes", (plan) => {
    for (const f of FEATURES) {
      expect(isAllowed(plan, f), `${plan} / ${f}`).toBe(FREE_FEATURES.includes(f));
    }
  });

  it.each<Plan>(["trial", "pro"])("%s gets every feature", (plan) => {
    for (const f of FEATURES) expect(isAllowed(plan, f), f).toBe(true);
  });

  it("overview counts are allowed for every plan, so locked areas still show counts (D7)", () => {
    for (const p of PLANS) expect(isAllowed(p, "overview.counts")).toBe(true);
  });
});

describe("gate: lock reason drives the CTA (D8)", () => {
  it("anonymous → sign in to start the trial", () => {
    expect(lockAction("anonymous")).toBe("sign-in-trial");
    expect(ctaLabel("sign-in-trial")).toBe("Sign in to start your 30-day free trial");
  });
  it("free and expired → manage subscription (AE5)", () => {
    expect(lockAction("free")).toBe("manage-subscription");
    expect(lockAction("expired")).toBe("manage-subscription");
    expect(ctaLabel("manage-subscription")).toBe("Manage subscription");
  });
  it("trial and pro → nothing locked", () => {
    expect(lockAction("trial")).toBeNull();
    expect(lockAction("pro")).toBeNull();
  });
});

describe("gate: per-finding features (D13)", () => {
  it("maps font and media kinds to list/size vs flag/issue features", () => {
    expect(featureForFinding({ area: "fonts", kind: "font-usage" })).toBe("area.fonts.list");
    expect(featureForFinding({ area: "fonts", kind: "hidden-list-style" })).toBe("area.fonts.flags");
    expect(featureForFinding({ area: "fonts", kind: "font-embedding" })).toBe("area.fonts.flags");
    expect(featureForFinding({ area: "media", kind: "media-size" })).toBe("area.media.sizes");
    expect(featureForFinding({ area: "media", kind: "file-size-breakdown" })).toBe("area.media.sizes");
    expect(featureForFinding({ area: "media", kind: "image-issue" })).toBe("area.media.issues");
    expect(featureForFinding({ area: "colors", kind: "color-usage" })).toBe("area.colors");
    expect(featureForFinding({ area: "links", kind: "hyperlink" })).toBe("area.links");
    expect(featureForFinding({ area: "masters", kind: "unused-layout" })).toBe("area.masters");
    expect(featureForFinding({ area: "review", kind: "hidden-slide" })).toBe("area.review");
    expect(featureForFinding({ area: "fonts", kind: "check-failed" })).toBe("area.fonts.list");
  });

  it("Graphics Ops kinds (G1-G5) follow their area's Pro features", () => {
    for (const kind of ["font-maybe-missing", "font-availability-summary"] as const) {
      expect(featureForFinding({ area: "fonts", kind })).toBe("area.fonts.flags");
    }
    for (const kind of ["media-missing", "media-linked", "media-online", "media-format", "media-poster-missing", "media-playback-settings"] as const) {
      expect(featureForFinding({ area: "media", kind })).toBe("area.media.issues");
    }
    for (const kind of ["partly-off-slide", "text-collision", "off-slide-shape"] as const) {
      expect(featureForFinding({ area: "review", kind })).toBe("area.review");
    }
  });

  it("the Problems view is partial on the free tier (headline and counts free, details Pro)", () => {
    expect(PROBLEMS_FEATURES).toEqual(["area.fonts.flags", "area.media.issues", "area.review"]);
    expect(viewAccess("anonymous", "problems")).toBe("partial");
    expect(viewAccess("pro", "problems")).toBe("full");
    expect(viewAccess("free", "links")).toBe("locked");
  });

  it("area access is partial for fonts/media and locked for Pro areas on the free tier", () => {
    expect(areaAccess("anonymous", "overview")).toBe("full");
    expect(areaAccess("anonymous", "fonts")).toBe("partial");
    expect(areaAccess("anonymous", "media")).toBe("partial");
    for (const a of ["colors", "masters", "links", "review"] as const) expect(areaAccess("free", a)).toBe("locked");
    for (const a of ["fonts", "colors", "media", "masters", "links", "review"] as const) {
      expect(areaAccess("trial", a)).toBe("full");
    }
  });
});
