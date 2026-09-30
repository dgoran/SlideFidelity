import { afterEach, describe, expect, it } from "vitest";
import { all, byText, cleanup, click, one, renderPane } from "../testing/render";
import { fakeFinding, fakeResult } from "../testing/fixtures";
import { deckResult } from "./deck";

afterEach(cleanup);

const count = (root: HTMLElement, area: string, sev: "warning" | "info") =>
  one(root, `[data-area="${area}"] [data-count="${sev}"]`).textContent;

describe("Overview (R1, D7, D10)", () => {
  it("shows warning and info counts for every area, including Pro-locked ones", () => {
    const { container } = renderPane({ result: deckResult(), plan: "anonymous" });
    const areas = all(container, "[data-overview] [data-area]").map((el) => el.getAttribute("data-area"));
    expect(areas).toEqual(["fonts", "colors", "media", "masters", "links", "review"]);
    expect([count(container, "fonts", "warning"), count(container, "fonts", "info")]).toEqual(["2", "1"]);
    expect([count(container, "colors", "warning"), count(container, "colors", "info")]).toEqual(["1", "1"]);
    expect([count(container, "media", "warning"), count(container, "media", "info")]).toEqual(["1", "2"]);
    expect([count(container, "review", "warning"), count(container, "review", "info")]).toEqual(["1", "1"]);
  });

  it("marks fully locked areas with a lock for free plans only", () => {
    const anon = renderPane({ result: deckResult(), plan: "anonymous" });
    const locked = all(anon.container, "[data-area] [data-locked]").map((el) => el.closest("[data-area]")!.getAttribute("data-area"));
    expect(locked).toEqual(["colors", "masters", "links", "review"]);
    anon.unmount();
    const pro = renderPane({ result: deckResult(), plan: "pro" });
    expect(all(pro.container, "[data-locked]")).toHaveLength(0);
  });

  it("shows the file-size headline from the file-size-breakdown finding", () => {
    const { container } = renderPane({ result: deckResult() });
    expect(one(container, "[data-file-size]").textContent).toMatch(/^File size: 5(\.0)? MB$/);
  });

  it("shows 'No issues found' with the items checked when nothing is flagged (D10)", () => {
    const { container } = renderPane({ result: fakeResult([fakeFinding({ area: "fonts", title: "Calibri" })]) });
    const empty = one(container, "[data-empty-state]");
    expect(byText(empty, "No issues found")).toBeTruthy();
    expect(empty.textContent).toContain("Checked 12 slides and 80 shapes");
  });

  it("does not show the empty state when there are warnings", () => {
    const { container } = renderPane({ result: deckResult() });
    expect(container.querySelector("[data-empty-state]")).toBeNull();
  });

  it("clicking an area opens it", () => {
    const { container } = renderPane({ result: deckResult() });
    click(one(container, '[data-overview] [data-area="links"]'));
    expect(one(container, "#results-heading").textContent).toBe("Links");
    expect(container.querySelector('[data-area-view="links"]')).not.toBeNull();
  });
});
