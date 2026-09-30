/**
 * Fix UI (U12/U13 UI) entry: builds the `fixPanelSlot` and `renderRowActions` pane slots around
 * one shared fix session store. Host APIs are injected (`FixDeps`): index.tsx passes
 * `PowerPoint.run` and `PowerPoint.createPresentation`; tests pass fakes.
 */
import type { PaneSlots } from "../context";
import { createFixController, type FixController } from "./controller";
import { FixPanel } from "./FixPanel";
import { FixRowAction } from "./RowActions";
import type { FixDeps } from "./useFixActions";

export type { FixDeps } from "./useFixActions";
export { createFixController, type FixController } from "./controller";

export function createFixSlots(deps: FixDeps, controller: FixController = createFixController()): Required<Pick<PaneSlots, "fixPanelSlot" | "renderRowActions">> {
  return {
    fixPanelSlot: ({ area }) => <FixPanel controller={controller} deps={deps} area={area} />,
    renderRowActions: (finding, ctx) => <FixRowAction controller={controller} finding={finding} ctx={ctx} />,
  };
}
