/**
 * Problems view (G1): the show-readiness checklist shown first after a scan.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditResult, Finding } from "@slidecheck/audit-core";
import { createFakePowerPoint, fontUsageFinding, shapeReviewFinding, target } from "../../office/fixes/testing/fakePowerPoint";
import { createFixSlots } from "../fixes";
import { fakeFinding, fakeResult, slideShape } from "../testing/fixtures";
import {
  fileSize,
  fontMaybeMissing,
  fontSummary,
  imageIssue,
  mediaFinding,
  mediaSize,
  offSlide,
  partlyOff,
  textCollision,
} from "../testing/problemFindings";
import { all, button, cleanup, click, flush, one, renderPane } from "../testing/render";

afterEach(cleanup);

function problemDeck(): AuditResult {
  return fakeResult([
    fakeFinding({ area: "fonts", kind: "font-usage", title: "Calibri", data: { typeface: "Calibri" } }),
    mediaFinding("media-missing", { title: "Video 'Intro' on slide 2 is missing from the file" }),
    mediaFinding("media-poster-missing", { title: "Video 'Intro' on slide 2 has no preview image" }),
    fontMaybeMissing("MS Gothic", [slideShape(3, 5, "Title")]),
    fontSummary(false, 1),
    offSlide(4),
    partlyOff(5, "info"),
    textCollision(6),
    textCollision(7, "info"),
    textCollision(8, "info"),
    fileSize(12 * 1024 * 1024, 10 * 1024 * 1024),
    mediaSize("ppt/media/media1.mp4", 8 * 1024 * 1024, "video"),
  ]);
}

const category = (root: ParentNode, id: string) => one(root, `[data-category="${id}"]`);
const toggleOf = (root: ParentNode, id: string) => one(category(root, id), "[data-category-toggle]") as HTMLButtonElement;

describe("Problems view (G1)", () => {
  it("is the default view after a scan, with focus on the headline (D15)", async () => {
    const { container, scan } = renderPane();
    click(button(container, "Scan"));
    await act(async () => scan.resolve(problemDeck()));
    await flush();
    expect(container.querySelector("[data-problems]")).not.toBeNull();
    const headline = one(container, "#results-heading");
    expect(headline.textContent).toBe("4 problems to fix");
    expect(document.activeElement).toBe(headline);
    const picker = one(container, "select[data-area-picker]") as HTMLSelectElement;
    expect(picker.value).toBe("problems");
    expect(picker.options[0]!.textContent).toBe("Problems (4 to fix)");
    expect(picker.options[1]!.textContent).toBe("Overview");
  });

  it("renders the five categories with status by icon shape and text, and counts", () => {
    const { container } = renderPane({ result: problemDeck() });
    const list = one(container, '[data-problems] ul[aria-label="Show readiness checklist"]');
    const items = all(list, ":scope > li");
    expect(items.map((li) => li.getAttribute("data-category"))).toEqual(["playback", "fonts", "off-slide", "text-collision", "size"]);
    expect(items.map((li) => li.getAttribute("data-status"))).toEqual(["warning", "warning", "warning", "warning", "pass"]);
    expect(one(category(container, "playback"), "[data-category-count]").textContent).toBe("1 problem · 1 note");
    expect(one(category(container, "text-collision"), "[data-category-count]").textContent).toBe("1 problem · 2 notes");
    // Pass: a check icon and text, not color alone.
    const size = category(container, "size");
    expect(one(size, "[data-status-icon]").getAttribute("data-status-icon")).toBe("check");
    expect(one(size, "[data-status-icon]").getAttribute("aria-label")).toBe("Passed");
    expect(one(size, "[data-category-count]").textContent).toBe("No problems");
    expect(one(category(container, "fonts"), "[data-status-icon]").getAttribute("data-status-icon")).toBe("flag");
    // File size headline stays visible on the size row.
    expect(one(size, "[data-size-headline]").textContent).toMatch(/^File size 12(\.0)? MB/);
  });

  it("a clean deck reads 'Ready for show' with every category passed", () => {
    const { container } = renderPane({ result: fakeResult([fontSummary(true)]) });
    expect(one(container, "#results-heading").textContent).toBe("Ready for show");
    expect(all(container, "[data-category]").every((li) => li.getAttribute("data-status") === "pass")).toBe(true);
  });

  it("expands and collapses a category; warnings first; infos of text collisions under 'Possibly intentional'", () => {
    const { container } = renderPane({ result: problemDeck() });
    const t = toggleOf(container, "text-collision");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(category(container, "text-collision").querySelector("[data-problem]")).toBeNull();
    click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(t.getAttribute("aria-controls")!)!;
    expect(all(region, "[data-problem]").map((el) => el.getAttribute("data-severity"))).toEqual(["warning"]);
    const more = button(region, "Possibly intentional (2)");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    click(more);
    expect(all(region, "[data-problem]")).toHaveLength(3);
    click(t);
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(category(container, "text-collision").querySelector("[data-problem]")).toBeNull();

    // Off-slide: warning listed before the note.
    click(toggleOf(container, "off-slide"));
    expect(all(category(container, "off-slide"), "[data-problem]").map((el) => el.getAttribute("data-severity"))).toEqual(["warning", "info"]);
  });

  it("is keyboard operable: the toggles are native, focusable buttons in a list", () => {
    const { container } = renderPane({ result: problemDeck() });
    const t = toggleOf(container, "playback");
    expect(t.tagName).toBe("BUTTON");
    expect(t.getAttribute("type")).toBe("button");
    expect(t.tabIndex).toBe(0);
    click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    const items = all(category(container, "playback"), "li[data-problem]");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("is missing from the file"),
      expect.stringContaining("has no preview image"),
    ]);
  });

  it("Show in PowerPoint navigates to the finding through navigateFromPane and announces the result", async () => {
    const { container, navigate } = renderPane({ result: problemDeck(), navigate: async () => ({ kind: "shape", slideId: "259#", shapeId: "8", method: "exact" }) });
    click(toggleOf(container, "off-slide"));
    const first = all(category(container, "off-slide"), "[data-problem]")[0]!;
    click(button(first, "Show in PowerPoint"));
    await flush();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]![0]).toMatchObject({ shapeId: 8, container: { slideNumber: 4 } });
    expect(one(container, "[data-problems] [role=status]").textContent).toBe("Selected Slide 4 · Far.");
  });

  it("free plan: headline and counts are visible, details are locked", () => {
    const { container } = renderPane({ result: problemDeck(), plan: "anonymous" });
    expect(one(container, "#results-heading").textContent).toBe("4 problems to fix");
    expect(one(category(container, "fonts"), "[data-category-count]").textContent).toBe("1 problem");
    click(toggleOf(container, "fonts"));
    const fonts = category(container, "fonts");
    expect(fonts.querySelector("[data-problem]")).toBeNull();
    expect(fonts.textContent).not.toContain("MS Gothic");
    const locked = one(fonts, "[data-locked-section]");
    expect(locked.getAttribute("aria-label")).toBe("Font details (Pro)");
    expect(locked.textContent).toContain("1 warnings and 0 information items.");
    expect(one(locked, "[data-lock-action]").textContent).toBe("Sign in to start your 30-day free trial");
    click(toggleOf(container, "playback"));
    expect(category(container, "playback").querySelector("[data-problem]")).toBeNull();
    expect(category(container, "playback").querySelector("[data-locked-section]")).not.toBeNull();
  });

  it("fonts: says when no show-machine font list is set and opens the setting", () => {
    const { container } = renderPane({
      result: problemDeck(),
      slots: { showFontsSlot: ({ placement }) => <div data-testid="show-fonts">{placement}</div> },
    });
    click(toggleOf(container, "fonts"));
    const fonts = category(container, "fonts");
    expect(one(fonts, "[data-show-fonts-hint]").textContent).toContain("No show-machine font list set — set one to reduce false alarms");
    const open = button(fonts, "Set show-machine fonts");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(one(fonts, '[data-testid="show-fonts"]').textContent).toBe("problems");
  });

  it("fonts: no hint when a show-machine list was used", () => {
    const result = fakeResult([fontMaybeMissing("MS Gothic", [slideShape(1, 2)]), fontSummary(true, 1)]);
    const { container } = renderPane({ result, slots: { showFontsSlot: () => <div data-testid="show-fonts" /> } });
    click(toggleOf(container, "fonts"));
    expect(category(container, "fonts").querySelector("[data-show-fonts-hint]")).toBeNull();
    expect(button(category(container, "fonts"), "Edit show-machine fonts")).toBeTruthy();
  });

  it("size: image issues and the largest media", () => {
    const result = fakeResult([
      fileSize(40 * 1024 * 1024, 30 * 1024 * 1024),
      mediaSize("ppt/media/image1.png", 20 * 1024 * 1024),
      mediaSize("ppt/media/media2.mp4", 9 * 1024 * 1024, "video"),
      imageIssue("oversized"),
    ]);
    const { container } = renderPane({ result });
    click(toggleOf(container, "size"));
    const size = category(container, "size");
    expect(size.getAttribute("data-status")).toBe("warning");
    expect(all(size, "[data-problem]")).toHaveLength(1);
    const largest = all(size, "[data-largest-media] li").map((li) => li.textContent);
    expect(largest).toEqual(["image1.png: 20.0 MB", "media2.mp4: 9.0 MB"]);
  });

  it("renders untrusted names, paths, and URLs as text only", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const result = fakeResult([
      mediaFinding("media-online", { title: `Video '${evil}' streams from https://evil.example/${evil}` }),
      fontMaybeMissing(evil, [slideShape(1, 2)]),
      mediaSize(`ppt/media/${evil}.mp4`, 1000, "video"),
    ]);
    const { container } = renderPane({ result });
    for (const id of ["playback", "fonts", "size"]) click(toggleOf(container, id));
    expect(container.querySelector("[data-problems] img")).toBeNull();
    expect(container.querySelector("[data-problems] a[href]")).toBeNull();
    expect(container.textContent).toContain(evil);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Replace missing fonts (G3)", () => {
  const textLoc = { property: "text" as const, paragraphIndex: 0, runIndex: 0, script: "latin" as const };

  function fontsDeck(): AuditResult {
    const gothicT = target({ slideNumber: 1, shapeId: 10, shapeName: "Title", reachable: true, locator: textLoc });
    const segoeT = target({ slideNumber: 2, shapeId: 11, shapeName: "Chart", containerKind: "chart", reachable: false, locator: { script: "latin" } });
    const narrowT = target({ slideNumber: 3, shapeId: 12, shapeName: "Body", reachable: true, locator: textLoc });
    const calibriT = target({ slideNumber: 1, shapeId: 13, shapeName: "Sub", reachable: true, locator: textLoc });
    const findings: Finding[] = [
      fontUsageFinding("MS Gothic", [{ target: gothicT }]),
      fontUsageFinding("Segoe UI", [{ target: segoeT }]),
      fontUsageFinding("Arial Narrow", [{ target: narrowT }]),
      fontUsageFinding("Calibri", [{ target: calibriT }]),
      fontMaybeMissing("MS Gothic", [gothicT]),
      fontMaybeMissing("Segoe UI", [segoeT]),
      fontMaybeMissing("Arial Narrow", [narrowT]),
      fontSummary(false, 3),
    ];
    return fakeResult(findings);
  }

  function checkbox(root: ParentNode, text: string): HTMLInputElement {
    const label = all(root, "label").find((l) => (l.textContent ?? "").trim() === text);
    if (!label) throw new Error(`no label ${text}`);
    return document.getElementById((label as HTMLLabelElement).htmlFor) as HTMLInputElement;
  }

  const slots = () => createFixSlots({ run: createFakePowerPoint({ slides: [] }).run, createPresentation: async () => {} });

  it("opens the replace-font picker pre-selected with the reachable missing fonts only", () => {
    const { container } = renderPane({ result: fontsDeck(), slots: slots() });
    click(toggleOf(container, "fonts"));
    const fonts = category(container, "fonts");
    click(button(fonts, "Replace missing fonts…"));
    const panel = one(fonts, "[data-fix-panel]");
    expect(checkbox(panel, "MS Gothic").checked).toBe(true);
    expect(checkbox(panel, "Arial Narrow").checked).toBe(true);
    expect(checkbox(panel, "Segoe UI").checked).toBe(false);
    expect(checkbox(panel, "Calibri").checked).toBe(false);
    // The target never defaults to another missing font.
    const select = panel.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("deck:Calibri");
    expect(document.activeElement?.textContent).toBe("Replace fonts");
  });

  it("is not offered without the fixes feature", () => {
    const { container } = renderPane({ result: fontsDeck(), slots: slots(), plan: "free" });
    click(toggleOf(container, "fonts"));
    expect(all(category(container, "fonts"), "button").some((b) => b.textContent === "Replace missing fonts…")).toBe(false);
  });

  it("is disabled when no missing font can be changed in place", () => {
    const segoeT = target({ slideNumber: 2, shapeId: 11, containerKind: "chart", reachable: false, locator: { script: "latin" } });
    const result = fakeResult([fontUsageFinding("Segoe UI", [{ target: segoeT }]), fontMaybeMissing("Segoe UI", [segoeT])]);
    const { container } = renderPane({ result, slots: slots() });
    click(toggleOf(container, "fonts"));
    expect(button(category(container, "fonts"), "Replace missing fonts…").disabled).toBe(true);
  });

  it("a row's Replace font action preselects that missing font", () => {
    const { container } = renderPane({ result: fontsDeck(), slots: slots() });
    click(toggleOf(container, "fonts"));
    const fonts = category(container, "fonts");
    const row = all(fonts, "[data-problem]").find((el) => el.textContent?.includes("Arial Narrow"))!;
    click(one(row, "[data-row-fix]"));
    const panel = one(fonts, "[data-fix-panel]");
    expect(checkbox(panel, "Arial Narrow").checked).toBe(true);
    expect(checkbox(panel, "MS Gothic").checked).toBe(false);
  });
});

describe("fixes inside a category", () => {
  it("an off-slide shape's Delete action opens its picker inside the Off-slide category", () => {
    const shape = shapeReviewFinding("off-slide-shape", target({ slideNumber: 2, shapeId: 30, shapeName: "Far away", reachable: true }));
    const { container } = renderPane({
      result: fakeResult([shape]),
      slots: createFixSlots({ run: createFakePowerPoint({ slides: [] }).run, createPresentation: async () => {} }),
    });
    click(toggleOf(container, "off-slide"));
    const off = category(container, "off-slide");
    expect(off.querySelector("[data-fix-panel]")).toBeNull();
    click(one(off, "[data-row-fix]"));
    const panel = one(off, "[data-fix-panel]");
    expect(panel.getAttribute("data-fix-panel")).toBe("review");
    expect(panel.textContent).toContain("Delete shapes");
  });
});
