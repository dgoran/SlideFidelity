/**
 * Remove slide numbers (Graphics Ops bulk fix).
 *
 * Targets are the reachable `slide-numbers` finding targets: `sldNum` placeholders and text boxes
 * that hold only a slide-number field. A number mixed with other text ("Page 3 of 10") is listed
 * as unreachable: deleting the shape would delete that text too.
 *
 * Destructive: each shape must resolve by exact id; a name + position fallback match is skipped as
 * "identity uncertain" (`IDENTITY_UNCERTAIN`, D4). Shapes are removed with `Shape.delete()`
 * (PowerPointApi 1.4). The layout / master Header & Footer setting is not reachable from add-ins,
 * so the preview says how to stop new slides from getting numbers.
 */
import { isReachable, mergeUnit, plannedUnit, resolveShapes, scopeSelector, shapeKey, unitRequirement, unitUnreachable, unreachable, validateScope } from "./engine";
import type { FixKindDef, PlannedTarget, TargetOutcome, UnreachableTarget } from "./types";

export const MIXED_NUMBER_REASON = "Slide number is part of other text — edit it by hand";
export const TABLE_NUMBER_REASON = "Slide number is inside a table — edit it by hand";
export const HEADER_FOOTER_NOTE =
  "To stop new slides from getting numbers, turn off Slide number in Insert > Header & Footer (add-ins can't change that setting).";
export const EXACT_ID_NOTE = "Only shapes that still match their exact id are deleted; anything else is skipped and listed.";

export const removeSlideNumbersKind: FixKindDef<"remove-slide-numbers"> = {
  id: "remove-slide-numbers",
  requiredSet: "1.4",
  destructive: true,

  validate(params) {
    return validateScope(params.scope, "to remove slide numbers from");
  },

  plan(findings, params, env) {
    const inScope = scopeSelector(params.scope);
    const units = new Map<string, PlannedTarget>();
    const out: UnreachableTarget[] = [];
    for (const f of findings) {
      if (f.kind !== "slide-numbers" || !f.fixes.includes("remove-slide-numbers")) continue;
      f.targets.forEach((t, i) => {
        if (!inScope(t)) return;
        const entry = f.data.slides[i];
        if (entry?.kind === "field-in-text") {
          out.push(unreachable(f, t, entry.reason?.includes("table") ? TABLE_NUMBER_REASON : MIXED_NUMBER_REASON));
          return;
        }
        const u = isReachable(f, t) ? plannedUnit(f, t, shapeKey(t), { type: "delete-shape" }) : null;
        if (!u) {
          out.push(unreachable(f, t, entry?.reason ?? "Can't be removed in place"));
          return;
        }
        mergeUnit(units, u);
      });
    }
    const targets: PlannedTarget[] = [];
    for (const u of units.values()) {
      const why = unitRequirement(u, env.isSetSupported);
      if (why) out.push(...unitUnreachable(u, why));
      else targets.push(u);
    }
    return { targets, unreachable: out, notes: [EXACT_ID_NOTE, HEADER_FOOTER_NOTE] };
  },

  async apply(context, batch, io) {
    const shapes = await resolveShapes(context, io, batch, { destructive: true });
    return shapes.map((s): TargetOutcome => {
      if (s.status !== "ok") return { status: "skipped", reason: s.reason };
      s.shape.delete();
      return { status: "changed" };
    });
  },
};
