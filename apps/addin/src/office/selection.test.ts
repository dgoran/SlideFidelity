import { describe, expect, it, vi } from "vitest";
import {
  createSelectionWatcher,
  readSelection,
  SELECTION_CHANGED_EVENT,
  type SelectionContextLike,
  type SelectionDocumentLike,
  type SelectionResult,
  type SelectionRunLike,
  type TimerLike,
} from "./selection";

// ---------------------------------------------------------------------------------------------
// Fakes

interface FakeShape {
  id: string;
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  type: string;
}

function fakeRun(state: { all: string[]; slides: string[]; shapes: FakeShape[]; fail?: string }): {
  run: SelectionRunLike;
  calls: number;
  loads: string[];
} {
  const out = { calls: 0, loads: [] as string[], run: undefined as unknown as SelectionRunLike };
  out.run = async (batch) => {
    out.calls += 1;
    const coll = <T>(items: () => T[], label: string) => {
      const c = {
        items: [] as T[],
        load(props: string) {
          out.loads.push(`${label}:${props}`);
        },
      };
      return { c, fill: () => (c.items = items()) };
    };
    const all = coll(() => state.all.map((id) => ({ id })), "slides");
    const sel = coll(() => state.slides.map((id) => ({ id })), "selectedSlides");
    const shp = coll(() => state.shapes.map((s) => ({ ...s })), "selectedShapes");
    const ctx: SelectionContextLike = {
      presentation: {
        slides: all.c,
        getSelectedSlides: () => sel.c,
        getSelectedShapes: () => shp.c,
      },
      async sync() {
        if (state.fail) throw new Error(state.fail);
        all.fill();
        sel.fill();
        shp.fill();
      },
    };
    return batch(ctx);
  };
  return out;
}

function fakeDocument(): SelectionDocumentLike & {
  handlers: Array<(args?: unknown) => void>;
  fire(): void;
  removed: number;
  addFails?: boolean;
} {
  const d = {
    handlers: [] as Array<(args?: unknown) => void>,
    removed: 0,
    addFails: false,
    addHandlerAsync(type: unknown, handler: (args?: unknown) => void, cb?: (r: { status: string; error?: { message?: string } | null }) => void) {
      expect(type).toBe(SELECTION_CHANGED_EVENT);
      if (d.addFails) {
        cb?.({ status: "failed", error: { message: "nope" } });
        return;
      }
      d.handlers.push(handler);
      cb?.({ status: "succeeded" });
    },
    removeHandlerAsync(type: unknown, options: { handler?: (args?: unknown) => void } | undefined, cb?: (r: { status: string }) => void) {
      expect(type).toBe(SELECTION_CHANGED_EVENT);
      const i = d.handlers.indexOf(options?.handler as (args?: unknown) => void);
      if (i >= 0) {
        d.handlers.splice(i, 1);
        d.removed += 1;
      }
      cb?.({ status: "succeeded" });
    },
    fire() {
      for (const h of [...d.handlers]) h({ type: "documentSelectionChanged" });
    },
  };
  return d;
}

/** Manual clock + timers. */
function fakeTimers(): TimerLike & { now(): number; advance(ms: number): Promise<void> } {
  let t = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn: () => void, ms: number) {
      seq += 1;
      pending.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout(h: unknown) {
      pending.delete(h as number);
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      t = end;
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

const supported = { supports: () => true };
const unsupported = { supports: () => false };

const box: FakeShape = { id: "4", name: "TextBox 3", left: 72, top: 144, width: 432, height: 72, type: "GeometricShape" };

function setup(opts: { caps?: { supports(f: string): boolean }; state?: Parameters<typeof fakeRun>[0] } = {}) {
  const state = opts.state ?? { all: ["256#", "257#"], slides: ["257#"], shapes: [box] };
  const ppt = fakeRun(state);
  const doc = fakeDocument();
  const timers = fakeTimers();
  const events: SelectionResult[] = [];
  const watcher = createSelectionWatcher({
    capabilities: opts.caps ?? supported,
    run: ppt.run,
    document: doc,
    timers,
    now: timers.now,
    onChange: (s) => events.push(s),
  });
  return { state, ppt, doc, timers, events, watcher };
}

// ---------------------------------------------------------------------------------------------

describe("readSelection", () => {
  it("reads selected slides (with their index) and shapes", async () => {
    const { run } = fakeRun({ all: ["256#", "257#", "258#"], slides: ["257#"], shapes: [box] });
    const r = await readSelection(run, supported);
    expect(r).toEqual({
      status: "ok",
      unsupported: false,
      slides: [{ liveId: "257#", index: 1 }],
      shapes: [{ liveId: "4", name: "TextBox 3", left: 72, top: 144, width: 432, height: 72, type: "GeometricShape" }],
    });
  });

  it("reports unsupported below PowerPointApi 1.5 without touching the model", async () => {
    const ppt = fakeRun({ all: [], slides: [], shapes: [] });
    const caps = { supports: vi.fn(() => false) };
    expect(await readSelection(ppt.run, caps)).toEqual({ status: "unsupported", unsupported: true });
    expect(caps.supports).toHaveBeenCalledWith("selectShapes");
    expect(ppt.calls).toBe(0);
  });

  it("returns an error result instead of throwing", async () => {
    const { run } = fakeRun({ all: [], slides: [], shapes: [], fail: "GeneralException" });
    expect(await readSelection(run, supported)).toEqual({ status: "error", unsupported: false, message: "GeneralException" });
  });

  it("gives index -1 for a selected slide not found among all slides", async () => {
    const { run } = fakeRun({ all: ["256#"], slides: ["999#"], shapes: [] });
    const r = await readSelection(run, supported);
    expect(r.status === "ok" && r.slides).toEqual([{ liveId: "999#", index: -1 }]);
  });
});

describe("createSelectionWatcher", () => {
  it("subscribes to DocumentSelectionChanged and emits the selection after the debounce", async () => {
    const { doc, timers, events, watcher } = setup();
    expect(await watcher.start()).toEqual({ ok: true });
    expect(doc.handlers).toHaveLength(1);
    doc.fire();
    await timers.advance(149);
    expect(events).toHaveLength(0);
    await timers.advance(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "ok", shapes: [{ liveId: "4" }] });
  });

  it("collapses rapid events into one read", async () => {
    const { doc, timers, events, watcher, ppt } = setup();
    await watcher.start();
    for (let i = 0; i < 5; i++) {
      doc.fire();
      await timers.advance(100);
    }
    expect(events).toHaveLength(0);
    await timers.advance(150);
    expect(events).toHaveLength(1);
    expect(ppt.calls).toBe(1);
  });

  it("ignoreNext suppresses one navigation-caused event burst, not later user changes", async () => {
    const { doc, timers, events, watcher, ppt } = setup();
    await watcher.start();
    watcher.ignoreNext();
    doc.fire(); // setSelectedSlides
    doc.fire(); // setSelectedShapes
    await timers.advance(200);
    expect(events).toHaveLength(0);
    expect(ppt.calls).toBe(0);
    // The user then clicks another shape.
    doc.fire();
    await timers.advance(200);
    expect(events).toHaveLength(1);
  });

  it("ignoreNext expires when no event arrives within the window", async () => {
    const { doc, timers, events, watcher } = setup();
    await watcher.start();
    watcher.ignoreNext(500);
    await timers.advance(1000);
    doc.fire();
    await timers.advance(200);
    expect(events).toHaveLength(1);
  });

  it("reports unsupported once and does not subscribe below 1.5", async () => {
    const { doc, events, watcher } = setup({ caps: unsupported });
    expect(await watcher.start()).toEqual({ ok: true });
    expect(doc.handlers).toHaveLength(0);
    expect(events).toEqual([{ status: "unsupported", unsupported: true }]);
    expect(await watcher.read()).toEqual({ status: "unsupported", unsupported: true });
  });

  it("removes the handler on dispose and ignores pending bursts afterwards", async () => {
    const { doc, timers, events, watcher } = setup();
    await watcher.start();
    doc.fire();
    await watcher.dispose();
    expect(doc.removed).toBe(1);
    expect(doc.handlers).toHaveLength(0);
    await timers.advance(500);
    expect(events).toHaveLength(0);
  });

  it("drops a slow read superseded by a newer burst", async () => {
    const state = { all: ["256#"], slides: ["256#"], shapes: [box] };
    const doc = fakeDocument();
    const timers = fakeTimers();
    const events: SelectionResult[] = [];
    let release: (() => void) | undefined;
    let n = 0;
    const base = fakeRun(state).run;
    const run: SelectionRunLike = async (batch) => {
      n += 1;
      if (n === 1) await new Promise<void>((r) => (release = r));
      return base(batch);
    };
    const watcher = createSelectionWatcher({ capabilities: supported, run, document: doc, timers, now: timers.now, onChange: (s) => events.push(s) });
    await watcher.start();
    doc.fire();
    await timers.advance(150); // first read starts and blocks
    state.shapes = [{ ...box, id: "9", name: "Later" }];
    doc.fire();
    await timers.advance(150); // second read completes
    release?.();
    await timers.advance(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ shapes: [{ liveId: "9" }] });
  });

  it("removes the handler when dispose runs while the subscription is still pending", async () => {
    const { doc, timers, events, watcher } = setup();
    let completeAdd: (() => void) | undefined;
    const add = doc.addHandlerAsync.bind(doc);
    doc.addHandlerAsync = (type, handler, cb) => {
      completeAdd = () => add(type, handler, cb);
    };
    const started = watcher.start();
    await watcher.dispose();
    expect(doc.removed).toBe(0); // nothing registered yet
    completeAdd?.();
    expect(await started).toEqual({ ok: false, message: "disposed" });
    expect(doc.handlers).toHaveLength(0);
    expect(doc.removed).toBe(1);
    doc.fire();
    await timers.advance(500);
    expect(events).toHaveLength(0);
    await watcher.dispose(); // still safe
    expect(doc.removed).toBe(1);
  });

  it("start reports a failed subscription", async () => {
    const { doc, watcher } = setup();
    doc.addFails = true;
    expect(await watcher.start()).toEqual({ ok: false, message: "nope" });
  });
});
