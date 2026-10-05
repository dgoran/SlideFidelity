import { describe, expect, it } from "vitest";
import {
  area,
  contains,
  emuToInches,
  emuToPoints,
  fullyOutside,
  gap,
  intersection,
  isRotated,
  offSlideFraction,
  overflow,
  rotatedBounds,
  visualBounds,
} from "../src/geometry";
import type { Bounds, ShapeRef } from "../src/package/shapes";

const b = (x: number, y: number, cx: number, cy: number): Bounds => ({ x, y, cx, cy });

function ref(partial: Partial<ShapeRef> & Pick<ShapeRef, "shapeId" | "kind">): ShapeRef {
  return {
    container: { kind: "slide", partName: "ppt/slides/slide1.xml" },
    name: "",
    element: `p:${partial.kind}`,
    path: [],
    order: 0,
    hidden: false,
    effectivelyHidden: false,
    node: { type: "element", name: `p:${partial.kind}`, attrs: {}, children: [] },
    ...partial,
  };
}

describe("geometry", () => {
  it("computes intersections with positive area only", () => {
    expect(intersection(b(0, 0, 10, 10), b(5, 5, 10, 10))).toEqual(b(5, 5, 5, 5));
    expect(intersection(b(0, 0, 10, 10), b(10, 0, 5, 5))).toBeUndefined();
    expect(area(b(0, 0, 3, 4))).toBe(12);
    expect(area(b(0, 0, -3, 4))).toBe(0);
  });

  it("measures edge gaps, including diagonal separation", () => {
    expect(gap(b(0, 0, 10, 10), b(12, 0, 5, 5))).toBe(2);
    expect(gap(b(0, 0, 10, 10), b(0, 13, 5, 5))).toBe(3);
    expect(gap(b(0, 0, 10, 10), b(13, 14, 5, 5))).toBe(5);
    expect(gap(b(0, 0, 10, 10), b(10, 0, 5, 5))).toBe(0);
    expect(gap(b(0, 0, 10, 10), b(2, 2, 3, 3))).toBe(0);
  });

  it("tests containment with optional tolerance", () => {
    expect(contains(b(0, 0, 10, 10), b(0, 0, 10, 10))).toBe(true);
    expect(contains(b(0, 0, 10, 10), b(-1, 0, 5, 5))).toBe(false);
    expect(contains(b(0, 0, 10, 10), b(-1, 0, 5, 5), 1)).toBe(true);
  });

  it("reports overflow per side beyond a tolerance", () => {
    expect(overflow(b(-5, 2, 20, 6), 10, 10, 0)).toEqual([
      { side: "left", emu: 5 },
      { side: "right", emu: 5 },
    ]);
    expect(overflow(b(-5, -1, 20, 12), 10, 10, 1)).toEqual([
      { side: "left", emu: 5 },
      { side: "right", emu: 5 },
    ]);
    expect(overflow(b(1, 1, 5, 5), 10, 10)).toEqual([]);
  });

  it("detects fully outside bounds and the off-slide fraction", () => {
    expect(fullyOutside(b(10, 0, 5, 5), 10, 10)).toBe(true);
    expect(fullyOutside(b(-5, 0, 5, 5), 10, 10)).toBe(true);
    expect(fullyOutside(b(9, 0, 5, 5), 10, 10)).toBe(false);
    expect(offSlideFraction(b(5, 0, 10, 10), 10, 10)).toBeCloseTo(0.5);
    expect(offSlideFraction(b(5, 5, 10, 0), 10, 10)).toBeCloseTo(0.5); // a line
    expect(offSlideFraction(b(0, 0, 10, 10), 10, 10)).toBe(0);
  });

  it("treats multiples of 180° as unrotated", () => {
    expect(isRotated(undefined)).toBe(false);
    expect(isRotated(0)).toBe(false);
    expect(isRotated(10800000)).toBe(false);
    expect(isRotated(-10800000)).toBe(false);
    expect(isRotated(5400000)).toBe(true);
    expect(isRotated(60000)).toBe(true);
  });

  it("computes the axis-aligned box of a rotated rect", () => {
    expect(rotatedBounds(b(0, 0, 40, 10), 5400000)).toEqual(b(15, -15, 10, 40));
    const r45 = rotatedBounds(b(0, 0, 100, 100), 2700000);
    expect(r45.cx).toBe(142);
    expect(r45.x).toBe(-21);
    expect(rotatedBounds(b(1, 2, 3, 4), 10800000)).toEqual(b(1, 2, 3, 4));
  });

  it("applies own rotation and ancestor group rotation / flips in visualBounds", () => {
    const shape = ref({ shapeId: 3, kind: "sp", xfrm: { off: { x: 0, y: 0 }, ext: { cx: 40, cy: 10 }, rot: 5400000 } });
    expect(visualBounds(shape, b(0, 0, 40, 10), new Map())).toEqual({ bounds: b(15, -15, 10, 40), rotated: true });

    const group = ref({ shapeId: 2, kind: "grpSp", bounds: b(0, 0, 100, 100), xfrm: { off: { x: 0, y: 0 }, ext: { cx: 100, cy: 100 }, flipH: true } });
    const childRef = ref({ shapeId: 4, kind: "pic", path: [2], xfrm: { off: { x: 0, y: 0 }, ext: { cx: 10, cy: 10 } } });
    const byId = new Map([[2, group]]);
    expect(visualBounds(childRef, b(0, 0, 10, 10), byId)).toEqual({ bounds: b(90, 0, 10, 10), rotated: false });

    const rotGroup = ref({ shapeId: 2, kind: "grpSp", bounds: b(0, 0, 100, 100), xfrm: { off: { x: 0, y: 0 }, ext: { cx: 100, cy: 100 }, rot: 5400000 } });
    expect(visualBounds(childRef, b(0, 0, 10, 10), new Map([[2, rotGroup]]))).toEqual({ bounds: b(90, 0, 10, 10), rotated: true });

    const plain = ref({ shapeId: 5, kind: "sp" });
    const base = b(1, 2, 3, 4);
    expect(visualBounds(plain, base, new Map()).bounds).toBe(base);
  });

  it("converts units", () => {
    expect(emuToInches(914400)).toBe(1);
    expect(emuToInches(609600)).toBe(0.667);
    expect(emuToPoints(12700)).toBe(1);
    expect(emuToPoints(25400)).toBe(2);
  });
});
