import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AuditClientError } from "../../worker/client";
import { ScanError } from "../../office/scan";
import { all, button, cleanup, click, flush, one, renderPane } from "../testing/render";
import { deckResult } from "./deck";

afterEach(cleanup);

describe("scan lifecycle in the pane (D10, D15)", () => {
  it("starts not scanned with a Scan button and an explanation; no auto-scan", () => {
    const { container, scan } = renderPane();
    expect(one(container, "[data-scan-status]").textContent).toBe("Not scanned yet");
    expect(button(container, "Scan")).toBeTruthy();
    expect(container.textContent).toContain("never uploaded");
    expect(scan.calls()).toBe(0);
  });

  it("shows per-area progress, then results, and moves focus to the results heading", async () => {
    const { container, scan } = renderPane();
    click(button(container, "Scan"));
    expect(container.querySelector("[data-scan-progress]")).not.toBeNull();
    expect(button(container, "Scan").disabled).toBe(true);
    scan.progress({ area: "overview", completed: 1, total: 7 });
    scan.progress({ area: "fonts", completed: 2, total: 7 });
    expect(one(container, '[data-area="fonts"]').getAttribute("data-state")).toBe("done");
    expect(one(container, '[data-area="colors"]').getAttribute("data-state")).toBe("pending");
    expect(container.textContent).toContain("Checking 2 of 7 areas");
    await act(async () => scan.resolve(deckResult()));
    await flush();
    // G1: the Problems checklist opens first; its headline is the results heading.
    expect(container.querySelector("[data-problems]")).not.toBeNull();
    expect(document.activeElement?.id).toBe("results-heading");
    expect(button(container, "Rescan")).toBeTruthy();
  });

  it("Cancel returns to the not-scanned state", async () => {
    const { container } = renderPane();
    click(button(container, "Scan"));
    click(button(container, "Cancel"));
    await flush();
    expect(container.querySelector("[data-scan-progress]")).toBeNull();
    expect(one(container, "[data-scan-status]").textContent).toBe("Not scanned yet");
  });

  it("Cancel during a rescan keeps the previous results", async () => {
    const { container } = renderPane({ result: deckResult() });
    click(button(container, "Rescan"));
    click(button(container, "Cancel"));
    await flush();
    expect(container.querySelector("[data-problems]")).not.toBeNull();
  });

  it.each([
    [new ScanError("read-failed", "x"), false, "SlideCheck couldn't read the presentation"],
    [new ScanError("read-failed", "x"), true, "Waiting for PowerPoint to save"],
    [new ScanError("empty", "x"), false, "This presentation is empty"],
    [new AuditClientError("not-a-pptx", "x"), false, "This file can't be scanned"],
    [new AuditClientError("worker-crashed", "x"), false, "The scan stopped unexpectedly"],
    [new Error("boom"), false, "Something went wrong"],
  ])("failure %s (web=%s) shows a plain message and focuses it", async (err, isWeb, title) => {
    const { container, scan } = renderPane({ isWeb });
    click(button(container, "Scan"));
    await act(async () => scan.reject(err));
    await flush();
    const heading = one(container, '[role="alert"] h2');
    expect(heading.textContent).toBe(title);
    expect(document.activeElement).toBe(heading);
    expect(one(container, "[data-scan-status]").textContent).toBe("Scan failed");
  });

  it("Retry starts a new scan that can succeed", async () => {
    const { container, scan } = renderPane();
    click(button(container, "Scan"));
    await act(async () => scan.reject(new ScanError("read-failed", "x")));
    await flush();
    click(button(container, "Retry"));
    expect(scan.calls()).toBe(2);
    await act(async () => scan.resolve(deckResult()));
    await flush();
    expect(container.querySelector("[data-problems]")).not.toBeNull();
    expect(all(container, '[role="alert"]')).toHaveLength(0);
  });

  it("the area picker switches areas and labels counts", () => {
    const { container } = renderPane({ result: deckResult(), plan: "anonymous" });
    const picker = one(container, "select[data-area-picker]") as HTMLSelectElement;
    const labels = Array.from(picker.options).map((o) => o.textContent);
    expect(labels).toHaveLength(8);
    expect(labels[0]).toBe("Problems (1 to fix)");
    expect(labels[1]).toBe("Overview");
    expect(labels[3]).toBe("Colors (1 warning, 1 info) - Pro");
  });
});
