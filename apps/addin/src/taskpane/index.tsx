/**
 * Task pane entry (KTD1): wait for Office, probe the host once, build the real services, render.
 * No auto-scan (D10): the user starts the first scan.
 *
 * Services: capabilities → navigator + selection echo guard (U11), the brand store (D9) feeding
 * the scan service's `getOptions`, and ONE license service (U15) driving the gate's plan through
 * `LicenseBridge`. Slots: Inspector (U11), account entry + notices (U15), settings entry and the
 * Fonts/Colors brand editor (D9). U12/U13 add `fixPanelSlot` / `renderRowActions` here.
 */
import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { createLicenseService } from "../license/license";
import { getHostCapabilities } from "../office/capabilities";
import { createNavigator } from "../office/navigate";
import { createScanService } from "../office/scan";
import { createBrandStore } from "./brand/brandStore";
import { AccountEntry, AccountNotices } from "./components/Account";
import { BrandEditor, BrandSettingsEntry } from "./components/BrandEditor";
import { Inspector } from "./components/Inspector";
import { createSelectionEchoGuard, type PaneServices, type PaneSlots } from "./context";
import { LicenseBridge } from "./license/LicenseBridge";
import { TaskPaneRoot } from "./Root";

/** Selection activity drives only the non-blocking "may be out of date" hint (D4). */
function subscribeSelectionChanges(onActivity: () => void): () => void {
  const doc = Office.context.document;
  const handler = () => onActivity();
  try {
    doc.addHandlerAsync(Office.EventType.DocumentSelectionChanged, handler);
  } catch {
    return () => {};
  }
  return () => {
    try {
      doc.removeHandlerAsync(Office.EventType.DocumentSelectionChanged, { handler });
    } catch {
      /* ignore */
    }
  };
}

const licenseService = createLicenseService();
const brandStore = createBrandStore();

const rootElement = document.getElementById("container");
const root = rootElement ? createRoot(rootElement) : undefined;

void Office.onReady(() => {
  const capabilities = getHostCapabilities();
  const services: PaneServices = {
    capabilities,
    navigator: createNavigator({ capabilities }),
    isWeb: Office.context.platform === Office.PlatformType.OfficeOnline,
    selectionGuard: createSelectionEchoGuard(),
  };
  const scanService = createScanService({ getOptions: () => brandStore.auditOptions() });
  const slots: PaneSlots = {
    inspectorSlot: <Inspector />,
    accountSlot: <AccountEntry />,
    noticeSlot: <AccountNotices />,
    settingsSlot: <BrandSettingsEntry store={brandStore} />,
    brandSlot: ({ area }) => <BrandEditor store={brandStore} placement={area} />,
  };
  root?.render(
    <FluentProvider theme={webLightTheme}>
      <LicenseBridge service={licenseService}>
        {({ plan, onSignIn, onManageSubscription }) => (
          <TaskPaneRoot
            services={services}
            scanService={scanService}
            subscribeActivity={subscribeSelectionChanges}
            plan={plan}
            onSignIn={onSignIn}
            onManageSubscription={onManageSubscription}
            slots={slots}
          />
        )}
      </LicenseBridge>
    </FluentProvider>,
  );
});
