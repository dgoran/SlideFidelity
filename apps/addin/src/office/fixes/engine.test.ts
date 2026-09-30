import { describe, expect, it, vi } from "vitest";
import type { Finding } from "@slidecheck/audit-core";
import { BATCH_SIZE, makeBatches, previewFix, runFix, UNDO_NOTE } from "./engine";
import { replaceFontsKind } from "./replaceFonts";
import { deleteShapesKind } from "./deleteShapes";
import type { PlannedTarget, RunFixDeps } from "./types";
import {
  createFakePowerPoint,
  fontUsageFinding,
  run,
  shapeReviewFinding,
  supportsUpTo,
  target,
  type FakeDeck,
  type FakeShape,
} from "./testing/fakePowerPoint";

/** `n` Arial text boxes spread over slides of 10 shapes each, plus the matching finding. */
function arialDeck(n: number): { deck: FakeDeck; findings: Finding[] } {
  const deck: FakeDeck = { slides: [] };
  const entries: Parameters<typeof fontUsageFinding>[1] = [];
  for (let i = 0; i < n; i++) {
    const slideNumber = Math.floor(i / 10) + 1;
    let slide = deck.slides[slideNumber - 1];
    if (!slide) {
      slide = { id: `${255 + slideNumber}#`, shapes: [] };
      deck.slides.push(slide);
    }
    const shapeId = 100 + i;
    slide.shapes.push({ id: String(shapeId), name: `TextBox ${i}`, left: i, top: 10, runs: [run(`Text ${i}`, "Arial")] });
    entries.push({
      target: target({ slideNumber, shapeId, shapeName: `TextBox ${i}`, left: i, top: 10, reachable: true, locator: { property: "text", paragraphIndex: 0, runIndex: 0, script: "latin" } }),
    });
  }
  return { deck, findings: [fontUsageFinding("Arial", entries)] };
}

function deps(fake: ReturnType<typeof createFakePowerPoint>, findings: Finding[], extra: Partial<RunFixDeps> = {}): RunFixDeps {
  return {
    rescanForFix: vi.fn(async () => ({ changed: false, hash: "h1", bytes: new Uint8Array([1, 2, 3]), result: { findings } })),
    run: fake.run,
    isSetSupported: supportsUpTo("1.10"),
    ...extra,
  };
}

function allShapes(deck: FakeDeck): FakeShape[] {
  return deck.slides.flatMap((s) => s.shapes);
}

const params = { from: ["Arial"], to: "Georgia" };

describe("fix engine", () => {
  it("applies a 60-target plan in 3 batches and reports 60 changed", async () => {
    const { deck, findings } = arialDeck(60);
    const fake = createFakePowerPoint(deck);
    const progress = vi.fn();
    const res = await runFix(replaceFontsKind, params, deps(fake, findings, { onProgress: progress }));
    expect(res.status).toBe("completed");
    if (res.status !== "completed") return;
    expect(res.summary.changed).toBe(60);
    expect(res.summary.batches).toBe(3);
    expect(res.summary.completedBatches).toBe(3);
    expect(fake.runCount).toBe(3);
    expect(fake.writeSyncs).toHaveLength(3);
    expect(progress.mock.calls.map((c) => c[0])).toEqual([
      { batch: 1, batches: 3, done: 25, total: 60 },
      { batch: 2, batches: 3, done: 50, total: 60 },
      { batch: 3, batches: 3, done: 60, total: 60 },
    ]);
    expect(allShapes(fake.deck).every((s) => s.runs!.every((r) => r.font.name === "Georgia"))).toBe(true);
  });

  it("skips 2 targets deleted since the scan and still applies the rest", async () => {
    const { deck, findings } = arialDeck(60);
    deck.slides[0]!.shapes.splice(3, 1);
    deck.slides[4]!.shapes.splice(0, 1);
    const fake = createFakePowerPoint(deck);
    const res = await runFix(replaceFontsKind, params, deps(fake, findings));
    if (res.status !== "completed") throw new Error(res.status);
    expect(res.summary.changed).toBe(58);
    expect(res.summary.skipped.map((s) => s.target.shapeId).sort()).toEqual([103, 140]);
    expect(res.summary.skipped[0]!.reason).toMatch(/no longer exists/i);
  });

  it("marks a batch whose write sync throws as unknown and continues with the next batch", async () => {
    const { deck, findings } = arialDeck(60);
    const fake = createFakePowerPoint(deck);
    fake.failSync({ onWriteSync: 2, afterOps: 5 });
    const res = await runFix(replaceFontsKind, params, deps(fake, findings));
    if (res.status !== "completed") throw new Error(res.status);
    expect(res.summary.changed).toBe(35);
    expect(res.summary.unknown).toHaveLength(25);
    expect(res.summary.unknown.every((u) => u.target.shapeId >= 125 && u.target.shapeId < 150)).toBe(true);
    expect(res.summary.unknown[0]!.reason).toMatch(/may or may not/i);
    expect(res.summary.failed).toHaveLength(0);
    // The third batch ran after the failure.
    expect(allShapes(fake.deck).slice(50).every((s) => s.runs![0]!.font.name === "Georgia")).toBe(true);
  });

  it("marks a batch whose reads fail as failed (nothing written) and continues", async () => {
    const { deck, findings } = arialDeck(30);
    delete deck.slides[0]!.shapes[2]!.runs; // text frame read fails at sync
    const fake = createFakePowerPoint(deck);
    const res = await runFix(replaceFontsKind, params, deps(fake, findings));
    if (res.status !== "completed") throw new Error(res.status);
    expect(res.summary.failed).toHaveLength(25);
    expect(res.summary.unknown).toHaveLength(0);
    expect(res.summary.changed).toBe(5);
    expect(allShapes(fake.deck).slice(0, 25).some((s) => s.runs?.[0]?.font.name === "Georgia")).toBe(false);
  });

  it("stops after batch 1 when cancelled and reports the partial result", async () => {
    const { deck, findings } = arialDeck(60);
    const fake = createFakePowerPoint(deck);
    const ac = new AbortController();
    const res = await runFix(
      replaceFontsKind,
      params,
      deps(fake, findings, { signal: ac.signal, onProgress: (p) => p.batch === 1 && ac.abort() }),
    );
    expect(res.status).toBe("cancelled");
    if (res.status !== "cancelled") return;
    expect(res.summary.changed).toBe(25);
    expect(res.summary.notRun).toHaveLength(35);
    expect(res.summary.completedBatches).toBe(1);
    expect(fake.runCount).toBe(1);
  });

  it("D4: re-plans without writing when the file changed since the preview", async () => {
    const { deck, findings } = arialDeck(5);
    const newer = arialDeck(7).findings;
    const fake = createFakePowerPoint(deck);
    const onApplied = vi.fn();
    const res = await runFix(
      replaceFontsKind,
      params,
      deps(fake, findings, {
        onApplied,
        rescanForFix: async () => ({ changed: true, hash: "h2", bytes: new Uint8Array(), result: { findings: newer } }),
      }),
    );
    expect(res.status).toBe("replanned");
    if (res.status !== "replanned") return;
    expect(res.plan.targets).toHaveLength(7);
    expect(res.hash).toBe("h2");
    expect(fake.runCount).toBe(0);
    expect(fake.writes).toEqual([]);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("blocks with an explanation when the host lacks the kind's requirement set", async () => {
    const { deck, findings } = arialDeck(3);
    const fake = createFakePowerPoint(deck);
    const d = deps(fake, findings, { isSetSupported: supportsUpTo("1.3") });
    const res = await runFix(replaceFontsKind, params, d);
    expect(res).toMatchObject({ status: "blocked", requiredSet: "1.4" });
    if (res.status === "blocked") expect(res.reason).toMatch(/PowerPointApi 1\.4/);
    expect(d.rescanForFix).not.toHaveBeenCalled();
    expect(fake.runCount).toBe(0);
  });

  it("returns the pre-fix bytes and calls onApplied exactly once", async () => {
    const { deck, findings } = arialDeck(30);
    const fake = createFakePowerPoint(deck);
    const onApplied = vi.fn();
    const res = await runFix(replaceFontsKind, params, deps(fake, findings, { onApplied }));
    if (res.status !== "completed") throw new Error(res.status);
    expect(Array.from(res.summary.preFixBytes)).toEqual([1, 2, 3]);
    expect(res.summary.preFixHash).toBe("h1");
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("allows a name+position fallback match for replace-font but refuses it for delete", async () => {
    const deck: FakeDeck = {
      slides: [{ id: "256#", shapes: [{ id: "900", name: "Box", left: 40, top: 20, runs: [run("x", "Arial")] }] }],
    };
    const t = target({ shapeId: 7, shapeName: "Box", left: 40, top: 20, reachable: true, locator: { property: "text", paragraphIndex: 0, runIndex: 0 } });
    const fake = createFakePowerPoint(deck);
    const font = await runFix(replaceFontsKind, params, deps(fake, [fontUsageFinding("Arial", [{ target: t }])]));
    if (font.status !== "completed") throw new Error(font.status);
    expect(font.summary.changed).toBe(1);

    const hidden = shapeReviewFinding("hidden-shape", { ...t, locator: undefined } as typeof t);
    const del = await runFix(deleteShapesKind, { all: true }, deps(fake, [hidden]));
    if (del.status !== "completed") throw new Error(del.status);
    expect(del.summary.changed).toBe(0);
    expect(del.summary.skipped[0]!.reason).toMatch(/identity uncertain/i);
    expect(fake.deck.slides[0]!.shapes).toHaveLength(1);
  });

  it("previews without Office calls, with per-slide counts and the undo caveat", () => {
    const { findings } = arialDeck(23);
    const p = previewFix(replaceFontsKind, findings, params, { isSetSupported: supportsUpTo("1.10") });
    expect(p.status).toBe("ready");
    if (p.status !== "ready") return;
    expect(p.plan.perSlide).toEqual([
      { slideId: 256, slideNumber: 1, count: 10 },
      { slideId: 257, slideNumber: 2, count: 10 },
      { slideId: 258, slideNumber: 3, count: 3 },
    ]);
    expect(p.plan.notes).toContain(UNDO_NOTE);
  });

  it("keeps units with the same batch key in one batch", () => {
    const mk = (key: string, batchKey?: string): PlannedTarget => ({
      key,
      slideId: 256,
      shapeId: 1,
      shapeName: "",
      left: 0,
      top: 0,
      path: [],
      label: key,
      op: { type: "delete-shape" },
      sources: [],
      findingIds: [],
      ...(batchKey ? { batchKey } : {}),
    });
    const units = [mk("a"), mk("b"), mk("c", "k"), mk("d", "k"), mk("e", "k"), mk("f"), mk("g", "k")];
    const batches = makeBatches(units, 3);
    expect(batches.map((b) => b.map((u) => u.key))).toEqual([["a", "b"], ["c", "d", "e", "g"], ["f"]]);
    expect(BATCH_SIZE).toBe(25);
  });
});
