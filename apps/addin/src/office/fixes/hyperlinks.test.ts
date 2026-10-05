import { describe, expect, it } from "vitest";
import type { Finding } from "@slidefidelity/audit-core";
import { previewFix, runFix } from "./engine";
import { editHyperlinkKind, removeHyperlinkKind, validateHyperlinkAddress } from "./hyperlinks";
import type { RunFixDeps } from "./types";
import { createFakePowerPoint, hyperlinkFinding, supportsUpTo, target, type FakeDeck } from "./testing/fakePowerPoint";

function deps(fake: ReturnType<typeof createFakePowerPoint>, findings: Finding[], max = "1.10"): RunFixDeps {
  return {
    rescanForFix: async () => ({ changed: false, hash: "h", bytes: new Uint8Array(), result: { findings } }),
    run: fake.run,
    isSetSupported: supportsUpTo(max),
  };
}

async function completed(p: ReturnType<typeof runFix>) {
  const r = await p;
  if (r.status !== "completed") throw new Error(`expected completed, got ${r.status}`);
  return r.summary;
}

const A = "https://a.example/";
const B = "https://b.example/";

function link(address: string, occurrence: number, sameAddressCount: number, shapeId = 5): Finding {
  return hyperlinkFinding(
    address,
    target({ shapeId, reachable: true, locator: { property: "hyperlink", relId: `rId${shapeId}`, hyperlink: { address, occurrence, sameAddressCount } } }),
  );
}

function deck(addresses: string[]): FakeDeck {
  return { slides: [{ id: "256#", shapes: [], hyperlinks: addresses.map((address) => ({ address })) }] };
}

describe("hyperlink fixes", () => {
  it("blocks removal at plan time on a host without PowerPointApi 1.10", async () => {
    const findings = [link(A, 0, 1)];
    const p = previewFix(removeHyperlinkKind, findings, { all: true }, { isSetSupported: supportsUpTo("1.9") });
    expect(p).toMatchObject({ status: "blocked", requiredSet: "1.10" });
    if (p.status === "blocked") expect(p.reason).toMatch(/PowerPointApi 1\.10/);

    const fake = createFakePowerPoint(deck([A]));
    const r = await runFix(removeHyperlinkKind, { all: true }, deps(fake, findings, "1.9"));
    expect(r.status).toBe("blocked");
    expect(fake.writes).toEqual([]);
  });

  it("removes exactly the selected occurrence among same-address links", async () => {
    const d = deck([A, B, A]);
    const [first, , second] = d.slides[0]!.hyperlinks!;
    const findings = [link(A, 0, 2, 5), link(B, 0, 1, 6), link(A, 1, 2, 7)];
    const fake = createFakePowerPoint(d);
    const summary = await completed(runFix(removeHyperlinkKind, { findingIds: [findings[2]!.id] }, deps(fake, findings)));
    expect(summary.changed).toBe(1);
    expect(fake.deck.slides[0]!.hyperlinks).toEqual([first, { address: B }]);
    expect(second!.deleted).toBe(true);
  });

  it("removes every link to the chosen addresses", async () => {
    const findings = [link(A, 0, 2, 5), link(B, 0, 1, 6), link(A, 1, 2, 7)];
    const fake = createFakePowerPoint(deck([A, B, A]));
    const summary = await completed(runFix(removeHyperlinkKind, { addresses: [A] }, deps(fake, findings)));
    expect(summary.changed).toBe(2);
    expect(fake.deck.slides[0]!.hyperlinks!.map((h) => h.address)).toEqual([B]);
  });

  it("skips an ambiguous match (the live slide has a different number of same-address links)", async () => {
    const findings = [link(A, 0, 2, 5), link(A, 1, 2, 7)];
    const fake = createFakePowerPoint(deck([A, A, A]));
    const summary = await completed(runFix(removeHyperlinkKind, { all: true }, deps(fake, findings)));
    expect(summary.changed).toBe(0);
    expect(summary.skipped).toHaveLength(2);
    expect(summary.skipped[0]!.reason).toMatch(/ambiguous/i);
    expect(fake.deck.slides[0]!.hyperlinks).toHaveLength(3);
  });

  it("edits an address on a 1.6 host", async () => {
    const findings = [link(A, 0, 1)];
    const fake = createFakePowerPoint(deck([A, B]));
    const summary = await completed(runFix(editHyperlinkKind, { address: A, newAddress: "https://new.example/x" }, deps(fake, findings, "1.6")));
    expect(summary.changed).toBe(1);
    expect(fake.deck.slides[0]!.hyperlinks!.map((h) => h.address)).toEqual(["https://new.example/x", B]);
  });

  it("rejects unsafe or unsupported new addresses", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://x.example/", "vbscript:x", "https://", "", "not a url", "https://a.example/\u0000"]) {
      expect(validateHyperlinkAddress(bad), bad).not.toBeNull();
      const p = previewFix(editHyperlinkKind, [link(A, 0, 1)], { address: A, newAddress: bad }, { isSetSupported: supportsUpTo("1.10") });
      expect(p.status, bad).toBe("invalid");
    }
    for (const ok of ["https://example.com/a?b=c", "http://example.com", "mailto:someone@example.com", " HTTPS://Example.com "]) {
      expect(validateHyperlinkAddress(ok), ok).toBeNull();
    }
  });

  it("lists hover links and layout links as unreachable", () => {
    const findings = [
      hyperlinkFinding(A, target({ shapeId: 5, reachable: false, locator: { property: "hyperlink", relId: "rId1" } }), "hover"),
      hyperlinkFinding(A, target({ shapeId: 6, reachable: false, containerKind: "layout", locator: { property: "hyperlink", relId: "rId2" } })),
    ];
    const p = previewFix(removeHyperlinkKind, findings, { all: true }, { isSetSupported: supportsUpTo("1.10") });
    if (p.status !== "ready") throw new Error(p.status);
    expect(p.plan.targets).toHaveLength(0);
    expect(p.plan.unreachable.map((u) => u.reason)).toEqual([expect.stringMatching(/mouse-over/i), expect.stringMatching(/layout/i)]);
  });
});
