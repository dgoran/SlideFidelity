/**
 * Edit (PowerPointApi 1.6, `Hyperlink.address`) and remove (1.10, `Hyperlink.delete()`) slide
 * hyperlinks (R15, U13).
 *
 * Only slide click links are targets: they carry the D3 join key (slide id, address, occurrence
 * among same-address links, same-address count), matched with `matchHyperlink` (ids.ts). An
 * ambiguous match (the live slide has a different number of links with that address) is skipped.
 * All links with one address on one slide share a batch so occurrence numbers stay valid.
 */
import type { Finding, FindingTarget } from "@slidecheck/audit-core";
import { matchHyperlink } from "../ids";
import { containerReason, isReachable, plannedUnit, resolveSlides, selected, unreachable } from "./engine";
import type { EditHyperlinkParams, FixKindDef, FixKindId, KindPlan, PlannedTarget, RemoveHyperlinkParams, TargetOutcome, TargetSelection, UnreachableTarget } from "./types";

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Reason a new hyperlink address is unacceptable, else null. http, https, and mailto only. */
export function validateHyperlinkAddress(address: string): string | null {
  const a = address.trim();
  if (!a) return "Enter the new address.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(a)) return "The address can't contain spaces or control characters.";
  let url: URL;
  try {
    url = new URL(a);
  } catch {
    return "Enter a full address starting with https://, http://, or mailto:.";
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return "Only http, https, and mailto addresses are allowed.";
  if (url.protocol === "mailto:") return url.pathname.length > 0 ? null : "Enter an email address after mailto:.";
  return url.hostname ? null : "The address needs a host name.";
}

function linkReason(f: Finding, t: FindingTarget): string {
  const c = containerReason(t);
  if (c) return c;
  if (f.kind === "hyperlink" && f.data.trigger === "hover") return "Mouse-over link; PowerPoint's API only exposes click links";
  return "Can't be matched to a live hyperlink";
}

type Filter = (f: Finding, t: FindingTarget) => boolean;

function planLinks(kind: FixKindId, findings: readonly Finding[], filter: Filter): KindPlan {
  const units = new Map<string, PlannedTarget>();
  const out: UnreachableTarget[] = [];
  const seenUnreachable = new Set<string>();
  for (const f of findings) {
    if (!f.fixes.includes(kind)) continue;
    for (const t of f.targets) {
      if (!filter(f, t)) continue;
      const h = t.locator?.hyperlink;
      const slideId = t.container.slideId;
      const key = h && slideId !== undefined ? `${slideId}|${h.occurrence}|${h.address}` : undefined;
      const u =
        key && h && isReachable(f, t)
          ? plannedUnit(f, t, key, { type: "hyperlink", address: h.address, occurrence: h.occurrence, sameAddressCount: h.sameAddressCount })
          : null;
      if (!u) {
        // The same link can appear in an info and a warning finding: list it once.
        const k = `${t.container.partName}|${t.shapeId}|${t.locator?.relId}|${t.locator?.paragraphIndex}|${t.locator?.runIndex}`;
        if (!seenUnreachable.has(k)) {
          seenUnreachable.add(k);
          out.push(unreachable(f, t, linkReason(f, t)));
        }
        continue;
      }
      u.batchKey = `${u.slideId}|${h!.address}`;
      const existing = units.get(u.key);
      if (existing) {
        if (!existing.findingIds.includes(f.id)) existing.findingIds.push(f.id);
        existing.sources.push(t);
      } else units.set(u.key, u);
    }
  }
  return { targets: [...units.values()], unreachable: out };
}

async function applyLinks(
  context: PowerPoint.RequestContext,
  batch: readonly PlannedTarget[],
  io: Parameters<FixKindDef<"remove-hyperlink">["apply"]>[2],
  destructive: boolean,
  write: (link: PowerPoint.Hyperlink) => void,
): Promise<TargetOutcome[]> {
  const outcomes: TargetOutcome[] = batch.map(() => ({ status: "skipped", reason: "Skipped" }));
  const slides = await resolveSlides(context, io, batch, { destructive });
  const collections = new Map<PowerPoint.Slide, PowerPoint.HyperlinkCollection>();
  slides.forEach((s, i) => {
    if (s.status !== "ok") {
      outcomes[i] = { status: "skipped", reason: s.reason };
      return;
    }
    if (!collections.has(s.slide)) {
      const c = s.slide.hyperlinks;
      c.load("items/address");
      collections.set(s.slide, c);
    }
  });
  if (collections.size > 0) await io.sync();

  batch.forEach((u, i) => {
    const s = slides[i]!;
    if (s.status !== "ok" || u.op.type !== "hyperlink") return;
    const live = collections.get(s.slide)!.items;
    const r = matchHyperlink({ slideId: u.slideId, address: u.op.address, occurrence: u.op.occurrence, sameAddressCount: u.op.sameAddressCount }, live);
    if (r.status === "matched") {
      write(r.item);
      outcomes[i] = { status: "changed" };
    } else if (r.status === "ambiguous") {
      outcomes[i] = {
        status: "skipped",
        reason: `Skipped: ambiguous; the slide now has ${r.candidates.length} links to this address (the scan saw ${u.op.sameAddressCount})`,
      };
    } else {
      outcomes[i] = { status: "skipped", reason: "Skipped: the link no longer exists" };
    }
  });
  return outcomes;
}

export const editHyperlinkKind: FixKindDef<"edit-hyperlink"> = {
  id: "edit-hyperlink",
  requiredSet: "1.6",
  destructive: false,

  validate(params: EditHyperlinkParams) {
    if (!params.address) return "Choose the link to edit.";
    const bad = validateHyperlinkAddress(params.newAddress);
    if (bad) return bad;
    if (params.newAddress.trim() === params.address) return "The new address is the same as the current one.";
    return null;
  },

  plan(findings, params) {
    const sel: Partial<{ findingIds: string[]; targetKeys: string[] }> = {};
    if (params.findingIds) sel.findingIds = params.findingIds;
    else if (params.targetKeys) sel.targetKeys = params.targetKeys;
    return planLinks("edit-hyperlink", findings, (f, t) => {
      const addr = t.locator?.hyperlink?.address ?? (f.kind === "hyperlink" ? f.data.address : f.group);
      return addr === params.address && selected(sel, f, t);
    });
  },

  apply(context, batch, io, params) {
    const next = params.newAddress.trim();
    return applyLinks(context, batch, io, false, (link) => {
      link.address = next;
    });
  },
};

export const removeHyperlinkKind: FixKindDef<"remove-hyperlink"> = {
  id: "remove-hyperlink",
  requiredSet: "1.10",
  destructive: true,

  validate(params: RemoveHyperlinkParams) {
    if ("all" in params) return params.all ? null : "Choose the links to remove.";
    if ("addresses" in params) return params.addresses.length ? null : "Choose the links to remove.";
    if ("findingIds" in params) return params.findingIds.length ? null : "Choose the links to remove.";
    if ("targetKeys" in params) return params.targetKeys.length ? null : "Choose the links to remove.";
    return "Choose the links to remove.";
  },

  plan(findings, params) {
    if ("addresses" in params) {
      const set = new Set(params.addresses);
      return planLinks("remove-hyperlink", findings, (f, t) => set.has(t.locator?.hyperlink?.address ?? (f.kind === "hyperlink" ? f.data.address : f.group)));
    }
    const sel: TargetSelection = params;
    return planLinks("remove-hyperlink", findings, (f, t) => selected(sel, f, t));
  },

  apply(context, batch, io) {
    return applyLinks(context, batch, io, true, (link) => link.delete());
  },
};
