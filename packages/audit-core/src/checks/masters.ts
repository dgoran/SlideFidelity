/**
 * Masters area (U8, R8): master → layout → slides usage, unused layouts and masters, preserved
 * masters, and near-duplicate active masters (typically pasted-in copies of the same template).
 *
 * All findings are read-only in v1: deleting layouts / masters is a preview-only Office.js API, so
 * `fixes` is empty and `reachable` is false.
 */
import { makeFinding, partTarget, type Finding } from "../findings";
import type { LayoutInfo, MasterInfo, Presentation } from "../package/model";
import type { Check } from "../runner";

export interface LayoutUsage {
  partName: string;
  name: string;
  /** `p:sldLayout/@type` (`cust` when absent). */
  type: string;
  preserve: boolean;
  /** 1-based slide numbers using this layout, in slide order. */
  slideNumbers: number[];
  /** `p:sldId/@id` of the slides using this layout. */
  slideIds: number[];
}

export interface MasterUsageData {
  masterPart: string;
  /** Master display name: `p:cSld/@name`, else the theme name, else "Master N". */
  name: string;
  themePart?: string;
  preserve: boolean;
  /** Number of slides using any of this master's layouts. */
  slideCount: number;
  layouts: LayoutUsage[];
}

export interface UnusedLayoutData {
  layoutPart: string;
  layoutName: string;
  layoutType: string;
  masterPart?: string;
  masterName?: string;
  /** The layout itself carries `preserve="1"`. */
  preserve: boolean;
}

export interface UnusedMasterData {
  masterPart: string;
  masterName: string;
  layoutCount: number;
  /** The master carries `preserve="1"` (PowerPoint keeps it even when unused). */
  preserved: boolean;
}

export interface PreservedMasterData {
  masterPart: string;
  masterName: string;
  /** True when no slide uses the master (it is kept only because of `preserve`). */
  unused: boolean;
  slideCount: number;
}

export interface DuplicateMastersData {
  masters: { partName: string; name: string; slideCount: number; layoutCount: number }[];
  /** Layout names (as written on the first master) that both masters share, case-insensitively. */
  sharedLayoutNames: string[];
  /** |shared| / max(|layouts A|, |layouts B|), 0–1. */
  overlap: number;
}

declare module "../findings" {
  interface FindingDataMap {
    "master-usage": MasterUsageData;
    "unused-layout": UnusedLayoutData;
    "unused-master": UnusedMasterData;
    "preserved-master": PreservedMasterData;
    "duplicate-masters": DuplicateMastersData;
  }
}

/** Minimum layout-name overlap for two active masters to count as near-duplicates. */
export const DUPLICATE_MASTER_OVERLAP = 0.8;

export function masterDisplayName(pres: Presentation, m: MasterInfo): string {
  if (m.name.trim() !== "") return m.name;
  const theme = pres.themes.find((t) => t.partName === m.themePart)?.name;
  if (theme && theme.trim() !== "") return theme;
  return `Master ${pres.masters.indexOf(m) + 1}`;
}

function layoutUsage(pres: Presentation, l: LayoutInfo): LayoutUsage {
  const numbers = l.slideParts
    .map((p) => pres.slides.find((s) => s.partName === p)?.number)
    .filter((n): n is number => n !== undefined);
  return {
    partName: l.partName,
    name: l.name,
    type: l.type,
    preserve: l.preserve,
    slideNumbers: numbers,
    slideIds: [...l.slideIds],
  };
}

function layoutsOf(pres: Presentation, m: MasterInfo): LayoutInfo[] {
  return m.layoutParts
    .map((p) => pres.layouts.find((l) => l.partName === p))
    .filter((l): l is LayoutInfo => l !== undefined);
}

const normName = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

function runMasters(pres: Presentation): Finding[] {
  const out: Finding[] = [];
  const area = "masters" as const;
  const infos = pres.masters.map((m) => {
    const layouts = layoutsOf(pres, m);
    return { m, name: masterDisplayName(pres, m), layouts, usage: layouts.map((l) => layoutUsage(pres, l)) };
  });

  // Usage tree.
  for (const { m, name, usage } of infos) {
    const target = partTarget("master", m.partName, { name });
    const data: MasterUsageData = {
      masterPart: m.partName,
      name,
      preserve: m.preserve,
      slideCount: m.slideParts.length,
      layouts: usage,
    };
    if (m.themePart !== undefined) data.themePart = m.themePart;
    const used = usage.filter((u) => u.slideIds.length > 0).length;
    out.push(
      makeFinding({
        area,
        kind: "master-usage",
        severity: "info",
        title: `${name}: ${m.slideParts.length} slide${m.slideParts.length === 1 ? "" : "s"}, ${used} of ${usage.length} layouts used`,
        group: m.partName,
        groupLabel: name,
        count: m.slideParts.length,
        targets: [target],
        fixes: [],
        data,
      }),
    );
  }

  // Unused layouts (including those of unused masters: each is individually removable).
  for (const { m, name, layouts } of infos) {
    for (const l of layouts) {
      if (l.slideParts.length > 0) continue;
      out.push(
        makeFinding({
          area,
          kind: "unused-layout",
          severity: "warning",
          title: `Unused layout "${l.name}"`,
          detail: `No slide uses this layout of ${name}.${l.preserve ? " It is marked to be preserved." : ""}`,
          group: m.partName,
          groupLabel: name,
          targets: [partTarget("layout", l.partName, { name: l.name })],
          fixes: [],
          reachable: false,
          data: {
            layoutPart: l.partName,
            layoutName: l.name,
            layoutType: l.type,
            masterPart: m.partName,
            masterName: name,
            preserve: l.preserve,
          },
        }),
      );
    }
  }

  // Unused and preserved masters.
  for (const { m, name, layouts } of infos) {
    const unused = layouts.every((l) => l.slideParts.length === 0) && m.slideParts.length === 0;
    const target = partTarget("master", m.partName, { name });
    if (unused) {
      out.push(
        makeFinding({
          area,
          kind: "unused-master",
          severity: "warning",
          title: `Unused master "${name}"`,
          detail: m.preserve
            ? "No slide uses any of its layouts. It is marked preserve, so PowerPoint keeps it until it is deleted."
            : "No slide uses any of its layouts.",
          group: m.partName,
          groupLabel: name,
          targets: [target],
          fixes: [],
          reachable: false,
          data: { masterPart: m.partName, masterName: name, layoutCount: layouts.length, preserved: m.preserve },
        }),
      );
    }
    if (m.preserve) {
      out.push(
        makeFinding({
          area,
          kind: "preserved-master",
          severity: "info",
          title: `Preserved master "${name}"`,
          detail: unused
            ? "Marked preserve and unused: PowerPoint keeps it in the file even though no slide uses it."
            : "Marked preserve: PowerPoint keeps it in the file even if its slides are deleted.",
          group: m.partName,
          groupLabel: name,
          targets: [target],
          fixes: [],
          data: { masterPart: m.partName, masterName: name, unused, slideCount: m.slideParts.length },
        }),
      );
    }
  }

  // Near-duplicate active masters.
  const active = infos.filter((i) => i.m.slideParts.length > 0 && i.layouts.length > 0);
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const A = active[a]!;
      const B = active[b]!;
      const namesB = new Set(B.layouts.map((l) => normName(l.name)));
      const seen = new Set<string>();
      const shared: string[] = [];
      for (const l of A.layouts) {
        const n = normName(l.name);
        if (namesB.has(n) && !seen.has(n)) {
          seen.add(n);
          shared.push(l.name);
        }
      }
      const sizeA = new Set(A.layouts.map((l) => normName(l.name))).size;
      const overlap = shared.length / Math.max(sizeA, namesB.size);
      if (overlap < DUPLICATE_MASTER_OVERLAP) continue;
      const masters = [A, B].map((i) => ({
        partName: i.m.partName,
        name: i.name,
        slideCount: i.m.slideParts.length,
        layoutCount: i.layouts.length,
      }));
      out.push(
        makeFinding({
          area,
          kind: "duplicate-masters",
          severity: "warning",
          title: `"${A.name}" and "${B.name}" look like copies of the same master`,
          detail: `${shared.length} layout names in common (${Math.round(overlap * 100)}% overlap). Slides pasted from another deck often bring a duplicate master.`,
          group: "duplicate-masters",
          groupLabel: "Duplicate masters",
          targets: [partTarget("master", A.m.partName, { name: A.name }), partTarget("master", B.m.partName, { name: B.name })],
          fixes: [],
          data: { masters, sharedLayoutNames: shared, overlap },
        }),
      );
    }
  }
  return out;
}

export const masterChecks: Check[] = [{ id: "masters", area: "masters", run: ({ pres }) => runMasters(pres) }];
