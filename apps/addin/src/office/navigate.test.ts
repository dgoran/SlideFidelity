import { describe, expect, it, vi } from "vitest";
import type { FindingTarget } from "@slidecheck/audit-core";
import { capabilitiesUpTo } from "./capabilities";
import { createNavigator, type PptContextLike, type PowerPointRunLike } from "./navigate";

interface FakeShape {
  id: string;
  name: string;
  left: number;
  top: number;
}

function fakePowerPoint(slides: Array<{ id: string; shapes: FakeShape[] }>) {
  const setSelectedSlides = vi.fn();
  const selectedShapes: Array<{ slideId: string; ids: string[] }> = [];
  const loads: string[] = [];
  const liveSlides = slides.map((s) => ({
    id: s.id,
    shapes: {
      items: s.shapes,
      load: vi.fn((p: string) => loads.push(`shapes:${p}`)),
    },
    setSelectedShapes: vi.fn((ids: string[]) => selectedShapes.push({ slideId: s.id, ids })),
  }));
  const ctx: PptContextLike = {
    presentation: {
      slides: { items: liveSlides, load: vi.fn((p: string) => loads.push(`slides:${p}`)) },
      setSelectedSlides,
    },
    sync: vi.fn(async () => {}),
  };
  const run: PowerPointRunLike = (batch) => batch(ctx);
  return { run, ctx, setSelectedSlides, selectedShapes, liveSlides, loads };
}

const shapeTarget: FindingTarget = {
  container: { kind: "slide", partName: "ppt/slides/slide2.xml", slideId: 257, slideIndex: 1, slideNumber: 2 },
  shapeId: 5,
  shapeName: "Title 1",
  bounds: { x: 12700 * 10, y: 12700 * 20, cx: 100, cy: 100 },
};

describe("navigate (R2)", () => {
  it("selects the slide and the shape with ids resolved from the live model", async () => {
    const pp = fakePowerPoint([
      { id: "256#1", shapes: [{ id: "5", name: "Other", left: 0, top: 0 }] },
      {
        id: "257#99",
        shapes: [
          { id: "4", name: "Body", left: 0, top: 0 },
          { id: "5", name: "Title 1", left: 10, top: 20 },
        ],
      },
    ]);
    const nav = createNavigator({ capabilities: capabilitiesUpTo("1.5"), run: pp.run });
    const res = await nav.navigate(shapeTarget);
    expect(pp.setSelectedSlides).toHaveBeenCalledWith(["257#99"]);
    expect(pp.selectedShapes).toEqual([{ slideId: "257#99", ids: ["5"] }]);
    expect(res).toEqual({ kind: "shape", slideId: "257#99", shapeId: "5", method: "exact" });
  });

  it("selects the outermost group when the shape is nested", async () => {
    const pp = fakePowerPoint([{ id: "257#", shapes: [{ id: "9", name: "Group 8", left: 0, top: 0 }] }]);
    const nav = createNavigator({ capabilities: capabilitiesUpTo("1.8"), run: pp.run });
    const res = await nav.navigate({ ...shapeTarget, path: [9] });
    expect(pp.selectedShapes).toEqual([{ slideId: "257#", ids: ["9"] }]);
    expect(res.kind).toBe("shape");
  });

  it("falls back to slide-only when the shape is gone", async () => {
    const pp = fakePowerPoint([{ id: "257#", shapes: [] }]);
    const nav = createNavigator({ capabilities: capabilitiesUpTo("1.5"), run: pp.run });
    const res = await nav.navigate(shapeTarget);
    expect(pp.setSelectedSlides).toHaveBeenCalledWith(["257#"]);
    expect(pp.selectedShapes).toEqual([]);
    expect(res).toEqual({ kind: "slide", slideId: "257#", method: "exact", note: "shape-not-found" });
  });

  it("reports not-found when the slide was deleted", async () => {
    const pp = fakePowerPoint([{ id: "256#", shapes: [] }]);
    const nav = createNavigator({ capabilities: capabilitiesUpTo("1.5"), run: pp.run });
    expect(await nav.navigate(shapeTarget)).toEqual({ kind: "not-found" });
    expect(pp.setSelectedSlides).not.toHaveBeenCalled();
  });

  it("layout and master targets return a note and never select shapes", async () => {
    const pp = fakePowerPoint([{ id: "257#", shapes: [] }]);
    let runs = 0;
    const run: PowerPointRunLike = (batch) => {
      runs += 1;
      return pp.run(batch);
    };
    const nav = createNavigator({ capabilities: capabilitiesUpTo("1.10"), run });
    const layout = await nav.navigate({
      container: { kind: "layout", partName: "ppt/slideLayouts/slideLayout1.xml", name: "Title Slide" },
      shapeId: 3,
      shapeName: "Title",
    });
    expect(layout).toEqual({ kind: "layout-note", containerKind: "layout", name: "Title Slide" });
    const master = await nav.navigate({ container: { kind: "master", partName: "ppt/slideMasters/slideMaster1.xml" } });
    expect(master).toEqual({ kind: "layout-note", containerKind: "master", name: "slideMaster1" });
    expect(runs).toBe(0);
    expect(pp.selectedShapes).toEqual([]);
  });

  it("below 1.5 degrades to slide-only through goToByIdAsync", async () => {
    const run = vi.fn();
    const goToByIdAsync = vi.fn((_id: string | number, _t: unknown, cb: (r: { status: string }) => void) =>
      cb({ status: "succeeded" }),
    );
    const nav = createNavigator({ capabilities: capabilitiesUpTo("1.4"), run, document: { goToByIdAsync } });
    const res = await nav.navigate(shapeTarget);
    expect(run).not.toHaveBeenCalled();
    expect(goToByIdAsync).toHaveBeenCalledTimes(1);
    expect(goToByIdAsync.mock.calls[0]![0]).toBe(257);
    expect(goToByIdAsync.mock.calls[0]![1]).toBe("slide");
    expect(res).toEqual({ kind: "slide", method: "exact", note: "shape-selection-unsupported" });
  });

  it("below 1.5, a failed id jump retries by 1-based index", async () => {
    const goToByIdAsync = vi.fn((_id: string | number, t: unknown, cb: (r: { status: string }) => void) =>
      cb({ status: t === "slide" ? "failed" : "succeeded" }),
    );
    const nav = createNavigator({ capabilities: capabilitiesUpTo("1.3"), run: vi.fn(), document: { goToByIdAsync } });
    const res = await nav.navigate(shapeTarget);
    expect(goToByIdAsync.mock.calls[1]![0]).toBe(2);
    expect(goToByIdAsync.mock.calls[1]![1]).toBe("index");
    expect(res).toEqual({ kind: "slide", method: "index", note: "shape-selection-unsupported" });
  });

  it("targets without a slide are not navigable", async () => {
    const nav = createNavigator({ capabilities: capabilitiesUpTo("1.10"), run: vi.fn() });
    expect(await nav.navigate({ container: { kind: "media", partName: "ppt/media/image1.png" } })).toEqual({
      kind: "not-navigable",
    });
  });

  it("maps API failures to an error result", async () => {
    const nav = createNavigator({
      capabilities: capabilitiesUpTo("1.5"),
      run: async () => {
        throw new Error("GeneralException");
      },
    });
    expect(await nav.navigate(shapeTarget)).toEqual({ kind: "error", message: "GeneralException" });
  });
});
