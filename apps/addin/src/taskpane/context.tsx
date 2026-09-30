/**
 * Pane-wide services and extension points.
 *
 * - `PaneServices`: host capabilities (R17), the navigator ("Show in PowerPoint", R2), and the
 *   selection echo guard (U11): every pane navigation goes through `navigateFromPane`, which
 *   tells the Inspector's selection watcher to ignore the selection change it is about to cause.
 * - `PaneSlots`: named extension points later units fill (all optional; the pane renders nothing
 *   in their place when absent):
 *   - `inspectorSlot` (U11): rendered below the results when the pane has results.
 *   - `renderRowActions` (U12/U13): per-row action entries ("Replace font…", "Remove link").
 *   - `fixPanelSlot` (U12/U13): the area's bulk-fix / inline fix picker panel (D11), above the tree.
 *   - `accountSlot` (U15): the account / sign-in entry in the header.
 *   - `settingsSlot` (D9): the settings entry in the header (brand profile editor).
 *   - `noticeSlot` (U15, D8/D12): non-blocking notices above the pane body (trial ending, offline).
 *   - `brandSlot` (brand editor, D9): entry point rendered in the Fonts and Colors areas.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { Area, Finding, FindingTarget } from "@slidecheck/audit-core";
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
}

export interface BrandSlotContext {
  area: "fonts" | "colors";
}

export interface PaneSlots {
  inspectorSlot?: ReactNode;
  renderRowActions?: (finding: Finding, ctx: RowActionContext) => ReactNode;
  fixPanelSlot?: (ctx: FixPanelContext) => ReactNode;
  accountSlot?: ReactNode;
  settingsSlot?: ReactNode;
  noticeSlot?: ReactNode;
  brandSlot?: (ctx: BrandSlotContext) => ReactNode;
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
