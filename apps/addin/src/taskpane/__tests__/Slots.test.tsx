import { afterEach, describe, expect, it } from "vitest";
import { CapabilityButton } from "../components/CapabilityButton";
import { cleanup, one, renderPane } from "../testing/render";
import { deckResult } from "./deck";

afterEach(cleanup);

describe("extension points", () => {
  it("renders the inspector, account, fix panel, brand, and row-action slots", () => {
    const { container } = renderPane({
      result: deckResult(),
      state: { area: "fonts" },
      slots: {
        inspectorSlot: <div data-testid="inspector" />,
        accountSlot: <div data-testid="account" />,
        fixPanelSlot: ({ area, findings }) => <div data-testid="fix-panel">{`${area}:${findings.length}`}</div>,
        brandSlot: ({ area }) => <div data-testid="brand">{area}</div>,
        renderRowActions: (f, ctx) => <button tabIndex={ctx.tabIndex} data-testid="row-action">{f.title}</button>,
      },
    });
    expect(container.querySelector('[data-testid="inspector"]')).not.toBeNull();
    expect(container.querySelector('header [data-testid="account"]')).not.toBeNull();
    expect(one(container, '[data-testid="fix-panel"]').textContent).toBe("fonts:3");
    expect(one(container, '[data-testid="brand"]').textContent).toBe("fonts");
    expect(container.querySelectorAll('[role="treeitem"] [data-testid="row-action"]').length).toBeGreaterThan(0);
  });
});

describe("capability-gated actions (AE4, R17)", () => {
  it("on a PowerPointApi 1.8 host, Remove link is disabled with the upgrade note", () => {
    const { container } = renderPane({
      api: "1.8",
      result: deckResult(),
      state: { area: "links" },
      slots: { fixPanelSlot: () => <CapabilityButton feature="hyperlinkRemove">Remove link</CapabilityButton> },
    });
    // Links are still listed.
    expect(container.textContent).toContain("Web link");
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Remove link")!;
    expect(btn.disabled).toBe(true);
    const note = document.getElementById(btn.getAttribute("aria-describedby")!);
    expect(note?.textContent).toBe("Requires a newer version of PowerPoint (PowerPointApi 1.10)");
  });

  it("on a 1.10 host the same action is enabled", () => {
    const { container } = renderPane({
      api: "1.10",
      result: deckResult(),
      state: { area: "links" },
      slots: { fixPanelSlot: () => <CapabilityButton feature="hyperlinkRemove">Remove link</CapabilityButton> },
    });
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Remove link")!;
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute("aria-describedby")).toBe(false);
  });
});
