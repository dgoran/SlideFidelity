import { afterEach, describe, expect, it, vi } from "vitest";
import { all, cleanup, click, one, renderPane } from "../testing/render";
import { deckResult } from "./deck";

afterEach(cleanup);

const titles = (root: HTMLElement) => all(root, '[role="treeitem"][aria-level="2"]').map((r) => r.textContent ?? "");

describe("gated areas (D8, D13, AE5)", () => {
  it("anonymous: a Pro area shows the sign-in-to-trial CTA and no findings", () => {
    const onSignIn = vi.fn();
    const { container } = renderPane({ result: deckResult(), plan: "anonymous", onSignIn, state: { area: "colors" } });
    expect(container.querySelector('[role="tree"]')).toBeNull();
    const cta = one(container, "[data-locked-section] button");
    expect(cta.textContent).toBe("Sign in to start your 30-day free trial");
    expect(one(container, "[data-locked-section]").textContent).toContain("1 warnings and 1 information items");
    click(cta);
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it.each(["free", "expired"] as const)("%s: the CTA is Manage subscription", (plan) => {
    const onManageSubscription = vi.fn();
    const { container } = renderPane({ result: deckResult(), plan, onManageSubscription, state: { area: "links" } });
    const cta = one(container, "[data-locked-section] button");
    expect(cta.textContent).toBe("Manage subscription");
    click(cta);
    expect(onManageSubscription).toHaveBeenCalledTimes(1);
  });

  it("free Fonts: the font list is visible and the flags are an inline locked section", () => {
    const { container } = renderPane({ result: deckResult(), plan: "free", state: { area: "fonts" } });
    const shown = titles(container).join("|");
    expect(shown).toContain("Calibri");
    expect(shown).toContain("Comic Sans MS");
    expect(shown).not.toContain("Hidden list style");
    expect(one(container, "[data-locked-section]").textContent).toContain("Font flags (Pro)");
  });

  it("free Media: the size list is visible, image issues are locked", () => {
    const { container } = renderPane({ result: deckResult(), plan: "free", state: { area: "media" } });
    const shown = titles(container).join("|");
    expect(shown).toContain("image1.png");
    expect(shown).not.toContain("Oversized");
    expect(one(container, "[data-locked-section]").textContent).toContain("Image issues (Pro)");
  });

  it.each(["trial", "pro"] as const)("%s: nothing is locked", (plan) => {
    const { container } = renderPane({ result: deckResult(), plan, state: { area: "fonts" } });
    expect(container.querySelector("[data-locked-section]")).toBeNull();
    expect(titles(container).join("|")).toContain("Hidden list style");
  });
});
