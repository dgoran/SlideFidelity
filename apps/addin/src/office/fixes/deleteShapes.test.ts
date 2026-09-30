import { describe, expect, it } from "vitest";
import { targetKey, type Finding } from "@slidecheck/audit-core";
import { previewFix, runFix } from "./engine";
import { deleteShapesKind } from "./deleteShapes";
import type { RunFixDeps } from "./types";
import { createFakePowerPoint, shapeReviewFinding, supportsUpTo, target, type FakeDeck } from "./testing/fakePowerPoint";

const env = { isSetSupported: supportsUpTo("1.10") };

function deps(fake: ReturnType<typeof createFakePowerPoint>, findings: Finding[]): RunFixDeps {
  return {
    rescanForFix: async () => ({ changed: false, hash: "h", bytes: new Uint8Array(), result: { findings } }),
    run: fake.run,
    isSetSupported: supportsUpTo("1.10"),
  };
}

async function completed(p: ReturnType<typeof runFix>) {
  const r = await p;
  if (r.status !== "completed") throw new Error(`expected completed, got ${r.status}`);
  return r.summary;
}

function offSlideDeck() {
  const deck: FakeDeck = { slides: [{ id: "256#", shapes: [] }] };
  const findings: Finding[] = [];
  for (let i = 1; i <= 5; i++) {
    deck.slides[0]!.shapes.push({ id: String(i), name: `Off ${i}`, left: 900 + i, top: 0 });
    findings.push(shapeReviewFinding("off-slide-shape", target({ shapeId: i, shapeName: `Off ${i}`, left: 900 + i, reachable: true })));
  }
  deck.slides[0]!.shapes.push({ id: "50", name: "Keep", left: 10, top: 10 });
  return { deck, findings };
}

describe("delete shapes", () => {
  it("is destructive and deletes exactly the 3 selected shape ids", async () => {
    expect(deleteShapesKind.destructive).toBe(true);
    const { deck, findings } = offSlideDeck();
    const selected = [findings[0]!, findings[2]!, findings[4]!].map((f) => f.id);
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(deleteShapesKind, { findingIds: selected }, deps(fake, findings)));
    expect(summary.changed).toBe(3);
    expect(fake.deck.slides[0]!.shapes.map((s) => s.id)).toEqual(["2", "4", "50"]);
  });

  it("selects by target key, and all at once", async () => {
    const { deck, findings } = offSlideDeck();
    const p = previewFix(deleteShapesKind, findings, { targetKeys: [targetKey(findings[1]!.targets[0]!)] }, env);
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.targets.map((t) => t.shapeId)).toEqual([2]);

    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(deleteShapesKind, { all: true }, deps(fake, findings)));
    expect(summary.changed).toBe(5);
    expect(fake.deck.slides[0]!.shapes.map((s) => s.id)).toEqual(["50"]);
  });

  it("refuses a shape whose id no longer matches even when name and position do", async () => {
    const { deck, findings } = offSlideDeck();
    deck.slides[0]!.shapes[0]!.id = "777"; // same name + position as target 1
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(deleteShapesKind, { findingIds: [findings[0]!.id] }, deps(fake, findings)));
    expect(summary.changed).toBe(0);
    expect(summary.skipped[0]!.reason).toMatch(/identity uncertain/i);
    expect(fake.deck.slides[0]!.shapes).toHaveLength(6);
  });

  it("refuses a slide matched only by position", async () => {
    const { deck, findings } = offSlideDeck();
    deck.slides[0]!.id = "not-a-number";
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(deleteShapesKind, { all: true }, deps(fake, findings)));
    expect(summary.changed).toBe(0);
    expect(summary.skipped.every((s) => /identity uncertain/i.test(s.reason ?? ""))).toBe(true);
  });

  it("merges a shape into its selected group and dedupes a shape flagged twice", () => {
    const group = target({ shapeId: 10, shapeName: "Group", reachable: true });
    const child = target({ shapeId: 11, shapeName: "Child", path: [10], reachable: true });
    const findings = [
      shapeReviewFinding("hidden-shape", group),
      shapeReviewFinding("hidden-shape", child),
      shapeReviewFinding("off-slide-shape", group),
    ];
    const p = previewFix(deleteShapesKind, findings, { all: true }, env);
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.targets).toHaveLength(1);
    expect(p.plan.targets[0]!.shapeId).toBe(10);
    expect(p.plan.targets[0]!.sources).toHaveLength(3);
  });

  it("lists layout and master shapes, and unreachable targets, as not deletable", () => {
    const findings = [
      shapeReviewFinding("empty-placeholder", target({ shapeId: 3, containerKind: "layout", containerName: "Title Slide", reachable: false })),
      shapeReviewFinding("hidden-shape", target({ shapeId: 4, reachable: false })),
    ];
    const p = previewFix(deleteShapesKind, findings, { all: true }, env);
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.targets).toHaveLength(0);
    expect(p.plan.unreachable).toHaveLength(2);
    expect(p.plan.unreachable[0]!.reason).toMatch(/layout/i);
  });

  it("requires an explicit selection", () => {
    const { findings } = offSlideDeck();
    expect(previewFix(deleteShapesKind, findings, { findingIds: [] }, env).status).toBe("invalid");
  });
});
