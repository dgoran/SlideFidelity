/**
 * Delete hidden, off-slide, and empty-placeholder shapes (R14, U13).
 *
 * Destructive: each shape (and every ancestor group) must resolve by exact id; a name + position
 * fallback match is skipped as "identity uncertain" (`isSafeForDestructiveFix`, D4). A shape whose
 * group is also selected is folded into the group's unit (deleting the group removes it).
 */
import type { Finding } from "@slidecheck/audit-core";
import { containerReason, isReachable, mergeUnit, plannedUnit, resolveShapes, selected, shapeKey, unitRequirement, unreachable } from "./engine";
import type { DeleteShapesParams, FixKindDef, PlannedTarget, TargetOutcome, UnreachableTarget } from "./types";

const DELETABLE = new Set<Finding["kind"]>(["hidden-shape", "off-slide-shape", "empty-placeholder"]);

export const deleteShapesKind: FixKindDef<"delete-shapes"> = {
  id: "delete-shapes",
  requiredSet: "1.4",
  destructive: true,

  validate(params: DeleteShapesParams) {
    if ("all" in params) return params.all ? null : "Choose the shapes to delete.";
    if ("findingIds" in params) return params.findingIds.length ? null : "Choose the shapes to delete.";
    if ("targetKeys" in params) return params.targetKeys.length ? null : "Choose the shapes to delete.";
    return "Choose the shapes to delete.";
  },

  plan(findings, params, env) {
    const units = new Map<string, PlannedTarget>();
    const out: UnreachableTarget[] = [];
    for (const f of findings) {
      if (!DELETABLE.has(f.kind) || !f.fixes.includes("delete-shapes")) continue;
      for (const t of f.targets) {
        if (!selected(params, f, t)) continue;
        const u = isReachable(f, t) ? plannedUnit(f, t, shapeKey(t), { type: "delete-shape" }) : null;
        if (!u) {
          out.push(unreachable(f, t, containerReason(t) ?? "Can't be deleted in place"));
          continue;
        }
        mergeUnit(units, u);
      }
    }
    // Fold shapes into a selected ancestor group on the same slide.
    const byShape = new Map<string, PlannedTarget>();
    for (const u of units.values()) byShape.set(`${u.slideId}|${u.shapeId}`, u);
    const targets: PlannedTarget[] = [];
    for (const u of units.values()) {
      const ancestor = u.path.map((id) => byShape.get(`${u.slideId}|${id}`)).find((a) => a !== undefined);
      if (ancestor) {
        ancestor.sources.push(...u.sources);
        for (const id of u.findingIds) if (!ancestor.findingIds.includes(id)) ancestor.findingIds.push(id);
        continue;
      }
      targets.push(u);
    }
    const reachable: PlannedTarget[] = [];
    for (const u of targets) {
      const why = unitRequirement(u, env.isSetSupported);
      if (why) u.sources.forEach((t, i) => out.push({ target: t, findingId: u.findingIds[Math.min(i, u.findingIds.length - 1)]!, label: u.label, reason: why }));
      else reachable.push(u);
    }
    return {
      targets: reachable,
      unreachable: out,
      notes: ["Only shapes that still match their exact id are deleted; anything else is skipped and listed."],
    };
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
