/**
 * Task pane entry (KTD1): wait for Office, probe the host once, build the real services, render.
 * No auto-scan (D10): the user starts the first scan.
 */
import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { getHostCapabilities } from "../office/capabilities";
import { createNavigator } from "../office/navigate";
import { createScanService } from "../office/scan";
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

const rootElement = document.getElementById("container");
const root = rootElement ? createRoot(rootElement) : undefined;

void Office.onReady(() => {
  const capabilities = getHostCapabilities();
  const services = {
    capabilities,
    navigator: createNavigator({ capabilities }),
    isWeb: Office.context.platform === Office.PlatformType.OfficeOnline,
  };
  const scanService = createScanService();
  root?.render(
    <FluentProvider theme={webLightTheme}>
      <TaskPaneRoot services={services} scanService={scanService} subscribeActivity={subscribeSelectionChanges} />
    </FluentProvider>,
  );
});
