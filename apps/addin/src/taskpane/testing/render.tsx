/**
 * Minimal React render helpers for jsdom tests.
 *
 * `@testing-library/react` is a dependency, but its required peer `@testing-library/dom` is not
 * installed in this workspace (and dependencies are not changed in U10), so these helpers use
 * `react-dom/client` + `act` directly and plain DOM queries. `renderPane` renders the real
 * provider tree (`TaskPaneRoot`) with a controllable fake scan service and navigator.
 */
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import type { AuditResult, FindingTarget, ProgressEvent } from "@slidecheck/audit-core";
import { vi } from "vitest";
import type { Plan } from "../../license/gate";
import { capabilitiesUpTo, type ApiVersion } from "../../office/capabilities";
import type { NavigateResult, Navigator } from "../../office/navigate";
import { ScanError, type ScanRunOptions, type ScanService } from "../../office/scan";
import type { PaneSlots } from "../context";
import { TaskPaneRoot } from "../Root";
import { initialPaneState, type PaneState } from "../state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  rerender(ui: ReactElement): void;
  unmount(): void;
}

const mounted = new Set<Rendered>();

export function render(ui: ReactElement, opts: { fluent?: boolean } = {}): Rendered {
  const wrap = (el: ReactElement) => (opts.fluent === false ? el : <FluentProvider theme={webLightTheme}>{el}</FluentProvider>);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(wrap(ui)));
  const r: Rendered = {
    container,
    rerender: (next) => act(() => root.render(wrap(next))),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      mounted.delete(r);
    },
  };
  mounted.add(r);
  return r;
}

export function cleanup(): void {
  for (const r of [...mounted]) r.unmount();
}

/** Let pending promises (and resulting state updates) settle. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export function focus(el: HTMLElement): void {
  act(() => el.focus());
}

export function keyDown(el: Element, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** Set a controlled input/select value the way React listens for it. */
export function changeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

export function all(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

export function one(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
}

/** First element whose own trimmed text content equals `text` (or matches the regex). */
export function byText(root: ParentNode, text: string | RegExp, selector = "*"): HTMLElement {
  const hit = all(root, selector).find((el) => {
    const t = (el.textContent ?? "").trim();
    const own = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim());
    if (!own) return false;
    return typeof text === "string" ? t === text : text.test(t);
  });
  if (!hit) throw new Error(`no element with text ${String(text)}`);
  return hit;
}

export function button(root: ParentNode, name: string | RegExp): HTMLButtonElement {
  const hit = all(root, "button").find((b) => {
    const label = b.getAttribute("aria-label") ?? (b.textContent ?? "").trim();
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!hit) throw new Error(`no button named ${String(name)}`);
  return hit as HTMLButtonElement;
}

// ---------------------------------------------------------------------------------------------
// Pane harness: the real provider tree with fake services.


export interface FakeScan {
  service: ScanService;
  /** Options of the most recent `scan()` call (to drive progress). */
  lastOptions: () => ScanRunOptions | undefined;
  progress(e: ProgressEvent): void;
  resolve(result: AuditResult): void;
  reject(e: unknown): void;
  calls: () => number;
}

export function fakeScanService(): FakeScan {
  let opts: ScanRunOptions | undefined;
  let settle: { resolve: (r: AuditResult) => void; reject: (e: unknown) => void } | undefined;
  let calls = 0;
  const service: ScanService = {
    last: null,
    busy: false,
    scan: (o = {}) => {
      calls += 1;
      opts = o;
      return new Promise<AuditResult>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    rescanForFix: () => Promise.reject(new Error("not used")),
    cancel: () => settle?.reject(new ScanError("cancelled", "Scan cancelled")),
    dispose: () => {},
  };
  return {
    service,
    lastOptions: () => opts,
    progress: (e) => act(() => opts?.onProgress?.(e)),
    resolve: (r) => settle?.resolve(r),
    reject: (e) => settle?.reject(e),
    calls: () => calls,
  };
}

export interface PaneHarnessOptions {
  result?: AuditResult;
  plan?: Plan;
  api?: ApiVersion | null;
  navigate?: (t: FindingTarget) => Promise<NavigateResult>;
  slots?: PaneSlots;
  isWeb?: boolean;
  onSignIn?: () => void;
  onManageSubscription?: () => void;
  treeViewportHeight?: number;
  state?: Partial<PaneState>;
}

export function renderPane(o: PaneHarnessOptions = {}) {
  const scan = fakeScanService();
  const navigate = vi.fn(o.navigate ?? (async (): Promise<NavigateResult> => ({ kind: "not-found" })));
  const navigator: Navigator = { navigate };
  const base = initialPaneState();
  const initialState: PaneState = {
    ...base,
    ...(o.result ? { scan: { status: "ready", result: o.result, scannedAt: 0, possiblyOutdated: false } } : {}),
    ...o.state,
  };
  const r = render(
    <TaskPaneRoot
      services={{ capabilities: capabilitiesUpTo(o.api === undefined ? "1.10" : o.api), navigator, isWeb: o.isWeb ?? false }}
      scanService={scan.service}
      plan={o.plan ?? "pro"}
      initialState={initialState}
      treeViewportHeight={o.treeViewportHeight ?? 440}
      {...(o.slots ? { slots: o.slots } : {})}
      {...(o.onSignIn ? { onSignIn: o.onSignIn } : {})}
      {...(o.onManageSubscription ? { onManageSubscription: o.onManageSubscription } : {})}
    />,
  );
  return { ...r, scan, navigate };
}
