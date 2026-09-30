import { describe, expect, it } from "vitest";
import { runChecks } from "../src/index";
import { buildDeck, para, pic, run, sp, type SlideSpec } from "./helpers/buildDeck";
import { jpegBytes } from "./helpers/media";

// Success criterion: a 100-slide, 50 MB deck scans in under 10 s. Opt-in because it builds a 50 MB
// package in memory: PERF=1 npx vitest run test/perf.test.ts
const enabled = process.env.PERF === "1";

describe.skipIf(!enabled)("scan performance", () => {
  it("scans a 100-slide, ~50 MB deck within the budget", async () => {
    const media: Record<string, Uint8Array> = {};
    for (let i = 1; i <= 50; i++) media[`image${i}.jpeg`] = jpegBytes(4000, 3000, 1_000_000, i);
    const slides: SlideSpec[] = [];
    for (let s = 0; s < 100; s++) {
      let shapes = "";
      for (let k = 0; k < 12; k++) {
        const runs = run(`Slide ${s} shape ${k} `, { attrs: 'lang="en-US"', inner: '<a:latin typeface="Arial"/>' }) +
          run("emphasis", { attrs: 'b="1"', inner: '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>' });
        shapes += sp({ id: 10 + k, name: `TextBox ${k}`, x: 100000 * k, y: 200000, cx: 900000, cy: 300000, paragraphs: para(runs) + para(runs) });
      }
      shapes += pic({ id: 99, name: "Picture", embed: "rIdImg", x: 0, y: 0, cx: 1828800, cy: 1371600 });
      slides.push({ shapes, rels: [{ id: "rIdImg", type: "image", target: `../media/image${(s % 50) + 1}.jpeg` }] });
    }
    const bytes = await buildDeck({ slides, media });
    expect(bytes.byteLength).toBeGreaterThan(45_000_000);

    const t0 = performance.now();
    const result = await runChecks(bytes);
    const ms = performance.now() - t0;
    console.log(`scan: ${(bytes.byteLength / 1e6).toFixed(1)} MB, ${result.stats.slides} slides, ${result.stats.shapes} shapes, ${result.findings.length} findings in ${ms.toFixed(0)} ms`);
    expect(result.errors).toEqual([]);
    expect(ms).toBeLessThan(10_000);
  }, 120_000);
});
