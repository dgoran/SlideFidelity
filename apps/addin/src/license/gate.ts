/**
 * Feature gating (D7, D8, D13, R19): the single source of truth for what each plan may see.
 *
 * Gating is per feature, not per area. Free and anonymous users get the Overview counts for every
 * area (D7), the font list, and the media size breakdown; trial and Pro get everything. Client-side
 * gating is convenience only (KTD7): server-enforced features (link checking) re-check on the API.
 *
 * U15 drives the plan from real entitlements through `PlanProvider` (controlled `plan` prop or
 * `setPlan`) and wires `onSignIn` / `onManageSubscription`.
 */
import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Area, Finding } from "@slidefidelity/audit-core";

// ---------------------------------------------------------------------------------------------
// Plans and features

export const PLANS = ["anonymous", "free", "trial", "pro", "expired"] as const;
export type Plan = (typeof PLANS)[number];

export const FEATURES = [
  "overview.counts",
  "area.fonts.list",
  "area.fonts.flags",
  "area.colors",
  "area.media.sizes",
  "area.media.issues",
  "area.masters",
  "area.links",
  "area.review",
  "inspector",
  "fixes",
  "linkcheck",
  "brand",
] as const;
export type Feature = (typeof FEATURES)[number];

const FREE: ReadonlySet<Feature> = new Set<Feature>(["overview.counts", "area.fonts.list", "area.media.sizes"]);

/** Trial and Pro have full access; the others are the free tier. */
export function hasProAccess(plan: Plan): boolean {
  return plan === "trial" || plan === "pro";
}

export function isAllowed(plan: Plan, feature: Feature): boolean {
  return hasProAccess(plan) || FREE.has(feature);
}

// ---------------------------------------------------------------------------------------------
// Locked-state calls to action (D8)

export type LockAction = "sign-in-trial" | "manage-subscription";

/** Which CTA a locked feature shows for this plan; `null` when nothing is locked. */
export function lockAction(plan: Plan): LockAction | null {
  if (hasProAccess(plan)) return null;
  return plan === "anonymous" ? "sign-in-trial" : "manage-subscription";
}

export function ctaLabel(action: LockAction): string {
  return action === "sign-in-trial" ? "Sign in to start your 30-day free trial" : "Manage subscription";
}

// ---------------------------------------------------------------------------------------------
// Findings and areas

/** Free Fonts kinds: the font list (D13). Every other Fonts kind is a Pro flag. */
const FONT_LIST_KINDS: ReadonlySet<string> = new Set(["font-usage", "check-failed"]);
/** Free Media kinds: the size breakdown (D13). Every other Media kind is a Pro issue. */
const MEDIA_SIZE_KINDS: ReadonlySet<string> = new Set(["media-size", "file-size-breakdown", "check-failed"]);

/**
 * The feature a finding's details belong to (D13). Graphics Ops kinds (G1-G5) follow their area:
 * `font-maybe-missing` / `font-missing-here` / `font-availability-summary` are font flags; `media-missing`,
 * `media-linked`, `media-online`, `media-format`, `media-poster-missing`, and
 * `media-playback-settings` are media issues; `partly-off-slide` and `text-collision` are review.
 */
export function featureForFinding(f: Pick<Finding, "area" | "kind">): Feature {
  switch (f.area) {
    case "overview":
      return "overview.counts";
    case "fonts":
      return FONT_LIST_KINDS.has(f.kind) ? "area.fonts.list" : "area.fonts.flags";
    case "media":
      return MEDIA_SIZE_KINDS.has(f.kind) ? "area.media.sizes" : "area.media.issues";
    case "colors":
      return "area.colors";
    case "masters":
      return "area.masters";
    case "links":
      return "area.links";
    case "review":
      return "area.review";
  }
}

export const AREA_FEATURES: Record<Area, readonly Feature[]> = {
  overview: ["overview.counts"],
  fonts: ["area.fonts.list", "area.fonts.flags"],
  colors: ["area.colors"],
  media: ["area.media.sizes", "area.media.issues"],
  masters: ["area.masters"],
  links: ["area.links"],
  review: ["area.review"],
};

/**
 * The Problems view (G1): its headline and counts are free (like the Overview, D7); the listed
 * findings' details follow these features.
 */
export const PROBLEMS_FEATURES: readonly Feature[] = ["area.fonts.flags", "area.media.issues", "area.review"];

export type AreaAccess = "full" | "partial" | "locked";

function access(plan: Plan, features: readonly Feature[]): AreaAccess {
  const allowed = features.filter((f) => isAllowed(plan, f)).length;
  if (allowed === features.length) return "full";
  return allowed === 0 ? "locked" : "partial";
}

export function areaAccess(plan: Plan, area: Area): AreaAccess {
  return access(plan, AREA_FEATURES[area]);
}

/** Access for a pane view: an area, or the Problems view (never fully locked: its counts are free). */
export function viewAccess(plan: Plan, view: Area | "problems"): AreaAccess {
  if (view !== "problems") return areaAccess(plan, view);
  return access(plan, PROBLEMS_FEATURES) === "full" ? "full" : "partial";
}

// ---------------------------------------------------------------------------------------------
// React context

export interface PlanContextValue {
  plan: Plan;
  setPlan: (plan: Plan) => void;
  isAllowed: (feature: Feature) => boolean;
  lockAction: LockAction | null;
  /** Opens sign-in (U15). No-op until wired. */
  requestSignIn: () => void;
  /** Opens the website account page (U15). No-op until wired. */
  openManageSubscription: () => void;
}

const noop = (): void => {};

const PlanContext = createContext<PlanContextValue>({
  plan: "anonymous",
  setPlan: noop,
  isAllowed: (f) => isAllowed("anonymous", f),
  lockAction: lockAction("anonymous"),
  requestSignIn: noop,
  openManageSubscription: noop,
});

export interface PlanProviderProps {
  /** Controlled plan (U15 passes the entitlement-derived plan). */
  plan?: Plan;
  /** Uncontrolled starting plan; defaults to `anonymous`. */
  initialPlan?: Plan;
  onPlanChange?: (plan: Plan) => void;
  onSignIn?: () => void;
  onManageSubscription?: () => void;
  children?: ReactNode;
}

export function PlanProvider(props: PlanProviderProps) {
  const { plan: controlled, initialPlan, onPlanChange, onSignIn, onManageSubscription, children } = props;
  const [own, setOwn] = useState<Plan>(initialPlan ?? "anonymous");
  const plan = controlled ?? own;
  const setPlan = useCallback(
    (p: Plan) => {
      setOwn(p);
      onPlanChange?.(p);
    },
    [onPlanChange],
  );
  const value = useMemo<PlanContextValue>(
    () => ({
      plan,
      setPlan,
      isAllowed: (f) => isAllowed(plan, f),
      lockAction: lockAction(plan),
      requestSignIn: onSignIn ?? noop,
      openManageSubscription: onManageSubscription ?? noop,
    }),
    [plan, setPlan, onSignIn, onManageSubscription],
  );
  return createElement(PlanContext.Provider, { value }, children);
}

export function usePlan(): PlanContextValue {
  return useContext(PlanContext);
}
