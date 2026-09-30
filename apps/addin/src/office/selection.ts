/**
 * Live PowerPoint selection for the Inspector (R4, U11).
 *
 * - Subscribes to `DocumentSelectionChanged` through `Office.context.document.addHandlerAsync`
 *   and debounces bursts (default 150 ms) into one read.
 * - Reads the selection with `presentation.getSelectedSlides()` / `getSelectedShapes()`
 *   (PowerPointApi 1.5). Below 1.5 it reports `{ unsupported: true }` and never subscribes.
 * - `ignoreNext()` drops the next event burst inside a short window, so selection changes caused
 *   by SlideCheck's own "Show in PowerPoint" navigation do not repaint the Inspector.
 * - Selection changes never block anything (D4); they only drive the Inspector.
 *
 * Every dependency is injectable; the defaults use the `PowerPoint` / `Office` globals.
 */
import type { Capabilities } from "./capabilities";

// ---------------------------------------------------------------------------------------------
// Results

export interface SelectedSlide {
  /** Live `PowerPoint.Slide.id` (see ids.ts for the assumed format). */
  liveId: string;
  /** 0-based position in `presentation.slides`, or -1 when not found. */
  index: number;
}

export interface SelectedShape {
  /** Live `PowerPoint.Shape.id`. */
  liveId: string;
  name: string;
  /** Points. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** `PowerPoint.ShapeType` string (`GeometricShape`, `Image`, `Group`, …). */
  type: string;
}

export type SelectionResult =
  | { status: "ok"; unsupported: false; slides: SelectedSlide[]; shapes: SelectedShape[] }
  | { status: "unsupported"; unsupported: true }
  | { status: "error"; unsupported: false; message: string };

// ---------------------------------------------------------------------------------------------
// Minimal shapes of the Office / PowerPoint API we use (so tests can fake them)

interface LoadableCollection<T> {
  items: T[];
  load(props: string): void;
}

export interface SelectionContextLike {
  presentation: {
    slides: LoadableCollection<{ id: string }>;
    getSelectedSlides(): LoadableCollection<{ id: string }>;
    getSelectedShapes(): LoadableCollection<{
      id: string;
      name: string;
      left: number;
      top: number;
      width: number;
      height: number;
      type: string;
    }>;
  };
  sync(): Promise<unknown>;
}

export type SelectionRunLike = <T>(batch: (ctx: SelectionContextLike) => Promise<T>) => Promise<T>;

interface AsyncResultLike {
  status: Office.AsyncResultStatus | string;
  error?: { message?: string } | null;
}

export interface SelectionDocumentLike {
  addHandlerAsync(eventType: Office.EventType, handler: (args?: unknown) => void, callback?: (r: AsyncResultLike) => void): void;
  removeHandlerAsync(
    eventType: Office.EventType,
    options: { handler?: (args?: unknown) => void } | undefined,
    callback?: (r: AsyncResultLike) => void,
  ): void;
}

export interface TimerLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** `Office.EventType.DocumentSelectionChanged` as a literal so the module loads without Office. */
export const SELECTION_CHANGED_EVENT = "documentSelectionChanged" as unknown as Office.EventType;

export const DEFAULT_DEBOUNCE_MS = 150;
/** How long `ignoreNext()` waits for the navigation-caused event before expiring. */
export const DEFAULT_IGNORE_WINDOW_MS = 1000;

const SHAPE_PROPS = "items/id,items/name,items/left,items/top,items/width,items/height,items/type";

const defaultRun: SelectionRunLike = (batch) =>
  PowerPoint.run((ctx) => batch(ctx as unknown as SelectionContextLike));

const defaultTimers: TimerLike = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

const succeeded = (r: AsyncResultLike): boolean => String(r.status) === "succeeded";

// ---------------------------------------------------------------------------------------------
// One-shot read

/** Read the current selection once. Never throws. */
export async function readSelection(
  run: SelectionRunLike,
  capabilities: Pick<Capabilities, "supports">,
): Promise<SelectionResult> {
  if (!capabilities.supports("selectShapes")) return { status: "unsupported", unsupported: true };
  try {
    return await run(async (ctx) => {
      const all = ctx.presentation.slides;
      all.load("items/id");
      const slides = ctx.presentation.getSelectedSlides();
      slides.load("items/id");
      const shapes = ctx.presentation.getSelectedShapes();
      shapes.load(SHAPE_PROPS);
      await ctx.sync();
      const order = all.items.map((s) => s.id);
      return {
        status: "ok" as const,
        unsupported: false as const,
        slides: slides.items.map((s) => ({ liveId: s.id, index: order.indexOf(s.id) })),
        shapes: shapes.items.map((s) => ({
          liveId: s.id,
          name: s.name,
          left: s.left,
          top: s.top,
          width: s.width,
          height: s.height,
          type: String(s.type),
        })),
      };
    });
  } catch (e) {
    return { status: "error", unsupported: false, message: messageOf(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Watcher

export interface SelectionWatcherDeps {
  capabilities: Pick<Capabilities, "supports">;
  /** Called with each settled selection (after debounce), and once with `unsupported` below 1.5. */
  onChange(selection: SelectionResult): void;
  run?: SelectionRunLike;
  /** Defaults to `Office.context.document`. */
  document?: SelectionDocumentLike;
  debounceMs?: number;
  timers?: TimerLike;
  now?: () => number;
}

export interface SelectionWatcher {
  /** Subscribe. Resolves `{ ok: false }` when the host refuses the handler. */
  start(): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Read the selection now (e.g. when the Inspector first opens). */
  read(): Promise<SelectionResult>;
  /**
   * Drop the next event burst (all events within one debounce) if it starts within `windowMs`.
   * Call right before SlideCheck's own navigation changes the selection.
   */
  ignoreNext(windowMs?: number): void;
  /** Remove the handler and cancel any pending read. Safe to call twice. */
  dispose(): Promise<void>;
}

export function createSelectionWatcher(deps: SelectionWatcherDeps): SelectionWatcher {
  const run = deps.run ?? defaultRun;
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const getDocument = (): SelectionDocumentLike =>
    deps.document ?? (Office.context.document as unknown as SelectionDocumentLike);

  let subscribed = false;
  let disposed = false;
  let timer: unknown;
  let hasTimer = false;
  /** Latest read sequence; older reads are discarded. */
  let seq = 0;
  /** `ignoreNext` window end (ms), or null. */
  let ignoreUntil: number | null = null;
  /** The current burst started inside an ignore window. */
  let burstIgnored = false;

  const supported = (): boolean => deps.capabilities.supports("selectShapes");

  const flush = (): void => {
    hasTimer = false;
    if (disposed) return;
    if (burstIgnored) {
      burstIgnored = false;
      return;
    }
    const mine = ++seq;
    void readSelection(run, deps.capabilities).then((result) => {
      if (disposed || mine !== seq) return;
      deps.onChange(result);
    });
  };

  const handler = (): void => {
    if (disposed) return;
    if (!hasTimer) {
      // A new burst: decide once whether it is the navigation echo.
      if (ignoreUntil !== null && now() <= ignoreUntil) burstIgnored = true;
      ignoreUntil = null;
    } else {
      timers.clearTimeout(timer);
    }
    // Any newer burst supersedes an in-flight read.
    seq += 1;
    hasTimer = true;
    timer = timers.setTimeout(flush, debounceMs);
  };

  return {
    async start() {
      if (disposed) return { ok: false, message: "disposed" };
      if (!supported()) {
        deps.onChange({ status: "unsupported", unsupported: true });
        return { ok: true };
      }
      if (subscribed) return { ok: true };
      return new Promise((resolve) => {
        try {
          getDocument().addHandlerAsync(SELECTION_CHANGED_EVENT, handler, (r) => {
            if (succeeded(r)) {
              subscribed = true;
              resolve({ ok: true });
            } else {
              resolve({ ok: false, message: r.error?.message ?? "Could not subscribe to selection changes" });
            }
          });
        } catch (e) {
          resolve({ ok: false, message: messageOf(e) });
        }
      });
    },

    read() {
      return readSelection(run, deps.capabilities);
    },

    ignoreNext(windowMs = DEFAULT_IGNORE_WINDOW_MS) {
      if (hasTimer) {
        // Navigation joins the burst already in progress; its result is superseded anyway.
        burstIgnored = true;
        return;
      }
      ignoreUntil = now() + windowMs;
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      if (hasTimer) timers.clearTimeout(timer);
      hasTimer = false;
      if (!subscribed) return;
      subscribed = false;
      await new Promise<void>((resolve) => {
        try {
          getDocument().removeHandlerAsync(SELECTION_CHANGED_EVENT, { handler }, () => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
