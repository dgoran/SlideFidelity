import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import App from "./components/App";

const rootElement = document.getElementById("container");
const root = rootElement ? createRoot(rootElement) : undefined;

Office.onReady(() => {
  root?.render(
    <FluentProvider theme={webLightTheme}>
      <App />
    </FluentProvider>,
  );
});
