import { describe, expect, it } from "vitest";
import {
  buildHyperlinkKeys,
  emuToPoints,
  formatLiveSlideId,
  hyperlinkKeyString,
  isSafeForDestructiveFix,
  matchHyperlink,
  parseLiveShapeId,
  parseLiveSlideId,
  resolveShape,
  resolveSlide,
  type LiveShape,
} from "./ids";

describe("live slide id <-> OOXML p:sldId/@id", () => {
  it("parses the leading integer of the assumed live formats", () => {
    expect(parseLiveSlideId("256#")).toBe(256);
    expect(parseLiveSlideId("256#3241234")).toBe(256);
    expect(parseLiveSlideId("257")).toBe(257);
  });

  it("maps an OOXML slide id to the live format and back", () => {
    const live = formatLiveSlideId(260);
    expect(live).toBe("260#");
    expect(parseLiveSlideId(live)).toBe(260);
  });

  it("returns null for unparseable live slide ids", () => {
    expect(parseLiveSlideId("")).toBeNull();
    expect(parseLiveSlideId("#256")).toBeNull();
    expect(parseLiveSlideId("abc")).toBeNull();
    expect(parseLiveSlideId("{8A7F-...}")).toBeNull();
  });

  it("rejects out-of-range OOXML slide ids when formatting", () => {
    expect(() => formatLiveSlideId(-1)).toThrow();
    expect(() => formatLiveSlideId(1.5)).toThrow();
  });
});

describe("live shape id <-> OOXML p:cNvPr/@id", () => {
  it("parses a numeric string", () => {
    expect(parseLiveShapeId("4")).toBe(4);
    expect(parseLiveShapeId("1024")).toBe(1024);
  });
  it("returns null for non-numeric ids", () => {
    expect(parseLiveShapeId("")).toBeNull();
    expect(parseLiveShapeId("4#1")).toBeNull();
    expect(parseLiveShapeId("{GUID}")).toBeNull();
  });
});

describe("resolveSlide", () => {
  const live = [{ id: "256#1" }, { id: "257#2" }, { id: "300#3" }];

  it("matches by id exactly", () => {
    const r = resolveSlide({ slideId: 257 }, live);
    expect(r).toMatchObject({ status: "matched", method: "exact", index: 1 });
  });

  it("falls back to slide position when no live id matches", () => {
    const r = resolveSlide({ slideId: 999, index: 2 }, [{ id: "x" }, { id: "y" }, { id: "z" }]);
    expect(r).toMatchObject({ status: "matched", method: "fallback", index: 2 });
  });

  it("does not fall back when the slide at that position has a different parseable id", () => {
    const r = resolveSlide({ slideId: 999, index: 2 }, live);
    expect(r.status).toBe("not-found");
  });

  it("is not-found without id match or fallback index", () => {
    expect(resolveSlide({ slideId: 999 }, live).status).toBe("not-found");
  });

  it("is ambiguous when two live slides share an id", () => {
    const r = resolveSlide({ slideId: 256 }, [{ id: "256#1" }, { id: "256#9" }]);
    expect(r.status).toBe("ambiguous");
  });
});

describe("resolveShape", () => {
  const shapes: LiveShape[] = [
    { id: "2", name: "Title 1", left: 36, top: 20 },
    { id: "3", name: "Content Placeholder 2", left: 36, top: 120 },
    { id: "7", name: "Picture 6", left: 400, top: 200 },
  ];

  it("matches by shape id exactly", () => {
    const r = resolveShape({ shapeId: 3, name: "Content Placeholder 2", left: 36, top: 120 }, shapes);
    expect(r).toMatchObject({ status: "matched", method: "exact", item: shapes[1] });
    expect(isSafeForDestructiveFix(r)).toBe(true);
  });

  it("falls back to name + position when the id is absent in the live model", () => {
    const live: LiveShape[] = [
      { id: "{A}", name: "Title 1", left: 36, top: 20 },
      { id: "{B}", name: "Picture 6", left: 400.4, top: 199.8 },
    ];
    const r = resolveShape({ shapeId: 7, name: "Picture 6", left: 400, top: 200 }, live);
    expect(r).toMatchObject({ status: "matched", method: "fallback", item: live[1] });
    expect(isSafeForDestructiveFix(r)).toBe(false);
  });

  it("uses position to disambiguate shapes with the same name", () => {
    const live: LiveShape[] = [
      { id: "{A}", name: "Rectangle 1", left: 10, top: 10 },
      { id: "{B}", name: "Rectangle 1", left: 200, top: 10 },
    ];
    const r = resolveShape({ shapeId: 50, name: "Rectangle 1", left: 200, top: 10 }, live);
    expect(r).toMatchObject({ status: "matched", method: "fallback", item: live[1] });
  });

  it("is ambiguous when name + position match more than one shape", () => {
    const live: LiveShape[] = [
      { id: "{A}", name: "Rectangle 1", left: 10, top: 10 },
      { id: "{B}", name: "Rectangle 1", left: 10.5, top: 10 },
    ];
    const r = resolveShape({ shapeId: 50, name: "Rectangle 1", left: 10, top: 10 }, live);
    expect(r.status).toBe("ambiguous");
    expect(isSafeForDestructiveFix(r)).toBe(false);
  });

  it("is not-found when the name matches but the position has moved beyond tolerance", () => {
    const r = resolveShape({ shapeId: 99, name: "Picture 6", left: 10, top: 10 }, shapes);
    expect(r.status).toBe("not-found");
  });

  it("honours a custom position tolerance", () => {
    const r = resolveShape({ shapeId: 99, name: "Picture 6", left: 395, top: 200 }, shapes, { tolerancePt: 6 });
    expect(r).toMatchObject({ status: "matched", method: "fallback" });
  });

  it("does not fall back when the target has no name", () => {
    const r = resolveShape({ shapeId: 99, name: "", left: 36, top: 20 }, [{ id: "{A}", name: "", left: 36, top: 20 }]);
    expect(r.status).toBe("not-found");
  });

  it("is ambiguous when two live shapes report the same id", () => {
    const live: LiveShape[] = [
      { id: "5", name: "A", left: 0, top: 0 },
      { id: "5", name: "B", left: 0, top: 0 },
    ];
    expect(resolveShape({ shapeId: 5, name: "A", left: 0, top: 0 }, live).status).toBe("ambiguous");
  });

  it("converts EMU to points for comparing OOXML offsets with live positions", () => {
    expect(emuToPoints(12700)).toBe(1);
    expect(emuToPoints(457200)).toBe(36);
  });
});

describe("hyperlink join key", () => {
  it("assigns occurrence order per address within a slide", () => {
    const keys = buildHyperlinkKeys(256, ["https://a", "https://b", "https://a"]);
    expect(keys.map((k) => [k.address, k.occurrence, k.sameAddressCount])).toEqual([
      ["https://a", 0, 2],
      ["https://b", 0, 1],
      ["https://a", 1, 2],
    ]);
    expect(hyperlinkKeyString(keys[2]!)).toBe("256|1|https://a");
  });

  it("matches the Nth occurrence of the same address on the live slide", () => {
    const [, , second] = buildHyperlinkKeys(256, ["https://a", "https://b", "https://a"]);
    const live = [{ address: "https://b" }, { address: "https://a" }, { address: "https://a" }];
    const r = matchHyperlink(second!, live);
    expect(r).toMatchObject({ status: "matched", method: "exact", index: 2 });
  });

  it("is ambiguous when the live count for that address differs from the snapshot", () => {
    const [first] = buildHyperlinkKeys(256, ["https://a", "https://a"]);
    const r = matchHyperlink(first!, [{ address: "https://a" }, { address: "https://a" }, { address: "https://a" }]);
    expect(r.status).toBe("ambiguous");
  });

  it("is ambiguous when some but not all same-address links remain live", () => {
    const [, second] = buildHyperlinkKeys(256, ["https://a", "https://a"]);
    expect(matchHyperlink(second!, [{ address: "https://a" }]).status).toBe("ambiguous");
  });

  it("is not-found when the address is gone from the live slide", () => {
    const [first] = buildHyperlinkKeys(256, ["https://a"]);
    expect(matchHyperlink(first!, [{ address: "https://z" }]).status).toBe("not-found");
  });
});
