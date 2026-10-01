/**
 * Link check UI (U9 UI, R11) entry: builds the Links area panel (`fixPanelSlot`) and the per-row
 * status (`renderRowActions`) around one shared controller. index.tsx composes these with the fix
 * slots (`composeSlots`) and injects the API base and `LicenseService.getSessionToken`; tests pass a
 * fake `checkLinks`.
 */
import type { PaneSlots } from "../context";
import { createLinkCheckController, type LinkCheckController, type LinkCheckSlotDeps } from "./controller";
import { LinkCheckPanel, LinkRowStatus } from "./LinkCheckPanel";

export { createLinkCheckController, type LinkCheckController, type LinkCheckSlotDeps } from "./controller";
export { DISCLOSURE_TEXT } from "./LinkCheckPanel";

export function createLinkCheckSlots(
  deps: LinkCheckSlotDeps,
  controller: LinkCheckController = createLinkCheckController(deps),
): Required<Pick<PaneSlots, "fixPanelSlot" | "renderRowActions">> {
  return {
    fixPanelSlot: ({ area }) => <LinkCheckPanel controller={controller} area={area} />,
    renderRowActions: (finding, ctx) => <LinkRowStatus controller={controller} finding={finding} ctx={ctx} />,
  };
}
