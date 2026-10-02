/**
 * Pure helpers for the fix UI (U12/U13, D11): which findings each picker offers, default picker
 * drafts, and draft → engine parameters. No React, no Office.
 *
 * Every string taken from findings (font names, hex values, addresses, labels) is untrusted deck
 * text: the components render it as React text only.
 */
import type { Area, AuditResult, Finding } from "@slidecheck/audit-core";
import {
  isReachable,
  normalizeHex,
  targetLabel,
  validateHyperlinkAddress,
  validateTitleSize,
  type FixKindId,
  type FixParamsMap,
  type SlideScope,
  type TitlePlaceholderType,
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
  "set-title-size": "setTitleSize",
  "remove-slide-numbers": "removeSlideNumbers",
};

/** At least one target the in-place fix engine can reach (per-target override, else finding). */
export function hasReachableTarget(f: Finding): boolean {
  if (f.targets.length === 0) return f.reachable === true;
  return f.targets.some((t) => isReachable(f, t));
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
  const seen = new Set<string>();
  for (const f of findings) {
    if (f.kind !== "font-usage" || !f.fixes.includes("replace-font")) continue;
    const name = f.data.typeface;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
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
  const seen = new Set<string>();
  for (const f of findings) {
    if (f.kind !== "color-usage" || !f.fixes.includes("replace-color")) continue;
    const hex = normalizeHex(f.data.hex);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
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
  const byAddress = new Map<string, LinkSource>();
  for (const f of findings) {
    if (f.area !== "links" || !isFixable(f)) continue;
    if (!f.fixes.includes("remove-hyperlink") && !f.fixes.includes("edit-hyperlink")) continue;
    const address = linkAddress(f);
    const hit = byAddress.get(address);
    if (hit) hit.count += f.targets.length;
    else {
      const s = { address, count: f.targets.length };
      byAddress.set(address, s);
      out.push(s);
    }
  }
  return out;
}

/** Finding kinds whose row action opens the title-size picker. */
export const TITLE_KINDS: readonly string[] = ["slide-titles", "title-sizes-inconsistent", "title-autofit-shrinks"];

export interface TitleSource {
  slideId: number;
  slideNumber: number;
  placeholderType: TitlePlaceholderType;
  sizesPt: number[];
  /** Untrusted deck text: render as text. */
  text: string;
  hidden: boolean;
  shrink: boolean;
  reachable: boolean;
}

/** Slide titles from the `slide-titles` finding, in slide order. */
export function titleSources(findings: readonly Finding[]): TitleSource[] {
  const out: TitleSource[] = [];
  for (const f of findings) {
    if (f.kind !== "slide-titles" || !f.fixes.includes("set-title-size")) continue;
    f.targets.forEach((t, i) => {
      const info = f.data.titles[i];
      if (!info) return;
      out.push({
        slideId: info.slideId,
        slideNumber: info.slideNumber,
        placeholderType: info.placeholderType === "ctrTitle" ? "ctrTitle" : "title",
        sizesPt: [...info.sizesPt],
        text: info.text,
        hidden: info.hidden,
        shrink: info.autofit === "shrink",
        reachable: isReachable(f, t),
      });
    });
  }
  return out.sort((a, b) => a.slideNumber - b.slideNumber);
}

/** Distinct sizes of the given titles, ascending. */
export function titleSizes(titles: readonly TitleSource[]): number[] {
  return [...new Set(titles.flatMap((t) => t.sizesPt))].sort((a, b) => a - b);
}

/** The size most titles use (ties → the larger size). */
export function mostCommonSize(titles: readonly TitleSource[]): number | undefined {
  const counts = new Map<number, number>();
  for (const t of titles) for (const p of t.sizesPt) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best: number | undefined;
  let n = 0;
  for (const [p, c] of counts) {
    if (c > n || (c === n && best !== undefined && p > best)) {
      best = p;
      n = c;
    }
  }
  return best;
}

export interface SlideNumberSource {
  slideId: number;
  slideNumber: number;
  /** Shapes the fix can delete / that stay (number mixed with other text). */
  removable: { label: string; kind: string }[];
  kept: { label: string; reason: string }[];
  hidden: boolean;
}

/** Slides showing a slide number (`slide-numbers` finding), in slide order. */
export function slideNumberSources(findings: readonly Finding[]): SlideNumberSource[] {
  const by = new Map<number, SlideNumberSource>();
  for (const f of findings) {
    if (f.kind !== "slide-numbers" || !f.fixes.includes("remove-slide-numbers")) continue;
    f.targets.forEach((t, i) => {
      const e = f.data.slides[i];
      if (!e) return;
      let s = by.get(e.slideId);
      if (!s) {
        s = { slideId: e.slideId, slideNumber: e.slideNumber, removable: [], kept: [], hidden: e.hidden };
        by.set(e.slideId, s);
      }
      const label = targetLabel(t);
      if (e.kind !== "field-in-text" && isReachable(f, t)) s.removable.push({ label, kind: e.kind });
      else s.kept.push({ label, reason: e.reason ?? "Can't be removed in place" });
    });
  }
  return [...by.values()].sort((a, b) => a.slideNumber - b.slideNumber);
}

/** Whether the deck has Header & Footer slide numbers turned on for new slides. */
export function slideNumbersFlagOn(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.kind === "slide-numbers" && (f.data.headerFooterFlag ?? []).some((h) => h.sldNum));
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
  const known = new Set(theme.map((x) => x.toLowerCase()));
  for (const f of result?.findings ?? []) {
    if (f.kind !== "font-usage") continue;
    const name = f.data.typeface;
    const k = name.toLowerCase();
    if (known.has(k)) continue;
    known.add(k);
    deck.push(name);
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
  | {
      type: "title-size";
      /** The size input, as typed (points). */
      size: string;
      placeholderTypes: TitlePlaceholderType[];
      alsoLayouts: boolean;
      /** Every slide with a title, or the chosen slide ids. */
      slides: "all" | number[];
    }
  | { type: "slide-numbers"; slides: "all" | number[] }
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
  /** Fonts: open the title-size picker. Review: open the slide-number picker. */
  titleSize?: boolean;
  slideNumbers?: boolean;
  /** Links: which action the bulk button asked for. */
  linkMode?: "remove" | "edit";
  /**
   * Fonts, from the Problems view (G3): font families to preselect (case-insensitive). Only those
   * the fix can reach are selected (D2); none of them is offered as the default target.
   */
  fonts?: readonly string[];
}

const lower = (s: string) => s.toLowerCase();

function initialTitleDraft(findings: readonly Finding[], row: Finding | undefined): Draft {
  const titles = titleSources(findings);
  let types: TitlePlaceholderType[];
  let size: number | undefined;
  if (row?.kind === "title-sizes-inconsistent") {
    types = [row.data.placeholderType === "ctrTitle" ? "ctrTitle" : "title"];
    size = row.data.mostCommonPt;
  } else {
    // Title slides are often intentionally larger: slide titles only, unless there are none.
    types = titles.some((t) => t.placeholderType === "title") || titles.length === 0 ? ["title"] : ["ctrTitle"];
    const inconsistent = findings.find((f) => f.kind === "title-sizes-inconsistent" && f.data.placeholderType === types[0]);
    size = inconsistent?.kind === "title-sizes-inconsistent" ? inconsistent.data.mostCommonPt : undefined;
  }
  size ??= mostCommonSize(titles.filter((t) => types.includes(t.placeholderType))) ?? 32;
  return { type: "title-size", size: String(size), placeholderTypes: types, alsoLayouts: false, slides: "all" };
}

export function initialDraft(area: FixArea, result: AuditResult | null, seed: DraftSeed = {}, canRemoveLinks = true): Draft {
  const findings = (result?.findings ?? []).filter((f) => f.area === area);
  const row = seed.finding;
  switch (area) {
    case "fonts": {
      if (seed.titleSize || (row && TITLE_KINDS.includes(row.kind))) return initialTitleDraft(findings, row);
      const sources = fontSources(findings);
      const seeded = seed.fonts ? new Set(seed.fonts.map(lower)) : null;
      const from =
        row && (row.kind === "font-usage" || row.kind === "font-maybe-missing" || row.kind === "font-missing-here")
          ? [row.data.typeface]
          : seeded
            ? sources.filter((s) => s.reachable && seeded.has(lower(s.name))).map((s) => s.name)
            : sources.filter((s) => s.inBrand === false && s.reachable).map((s) => s.name);
      const avoid = seed.fonts ? [...from, ...seed.fonts] : from;
      return { type: "fonts", from, target: defaultFontTarget(avoid, fontTargets(result)), custom: "" };
    }
    case "colors": {
      const sources = colorSources(findings);
      const rowHex = row && row.kind === "color-usage" ? normalizeHex(row.data.hex) : null;
      const from = rowHex ? [rowHex] : sources.filter((s) => s.inBrand === false && s.reachable).map((s) => s.hex);
      return { type: "colors", from, target: defaultColorTarget(from, colorTargets(result)), custom: "" };
    }
    case "review": {
      if (seed.slideNumbers || row?.kind === "slide-numbers") return { type: "slide-numbers", slides: "all" };
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

/** The typed title size as a number, or NaN. */
export function parseSize(text: string): number {
  const t = text.trim().replace(/\s*pt$/i, "");
  return t === "" || !/^\d+(\.\d+)?$/.test(t) ? Number.NaN : Number(t);
}

function scopeOf(slides: "all" | number[]): SlideScope {
  return slides === "all" ? "all" : { slideIds: [...slides] };
}

/** Inline validation message for the draft's free-text input, if any (shown next to it). */
export function draftInputError(draft: Draft): string | null {
  if (draft.type === "colors" && draft.target === CUSTOM && draft.custom.trim() !== "" && normalizeHex(draft.custom) === null) {
    return HEX_HINT;
  }
  if (draft.type === "links" && draft.mode === "edit" && draft.address !== null && draft.newAddress.trim() !== "") {
    return validateHyperlinkAddress(draft.newAddress);
  }
  if (draft.type === "title-size") return validateTitleSize(parseSize(draft.size));
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
    case "title-size":
      if (draft.placeholderTypes.length === 0 || (draft.slides !== "all" && draft.slides.length === 0)) return null;
      return {
        kind: "set-title-size",
        params: {
          sizePt: parseSize(draft.size),
          scope: scopeOf(draft.slides),
          placeholderTypes: [...draft.placeholderTypes],
          ...(draft.alsoLayouts ? { alsoLayouts: true } : {}),
        },
      };
    case "slide-numbers":
      if (draft.slides !== "all" && draft.slides.length === 0) return null;
      return { kind: "remove-slide-numbers", params: { scope: scopeOf(draft.slides) } };
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
    case "title-size":
      return "set-title-size";
    case "slide-numbers":
      return "remove-slide-numbers";
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
  "set-title-size": "Set title size",
  "remove-slide-numbers": "Remove slide numbers",
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
    case "remove-slide-numbers":
      return "slide number";
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
    case "set-title-size":
      return `Change ${plural(n, "title")}`;
    case "remove-slide-numbers":
      return `Delete ${plural(n, "slide number")}`;
  }
}

export function confirmLabel(kind: FixKindId, n: number): string {
  if (kind === "delete-shapes") return `Yes, delete ${plural(n, "shape")}. PowerPoint's undo may not bring them back.`;
  if (kind === "remove-slide-numbers") return `Yes, delete ${plural(n, "slide number")}. PowerPoint's undo may not bring them back.`;
  return `Yes, remove ${plural(n, "link")}. PowerPoint's undo may not bring them back.`;
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
