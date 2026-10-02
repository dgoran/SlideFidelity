/**
 * Task pane entry (KTD1): wait for Office, probe the host once, build the real services, render.
 * No auto-scan (D10): the user starts the first scan.
 *
 * Services: capabilities → navigator + selection echo guard (U11), the brand store (D9) and the
 * show-machine fonts store (G3) feeding the scan service's `getOptions` ({brand?, availableFonts?}),
 * and ONE license service (U15) driving the gate's plan through `LicenseBridge`. Slots: Inspector
 * (U11), account entry + notices (U15), settings entry (brand profile D9 + show-machine fonts G3),
 * the Fonts/Colors brand editor (D9), the show-machine fonts editor in the Problems view (G3), the
 * fix panel + row actions (U12/U13) over `PowerPoint.run`, and
 * the Links area's reachability check (U9 UI, R11) with its per-row statuses, composed into the same
 * `fixPanelSlot` / `renderRowActions` slots. The check authenticates with the license service's
 * session token and talks to the same API base as licensing.
 */
import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { createLicenseConfig } from "../license/config";
import { devUnlockFromEnvironment, effectivePlan } from "../license/devUnlock";
import { createLicenseService } from "../license/license";
import { getHostCapabilities } from "../office/capabilities";
import { createNavigator } from "../office/navigate";
import { createScanService } from "../office/scan";
import { createBrandStore } from "./brand/brandStore";
import { composeAuditOptions, createShowFontsStore } from "./fonts/showFontsStore";
import { AccountEntry, AccountNotices } from "./components/Account";
import { BrandEditor, BrandSettingsEntry } from "./components/BrandEditor";
import { DevUnlockBanner } from "./components/DevUnlockBanner";
import { FontProbeDiagnostics } from "./components/FontProbeDiagnostics";
import { Inspector } from "./components/Inspector";
import { ShowFontsEditor } from "./components/ShowFontsEditor";
import { composeSlots, createSelectionEchoGuard, type PaneServices, type PaneSlots } from "./context";
import { createFixSlots } from "./fixes";
import { LicenseBridge } from "./license/LicenseBridge";
import { createLinkCheckSlots } from "./linkcheck";
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

const licenseConfig = createLicenseConfig();
const licenseService = createLicenseService(licenseConfig);
const brandStore = createBrandStore();
const showFontsStore = createShowFontsStore();
// Development builds served from localhost only; always false in production bundles.
const devUnlock = devUnlockFromEnvironment();

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
  const scanService = createScanService({ getOptions: composeAuditOptions(brandStore, showFontsStore) });
  const fixSlots = createFixSlots({
    run: (batch) => PowerPoint.run(batch),
    createPresentation: (base64File) => PowerPoint.createPresentation(base64File),
    isSetSupported: (version) => {
      try {
        return Office.context.requirements.isSetSupported("PowerPointApi", version);
      } catch {
        return false;
      }
    },
  });
  const linkCheckSlots = createLinkCheckSlots({
    baseUrl: licenseConfig.apiBase,
    getToken: () => licenseService.getSessionToken(),
    // The API refused the session: refresh so the account state (signed out) catches up.
    onUnauthorized: () => void licenseService.refresh().catch(() => {}),
  });
  const slots: PaneSlots = composeSlots(fixSlots, linkCheckSlots, {
    inspectorSlot: <Inspector />,
    accountSlot: <AccountEntry />,
    noticeSlot: (
      <>
        {devUnlock && <DevUnlockBanner />}
        {devUnlock && <FontProbeDiagnostics />}
        <AccountNotices />
      </>
    ),
    settingsSlot: (
      <BrandSettingsEntry store={brandStore}>
        <ShowFontsEditor store={showFontsStore} placement="settings" />
      </BrandSettingsEntry>
    ),
    brandSlot: ({ area }) => <BrandEditor store={brandStore} placement={area} />,
    showFontsSlot: ({ placement }) => <ShowFontsEditor store={showFontsStore} placement={placement} />,
  });
  root?.render(
    <FluentProvider theme={webLightTheme}>
      <LicenseBridge service={licenseService}>
        {({ plan, onSignIn, onManageSubscription }) => (
          <TaskPaneRoot
            services={services}
            scanService={scanService}
            subscribeActivity={subscribeSelectionChanges}
            plan={effectivePlan(plan, devUnlock)}
            onSignIn={onSignIn}
            onManageSubscription={onManageSubscription}
            slots={slots}
          />
        )}
      </LicenseBridge>
    </FluentProvider>,
  );
});
