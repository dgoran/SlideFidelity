/**
 * "Show in PowerPoint" (R2, U10).
 *
 * - PowerPointApi 1.5+: `presentation.setSelectedSlides` + `slide.setSelectedShapes`, with live ids
 *   resolved from snapshot ids through `ids.ts` (KTD5). A nested shape selects its outermost group.
 * - Below 1.5: slide-only through the common API `Document.goToByIdAsync` (by slide id, then by
 *   1-based index).
 * - Layout and master targets cannot be shown (no master view from an add-in); they return a
 *   `layout-note` and never touch the live model.
 *
 * Every dependency is injectable; the defaults use the `PowerPoint` / `Office` globals.
 */
import type { Finding, FindingTarget } from "@slidefidelity/audit-core";
import type { Capabilities } from "./capabilities";
import { emuToPoints, resolveShape, resolveSlide, type MatchMethod } from "./ids";

// ---------------------------------------------------------------------------------------------
// Minimal shapes of the PowerPoint API we use (so tests can fake them)

export interface ShapeLike {
  id: string;
  name: string;
  left: number;
  top: number;
}

export interface SlideLike {
  id: string;
  shapes: { items: ShapeLike[]; load(props: string): void };
  setSelectedShapes(ids: string[]): void;
}

export interface PptContextLike {
  presentation: {
    slides: { items: SlideLike[]; load(props: string): void };
    setSelectedSlides(ids: string[]): void;
  };
  sync(): Promise<unknown>;
}

export type PowerPointRunLike = <T>(batch: (ctx: PptContextLike) => Promise<T>) => Promise<T>;

export interface GoToDocumentLike {
  goToByIdAsync(
    id: string | number,
    goToType: Office.GoToType,
    callback: (result: { status: Office.AsyncResultStatus | string; error?: { message?: string } | null }) => void,
  ): void;
}

// ---------------------------------------------------------------------------------------------
// Results

export type NavigateResult =
  | { kind: "shape"; slideId: string; shapeId: string; method: MatchMethod }
  | {
      kind: "slide";
      slideId?: string;
      method: MatchMethod | "index";
      /** Why only the slide was selected, when a shape was wanted. */
      note?: "shape-not-found" | "shape-ambiguous" | "shape-selection-unsupported";
    }
  | { kind: "layout-note"; containerKind: "layout" | "master"; name: string }
  | { kind: "not-navigable" }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

export interface Navigator {
  navigate(target: FindingTarget): Promise<NavigateResult>;
}

export interface NavigatorDeps {
  capabilities: Pick<Capabilities, "supports">;
  run?: PowerPointRunLike;
  document?: GoToDocumentLike;
}

// Office enum values as literals so the module loads without the Office global.
const GOTO_SLIDE = "slide" as unknown as Office.GoToType;
const GOTO_INDEX = "index" as unknown as Office.GoToType;

/** File stem of a part name: `ppt/slideMasters/slideMaster1.xml` → `slideMaster1`. */
function stem(partName: string): string {
  const base = partName.split("/").pop() ?? partName;
  return base.replace(/\.xml$/i, "");
}

/** True when a target can be shown (on a slide) or explained (on a layout/master). */
export function isNavigable(t: FindingTarget): boolean {
  const k = t.container.kind;
  return k === "layout" || k === "master" || t.container.slideId !== undefined;
}

/** The target "Show in PowerPoint" uses for a whole finding: the first navigable one. */
export function primaryTarget(f: Pick<Finding, "targets">): FindingTarget | undefined {
  return f.targets.find((t) => t.container.slideId !== undefined) ?? f.targets.find(isNavigable);
}

function goTo(doc: GoToDocumentLike, id: number, type: Office.GoToType): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      doc.goToByIdAsync(id, type, (r) => resolve(r.status !== "failed"));
    } catch {
      resolve(false);
    }
  });
}

function defaultRun(): PowerPointRunLike | undefined {
  if (typeof PowerPoint === "undefined") return undefined;
  return PowerPoint.run as unknown as PowerPointRunLike;
}

function defaultDocument(): GoToDocumentLike | undefined {
  if (typeof Office === "undefined") return undefined;
  return Office.context?.document as unknown as GoToDocumentLike | undefined;
}

export function createNavigator(deps: NavigatorDeps): Navigator {
  const { capabilities } = deps;

  async function slideOnly(target: FindingTarget): Promise<NavigateResult> {
    const doc = deps.document ?? defaultDocument();
    const c = target.container;
    if (!doc || c.slideId === undefined) return { kind: "not-found" };
    if (await goTo(doc, c.slideId, GOTO_SLIDE)) {
      return { kind: "slide", method: "exact", note: "shape-selection-unsupported" };
    }
    if (c.slideIndex !== undefined && (await goTo(doc, c.slideIndex + 1, GOTO_INDEX))) {
      return { kind: "slide", method: "index", note: "shape-selection-unsupported" };
    }
    return { kind: "not-found" };
  }

  async function select(target: FindingTarget, run: PowerPointRunLike): Promise<NavigateResult> {
    const c = target.container;
    const slideId = c.slideId!;
    return run(async (ctx) => {
      const slides = ctx.presentation.slides;
      slides.load("items/id");
      await ctx.sync();
      const sr = resolveSlide({ slideId, ...(c.slideIndex !== undefined ? { index: c.slideIndex } : {}) }, slides.items);
      if (sr.status !== "matched") return { kind: "not-found" } as const;
      const slide = sr.item;
      ctx.presentation.setSelectedSlides([slide.id]);

      // Only slide shape-tree targets can be selected as shapes.
      const wantShape = c.kind === "slide" && target.shapeId !== undefined;
      if (!wantShape) {
        await ctx.sync();
        return { kind: "slide", slideId: slide.id, method: sr.method } as const;
      }

      slide.shapes.load("items/id,items/name,items/left,items/top");
      await ctx.sync();
      const outer = target.path?.[0];
      const shapeRes =
        outer !== undefined
          ? resolveShape({ shapeId: outer, name: "", left: 0, top: 0 }, slide.shapes.items)
          : resolveShape(
              {
                shapeId: target.shapeId!,
                name: target.shapeName ?? "",
                left: target.bounds ? emuToPoints(target.bounds.x) : Number.NaN,
                top: target.bounds ? emuToPoints(target.bounds.y) : Number.NaN,
              },
              slide.shapes.items,
            );
      if (shapeRes.status !== "matched") {
        await ctx.sync();
        return {
          kind: "slide",
          slideId: slide.id,
          method: sr.method,
          note: shapeRes.status === "ambiguous" ? "shape-ambiguous" : "shape-not-found",
        } as const;
      }
      slide.setSelectedShapes([shapeRes.item.id]);
      await ctx.sync();
      return { kind: "shape", slideId: slide.id, shapeId: shapeRes.item.id, method: shapeRes.method } as const;
    });
  }

  return {
    async navigate(target) {
      const c = target.container;
      if (c.kind === "layout" || c.kind === "master") {
        return { kind: "layout-note", containerKind: c.kind, name: c.name ?? stem(c.partName) };
      }
      if (c.slideId === undefined) return { kind: "not-navigable" };
      try {
        const run = deps.run ?? defaultRun();
        if (capabilities.supports("selectSlides") && run) return await select(target, run);
        return await slideOnly(target);
      } catch (e) {
        return { kind: "error", message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
