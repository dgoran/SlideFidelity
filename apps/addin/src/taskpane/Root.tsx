/**
 * All pane providers in one place, so index.tsx (real services) and tests (fakes) build the same
 * tree: PlanProvider (gate) → services → pane store → App.
 */
import type { Plan } from "../license/gate";
import { PlanProvider } from "../license/gate";
import type { ScanService } from "../office/scan";
import App from "./components/App";
import { PaneServicesContext, type PaneServices, type PaneSlots } from "./context";
import { PaneProvider } from "./state/PaneContext";
import type { PaneState } from "./state/store";

export interface TaskPaneRootProps {
  services: PaneServices;
  scanService: ScanService;
  /** Controlled plan (U15). Omit to let `PlanProvider` own it (defaults to `anonymous`). */
  plan?: Plan;
  initialPlan?: Plan;
  onPlanChange?: (plan: Plan) => void;
  onSignIn?: () => void;
  onManageSubscription?: () => void;
  subscribeActivity?: (onActivity: () => void) => () => void;
  slots?: PaneSlots;
  initialState?: PaneState;
  treeViewportHeight?: number;
}

export function TaskPaneRoot(props: TaskPaneRootProps) {
  const { services, scanService, slots, initialState, subscribeActivity, treeViewportHeight } = props;
  return (
    <PlanProvider
      {...(props.plan !== undefined ? { plan: props.plan } : {})}
      {...(props.initialPlan !== undefined ? { initialPlan: props.initialPlan } : {})}
      {...(props.onPlanChange ? { onPlanChange: props.onPlanChange } : {})}
      {...(props.onSignIn ? { onSignIn: props.onSignIn } : {})}
      {...(props.onManageSubscription ? { onManageSubscription: props.onManageSubscription } : {})}
    >
      <PaneServicesContext.Provider value={services}>
        <PaneProvider
          scanService={scanService}
          {...(initialState ? { initialState } : {})}
          {...(subscribeActivity ? { subscribeActivity } : {})}
        >
          <App {...(slots ? { slots } : {})} {...(treeViewportHeight !== undefined ? { treeViewportHeight } : {})} />
        </PaneProvider>
      </PaneServicesContext.Provider>
    </PlanProvider>
  );
}
