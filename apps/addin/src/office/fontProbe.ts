/**
 * Detects whether a font family is available to the task pane's web view by measuring text.
 * Text set in `"Family", <fallback>` is compared with text set in `<fallback>` alone, for three
 * different fallbacks. If the width differs from every fallback, the family rendered, so it is
 * available. If it matches any fallback, it was not found (or happens to share that metric).
 *
 * Limits (measured, see docs/notes/office-js-platform-behavior.md): the web view's font list is
 * not PowerPoint's. Fonts that ship inside Office are invisible here, and the host may hide
 * user-installed fonts. Treat "not detected" as a hint, never as proof.
 */

export type MeasureText = (text: string, font: string) => number;

export type ProbeResult = "detected" | "not-detected" | "unavailable";

const SAMPLE = "mmmmmmmmmmlliWW@#0123456789 The quick brown fox";
const SIZE_PX = 72;
const FALLBACKS = ["monospace", "serif", "sans-serif"] as const;

/** Canvas-based measurement in the page; null where no 2D canvas exists (tests, some hosts). */
export function canvasMeasure(doc: Document = document): MeasureText | null {
  try {
    const ctx = doc.createElement("canvas").getContext("2d");
    if (!ctx || typeof ctx.measureText !== "function") return null;
    return (text, font) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
  } catch {
    return null;
  }
}

function quoteFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "")}"`;
}

export function createFontProbe(measure: MeasureText | null) {
  const baseline = new Map<string, number>();
  const cache = new Map<string, ProbeResult>();
  const base = (fallback: string): number => {
    let w = baseline.get(fallback);
    if (w === undefined) {
      w = measure!(SAMPLE, `${SIZE_PX}px ${fallback}`);
      baseline.set(fallback, w);
    }
    return w;
  };

  return {
    probe(family: string): ProbeResult {
      const key = family.trim().toLowerCase();
      if (!key || !measure) return "unavailable";
      const hit = cache.get(key);
      if (hit) return hit;
      // Detected when the family changes the width against at least one fallback. A missing family
      // matches all three; a present one can still match one fallback by design (Arial has the
      // same metrics as Helvetica, the usual sans-serif default).
      let result: ProbeResult = "not-detected";
      for (const fallback of FALLBACKS) {
        const width = measure(SAMPLE, `${SIZE_PX}px ${quoteFamily(family.trim())}, ${fallback}`);
        if (Math.abs(width - base(fallback)) >= 0.01) {
          result = "detected";
          break;
        }
      }
      cache.set(key, result);
      return result;
    },
  };
}

export type FontProbe = ReturnType<typeof createFontProbe>;
