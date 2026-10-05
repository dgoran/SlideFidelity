import { describe, expect, it } from "vitest";
import {
  child,
  childrenNamed,
  elements,
  localName,
  parseRelationships,
  parseXml,
  relAttr,
  relsPartFor,
  resolveTarget,
  textContent,
} from "../src/index";

describe("xml", () => {
  it("preserves element order across different names, prefixes, and raw attribute strings", () => {
    const root = parseXml(
      `<?xml version="1.0"?><p:spTree xmlns:p="p" xmlns:r="r"><p:sp n="1"/><p:pic n="2"/><p:sp n="3" val="0070C0" id="007"/></p:spTree>`,
    );
    expect(elements(root).map((e) => `${e.name}#${e.attrs.n ?? ""}`)).toEqual(["p:sp#1", "p:pic#2", "p:sp#3"]);
    expect(childrenNamed(root, "p:sp")).toHaveLength(2);
    expect(childrenNamed(root, "sp")).toHaveLength(2);
    expect(child(root, "pic")?.name).toBe("p:pic");
    expect(elements(root)[2]?.attrs).toEqual({ n: "3", val: "0070C0", id: "007" });
    expect(localName("a:latin")).toBe("latin");
  });

  it("keeps significant whitespace in leaf text and drops formatting whitespace", () => {
    const root = parseXml(`<a:p xmlns:a="a">\n  <a:r>\n    <a:t> two  spaces </a:t>\n  </a:r>\n</a:p>`);
    expect(textContent(root)).toBe(" two  spaces ");
    expect(root.children).toHaveLength(1);
  });

  it("decodes entities and numeric character references", () => {
    expect(textContent(parseXml(`<t>a &amp; b &lt; c &#8226; &#x2022;</t>`))).toBe("a & b < c • •");
  });

  it("reads r:-namespaced attributes by local name even with another prefix", () => {
    const el = parseXml(`<a:blip xmlns:a="a" xmlns:rel="r" rel:embed="rId7"/>`);
    expect(relAttr(el, "embed")).toBe("rId7");
  });

  it("rejects malformed XML", () => {
    expect(() => parseXml("<a><b></a>")).toThrow();
    expect(() => parseXml("")).toThrow();
  });
});

describe("rels", () => {
  it("maps parts to their rels part", () => {
    expect(relsPartFor("")).toBe("_rels/.rels");
    expect(relsPartFor("ppt/presentation.xml")).toBe("ppt/_rels/presentation.xml.rels");
    expect(relsPartFor("ppt/slides/slide1.xml")).toBe("ppt/slides/_rels/slide1.xml.rels");
  });

  it("resolves relative, parent, absolute, and encoded targets", () => {
    expect(resolveTarget("ppt/slides/slide1.xml", "../media/image1.png")).toBe("ppt/media/image1.png");
    expect(resolveTarget("ppt/slides/slide1.xml", "slide2.xml")).toBe("ppt/slides/slide2.xml");
    expect(resolveTarget("ppt/slides/slide1.xml", "/ppt/media/a%20b.png")).toBe("ppt/media/a b.png");
    expect(resolveTarget("", "ppt/presentation.xml")).toBe("ppt/presentation.xml");
    expect(resolveTarget("ppt/slides/slide1.xml", "./x/../y.xml#frag")).toBe("ppt/slides/y.xml");
  });

  it("marks external targets and never resolves them", () => {
    const rels = parseRelationships(
      "ppt/slides/slide1.xml",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="../media/fake.png" TargetMode="External"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/real.png"/>` +
        `</Relationships>`,
    );
    expect(rels.map((r) => [r.id, r.shortType, r.targetMode, r.targetPart])).toEqual([
      ["rId1", "hyperlink", "External", undefined],
      ["rId2", "image", "Internal", "ppt/media/real.png"],
    ]);
  });

  it("tolerates an unparseable rels part", () => {
    expect(parseRelationships("x.xml", "<not closed")).toEqual([]);
  });
});
