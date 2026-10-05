/**
 * Pane-wide services and extension points.
 *
 * - `PaneServices`: host capabilities (R17), the navigator ("Show in PowerPoint", R2), and the
 *   selection echo guard (U11): every pane navigation goes through `navigateFromPane`, which
 *   tells the Inspector's selection watcher to ignore the selection change it is about to cause.
 * - `PaneSlots`: named extension points later units fill (all optional; the pane renders nothing
 *   in their place when absent):
 *   - `inspectorSlot` (U11): rendered below the results when the pane has results.
 *   - `renderRowActions` (U12/U13, U9): per-row action entries ("Replace font…", "Remove link") and
 *     the link check status on hyperlink rows.
 *   - `fixPanelSlot` (U12/U13, U9): the area's bulk-fix / inline fix picker panel (D11), and the Links
 *     area's "Check links" panel, above the tree. Several contributors combine with `composeSlots`.
 *   - `accountSlot` (U15): the account / sign-in entry in the header.
 *   - `settingsSlot` (D9): the settings entry in the header (brand profile editor).
 *   - `noticeSlot` (U15, D8/D12): non-blocking notices above the pane body (trial ending, offline).
 *   - `brandSlot` (brand editor, D9): entry point rendered in the Fonts and Colors areas.
 *   - `showFontsSlot` (show-machine fonts editor, G3): rendered in the Problems view's Fonts category
 *     (the settings entry renders its own copy).
 *   - `helperSlot` (SlideFidelity Helper status and offer, helper plan U12): rendered in the Problems
 *     view's Fonts category (the settings entry renders its own copy).
 */
import { createContext, Fragment, useContext, type ReactNode } from "react";
import type { Area, Finding, FindingTarget } from "@slidefidelity/audit-core";
import { capabilitiesUpTo, type Capabilities } from "../office/capabilities";
import type { NavigateResult, Navigator } from "../office/navigate";

/**
 * Lets the Inspector's selection watcher skip the selection change caused by the pane's own
 * navigation (`SelectionWatcher.ignoreNext`). The Inspector registers while it is watching.
 */
export interface SelectionEchoGuard {
  /** Call right before a navigation that changes the PowerPoint selection. */
  beforeNavigate(): void;
  /** Register the current watcher's `ignoreNext`; returns an unregister function. */
  register(ignoreNext: () => void): () => void;
}

export function createSelectionEchoGuard(): SelectionEchoGuard {
  const hooks = new Set<() => void>();
  return {
    beforeNavigate() {
      for (const h of hooks) h();
    },
    register(ignoreNext) {
      hooks.add(ignoreNext);
      return () => {
        hooks.delete(ignoreNext);
      };
    },
  };
}

export interface PaneServices {
  capabilities: Capabilities;
  navigator: Navigator;
  /** PowerPoint on the web (D10 "waiting for PowerPoint to save"). */
  isWeb: boolean;
  /** Filled in by `TaskPaneRoot` when omitted. */
  selectionGuard?: SelectionEchoGuard;
}

/**
 * The ONLY way pane code should navigate: silences the Inspector's selection watcher for the
 * selection change the navigation causes, then navigates.
 */
export function navigateFromPane(services: Pick<PaneServices, "navigator" | "selectionGuard">, target: FindingTarget): Promise<NavigateResult> {
  services.selectionGuard?.beforeNavigate();
  return services.navigator.navigate(target);
}

const unavailableNavigator: Navigator = { navigate: async () => ({ kind: "not-navigable" }) };

export const DEFAULT_SERVICES: PaneServices = {
  capabilities: capabilitiesUpTo(null),
  navigator: unavailableNavigator,
  isWeb: false,
};

export const PaneServicesContext = createContext<PaneServices>(DEFAULT_SERVICES);

export function usePaneServices(): PaneServices {
  return useContext(PaneServicesContext);
}

export function useCapabilities(): Capabilities {
  return useContext(PaneServicesContext).capabilities;
}

export interface RowActionContext {
  area: Area;
  /** The row's target, when the row is a target (level 3) row. */
  target?: FindingTarget;
  /** True for the tree's active (keyboard-focused) row. */
  active: boolean;
  /** Tab index to put on interactive elements the slot renders (0 when active, else -1). */
  tabIndex: 0 | -1;
}

export interface FixPanelContext {
  area: Area;
  /** The findings currently visible in the area (allowed by the plan, after filters). */
  findings: readonly Finding[];
  /**
   * Where the panel is rendered. `area` (default): the area's bulk actions and fix session.
   * `problems` (G1): inside a Problems category; only the open fix session for `area`, plus the
   * seeded bulk action when `initialSources` is given.
   */
  placement?: "area" | "problems";
  /**
   * Problems only: sources to preselect in the area's picker (fonts: family names; the fix keeps
   * only those it can reach, D2). Fonts are the only area that takes them today.
   */
  initialSources?: readonly string[];
}

export interface BrandSlotContext {
  area: "fonts" | "colors";
}

export interface ShowFontsSlotContext {
  placement: "problems";
}

export interface HelperSlotContext {
  placement: "problems";
}

export interface PaneSlots {
  inspectorSlot?: ReactNode;
  renderRowActions?: (finding: Finding, ctx: RowActionContext) => ReactNode;
  fixPanelSlot?: (ctx: FixPanelContext) => ReactNode;
  accountSlot?: ReactNode;
  settingsSlot?: ReactNode;
  noticeSlot?: ReactNode;
  brandSlot?: (ctx: BrandSlotContext) => ReactNode;
  showFontsSlot?: (ctx: ShowFontsSlotContext) => ReactNode;
  helperSlot?: (ctx: HelperSlotContext) => ReactNode;
}

type FnSlot = "renderRowActions" | "fixPanelSlot" | "brandSlot" | "showFontsSlot" | "helperSlot";
const FN_SLOTS: readonly FnSlot[] = ["renderRowActions", "fixPanelSlot", "brandSlot", "showFontsSlot", "helperSlot"];

/**
 * Merges several slot sets. Function slots (`renderRowActions`, `fixPanelSlot`, `brandSlot`, `showFontsSlot`, `helperSlot`) render
 * every contributor in order; node slots take the last one given.
 */
export function composeSlots(...parts: PaneSlots[]): PaneSlots {
  const out: PaneSlots = Object.assign({}, ...parts) as PaneSlots;
  for (const name of FN_SLOTS) {
    const fns = parts.map((p) => p[name]).filter((f): f is NonNullable<PaneSlots[FnSlot]> => typeof f === "function");
    if (fns.length < 2) continue;
    const many = fns as Array<(...args: unknown[]) => ReactNode>;
    const composed = (...args: unknown[]): ReactNode => (
      <>
        {many.map((f, i) => (
          <Fragment key={i}>{f(...args)}</Fragment>
        ))}
      </>
    );
    (out as Record<FnSlot, unknown>)[name] = composed;
  }
  return out;
}

export const PaneSlotsContext = createContext<PaneSlots>({});

export function usePaneSlots(): PaneSlots {
  return useContext(PaneSlotsContext);
}

export const AREA_LABELS: Record<Area, string> = {
  overview: "Overview",
  fonts: "Fonts",
  colors: "Colors",
  media: "Media & size",
  masters: "Masters & layouts",
  links: "Links",
  review: "File review",
};

/** Labels for every pane view: the Problems view (G1) and the areas. */
export const VIEW_LABELS: Record<"problems" | Area, string> = { problems: "Problems", ...AREA_LABELS };
