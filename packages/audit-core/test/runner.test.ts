import { describe, expect, it, vi } from "vitest";
import {
  AREAS,
  CHECKS,
  createAuditCache,
  findingId,
  getShapes,
  loadPresentation,
  makeFinding,
  runChecks,
  runChecksCached,
  shapeTarget,
  slideTarget,
  partTarget,
  summarize,
  targetKey,
  type Area,
  type Check,
  type Finding,
  type ProgressEvent,
} from "../src/index";
import { corpusDeck } from "./helpers/corpus";

// Test-only finding kinds, registered through the same augmentation mechanism checks use.
declare module "../src/findings" {
  interface FindingDataMap {
    "test-stub": { area: Area; n: number };
    "test-shape": { name: string };
  }
}

/** One info finding per area, plus a warning-free shape finding in fonts. */
function stubChecks(): Check[] {
  return AREAS.map((area) => ({
    id: `stub-${area}`,
    area,
    run: ({ pres }) => [
      makeFinding({
        area,
        kind: "test-stub",
        severity: "info",
        title: `${area} ok`,
        group: area,
        targets: pres.slides.map((s) => slideTarget(s)),
        fixes: [],
        data: { area, n: pres.slides.length },
      }),
    ],
  }));
}

async function shapeCheckFindings(): Promise<Finding[]> {
  const bytes = await corpusDeck("clean");
  const check: Check = {
    id: "shapes",
    area: "fonts",
    run: async ({ pres }) => {
      const out: Finding[] = [];
      for (const slide of pres.slides) {
        const shapes = await getShapes(pres, { kind: "slide", partName: slide.partName, slideId: slide.slideId });
        for (const s of shapes) {
          out.push(
            makeFinding({
              area: "fonts",
              kind: "test-shape",
              severity: "warning",
              title: s.name,
              group: "Calibri",
              targets: [shapeTarget(s, pres, { property: "text", paragraphIndex: 0, runIndex: 0 })],
              fixes: ["replace-font"],
              reachable: true,
              data: { name: s.name },
            }),
          );
        }
      }
      return out;
    },
  };
  return (await runChecks(bytes, {}, { checks: [check] })).findings;
}

describe("runner", () => {
  it("the default registry is an empty list until checks land", () => {
    expect(Array.isArray(CHECKS)).toBe(true);
  });

  it("returns findings for every area with zero warnings on clean.pptx (stub checks)", async () => {
    const bytes = await corpusDeck("clean");
    const result = await runChecks(bytes, {}, { checks: stubChecks() });
    const areas = new Set(result.findings.map((f) => f.area));
    expect([...areas].sort()).toEqual([...AREAS].sort());
    expect(result.findings.filter((f) => f.severity === "warning")).toHaveLength(0);
    expect(result.errors).toEqual([]);
    expect(result.stats.slides).toBe(3);
    expect(result.stats.shapes).toBeGreaterThan(0);
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
    for (const a of AREAS) expect(result.stats.perArea[a]).toEqual({ error: 0, warning: 0, info: 1, total: 1 });
  });

  it("isolates a throwing check into one check-failed finding; other areas still run", async () => {
    const bytes = await corpusDeck("clean");
    const checks = stubChecks().map((c) =>
      c.area === "colors"
        ? {
            ...c,
            run: () => {
              throw new Error("boom");
            },
          }
        : c,
    );
    const result = await runChecks(bytes, {}, { checks });
    const failed = result.findings.filter((f) => f.kind === "check-failed");
    expect(failed).toHaveLength(1);
    const f = failed[0]!;
    expect(f.area).toBe("colors");
    expect(f.severity).toBe("error");
    if (f.kind === "check-failed") expect(f.data).toMatchObject({ checkId: "stub-colors", message: "boom" });
    expect(result.errors).toEqual([{ checkId: "stub-colors", area: "colors", message: "boom" }]);
    for (const a of AREAS.filter((x) => x !== "colors")) {
      expect(result.findings.some((x) => x.area === a && x.kind === "test-stub")).toBe(true);
    }
    expect(result.stats.perArea.colors).toEqual({ error: 1, warning: 0, info: 0, total: 1 });
  });

  it("isolates a rejecting async check and a check returning a non-array", async () => {
    const bytes = await corpusDeck("clean");
    const checks: Check[] = [
      { id: "async-bad", area: "media", run: async () => Promise.reject(new TypeError("nope")) },
      { id: "shape-bad", area: "links", run: () => "oops" as unknown as Finding[] },
      ...stubChecks().filter((c) => c.area === "review"),
    ];
    const result = await runChecks(bytes, {}, { checks });
    expect(result.errors.map((e) => e.checkId)).toEqual(["async-bad", "shape-bad"]);
    expect(result.findings.filter((f) => f.kind === "test-stub")).toHaveLength(1);
  });

  it("emits one progress event per area in fixed area order, regardless of registration order", async () => {
    const bytes = await corpusDeck("clean");
    const events: ProgressEvent[] = [];
    await runChecks(bytes, {}, { checks: stubChecks().reverse(), onProgress: (e) => events.push(e) });
    expect(events.map((e) => e.area)).toEqual([...AREAS]);
    expect(events.map((e) => e.completed)).toEqual(AREAS.map((_, i) => i + 1));
    expect(events.every((e) => e.total === AREAS.length)).toBe(true);
  });

  it("orders findings by area order", async () => {
    const bytes = await corpusDeck("clean");
    const result = await runChecks(bytes, {}, { checks: stubChecks().reverse() });
    expect(result.findings.map((f) => f.area)).toEqual([...AREAS]);
  });

  it("propagates package errors (not isolated) so the worker can map codes", async () => {
    await expect(runChecks(new Uint8Array([1, 2, 3]), {}, { checks: stubChecks() })).rejects.toMatchObject({
      code: "not-a-zip",
    });
  });
});

describe("cache", () => {
  it("returns the cached result for the same hash without re-parsing", async () => {
    const bytes = await corpusDeck("clean");
    const parse = vi.fn(loadPresentation);
    const cache = createAuditCache();
    const opts = { checks: stubChecks(), parse, cache };
    const first = await runChecksCached(bytes, "abc", {}, opts);
    const second = await runChecksCached(bytes, "abc", {}, opts);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.findings).toEqual(first.findings);
    expect(second.hash).toBe("abc");
  });

  it("still reports progress for every area on a cache hit", async () => {
    const bytes = await corpusDeck("clean");
    const cache = createAuditCache();
    await runChecksCached(bytes, "h", {}, { checks: stubChecks(), cache });
    const events: string[] = [];
    await runChecksCached(bytes, "h", {}, { checks: stubChecks(), cache, onProgress: (e) => events.push(e.area) });
    expect(events).toEqual([...AREAS]);
  });

  it("re-parses on a different hash or different options (brand profile)", async () => {
    const bytes = await corpusDeck("clean");
    const parse = vi.fn(loadPresentation);
    const cache = createAuditCache();
    const opts = { checks: stubChecks(), parse, cache };
    await runChecksCached(bytes, "h1", {}, opts);
    await runChecksCached(bytes, "h2", {}, opts);
    await runChecksCached(bytes, "h2", { brand: { fonts: ["Calibri"], colors: [], tolerance: 0 } }, opts);
    await runChecksCached(bytes, "h2", { brand: { fonts: ["Calibri"], colors: [], tolerance: 0 } }, opts);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("bounds its size (evicts least recently used)", async () => {
    const bytes = await corpusDeck("clean");
    const parse = vi.fn(loadPresentation);
    const cache = createAuditCache(2);
    const opts = { checks: stubChecks(), parse, cache };
    await runChecksCached(bytes, "a", {}, opts);
    await runChecksCached(bytes, "b", {}, opts);
    await runChecksCached(bytes, "c", {}, opts); // evicts a
    await runChecksCached(bytes, "a", {}, opts); // miss
    expect(parse).toHaveBeenCalledTimes(4);
  });
});

describe("findings contract", () => {
  it("ids are deterministic across runs of the same deck and unique within a run", async () => {
    const a = await shapeCheckFindings();
    const b = await shapeCheckFindings();
    expect(a.length).toBeGreaterThan(3);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
    for (const f of a) expect(f.id.startsWith("fonts:test-shape:")).toBe(true);
  });

  it("ids derive from area+kind+target keys, not from title/detail/data", () => {
    const base = {
      area: "fonts" as const,
      kind: "test-shape" as const,
      severity: "info" as const,
      group: "Arial",
      targets: [partTarget("slide", "ppt/slides/slide1.xml")],
      fixes: [],
    };
    const x = makeFinding({ ...base, title: "one", data: { name: "a" } });
    const y = makeFinding({ ...base, title: "two", detail: "d", data: { name: "b" } });
    const z = makeFinding({ ...base, title: "one", group: "Calibri", data: { name: "a" } });
    const w = makeFinding({ ...base, title: "one", data: { name: "a" }, key: "explicit" });
    expect(x.id).toBe(y.id);
    expect(x.id).not.toBe(z.id);
    expect(w.id).toBe(findingId("fonts", "test-shape", "explicit"));
    // Target order does not matter.
    const t1 = partTarget("slide", "ppt/slides/slide1.xml");
    const t2 = partTarget("layout", "ppt/slideLayouts/slideLayout1.xml");
    expect(makeFinding({ ...base, title: "", targets: [t1, t2], data: { name: "" } }).id).toBe(
      makeFinding({ ...base, title: "", targets: [t2, t1], data: { name: "" } }).id,
    );
  });

  it("targetKey distinguishes shape, run, and property locators", () => {
    const t = partTarget("slide", "ppt/slides/slide1.xml");
    const keys = new Set([
      targetKey(t),
      targetKey({ ...t, shapeId: 2 }),
      targetKey({ ...t, shapeId: 2, locator: { property: "fill" } }),
      targetKey({ ...t, shapeId: 2, locator: { property: "text", paragraphIndex: 0, runIndex: 1 } }),
      targetKey({ ...t, shapeId: 2, locator: { property: "text", paragraphIndex: 1, runIndex: 0 } }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("the runner disambiguates colliding ids deterministically", async () => {
    const bytes = await corpusDeck("clean");
    const dup: Check = {
      id: "dup",
      area: "review",
      run: () =>
        [1, 2].map((n) =>
          makeFinding({
            area: "review",
            kind: "test-stub",
            severity: "info",
            title: String(n),
            group: "g",
            targets: [],
            fixes: [],
            data: { area: "review", n },
          }),
        ),
    };
    const r = await runChecks(bytes, {}, { checks: [dup] });
    const ids = r.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toBe(`${ids[0]}~2`);
  });

  it("shapeTarget carries the KTD5 join keys and fallback data", async () => {
    const pres = await loadPresentation(await corpusDeck("clean"));
    const slide = pres.slides[2]!;
    const [shape] = await getShapes(pres, { kind: "slide", partName: slide.partName, slideId: slide.slideId });
    const t = shapeTarget(shape!, pres);
    expect(t).toMatchObject({
      container: { kind: "slide", partName: slide.partName, slideId: slide.slideId, slideIndex: 2, slideNumber: 3 },
      shapeId: shape!.shapeId,
      shapeName: shape!.name,
      path: [],
    });
    expect(t.bounds).toEqual(shape!.bounds);
  });

  it("results are structured-clone serializable (worker transfer)", async () => {
    const bytes = await corpusDeck("clean");
    const checks = stubChecks();
    checks.push({
      id: "bad",
      area: "links",
      run: () => {
        throw new Error("x");
      },
    });
    const result = await runChecks(bytes, {}, { checks, hash: "h" });
    const all = [...result.findings, ...(await shapeCheckFindings())];
    expect(structuredClone(result)).toEqual(result);
    expect(structuredClone(all)).toEqual(all);
    // No class instances sneak in: JSON round-trip is lossless too.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("summarize counts per area and severity, covering every area", () => {
    const mk = (area: Area, severity: "info" | "warning" | "error"): Finding =>
      makeFinding({ area, kind: "test-stub", severity, title: "", group: "", targets: [], fixes: [], data: { area, n: 0 } });
    const s = summarize([mk("fonts", "warning"), mk("fonts", "info"), mk("media", "error")]);
    expect(Object.keys(s).sort()).toEqual([...AREAS].sort());
    expect(s.fonts).toEqual({ error: 0, warning: 1, info: 1, total: 2 });
    expect(s.media).toEqual({ error: 1, warning: 0, info: 0, total: 1 });
    expect(s.review).toEqual({ error: 0, warning: 0, info: 0, total: 0 });
  });
});
