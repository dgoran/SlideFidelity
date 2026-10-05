/**
 * Test-only builders for findings and results. Not imported by production code.
 */
import { summarize, type Area, type AuditResult, type Finding, type FindingTarget, type Severity } from "@slidefidelity/audit-core";

let seq = 0;

export interface FakeFindingInput {
  area: Area;
  kind?: string;
  severity?: Severity;
  title?: string;
  detail?: string;
  group?: string;
  groupLabel?: string;
  count?: number;
  targets?: FindingTarget[];
  data?: unknown;
  id?: string;
}

/** A loosely-typed finding for UI tests (kind/data are not checked against the registry). */
export function fakeFinding(input: FakeFindingInput): Finding {
  seq += 1;
  const f = {
    id: input.id ?? `${input.area}:${input.kind ?? "x"}:${seq}`,
    area: input.area,
    kind: input.kind ?? "font-usage",
    severity: input.severity ?? "info",
    title: input.title ?? `Finding ${seq}`,
    group: input.group ?? "g",
    targets: input.targets ?? [],
    fixes: [],
    data: input.data ?? {},
  } as Record<string, unknown>;
  if (input.detail !== undefined) f.detail = input.detail;
  if (input.groupLabel !== undefined) f.groupLabel = input.groupLabel;
  if (input.count !== undefined) f.count = input.count;
  return f as unknown as Finding;
}

export function slideShape(slideNumber: number, shapeId: number, shapeName = `Shape ${shapeId}`): FindingTarget {
  return {
    container: {
      kind: "slide",
      partName: `ppt/slides/slide${slideNumber}.xml`,
      slideId: 255 + slideNumber,
      slideIndex: slideNumber - 1,
      slideNumber,
    },
    shapeId,
    shapeName,
  };
}

export function fakeResult(findings: Finding[], hash = "hash"): AuditResult {
  return {
    findings,
    hash,
    stats: { slides: 12, shapes: 80, durationMs: 5, perArea: summarize(findings) },
    errors: [],
  };
}
