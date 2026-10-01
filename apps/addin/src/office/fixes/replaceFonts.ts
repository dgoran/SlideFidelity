/**
 * Replace fonts (R12, U13).
 *
 * Targets are `font-usage` finding targets with `reachable === true` only: Latin fonts set directly
 * on slide text (runs, paragraph defaults, end-of-paragraph) and slide table cells. Theme font
 * references, East Asian / complex-script / symbol / bullet slots, hidden list styles, layouts,
 * masters, charts, and SmartArt are listed as unreachable with a reason (D2, AE1, AE2).
 *
 * Apply works per text body (a shape's text frame or a table cell), not per run: the snapshot's
 * paragraph/run indices do not map reliably onto live character offsets. For a shape, a uniform
 * `font.name` in `from` is set on the whole range; a mixed range is bisected with `getSubstring`
 * to find the maximal sub-ranges whose font is in `from`, and only those are set. Table cells
 * (PowerPointApi 1.9 `TableCell.font`) have no sub-range API, so a mixed cell is skipped.
 */
import type { Finding, FontUsageRef } from "@slidecheck/audit-core";
import {
  containerReason,
  findFontRanges,
  isReachable,
  mergeUnit,
  plannedUnit,
  resolveShapes,
  shapeKey,
  unitRequirement,
  unitUnreachable,
  unreachable,
} from "./engine";
import type { FixKindDef, IsSetSupported, KindPlan, PlannedTarget, ReplaceFontParams, TargetOutcome, UnreachableTarget } from "./types";

const norm = (name: string): string => name.trim().toLowerCase();

export const THEME_CONFLICT_REASON =
  "Shares text with a theme font reference to the same font; PowerPoint's API can't change one without the other";

function usageReason(u: FontUsageRef | undefined): string | null {
  if (!u) return null;
  if (u.theme) return `Theme font reference${u.ref ? ` (${u.ref})` : ""}; change the theme fonts instead`;
  switch (u.source) {
    case "chart":
      return "Inside a chart; PowerPoint's API can't change chart text";
    case "smartart":
      return "Inside SmartArt; PowerPoint's API can't change SmartArt text";
    case "master":
      return "On a slide layout or master; only slide text can be changed in place";
    case "hidden-list-style":
      return "In a hidden list style (not used by visible text); can't be changed in place";
    case "theme-default":
      return "Theme default font; change the theme fonts instead";
    default:
      break;
  }
  switch (u.script) {
    case "ea":
      return "East Asian (ea) font; PowerPoint's API can only change the Latin font";
    case "cs":
      return "Complex-script (cs) font; PowerPoint's API can only change the Latin font";
    case "sym":
      return "Symbol (sym) font; PowerPoint's API can only change the Latin font";
    case "bu":
      return "Bullet font; PowerPoint's API can't change bullet fonts";
    default:
      return null;
  }
}

function planFonts(findings: readonly Finding[], params: ReplaceFontParams, isSetSupported: IsSetSupported): KindPlan {
  const from = new Set(params.from.map(norm));
  const units = new Map<string, PlannedTarget>();
  const out: UnreachableTarget[] = [];
  /** Text bodies (shape or cell) that also hold a theme reference to one of the `from` fonts. */
  const themeBodies = new Set<string>();
  const themeFonts: string[] = [];

  const bodyKey = (t: Finding["targets"][number]): string => {
    const cell = t.locator?.cell;
    return `${shapeKey(t)}|${cell ? `${cell.row}.${cell.col}` : "text"}`;
  };

  for (const f of findings) {
    if (f.kind !== "font-usage" || !from.has(norm(f.data.typeface))) continue;
    if (f.data.themeRole && !themeFonts.includes(f.data.typeface)) themeFonts.push(f.data.typeface);
    f.targets.forEach((t, i) => {
      const usage = f.data.usages[i];
      if (usage?.theme && t.container.kind === "slide") themeBodies.add(bodyKey(t));
      const prop = t.locator?.property;
      const scriptOk = (usage?.script ?? t.locator?.script ?? "latin") === "latin";
      if (!isReachable(f, t) || !scriptOk || usage?.theme || (prop !== undefined && prop !== "text" && prop !== "table-cell")) {
        out.push(unreachable(f, t, usageReason(usage) ?? containerReason(t) ?? "Can't be changed in place"));
        return;
      }
      const cell = t.locator?.cell;
      const u = plannedUnit(f, t, bodyKey(t), cell ? { type: "font-cell", cell: { ...cell } } : { type: "font-text" });
      if (!u) {
        out.push(unreachable(f, t, containerReason(t) ?? "Can't be changed in place"));
        return;
      }
      mergeUnit(units, u);
    });
  }

  const targets: PlannedTarget[] = [];
  for (const u of units.values()) {
    const why = themeBodies.has(u.key) ? THEME_CONFLICT_REASON : unitRequirement(u, isSetSupported);
    if (why) {
      out.push(...unitUnreachable(u, why));
      continue;
    }
    targets.push(u);
  }

  const notes: string[] = [];
  if (themeFonts.length > 0) {
    notes.push(
      `${themeFonts.join(", ")} is also a theme font. In the shapes listed, text that inherits the theme font looks the same to PowerPoint's API and may be changed too.`,
    );
  }
  return { targets, unreachable: out, notes };
}

export const replaceFontsKind: FixKindDef<"replace-font"> = {
  id: "replace-font",
  requiredSet: "1.4",
  destructive: false,

  validate(params) {
    const from = params.from.map((f) => f.trim()).filter(Boolean);
    if (from.length === 0) return "Choose at least one font to replace.";
    const to = params.to.trim();
    if (!to) return "Choose a replacement font.";
    if (from.some((f) => norm(f) === norm(to))) return "The replacement font is one of the fonts being replaced.";
    return null;
  },

  plan(findings, params, env) {
    return planFonts(findings, params, env.isSetSupported);
  },

  async apply(context, batch, io, params) {
    const from = new Set(params.from.map(norm));
    const to = params.to.trim();
    const isFrom = (v: string) => from.has(norm(v));
    const outcomes: TargetOutcome[] = batch.map(() => ({ status: "skipped", reason: "Skipped" }));
    const shapes = await resolveShapes(context, io, batch, { destructive: false });

    const text: Array<{ i: number; range: PowerPoint.TextRange }> = [];
    const cells: Array<{ i: number; cell: PowerPoint.TableCell }> = [];
    batch.forEach((u, i) => {
      const s = shapes[i]!;
      if (s.status !== "ok") {
        outcomes[i] = { status: "skipped", reason: s.reason };
        return;
      }
      if (u.op.type === "font-cell") {
        const cell = s.shape.getTable().getCellOrNullObject(u.op.cell.row, u.op.cell.col);
        cell.load("text");
        cell.font.load("name");
        cells.push({ i, cell });
      } else {
        text.push({ i, range: s.shape.textFrame.textRange });
      }
    });

    // Reads: bisection (its first sync also flushes the cell loads).
    const found = await findFontRanges(
      io,
      text.map((t) => t.range),
      "name",
      isFrom,
    );
    if (text.length === 0 && cells.length > 0) await io.sync();

    // Writes: queued only; the engine commits.
    const gone = `Skipped: no longer uses ${params.from.join(", ")}`;
    text.forEach(({ i, range }, k) => {
      const m = found[k]!;
      if (m.whole) {
        range.font.name = to;
        outcomes[i] = { status: "changed" };
      } else if (m.ranges.length > 0) {
        for (const [start, length] of m.ranges) range.getSubstring(start, length).font.name = to;
        outcomes[i] = { status: "changed" };
      } else {
        outcomes[i] = { status: "skipped", reason: gone };
      }
    });
    for (const { i, cell } of cells) {
      if (cell.isNullObject) {
        outcomes[i] = { status: "skipped", reason: "Skipped: the table cell no longer exists" };
        continue;
      }
      const name = cell.font.name;
      if (name && isFrom(name)) {
        cell.font.name = to;
        outcomes[i] = { status: "changed" };
      } else if (!name) {
        outcomes[i] = { status: "skipped", reason: "Skipped: this table cell mixes fonts, which PowerPoint's API can't change safely" };
      } else {
        outcomes[i] = { status: "skipped", reason: gone };
      }
    }
    return outcomes;
  },
};
