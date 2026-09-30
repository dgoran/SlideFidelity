/**
 * Pure helpers for the fix UI (U12/U13, D11): which findings each picker offers, default picker
 * drafts, and draft → engine parameters. No React, no Office.
 *
 * Every string taken from findings (font names, hex values, addresses, labels) is untrusted deck
 * text: the components render it as React text only.
 */
import type { Area, AuditResult, Finding } from "@slidecheck/audit-core";
import {
  normalizeHex,
  targetLabel,
  validateHyperlinkAddress,
  type FixKindId,
  type FixParamsMap,
} from "../../office/fixes";
import type { CapabilityFeature } from "../../office/capabilities";
import { themeBrandFromResult } from "../brand/themeBrand";

export type FixArea = "fonts" | "colors" | "review" | "links";

export function isFixArea(area: Area): area is FixArea {
  return area === "fonts" || area === "colors" || area === "review" || area === "links";
}

export const FIX_AREA_TITLES: Record<FixArea, string> = {
  fonts: "Font fixes",
  colors: "Color fixes",
  review: "Cleanup fixes",
  links: "Link fixes",
};

/** Host feature per fix kind (KTD4), for `CapabilityButton` / `explain`. */
export const KIND_FEATURE: Record<FixKindId, CapabilityFeature> = {
  "replace-font": "replaceFonts",
  "replace-color": "replaceColors",
  "delete-shapes": "deleteShapes",
  "edit-hyperlink": "hyperlinkEdit",
  "remove-hyperlink": "hyperlinkRemove",
};

/** At least one target the in-place fix engine can reach (per-target override, else finding). */
export function hasReachableTarget(f: Finding): boolean {
  if (f.targets.length === 0) return f.reachable === true;
  return f.targets.some((t) => t.reachable === true || (t.reachable === undefined && f.reachable === true));
}

/** The finding offers a fix and something it can reach. */
export function isFixable(f: Finding): boolean {
  return f.fixes.length > 0 && hasReachableTarget(f);
}

// ---------------------------------------------------------------------------------------------
// Sources

export interface FontSource {
  name: string;
  count: number;
  reachable: boolean;
  inBrand: boolean | null;
}

export function fontSources(findings: readonly Finding[]): FontSource[] {
  const out: FontSource[] = [];
  for (const f of findings) {
    if (f.kind !== "font-usage" || !f.fixes.includes("replace-font")) continue;
    const name = f.data.typeface;
    if (out.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name, count: f.targets.length, reachable: hasReachableTarget(f), inBrand: f.data.inBrand });
  }
  return out;
}

export interface ColorSource {
  hex: string;
  count: number;
  reachable: boolean;
  inBrand: boolean | undefined;
}

export function colorSources(findings: readonly Finding[]): ColorSource[] {
  const out: ColorSource[] = [];
  for (const f of findings) {
    if (f.kind !== "color-usage" || !f.fixes.includes("replace-color")) continue;
    const hex = normalizeHex(f.data.hex);
    if (!hex || out.some((s) => s.hex === hex)) continue;
    out.push({ hex, count: f.targets.length, reachable: hasReachableTarget(f), inBrand: f.data.inBrand });
  }
  return out;
}

export type DeleteKind = "hidden-shape" | "off-slide-shape" | "empty-placeholder";
export const DELETE_KINDS: readonly DeleteKind[] = ["hidden-shape", "off-slide-shape", "empty-placeholder"];
export const DELETE_KIND_LABELS: Record<DeleteKind, string> = {
  "hidden-shape": "Hidden shapes",
  "off-slide-shape": "Off-slide shapes",
  "empty-placeholder": "Empty placeholders",
};
export const DELETE_ACTION_LABELS: Record<DeleteKind, string> = {
  "hidden-shape": "Delete hidden shapes…",
  "off-slide-shape": "Delete off-slide shapes…",
  "empty-placeholder": "Delete empty placeholders…",
};

export function isDeleteKind(kind: string): kind is DeleteKind {
  return (DELETE_KINDS as readonly string[]).includes(kind);
}

export interface DeleteSource {
  kind: DeleteKind;
  findingId: string;
  label: string;
}

export function deleteSources(findings: readonly Finding[]): DeleteSource[] {
  const out: DeleteSource[] = [];
  for (const f of findings) {
    if (!isDeleteKind(f.kind) || !f.fixes.includes("delete-shapes") || !hasReachableTarget(f)) continue;
    const t = f.targets[0];
    out.push({ kind: f.kind, findingId: f.id, label: t ? targetLabel(t) : f.title });
  }
  return out;
}

export interface LinkSource {
  address: string;
  count: number;
}

/** The address a link finding is about (hyperlink data, else the group key). */
export function linkAddress(f: Finding): string {
  return f.kind === "hyperlink" ? f.data.address : f.group;
}

export function linkSources(findings: readonly Finding[]): LinkSource[] {
  const out: LinkSource[] = [];
  for (const f of findings) {
    if (f.area !== "links" || !isFixable(f)) continue;
    if (!f.fixes.includes("remove-hyperlink") && !f.fixes.includes("edit-hyperlink")) continue;
    const address = linkAddress(f);
    const hit = out.find((s) => s.address === address);
    if (hit) hit.count += f.targets.length;
    else out.push({ address, count: f.targets.length });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Targets (D11)

export interface FontTargets {
  theme: string[];
  deck: string[];
}

export function fontTargets(result: AuditResult | null): FontTargets {
  const theme = themeBrandFromResult(result).fonts;
  const deck: string[] = [];
  for (const f of result?.findings ?? []) {
    if (f.kind !== "font-usage") continue;
    const name = f.data.typeface;
    const known = [...theme, ...deck].some((x) => x.toLowerCase() === name.toLowerCase());
    if (!known) deck.push(name);
  }
  return { theme, deck };
}

export interface ColorTarget {
  hex: string;
  slot: string;
}

export function colorTargets(result: AuditResult | null): ColorTarget[] {
  return themeBrandFromResult(result).colors.map((c) => ({ hex: c.hex, slot: c.slot }));
}

// ---------------------------------------------------------------------------------------------
// Drafts

export const CUSTOM = "custom";

export type Draft =
  | { type: "fonts"; from: string[]; target: string; custom: string }
  | { type: "colors"; from: string[]; target: string; custom: string }
  | { type: "delete"; findingIds: string[] }
  | { type: "links"; mode: "remove"; addresses: string[] }
  | { type: "links"; mode: "edit"; address: string | null; newAddress: string };

/** Select value for a picker target option. The part after the first ":" is the value. */
export const optionValue = (prefix: "theme" | "deck", value: string): string => `${prefix}:${value}`;

function optionPayload(v: string): string {
  const i = v.indexOf(":");
  return i < 0 ? v : v.slice(i + 1);
}

function defaultFontTarget(from: readonly string[], targets: FontTargets): string {
  const taken = (n: string) => from.some((f) => f.toLowerCase() === n.toLowerCase());
  const theme = targets.theme.find((n) => !taken(n));
  if (theme !== undefined) return optionValue("theme", theme);
  const deck = targets.deck.find((n) => !taken(n));
  if (deck !== undefined) return optionValue("deck", deck);
  return CUSTOM;
}

function defaultColorTarget(from: readonly string[], targets: readonly ColorTarget[]): string {
  const t = targets.find((c) => !from.includes(c.hex));
  return t ? optionValue("theme", t.hex) : CUSTOM;
}

export interface DraftSeed {
  /** Launched from a finding row: preselect that finding's font / color / shape / link. */
  finding?: Finding;
  /** Area bulk action for one delete kind. */
  deleteKind?: DeleteKind;
  /** Links: which action the bulk button asked for. */
  linkMode?: "remove" | "edit";
}

export function initialDraft(area: FixArea, result: AuditResult | null, seed: DraftSeed = {}, canRemoveLinks = true): Draft {
  const findings = (result?.findings ?? []).filter((f) => f.area === area);
  const row = seed.finding;
  switch (area) {
    case "fonts": {
      const sources = fontSources(findings);
      const from =
        row && row.kind === "font-usage"
          ? [row.data.typeface]
          : sources.filter((s) => s.inBrand === false && s.reachable).map((s) => s.name);
      return { type: "fonts", from, target: defaultFontTarget(from, fontTargets(result)), custom: "" };
    }
    case "colors": {
      const sources = colorSources(findings);
      const rowHex = row && row.kind === "color-usage" ? normalizeHex(row.data.hex) : null;
      const from = rowHex ? [rowHex] : sources.filter((s) => s.inBrand === false && s.reachable).map((s) => s.hex);
      return { type: "colors", from, target: defaultColorTarget(from, colorTargets(result)), custom: "" };
    }
    case "review": {
      const sources = deleteSources(findings);
      const ids = row
        ? sources.filter((s) => s.findingId === row.id).map((s) => s.findingId)
        : sources.filter((s) => seed.deleteKind === undefined || s.kind === seed.deleteKind).map((s) => s.findingId);
      return { type: "delete", findingIds: ids };
    }
    case "links": {
      if (row) {
        const address = linkAddress(row);
        return canRemoveLinks ? { type: "links", mode: "remove", addresses: [address] } : { type: "links", mode: "edit", address, newAddress: "" };
      }
      if (seed.linkMode === "edit") return { type: "links", mode: "edit", address: null, newAddress: "" };
      return { type: "links", mode: "remove", addresses: [] };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Draft → engine parameters

export type FixRequest = { [K in FixKindId]: { kind: K; params: FixParamsMap[K] } }[FixKindId];

export const HEX_HINT = "Enter a 6-digit hex color, like #1F4E79.";

/** Inline validation message for the draft's free-text input, if any (shown next to it). */
export function draftInputError(draft: Draft): string | null {
  if (draft.type === "colors" && draft.target === CUSTOM && draft.custom.trim() !== "" && normalizeHex(draft.custom) === null) {
    return HEX_HINT;
  }
  if (draft.type === "links" && draft.mode === "edit" && draft.address !== null && draft.newAddress.trim() !== "") {
    return validateHyperlinkAddress(draft.newAddress);
  }
  return null;
}

/** The engine request for a draft, or null while the draft is incomplete / invalid. */
export function draftRequest(draft: Draft): FixRequest | null {
  if (draftInputError(draft)) return null;
  switch (draft.type) {
    case "fonts": {
      const to = draft.target === CUSTOM ? draft.custom.trim() : optionPayload(draft.target);
      if (draft.from.length === 0 || !to) return null;
      return { kind: "replace-font", params: { from: [...draft.from], to } };
    }
    case "colors": {
      const to = draft.target === CUSTOM ? normalizeHex(draft.custom) : normalizeHex(optionPayload(draft.target));
      if (draft.from.length === 0 || !to) return null;
      return { kind: "replace-color", params: { from: [...draft.from], to } };
    }
    case "delete":
      return draft.findingIds.length ? { kind: "delete-shapes", params: { findingIds: [...draft.findingIds] } } : null;
    case "links":
      if (draft.mode === "remove") {
        return draft.addresses.length ? { kind: "remove-hyperlink", params: { addresses: [...draft.addresses] } } : null;
      }
      if (draft.address === null || !draft.newAddress.trim()) return null;
      return { kind: "edit-hyperlink", params: { address: draft.address, newAddress: draft.newAddress.trim() } };
  }
}

export function draftKind(draft: Draft): FixKindId {
  switch (draft.type) {
    case "fonts":
      return "replace-font";
    case "colors":
      return "replace-color";
    case "delete":
      return "delete-shapes";
    case "links":
      return draft.mode === "remove" ? "remove-hyperlink" : "edit-hyperlink";
  }
}

export const DRAFT_TITLES: Record<FixKindId, string> = {
  "replace-font": "Replace fonts",
  "replace-color": "Replace colors",
  "delete-shapes": "Delete shapes",
  "remove-hyperlink": "Remove links",
  "edit-hyperlink": "Edit link",
};

// ---------------------------------------------------------------------------------------------
// Wording

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What one planned unit is called in counts ("change", "shape", "link"). */
export function unitNoun(kind: FixKindId): string {
  switch (kind) {
    case "delete-shapes":
      return "shape";
    case "remove-hyperlink":
    case "edit-hyperlink":
      return "link";
    default:
      return "change";
  }
}

export function applyLabel(kind: FixKindId, n: number): string {
  switch (kind) {
    case "replace-font":
    case "replace-color":
      return `Replace in ${plural(n, "place")}`;
    case "delete-shapes":
      return `Delete ${plural(n, "shape")}`;
    case "remove-hyperlink":
      return `Remove ${plural(n, "link")}`;
    case "edit-hyperlink":
      return `Update ${plural(n, "link")}`;
  }
}

export function confirmLabel(kind: FixKindId, n: number): string {
  return kind === "delete-shapes"
    ? `Yes, delete ${plural(n, "shape")}. PowerPoint's undo may not bring them back.`
    : `Yes, remove ${plural(n, "link")}. PowerPoint's undo may not bring them back.`;
}

/** Group items by a string key, keeping first-seen order. */
export function groupBy<T>(items: readonly T[], key: (t: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = map.get(k);
    if (list) list.push(it);
    else map.set(k, [it]);
  }
  return [...map.entries()];
}
