import { describe, expect, it } from "vitest";
import { masterChecks } from "../../src/checks/masters";
import { loadPresentation, type Finding, type FindingOf } from "../../src/index";
import { buildDeck, DEFAULT_LAYOUTS, layoutPart, masterPart, type DeckSpec } from "../helpers/buildDeck";
import { corpusDeck, SEEDS } from "../helpers/corpus";

async function run(bytes: Uint8Array): Promise<Finding[]> {
  const pres = await loadPresentation(bytes);
  const out: Finding[] = [];
  for (const c of masterChecks) out.push(...(await c.run({ pres, options: {} })));
  return out;
}

function ofKind<K extends Finding["kind"]>(fs: Finding[], kind: K): FindingOf<K>[] {
  return fs.filter((f) => f.kind === kind) as unknown as FindingOf<K>[];
}

const seeds = SEEDS["masters-messy"];

describe("masters checks: masters-messy corpus", () => {
  it("builds the master → layout → slides usage tree with correct counts", async () => {
    const fs = await run(await corpusDeck("masters-messy"));
    const usage = ofKind(fs, "master-usage");
    expect(usage.map((f) => f.data.masterPart)).toEqual([masterPart(1), masterPart(2), masterPart(3)]);
    for (const f of usage) {
      expect(f.severity).toBe("info");
      expect(f.area).toBe("masters");
      expect(f.targets[0]?.container).toMatchObject({ kind: "master", partName: f.data.masterPart });
    }
    const layouts = usage.flatMap((f) => f.data.layouts);
    const byPart = Object.fromEntries(layouts.map((l) => [l.partName, l.slideIds]));
    expect(byPart).toEqual(seeds.usage);
    const m1 = usage[0]!;
    expect(m1.data.layouts.map((l) => [l.name, l.slideNumbers])).toEqual([
      ["Title Slide", [1]],
      ["Title and Content", [2, 3]],
      ["Two Content", []],
      ["Comparison", []],
    ]);
    expect(m1.data.slideCount).toBe(3);
    expect(m1.count).toBe(3);
    expect(usage[2]!.data.slideCount).toBe(2);
    expect(usage[1]!.data.name).toBe("Legacy Theme");
  });

  it("reports the seeded unused layouts as read-only warnings", async () => {
    const fs = await run(await corpusDeck("masters-messy"));
    const unused = ofKind(fs, "unused-layout");
    expect(unused.map((f) => f.data.layoutPart).sort()).toEqual([...seeds.unusedLayouts].sort());
    for (const f of unused) {
      expect(f.severity).toBe("warning");
      expect(f.fixes).toEqual([]);
      expect(f.reachable).toBe(false);
      expect(f.targets[0]?.container.kind).toBe("layout");
      expect(f.targets[0]?.container.name).toBe(f.data.layoutName);
    }
    const oldTitle = unused.find((f) => f.data.layoutPart === layoutPart(5));
    expect(oldTitle?.data).toMatchObject({ layoutName: "Old Title", masterPart: masterPart(2), masterName: "Legacy Theme" });
  });

  it("reports exactly one unused master, which is preserved", async () => {
    const fs = await run(await corpusDeck("masters-messy"));
    const unused = ofKind(fs, "unused-master");
    expect(unused).toHaveLength(1);
    expect(unused[0]!.data).toMatchObject({ masterPart: seeds.preservedUnusedMaster, preserved: true, layoutCount: 2 });
    expect(unused[0]!.severity).toBe("warning");
    const preserved = ofKind(fs, "preserved-master");
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.severity).toBe("info");
    expect(preserved[0]!.data).toMatchObject({ masterPart: seeds.preservedUnusedMaster, unused: true });
  });

  it("does not flag masters-messy's two active masters as duplicates (one shared name of six)", async () => {
    const fs = await run(await corpusDeck("masters-messy"));
    expect(ofKind(fs, "duplicate-masters")).toEqual([]);
  });

  it("produces deterministic ids and structured-clone-safe findings", async () => {
    const bytes = await corpusDeck("masters-messy");
    const a = await run(bytes);
    const b = await run(bytes);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
    expect(structuredClone(a)).toEqual(a);
  });
});

describe("masters checks: edge cases", () => {
  it("clean deck: usage only, no warnings", async () => {
    const fs = await run(await corpusDeck("clean"));
    expect(fs.filter((f) => f.severity !== "info")).toEqual([]);
    expect(ofKind(fs, "master-usage")).toHaveLength(1);
  });

  it("a preserved master that is used is info only", async () => {
    const spec: DeckSpec = { masters: [{ preserve: true, layouts: DEFAULT_LAYOUTS }], slides: [{ layout: "Title Slide" }] };
    const fs = await run(await buildDeck(spec));
    expect(ofKind(fs, "unused-master")).toEqual([]);
    const preserved = ofKind(fs, "preserved-master");
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.severity).toBe("info");
    expect(preserved[0]!.data.unused).toBe(false);
    // Its unused layouts are still reported.
    expect(ofKind(fs, "unused-layout").map((f) => f.data.layoutName)).toEqual(["Title and Content", "Blank"]);
  });

  it("warns on two active masters with near-identical layout names", async () => {
    const layouts = [
      { name: "Title Slide", type: "title" },
      { name: "Title and Content", type: "obj" },
      { name: "Section Header", type: "secHead" },
      { name: "Two Content", type: "twoObj" },
      { name: "Blank", type: "blank" },
    ];
    const spec: DeckSpec = {
      masters: [
        { layouts },
        { layouts: layouts.map((l) => ({ ...l, name: l.name === "Blank" ? "blank " : l.name })), theme: { name: "Pasted" } },
        { layouts: [{ name: "Blank", type: "blank" }], theme: { name: "Unused copy" } },
      ],
      slides: [{ layout: { master: 0, layout: 1 } }, { layout: { master: 1, layout: 1 } }],
    };
    const fs = await run(await buildDeck(spec));
    const dup = ofKind(fs, "duplicate-masters");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.severity).toBe("warning");
    expect(dup[0]!.data.masters.map((m) => m.partName)).toEqual([masterPart(1), masterPart(2)]);
    expect(dup[0]!.data.overlap).toBe(1);
    expect(dup[0]!.data.sharedLayoutNames).toHaveLength(5);
    expect(dup[0]!.targets.map((t) => t.container.kind)).toEqual(["master", "master"]);
  });

  it("does not flag duplicates below 80% overlap", async () => {
    const spec: DeckSpec = {
      masters: [
        { layouts: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }] },
        { layouts: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "X" }, { name: "Y" }] },
      ],
      slides: [{ layout: { master: 0, layout: 0 } }, { layout: { master: 1, layout: 0 } }],
    };
    const fs = await run(await buildDeck(spec));
    expect(ofKind(fs, "duplicate-masters")).toEqual([]);
  });
});
