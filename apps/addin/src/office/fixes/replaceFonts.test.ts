import { describe, expect, it } from "vitest";
import type { Finding } from "@slidefidelity/audit-core";
import { previewFix, runFix } from "./engine";
import { replaceFontsKind } from "./replaceFonts";
import type { RunFixDeps } from "./types";
import {
  createFakePowerPoint,
  fakeText,
  fontUsageFinding,
  run,
  supportsUpTo,
  target,
  type FakeDeck,
} from "./testing/fakePowerPoint";

const env = { isSetSupported: supportsUpTo("1.10") };

function deps(fake: ReturnType<typeof createFakePowerPoint>, findings: Finding[], max = "1.10"): RunFixDeps {
  return {
    rescanForFix: async () => ({ changed: false, hash: "h", bytes: new Uint8Array(), result: { findings } }),
    run: fake.run,
    isSetSupported: supportsUpTo(max),
  };
}

const textLoc = (paragraphIndex = 0, runIndex = 0) => ({ property: "text" as const, paragraphIndex, runIndex, script: "latin" as const });

async function completed(p: ReturnType<typeof runFix>) {
  const r = await p;
  if (r.status !== "completed") throw new Error(`expected completed, got ${r.status}`);
  return r.summary;
}

describe("replace fonts", () => {
  it("AE2: 40 text boxes change and the chart usage is listed unreachable by name", async () => {
    const deck: FakeDeck = { slides: [] };
    const entries: Parameters<typeof fontUsageFinding>[1] = [];
    for (let i = 0; i < 40; i++) {
      const slideNumber = (i % 4) + 1;
      if (!deck.slides[slideNumber - 1]) deck.slides[slideNumber - 1] = { id: `${255 + slideNumber}#`, shapes: [] };
      deck.slides[slideNumber - 1]!.shapes.push({ id: String(10 + i), name: `TextBox ${i}`, runs: [run("Body", "Arial")] });
      entries.push({ target: target({ slideNumber, shapeId: 10 + i, shapeName: `TextBox ${i}`, reachable: true, locator: textLoc() }) });
    }
    entries.push({
      target: target({ slideNumber: 3, shapeId: 99, shapeName: "Chart 5", containerKind: "chart", partName: "ppt/charts/chart1.xml", reachable: false, locator: { script: "latin" } }),
      usage: { source: "chart" },
    });
    const findings = [fontUsageFinding("Arial", entries)];

    const preview = previewFix(replaceFontsKind, findings, { from: ["Arial"], to: "Calibri" }, env);
    if (preview.status !== "ready") throw new Error(preview.status);
    expect(preview.plan.targets).toHaveLength(40);
    expect(preview.plan.unreachable).toHaveLength(1);
    expect(preview.plan.unreachable[0]!.reason).toMatch(/chart/i);
    expect(preview.plan.unreachable[0]!.label).toMatch(/Slide 3/);
    expect(preview.plan.unreachable[0]!.label).toMatch(/Chart 5/);

    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceFontsKind, { from: ["Arial"], to: "Calibri" }, deps(fake, findings)));
    expect(summary.changed).toBe(40);
    expect(summary.unreachable).toHaveLength(1);
    expect(summary.unreachable[0]!.label).toMatch(/Chart 5/);
  });

  it("changes only the Arial part of a mixed run ('Hello ' Arial + 'world' Calibri)", async () => {
    const deck: FakeDeck = { slides: [{ id: "256#", shapes: [{ id: "5", name: "Box", runs: [run("Hello ", "Arial"), run("world", "Calibri")] }] }] };
    const findings = [fontUsageFinding("Arial", [{ target: target({ shapeId: 5, shapeName: "Box", reachable: true, locator: textLoc() }) }])];
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceFontsKind, { from: ["Arial"], to: "Georgia" }, deps(fake, findings)));
    expect(summary.changed).toBe(1);
    const shape = fake.deck.slides[0]!.shapes[0]!;
    expect(fakeText(shape)).toBe("Hello world");
    const byChar = shape.runs!.flatMap((r) => [...r.text].map(() => r.font.name));
    expect(byChar).toEqual([...Array(6).fill("Georgia"), ...Array(5).fill("Calibri")]);
  });

  it("bisects several separated ranges and several source fonts in one shape", async () => {
    const runs = [run("Alpha ", "Arial"), run("beta ", "Calibri"), run("gamma ", "Helvetica"), run("delta", "Calibri"), run("!", "Arial")];
    const deck: FakeDeck = { slides: [{ id: "256#", shapes: [{ id: "5", name: "Box", runs }] }] };
    const t = (runIndex: number) => ({ target: target({ shapeId: 5, shapeName: "Box", reachable: true, locator: textLoc(0, runIndex) }) });
    const findings = [fontUsageFinding("Arial", [t(0), t(4)]), fontUsageFinding("Helvetica", [t(2)])];
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceFontsKind, { from: ["arial", "Helvetica"], to: "Georgia" }, deps(fake, findings)));
    // Three finding targets on one shape merge into one unit.
    expect(summary.plan.targets).toHaveLength(1);
    expect(summary.plan.targets[0]!.sources).toHaveLength(3);
    expect(summary.changed).toBe(1);
    const shape = fake.deck.slides[0]!.shapes[0]!;
    const byChar = shape.runs!.flatMap((r) => [...r.text].map((c) => `${c}:${r.font.name}`)).join("");
    expect(fakeText(shape)).toBe("Alpha beta gamma delta!");
    expect(byChar).not.toMatch(/Arial|Helvetica/);
    expect(shape.runs!.filter((r) => r.font.name === "Calibri").map((r) => r.text).join("|")).toBe("beta |delta");
  });

  it("reports an ea-only font as unreachable, not silently skipped", () => {
    const findings = [
      fontUsageFinding("MS Gothic", [
        { target: target({ shapeId: 5, reachable: false, locator: { property: "text", paragraphIndex: 0, runIndex: 0, script: "ea" } }), usage: { script: "ea" } },
      ]),
    ];
    const p = previewFix(replaceFontsKind, findings, { from: ["MS Gothic"], to: "Meiryo" }, env);
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.targets).toHaveLength(0);
    expect(p.plan.unreachable).toHaveLength(1);
    expect(p.plan.unreachable[0]!.reason).toMatch(/East Asian/);
  });

  it("D2: never targets theme font references and names why", () => {
    const findings = [
      fontUsageFinding("Calibri", [
        { target: target({ shapeId: 5, reachable: false, locator: textLoc() }), usage: { theme: "minor", ref: "+mn-lt" } },
        { target: target({ shapeId: 6, reachable: false, containerKind: "theme", partName: "ppt/theme/theme1.xml" }), usage: { source: "theme-default", theme: "minor" } },
        { target: target({ shapeId: 7, reachable: false, containerKind: "master" }), usage: { source: "master" } },
        { target: target({ shapeId: 8, reachable: false, locator: { property: "bullet", paragraphIndex: 0, script: "bu" } }), usage: { script: "bu" } },
        { target: target({ shapeId: 9, reachable: false, locator: { property: "list-style", level: 2 } }), usage: { source: "hidden-list-style" } },
      ]),
    ];
    const p = previewFix(replaceFontsKind, findings, { from: ["Calibri"], to: "Georgia" }, env);
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.targets).toHaveLength(0);
    const reasons = p.plan.unreachable.map((u) => u.reason);
    expect(reasons[0]).toMatch(/theme font/i);
    expect(reasons[1]).toMatch(/theme/i);
    expect(reasons[2]).toMatch(/layout or master/i);
    expect(reasons[3]).toMatch(/bullet/i);
    expect(reasons[4]).toMatch(/list style/i);
  });

  it("does not touch a shape that mixes a direct font with a theme reference to the same font", () => {
    const findings = [
      fontUsageFinding("Calibri", [
        { target: target({ shapeId: 5, reachable: true, locator: textLoc(0, 0) }) },
        { target: target({ shapeId: 5, reachable: false, locator: textLoc(0, 1) }), usage: { theme: "minor", ref: "+mn-lt" } },
      ]),
    ];
    const p = previewFix(replaceFontsKind, findings, { from: ["Calibri"], to: "Georgia" }, env);
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.targets).toHaveLength(0);
    expect(p.plan.unreachable).toHaveLength(2);
    expect(p.plan.unreachable[0]!.reason).toMatch(/theme font reference/i);
  });

  it("skips a shape that no longer uses the font", async () => {
    const deck: FakeDeck = { slides: [{ id: "256#", shapes: [{ id: "5", name: "Box", runs: [run("x", "Verdana")] }] }] };
    const findings = [fontUsageFinding("Arial", [{ target: target({ shapeId: 5, reachable: true, locator: textLoc() }) }])];
    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceFontsKind, { from: ["Arial"], to: "Georgia" }, deps(fake, findings)));
    expect(summary.changed).toBe(0);
    expect(summary.skipped[0]!.reason).toMatch(/no longer uses/i);
    expect(fake.writes).toEqual([]);
  });

  it("changes uniform table cells (1.9), skips mixed cells, and lists tables unreachable below 1.9", async () => {
    const deck: FakeDeck = {
      slides: [
        {
          id: "256#",
          shapes: [
            {
              id: "20",
              name: "Table 1",
              table: { cells: [[{ runs: [run("a", "Arial")] }, { runs: [run("b", "Arial"), run("c", "Calibri")] }]] },
            },
          ],
        },
      ],
    };
    const cell = (col: number) => ({
      target: target({ shapeId: 20, shapeName: "Table 1", reachable: true, locator: { property: "table-cell", cell: { row: 0, col }, paragraphIndex: 0, runIndex: 0, script: "latin" } }),
    });
    const findings = [fontUsageFinding("Arial", [cell(0), cell(1)])];

    const old = previewFix(replaceFontsKind, findings, { from: ["Arial"], to: "Georgia" }, { isSetSupported: supportsUpTo("1.8") });
    if (old.status !== "ready") throw new Error(old.status);
    expect(old.plan.targets).toHaveLength(0);
    expect(old.plan.unreachable[0]!.reason).toMatch(/1\.9/);

    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceFontsKind, { from: ["Arial"], to: "Georgia" }, deps(fake, findings)));
    expect(summary.changed).toBe(1);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]!.reason).toMatch(/mixes fonts/i);
    const cells = fake.deck.slides[0]!.shapes[0]!.table!.cells[0]!;
    expect(cells[0]!.runs[0]!.font.name).toBe("Georgia");
    expect(cells[1]!.runs.map((r) => r.font.name)).toEqual(["Arial", "Calibri"]);
  });

  it("recurses into groups (1.8) and lists grouped shapes unreachable below 1.8", async () => {
    const deck: FakeDeck = {
      slides: [
        {
          id: "256#",
          shapes: [
            { id: "30", name: "Group 1", shapes: [{ id: "31", name: "Inner", runs: [run("in", "Arial")] }] },
            { id: "31", name: "Decoy", runs: [run("out", "Arial")] },
          ],
        },
      ],
    };
    const findings = [fontUsageFinding("Arial", [{ target: target({ shapeId: 31, shapeName: "Inner", path: [30], reachable: true, locator: textLoc() }) }])];

    const old = previewFix(replaceFontsKind, findings, { from: ["Arial"], to: "Georgia" }, { isSetSupported: supportsUpTo("1.7") });
    if (old.status !== "ready") throw new Error(old.status);
    expect(old.plan.unreachable[0]!.reason).toMatch(/1\.8/);

    const fake = createFakePowerPoint(deck);
    const summary = await completed(runFix(replaceFontsKind, { from: ["Arial"], to: "Georgia" }, deps(fake, findings)));
    expect(summary.changed).toBe(1);
    expect(fake.deck.slides[0]!.shapes[0]!.shapes![0]!.runs![0]!.font.name).toBe("Georgia");
    expect(fake.deck.slides[0]!.shapes[1]!.runs![0]!.font.name).toBe("Arial");
  });

  it("rejects unusable parameters", () => {
    const f = [fontUsageFinding("Arial", [])];
    expect(previewFix(replaceFontsKind, f, { from: [], to: "Georgia" }, env).status).toBe("invalid");
    expect(previewFix(replaceFontsKind, f, { from: ["Arial"], to: "  " }, env).status).toBe("invalid");
    expect(previewFix(replaceFontsKind, f, { from: ["Arial"], to: "arial" }, env).status).toBe("invalid");
  });
});
