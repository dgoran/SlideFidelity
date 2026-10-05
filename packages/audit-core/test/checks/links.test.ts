import { describe, expect, it } from "vitest";
import { classifyAddress, linkChecks } from "../../src/checks/links";
import { loadPresentation, type Finding, type FindingOf } from "../../src/index";
import { corpusDeck, SEEDS } from "../helpers/corpus";
import { mutateDeck } from "../helpers/mutateDeck";
import { BACKGROUND_XML, DUPLICATE_URL, duplicateLinksDeck, RISKY, riskyLinksDeck } from "./links.fixtures";

async function scan(bytes: Uint8Array): Promise<Finding[]> {
  const pres = await loadPresentation(bytes);
  const out: Finding[] = [];
  for (const check of linkChecks) out.push(...(await check.run({ pres, options: {} })));
  return out;
}

const hyperlinks = (fs: Finding[]): FindingOf<"hyperlink">[] =>
  fs.filter((f): f is FindingOf<"hyperlink"> => f.kind === "hyperlink");
const linkedFiles = (fs: Finding[]): FindingOf<"linked-file">[] =>
  fs.filter((f): f is FindingOf<"linked-file"> => f.kind === "linked-file");
const localPaths = (fs: Finding[]): FindingOf<"local-path-link">[] =>
  fs.filter((f): f is FindingOf<"local-path-link"> => f.kind === "local-path-link");
const unsafe = (fs: Finding[]): FindingOf<"unsafe-link-scheme">[] =>
  fs.filter((f): f is FindingOf<"unsafe-link-scheme"> => f.kind === "unsafe-link-scheme");

describe("linkChecks registration", () => {
  it("exports link-area checks", () => {
    expect(linkChecks.length).toBeGreaterThan(0);
    for (const c of linkChecks) expect(c.area).toBe("links");
  });
});

describe("links corpus deck", () => {
  it("lists the 3 web hyperlinks on the right slides, the layout link, and the linked Excel OLE", async () => {
    const fs = await scan(await corpusDeck("links"));
    const seeds = SEEDS.links;

    const slideLinks = hyperlinks(fs).filter((f) => f.targets[0]!.container.kind === "slide");
    expect(slideLinks.map((f) => ({ slide: f.targets[0]!.container.slideNumber, url: f.data.address }))).toEqual(
      seeds.webHyperlinks.map((w) => ({ slide: w.slide, url: w.url })),
    );
    for (const f of slideLinks) {
      expect(f.severity).toBe("info");
      expect(f.area).toBe("links");
      expect(f.group).toBe(f.data.address);
      expect(f.data.checkable).toBe(true);
      expect(f.fixes).toEqual(["edit-hyperlink", "remove-hyperlink"]);
      expect(f.reachable).toBe(true);
      expect(f.targets[0]!.reachable).toBe(true);
      expect(f.targets[0]!.locator?.property).toBe("hyperlink");
      expect(f.targets[0]!.locator?.hyperlink).toEqual({ address: f.data.address, occurrence: 0, sameAddressCount: 1 });
    }
    // Text-run link vs shape-level (cNvPr) link on slide 1.
    const [a, b] = slideLinks;
    expect(a!.targets[0]).toMatchObject({ shapeId: 2, shapeName: "Text links", locator: { paragraphIndex: 0, runIndex: 0, relId: "rIdH1" } });
    expect(a!.data).toMatchObject({ location: "text", trigger: "click", text: "Site A" });
    expect(b!.targets[0]).toMatchObject({ shapeId: 3, shapeName: "Shape link", locator: { relId: "rIdH2" } });
    expect(b!.targets[0]!.locator?.paragraphIndex).toBeUndefined();
    expect(b!.data.location).toBe("shape");

    const layoutLinks = hyperlinks(fs).filter((f) => f.targets[0]!.container.kind === "layout");
    expect(layoutLinks).toHaveLength(1);
    const ll = layoutLinks[0]!;
    expect(ll.data.address).toBe(seeds.layoutLink.url);
    expect(ll.targets[0]!.container).toMatchObject({ kind: "layout", partName: seeds.layoutLink.layout, name: "Title and Content" });
    expect(ll.reachable).toBe(false);
    expect(ll.targets[0]!.reachable).toBe(false);
    expect(ll.targets[0]!.locator?.hyperlink).toBeUndefined();

    const files = linkedFiles(fs);
    expect(files).toHaveLength(1);
    const ole = files[0]!;
    expect(ole.severity).toBe("warning");
    expect(ole.fixes).toEqual([]);
    expect(ole.data).toMatchObject({ target: seeds.linkedOle.target, linkType: "ole", progId: "Excel.Sheet.12", relId: "rIdOle" });
    expect(ole.targets[0]).toMatchObject({ container: { kind: "slide", slideNumber: seeds.linkedOle.slide }, shapeId: 3, shapeName: "Linked Worksheet" });

    expect(hyperlinks(fs)).toHaveLength(4);
  });

  it("flags the file:///C:/ OLE target as a local file path warning", async () => {
    const fs = await scan(await corpusDeck("links"));
    const lp = localPaths(fs);
    expect(lp).toHaveLength(1);
    expect(lp[0]!.severity).toBe("warning");
    expect(lp[0]!.title.toLowerCase()).toContain("local file path");
    expect(lp[0]!.data).toMatchObject({ address: SEEDS.links.linkedOle.target, pathKind: "file-url", linkKind: "linked-file" });
    expect(lp[0]!.fixes).toEqual([]);
  });

  it("excludes the internal slide jump", async () => {
    const fs = await scan(await corpusDeck("links"));
    for (const f of fs) {
      for (const t of f.targets) expect(t.locator?.relId).not.toBe(SEEDS.links.internalJump.relId);
    }
    expect(JSON.stringify(fs)).not.toContain("ppaction");
    expect(fs.every((f) => f.group !== "slide1.xml")).toBe(true);
    expect(fs.filter((f) => f.targets[0]!.container.slideNumber === 2 && f.kind === "hyperlink")).toHaveLength(1);
  });

  it("produces structured-clone safe, deterministic findings", async () => {
    const bytes = await corpusDeck("links");
    const a = await scan(bytes);
    const b = await scan(bytes);
    expect(structuredClone(a)).toEqual(a);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
    for (const f of a) expect(f.severity).not.toBe("error");
  });
});

describe("hyperlink occurrence keys", () => {
  it("gives the same URL twice on one slide occurrences 0 and 1 with sameAddressCount 2", async () => {
    const fs = hyperlinks(await scan(await duplicateLinksDeck()));
    const s1 = fs.filter((f) => f.targets[0]!.container.slideNumber === 1 && f.data.address === DUPLICATE_URL && f.data.trigger === "click");
    expect(s1.map((f) => f.targets[0]!.locator?.hyperlink)).toEqual([
      { address: DUPLICATE_URL, occurrence: 0, sameAddressCount: 2 },
      { address: DUPLICATE_URL, occurrence: 1, sameAddressCount: 2 },
    ]);
    expect(s1.map((f) => f.targets[0]!.locator?.runIndex)).toEqual([0, 2]);
    expect(new Set(s1.map((f) => f.id)).size).toBe(2);
  });

  it("restarts occurrence per slide and excludes hover links from the key", async () => {
    const fs = hyperlinks(await scan(await duplicateLinksDeck()));
    const s2 = fs.filter((f) => f.targets[0]!.container.slideNumber === 2);
    expect(s2.map((f) => f.targets[0]!.locator?.hyperlink)).toEqual([{ address: DUPLICATE_URL, occurrence: 0, sameAddressCount: 1 }]);

    const hover = fs.filter((f) => f.data.trigger === "hover");
    expect(hover).toHaveLength(1);
    expect(hover[0]!.targets[0]!.locator?.hyperlink).toBeUndefined();
    expect(hover[0]!.targets[0]!.locator?.paragraphIndex).toBe(1);
    expect(hover[0]!.reachable).toBe(false);
  });

  it("lists mailto links inside groups but marks them not checkable", async () => {
    const fs = hyperlinks(await scan(await duplicateLinksDeck()));
    const mail = fs.find((f) => f.data.address.startsWith("mailto:"))!;
    expect(mail.data).toMatchObject({ scheme: "mailto", checkable: false });
    expect(mail.targets[0]).toMatchObject({ shapeId: 5, path: [4] });
    expect(mail.targets[0]!.locator?.hyperlink).toEqual({ address: "mailto:team@example.com", occurrence: 0, sameAddressCount: 1 });
  });
});

describe("unsafe schemes, local paths, and linked media", () => {
  async function riskyFindings(): Promise<Finding[]> {
    const bytes = await mutateDeck(await riskyLinksDeck(), (m) =>
      m.editXml("ppt/slides/slide2.xml", (x) => x.replace("<p:cSld>", `<p:cSld>${BACKGROUND_XML}`)),
    );
    return scan(bytes);
  }

  it("flags javascript:, vbscript:, and data: targets (including obfuscated whitespace)", async () => {
    const fs = await riskyFindings();
    const u = unsafe(fs);
    expect(u.map((f) => f.data.scheme)).toEqual(["javascript", "vbscript", "data", "javascript"]);
    expect(u.map((f) => f.data.address)).toEqual([RISKY.javascript, RISKY.vbscript, RISKY.data, RISKY.obfuscatedJs]);
    for (const f of u) {
      expect(f.severity).toBe("warning");
      expect(f.fixes).toEqual(["edit-hyperlink", "remove-hyperlink"]);
      expect(f.reachable).toBe(true);
    }
    for (const h of hyperlinks(fs)) {
      if (h.data.address.includes("script:") || h.data.address.startsWith("data:")) expect(h.data.checkable).toBe(false);
    }
  });

  it("flags UNC, drive-letter, relative, and file: paths", async () => {
    const fs = await riskyFindings();
    const byAddr = new Map(localPaths(fs).map((f) => [f.data.address, f.data]));
    expect(byAddr.get(RISKY.unc)).toMatchObject({ pathKind: "unc", linkKind: "hyperlink" });
    expect(byAddr.get(RISKY.drive)).toMatchObject({ pathKind: "drive", linkKind: "hyperlink" });
    expect(byAddr.get(RISKY.relative)).toMatchObject({ pathKind: "relative", linkKind: "hyperlink" });
    expect(byAddr.get(RISKY.fileUrl)).toMatchObject({ pathKind: "file-url", linkKind: "hyperlink" });
    expect(byAddr.get("file:///C:/Shared/handout.pdf")).toMatchObject({ pathKind: "file-url" });
    expect(byAddr.get(RISKY.linkedVideo)).toMatchObject({ pathKind: "unc", linkKind: "linked-file" });
    expect(byAddr.get(RISKY.linkedBackground)).toMatchObject({ pathKind: "drive", linkKind: "linked-file" });
    // Unsafe schemes are not also reported as local paths.
    expect(byAddr.has(RISKY.javascript)).toBe(false);
  });

  it("lists linked images, linked video, and linked backgrounds as linked files", async () => {
    const fs = await riskyFindings();
    const files = linkedFiles(fs);
    expect(files.map((f) => [f.data.linkType, f.data.target])).toEqual([
      ["image", RISKY.linkedImage],
      ["video", RISKY.linkedVideo],
      ["image", RISKY.linkedBackground],
    ]);
    expect(files[0]!.targets[0]).toMatchObject({ shapeId: 2, shapeName: "Linked Logo" });
    expect(files[2]!.targets[0]!.shapeId).toBeUndefined();
    expect(files[2]!.targets[0]!.container).toMatchObject({ kind: "slide", slideNumber: 2 });
    // The embedded poster image is not a linked file.
    expect(JSON.stringify(files)).not.toContain("image1.png");
  });

  it("locates table-cell links, keeps hlinkfile links, and skips show jumps and dangling ids", async () => {
    const fs = hyperlinks(await riskyFindings());
    const cell = fs.find((f) => f.data.address === "https://table.example.com/")!;
    expect(cell.targets[0]!.locator).toMatchObject({ cell: { row: 1, col: 1 }, paragraphIndex: 0, runIndex: 0 });
    expect(fs.some((f) => f.data.address === "file:///C:/Shared/handout.pdf")).toBe(true);
    expect(fs.some((f) => f.data.address.includes("should-not-appear"))).toBe(false);
    expect(fs.some((f) => f.targets[0]!.locator?.relId === "rIdMissing")).toBe(false);
  });
});

describe("classifyAddress", () => {
  it.each([
    ["https://example.com", "web"],
    ["HTTP://EXAMPLE.COM", "web"],
    ["mailto:a@b.c", "other"],
    ["ftp://host/file", "other"],
    ["javascript:void(0)", "unsafe"],
    ["\u0000javascript:x", "unsafe"],
    ["data:image/png;base64,AA", "unsafe"],
    ["file:///tmp/x", "local"],
    ["C:\\x.docx", "local"],
    ["c:/x.docx", "local"],
    ["\\\\srv\\share", "local"],
    ["//srv/share/x", "local"],
    ["notes.txt", "local"],
    ["", "other"],
  ])("%j → %s", (addr, cls) => {
    expect(classifyAddress(addr).class).toBe(cls);
  });
});
