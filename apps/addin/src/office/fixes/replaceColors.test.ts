import { describe, expect, it } from "vitest";
import type { Finding } from "@slidefidelity/audit-core";
import { previewFix, runFix } from "./engine";
import { FIXED_COLOR_NOTE, replaceColorsKind } from "./replaceColors";
import type { RunFixDeps } from "./types";
import { colorUsageFinding, createFakePowerPoint, run, supportsUpTo, target, type FakeDeck } from "./testing/fakePowerPoint";

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

const RED = "FF0000";
const ACCENT2 = "#ED7D31";

describe("replace colors", () => {
  it("changes fill, line, and text instances and lists gradients unreachable", async () => {
    const deck: FakeDeck = {
      slides: [
        {
          id: "256#",
          shapes: [
            { id: "1", name: "Rect", fill: { type: "Solid", foregroundColor: "#FF0000" } },
            { id: "2", name: "Arrow", line: { color: "#ff0000" } },
            { id: "3", name: "Title", runs: [run("Red ", "Arial", "#FF0000"), run("black", "Arial", "#000000")] },
            { id: "4", name: "Grad", fill: { type: "Gradient", foregroundColor: "#FF0000" } },
          ],
        },
      ],
    };
    const findings = [
      colorUsageFinding(RED, [
        target({ shapeId: 1, shapeName: "Rect", reachable: true, locator: { property: "fill" } }),
        target({ shapeId: 2, shapeName: "Arrow", reachable: true, locator: { property: "line" } }),
        target({ shapeId: 3, shapeName: "Title", reachable: true, locator: { property: "text", paragraphIndex: 0, runIndex: 0 } }),
        target({ shapeId: 4, shapeName: "Grad", reachable: false, locator: { property: "fill" } }),
      ]),
    ];

    const p = previewFix(replaceColorsKind, findings, { from: ["#ff0000"], to: ACCENT2 }, env);
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.targets.map((t) => t.op.type)).toEqual(["color-fill", "color-line", "color-text"]);
    expect(p.plan.unreachable).toHaveLength(1);
    expect(p.plan.unreachable[0]!.reason).toMatch(/gradient/i);
    expect(p.plan.notes).toContain(FIXED_COLOR_NOTE);
    expect(FIXED_COLOR_NOTE).toMatch(/written as a fixed color; it will not follow later theme changes/);

    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceColorsKind, { from: [RED], to: ACCENT2 }, deps(fake, findings)));
    expect(summary.changed).toBe(3);
    const [rect, arrow, title, grad] = fake.deck.slides[0]!.shapes;
    expect(rect!.fill).toEqual({ type: "Solid", foregroundColor: ACCENT2 });
    expect(arrow!.line!.color).toBe(ACCENT2);
    expect(title!.runs!.map((r) => `${r.text}:${r.font.color}`)).toEqual([`Red :${ACCENT2}`, "black:#000000"]);
    expect(grad!.fill).toEqual({ type: "Gradient", foregroundColor: "#FF0000" });
  });

  it("never writes a property the plan does not name", async () => {
    // Shape 1 has red fill AND red line, but only the fill is a target.
    const deck: FakeDeck = { slides: [{ id: "256#", shapes: [{ id: "1", name: "R", fill: { type: "Solid", foregroundColor: "#FF0000" }, line: { color: "#FF0000" } }] }] };
    const findings = [colorUsageFinding(RED, [target({ shapeId: 1, reachable: true, locator: { property: "fill" } })])];
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceColorsKind, { from: [RED], to: ACCENT2 }, deps(fake, findings)));
    expect(summary.changed).toBe(1);
    expect(fake.deck.slides[0]!.shapes[0]!.line!.color).toBe("#FF0000");
  });

  it("skips a fill that is no longer the source color", async () => {
    const deck: FakeDeck = { slides: [{ id: "256#", shapes: [{ id: "1", name: "R", fill: { type: "Solid", foregroundColor: "#00FF00" } }] }] };
    const findings = [colorUsageFinding(RED, [target({ shapeId: 1, reachable: true, locator: { property: "fill" } })])];
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceColorsKind, { from: [RED], to: ACCENT2 }, deps(fake, findings)));
    expect(summary.changed).toBe(0);
    expect(summary.skipped[0]!.reason).toMatch(/no longer/i);
    expect(fake.writes).toEqual([]);
  });

  it("changes table cell fill and uniform cell text color (1.9)", async () => {
    const deck: FakeDeck = {
      slides: [
        {
          id: "256#",
          shapes: [{ id: "9", name: "Table", table: { cells: [[{ runs: [run("x", "Arial", "#FF0000")], fill: { type: "Solid", foregroundColor: "#FF0000" } }]] } }],
        },
      ],
    };
    const findings = [
      colorUsageFinding(RED, [
        target({ shapeId: 9, reachable: true, locator: { property: "table-cell", cell: { row: 0, col: 0 } } }),
        target({ shapeId: 9, reachable: true, locator: { property: "text", cell: { row: 0, col: 0 }, paragraphIndex: 0, runIndex: 0 } }),
      ]),
    ];
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceColorsKind, { from: [RED], to: ACCENT2 }, deps(fake, findings)));
    expect(summary.changed).toBe(2);
    const c = fake.deck.slides[0]!.shapes[0]!.table!.cells[0]![0]!;
    expect(c.fill!.foregroundColor).toBe(ACCENT2);
    expect(c.runs[0]!.font.color).toBe(ACCENT2);

    const old = previewFix(replaceColorsKind, findings, { from: [RED], to: ACCENT2 }, { isSetSupported: supportsUpTo("1.8") });
    if (old.status !== "ready") throw new Error(old.status);
    expect(old.plan.targets).toHaveLength(0);
    expect(old.plan.unreachable).toHaveLength(2);
  });

  it("lists layout, master, and chart colors as unreachable", () => {
    const findings = [
      colorUsageFinding(RED, [
        target({ shapeId: 1, reachable: false, containerKind: "layout", containerName: "Title Slide", locator: { property: "fill" } }),
        target({ shapeId: 2, reachable: false, containerKind: "chart", locator: { property: "other" } }),
      ]),
    ];
    const p = previewFix(replaceColorsKind, findings, { from: [RED], to: ACCENT2 }, env);
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.unreachable.map((u) => u.reason)).toEqual([expect.stringMatching(/layout/i), expect.stringMatching(/chart/i)]);
    expect(p.plan.unreachable[0]!.label).toMatch(/Title Slide/);
  });

  it("rejects unusable colors", () => {
    const f = [colorUsageFinding(RED, [])];
    expect(previewFix(replaceColorsKind, f, { from: ["red"], to: ACCENT2 }, env).status).toBe("invalid");
    expect(previewFix(replaceColorsKind, f, { from: [RED], to: "#12345" }, env).status).toBe("invalid");
    expect(previewFix(replaceColorsKind, f, { from: [RED], to: "#ff0000" }, env).status).toBe("invalid");
    expect(previewFix(replaceColorsKind, f, { from: [], to: ACCENT2 }, env).status).toBe("invalid");
  });
});
