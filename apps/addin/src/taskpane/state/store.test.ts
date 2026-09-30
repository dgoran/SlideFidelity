import { describe, expect, it } from "vitest";
import { AREAS } from "@slidecheck/audit-core";
import { fakeResult } from "../testing/fixtures";
import { initialPaneState, isToggled, paneReducer, type PaneState } from "./store";

const run = (actions: Parameters<typeof paneReducer>[1][], from: PaneState = initialPaneState()) =>
  actions.reduce(paneReducer, from);

describe("pane reducer (D10)", () => {
  it("starts not scanned on the Overview with no filters", () => {
    const s = initialPaneState();
    expect(s.scan).toEqual({ status: "not-scanned" });
    expect(s.area).toBe("overview");
    expect(s.severity).toBe("all");
    expect(s.search).toBe("");
  });

  it("scan start → reading phase with every area pending", () => {
    const s = run([{ type: "scan/started" }]);
    expect(s.scan.status).toBe("scanning");
    if (s.scan.status !== "scanning") throw new Error();
    expect(s.scan.phase).toBe("reading");
    expect(s.scan.completed).toBe(0);
    expect(s.scan.total).toBe(AREAS.length);
    expect(Object.values(s.scan.areas).every((v) => v === "pending")).toBe(true);
  });

  it("tracks per-area progress through the auditing phase", () => {
    const s = run([
      { type: "scan/started" },
      { type: "scan/phase", phase: "auditing" },
      { type: "scan/progress", area: "overview", completed: 1, total: 7 },
      { type: "scan/progress", area: "fonts", completed: 2, total: 7 },
    ]);
    if (s.scan.status !== "scanning") throw new Error();
    expect(s.scan.phase).toBe("auditing");
    expect(s.scan.completed).toBe(2);
    expect(s.scan.areas.fonts).toBe("done");
    expect(s.scan.areas.colors).toBe("pending");
  });

  it("success → ready with the result", () => {
    const result = fakeResult([]);
    const s = run([{ type: "scan/started" }, { type: "scan/succeeded", result, scannedAt: 9 }]);
    expect(s.scan).toEqual({ status: "ready", result, scannedAt: 9, possiblyOutdated: false });
  });

  it("failure → failed with kind and message", () => {
    const s = run([{ type: "scan/started" }, { type: "scan/failed", kind: "read-failed", message: "m" }]);
    expect(s.scan).toMatchObject({ status: "failed", kind: "read-failed", message: "m" });
  });

  it("cancel returns to the previous results, or to not-scanned", () => {
    expect(run([{ type: "scan/started" }, { type: "scan/cancelled" }]).scan).toEqual({ status: "not-scanned" });
    const result = fakeResult([]);
    const ready = run([{ type: "scan/started" }, { type: "scan/succeeded", result, scannedAt: 1 }]);
    const again = run([{ type: "scan/started" }, { type: "scan/cancelled" }], ready);
    expect(again.scan).toMatchObject({ status: "ready", result });
  });

  it("progress and phase events outside a scan are ignored", () => {
    const s0 = initialPaneState();
    expect(run([{ type: "scan/progress", area: "fonts", completed: 1, total: 7 }], s0)).toBe(s0);
  });

  it("the optional 'may be out of date' hint only applies to results (D4)", () => {
    const ready = run([{ type: "scan/started" }, { type: "scan/succeeded", result: fakeResult([]), scannedAt: 1 }]);
    const hinted = run([{ type: "scan/possibly-outdated" }], ready);
    expect(hinted.scan).toMatchObject({ possiblyOutdated: true });
    expect(run([{ type: "scan/possibly-outdated" }]).scan.status).toBe("not-scanned");
  });

  it("area selection and filters", () => {
    const s = run([
      { type: "area/selected", area: "links" },
      { type: "filter/severity", severity: "warning" },
      { type: "filter/search", search: "arial" },
    ]);
    expect(s.area).toBe("links");
    expect(s.severity).toBe("warning");
    expect(s.search).toBe("arial");
  });

  it("tracks expanded/collapsed tree rows per area, flipping the default", () => {
    const s0 = initialPaneState();
    expect(isToggled(s0, "fonts", "g:Arial")).toBe(false);
    const s1 = run([{ type: "tree/toggle", area: "fonts", key: "g:Arial" }], s0);
    expect(isToggled(s1, "fonts", "g:Arial")).toBe(true);
    expect(isToggled(s1, "colors", "g:Arial")).toBe(false);
    const s2 = run([{ type: "tree/toggle", area: "fonts", key: "g:Arial" }], s1);
    expect(isToggled(s2, "fonts", "g:Arial")).toBe(false);
    expect(s0.toggled.fonts.size).toBe(0);
  });

  it("switching areas keeps each area's own toggles", () => {
    const s = run([
      { type: "tree/toggle", area: "links", key: "f:1" },
      { type: "area/selected", area: "fonts" },
      { type: "area/selected", area: "links" },
    ]);
    expect(isToggled(s, "links", "f:1")).toBe(true);
  });
});
