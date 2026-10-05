/**
 * Replace colors (R13, U13).
 *
 * Targets are `color-usage` finding targets with `reachable === true` only (D2): a slide shape's
 * solid fill, solid line, run text color, table cell fill, and run color in a table cell. Each unit
 * names exactly one property; apply never touches any other property.
 *
 * The API cannot write a theme color reference, so "replace with theme color" writes that swatch's
 * current RGB: the preview says so (`FIXED_COLOR_NOTE`). Gradients, patterns, adjusted (lumMod,
 * tint, ...) colors, effects, bullets, list styles, grouped shapes, layouts, masters, charts, and
 * SmartArt are listed unreachable.
 */
import type { Finding, FindingTarget } from "@slidefidelity/audit-core";
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
import type { FixKindDef, FixOp, IsSetSupported, KindPlan, PlannedTarget, ReplaceColorParams, TargetOutcome, UnreachableTarget } from "./types";

export const FIXED_COLOR_NOTE = "The new color is written as a fixed color; it will not follow later theme changes.";
export const TEXT_COLOR_NOTE =
  "In text, characters whose color comes from the theme but currently equals a replaced color look the same to PowerPoint's API and may be changed too.";

/** `RRGGBB` (upper case) from `RRGGBB` / `#rrggbb`, else null. */
export function normalizeHex(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(s) ? s : null;
}

function opFor(t: FindingTarget): FixOp | null {
  const l = t.locator;
  const cell = l?.cell ? { ...l.cell } : undefined;
  switch (l?.property) {
    case "fill":
      return cell ? null : { type: "color-fill" };
    case "line":
      return cell ? null : { type: "color-line" };
    case "text":
      return cell ? { type: "color-cell-text", cell } : { type: "color-text" };
    case "table-cell":
      return cell ? { type: "color-cell-fill", cell } : null;
    default:
      return null;
  }
}

function colorReason(t: FindingTarget): string {
  const c = containerReason(t);
  if (c) return c;
  switch (t.locator?.property) {
    case "effect":
      return "In an effect (shadow, glow, ...); PowerPoint's API can't change effect colors";
    case "bullet":
      return "Bullet color; PowerPoint's API can't change bullet colors";
    case "list-style":
      return "In a list or text style; can't be changed in place";
    case "image":
      return "In a picture; can't be changed in place";
    case "line":
      if (t.locator.cell) return "Table border; PowerPoint's API can't change it in place";
      break;
    default:
      break;
  }
  if ((t.path?.length ?? 0) > 0) return "Inside a group; its color can't be changed in place";
  return "Not a plain solid color (gradient, pattern, or adjusted color); can't be changed in place";
}

function unitKey(t: FindingTarget, op: FixOp): string {
  const cell = "cell" in op ? `${op.cell.row}.${op.cell.col}` : "";
  return `${shapeKey(t)}|${op.type}|${cell}`;
}

function planColors(findings: readonly Finding[], params: ReplaceColorParams, isSetSupported: IsSetSupported): KindPlan {
  const from = new Set(params.from.map(normalizeHex).filter((h): h is string => h !== null));
  const units = new Map<string, PlannedTarget>();
  const out: UnreachableTarget[] = [];
  for (const f of findings) {
    if (f.kind !== "color-usage") continue;
    const hex = normalizeHex(f.data.hex);
    if (!hex || !from.has(hex)) continue;
    for (const t of f.targets) {
      const op = isReachable(f, t) ? opFor(t) : null;
      const u = op ? plannedUnit(f, t, unitKey(t, op), op) : null;
      if (!u) {
        out.push(unreachable(f, t, colorReason(t)));
        continue;
      }
      mergeUnit(units, u);
    }
  }
  const targets: PlannedTarget[] = [];
  for (const u of units.values()) {
    const why = unitRequirement(u, isSetSupported);
    if (why) out.push(...unitUnreachable(u, why));
    else targets.push(u);
  }
  const notes = [FIXED_COLOR_NOTE];
  if (targets.some((u) => u.op.type === "color-text")) notes.push(TEXT_COLOR_NOTE);
  return { targets, unreachable: out, notes };
}

export const replaceColorsKind: FixKindDef<"replace-color"> = {
  id: "replace-color",
  requiredSet: "1.4",
  destructive: false,

  validate(params) {
    if (params.from.length === 0) return "Choose at least one color to replace.";
    const bad = params.from.find((c) => normalizeHex(c) === null);
    if (bad !== undefined) return `"${bad}" is not a 6-digit hex color.`;
    const to = normalizeHex(params.to);
    if (!to) return "Enter the new color as a 6-digit hex value, like #1F4E79.";
    if (params.from.some((c) => normalizeHex(c) === to)) return "The new color is one of the colors being replaced.";
    return null;
  },

  plan(findings, params, env) {
    return planColors(findings, params, env.isSetSupported);
  },

  async apply(context, batch, io, params) {
    const from = new Set(params.from.map(normalizeHex).filter((h): h is string => h !== null));
    const to = `#${normalizeHex(params.to)!}`;
    const isFrom = (v: string | null | undefined) => {
      const h = normalizeHex(v);
      return h !== null && from.has(h);
    };
    const gone = `Skipped: no longer ${params.from.map((c) => `#${normalizeHex(c)}`).join(", ")}`;
    const outcomes: TargetOutcome[] = batch.map(() => ({ status: "skipped", reason: "Skipped" }));
    const shapes = await resolveShapes(context, io, batch, { destructive: false });

    const fills: Array<{ i: number; fill: PowerPoint.ShapeFill; cell?: PowerPoint.TableCell }> = [];
    const lines: Array<{ i: number; line: PowerPoint.ShapeLineFormat }> = [];
    const texts: Array<{ i: number; range: PowerPoint.TextRange }> = [];
    const cellTexts: Array<{ i: number; cell: PowerPoint.TableCell }> = [];
    batch.forEach((u, i) => {
      const s = shapes[i]!;
      if (s.status !== "ok") {
        outcomes[i] = { status: "skipped", reason: s.reason };
        return;
      }
      const op = u.op;
      switch (op.type) {
        case "color-fill": {
          const fill = s.shape.fill;
          fill.load("type,foregroundColor");
          fills.push({ i, fill });
          break;
        }
        case "color-line": {
          const line = s.shape.lineFormat;
          line.load("color");
          lines.push({ i, line });
          break;
        }
        case "color-text":
          texts.push({ i, range: s.shape.textFrame.textRange });
          break;
        case "color-cell-fill": {
          const cell = s.shape.getTable().getCellOrNullObject(op.cell.row, op.cell.col);
          cell.load("text");
          cell.fill.load("type,foregroundColor");
          fills.push({ i, fill: cell.fill, cell });
          break;
        }
        case "color-cell-text": {
          const cell = s.shape.getTable().getCellOrNullObject(op.cell.row, op.cell.col);
          cell.load("text");
          cell.font.load("color");
          cellTexts.push({ i, cell });
          break;
        }
        default:
          outcomes[i] = { status: "skipped", reason: "Skipped: not a color target" };
      }
    });

    const found = await findFontRanges(
      io,
      texts.map((t) => t.range),
      "color",
      isFrom,
    );
    if (texts.length === 0 && (fills.length || lines.length || cellTexts.length)) await io.sync();

    for (const { i, fill, cell } of fills) {
      if (cell?.isNullObject) {
        outcomes[i] = { status: "skipped", reason: "Skipped: the table cell no longer exists" };
      } else if (fill.type === "Solid" && isFrom(fill.foregroundColor)) {
        fill.setSolidColor(to);
        outcomes[i] = { status: "changed" };
      } else {
        outcomes[i] = { status: "skipped", reason: fill.type === "Solid" ? gone : "Skipped: the fill is no longer a solid color" };
      }
    }
    for (const { i, line } of lines) {
      if (isFrom(line.color)) {
        line.color = to;
        outcomes[i] = { status: "changed" };
      } else outcomes[i] = { status: "skipped", reason: gone };
    }
    texts.forEach(({ i, range }, k) => {
      const m = found[k]!;
      if (m.whole) {
        range.font.color = to;
        outcomes[i] = { status: "changed" };
      } else if (m.ranges.length > 0) {
        for (const [start, length] of m.ranges) range.getSubstring(start, length).font.color = to;
        outcomes[i] = { status: "changed" };
      } else outcomes[i] = { status: "skipped", reason: gone };
    });
    for (const { i, cell } of cellTexts) {
      if (cell.isNullObject) {
        outcomes[i] = { status: "skipped", reason: "Skipped: the table cell no longer exists" };
        continue;
      }
      const c = cell.font.color;
      if (c && isFrom(c)) {
        cell.font.color = to;
        outcomes[i] = { status: "changed" };
      } else if (!c) {
        outcomes[i] = { status: "skipped", reason: "Skipped: this table cell mixes text colors, which PowerPoint's API can't change safely" };
      } else outcomes[i] = { status: "skipped", reason: gone };
    }
    return outcomes;
  },
};
