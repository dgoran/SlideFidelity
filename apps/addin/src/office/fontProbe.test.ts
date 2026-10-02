import { describe, expect, it, vi } from "vitest";
import { createFontProbe, type MeasureText } from "./fontProbe";

/** A fake text measurer: each installed family has its own width; anything else falls back. */
function fakeMeasure(installed: Record<string, number>): MeasureText {
  const fallbackWidth: Record<string, number> = { monospace: 100, serif: 90, "sans-serif": 80 };
  return (_text, font) => {
    const families = font.replace(/^\d+px\s+/, "").split(",").map((f) => f.trim().replace(/^"|"$/g, ""));
    for (const family of families) {
      if (family in installed) return installed[family]!;
      if (family in fallbackWidth) return fallbackWidth[family]!;
    }
    return 0;
  };
}

describe("font probe", () => {
  it("detects a family that renders with its own metrics", () => {
    const probe = createFontProbe(fakeMeasure({ Gotham: 123 }));
    expect(probe.probe("Gotham")).toBe("detected");
  });

  it("detects a family whose metrics match one fallback (Arial vs a Helvetica sans-serif default)", () => {
    const probe = createFontProbe(fakeMeasure({ Arial: 80 })); // same width as the sans-serif fallback
    expect(probe.probe("Arial")).toBe("detected");
  });

  it("reports a family that falls back to the generic fonts as not detected", () => {
    const probe = createFontProbe(fakeMeasure({ Gotham: 123 }));
    expect(probe.probe("Segoe UI")).toBe("not-detected");
  });

  it("is case-insensitive, trims, and caches results", () => {
    const measure = vi.fn(fakeMeasure({ Gotham: 123 }));
    const probe = createFontProbe(measure);
    expect(probe.probe(" gotham ")).toBe("not-detected"); // family names are matched by the engine, not by us
    const calls = measure.mock.calls.length;
    expect(probe.probe("GOTHAM")).toBe("not-detected");
    expect(measure.mock.calls.length).toBe(calls);
  });

  it("strips quotes and backslashes from family names before building the CSS font string", () => {
    const measure = vi.fn(fakeMeasure({}));
    createFontProbe(measure).probe('Evil", 72px x\\');
    expect(measure.mock.calls.some(([, font]) => font.includes('"Evil, 72px x"'))).toBe(true);
  });

  it("returns unavailable without a measurer or for an empty name", () => {
    expect(createFontProbe(null).probe("Arial")).toBe("unavailable");
    expect(createFontProbe(fakeMeasure({})).probe("  ")).toBe("unavailable");
  });
});
