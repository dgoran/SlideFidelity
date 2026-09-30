/**
 * Findings tree model (D14): per-area grouping, sorting, filtering, and flattening into rows for
 * the windowed tree. Pure data; no React.
 *
 * Levels: 1 = group, 2 = finding, 3 = target (only for findings with more than one target).
 * Groups start expanded, findings start collapsed; `toggled` holds keys flipped from that default.
 */
import type { Area, Finding, FindingTarget } from "@slidecheck/audit-core";
import type { SeverityFilter } from "../state/store";

export interface FindingGroup {
  key: string;
  label: string;
  findings: Finding[];
  errors: number;
  warnings: number;
  /** Sum of occurrence counts (`count`, else 1 per finding). */
  count: number;
}

/** Review groups are per kind (D14); these are the kind-level labels. */
const REVIEW_KIND_LABELS: Record<string, string> = {
  "hidden-slide": "Hidden slides",
  "hidden-shape": "Hidden shapes",
  "off-slide-shape": "Off-slide shapes",
  "empty-placeholder": "Empty placeholders",
  "empty-section": "Empty sections",
  "speaker-notes": "Speaker notes",
  comment: "Comments",
  "document-property": "Document properties",
  animation: "Animations",
  transition: "Transitions",
  autofit: "Text autofit",
  "proofing-language": "Proofing languages",
};

const CHECK_FAILED_LABEL = "Checks that could not finish";

const weight = (f: Finding) => f.count ?? 1;
const sevRank = (f: Pick<Finding, "severity">) => (f.severity === "error" ? 0 : f.severity === "warning" ? 1 : 2);

function mediaBytes(f: Finding): number {
  const b = (f.data as { bytes?: unknown }).bytes;
  return typeof b === "number" ? b : 0;
}

/** Group key and label for a finding in its area's grouping (D14). */
function groupOf(area: Area, f: Finding): { key: string; label: string } {
  if (f.kind === "check-failed") return { key: "check-failed", label: CHECK_FAILED_LABEL };
  if (area === "media" && f.kind === "media-size") return { key: "media-size", label: "Media by size" };
  if (area === "review") {
    return { key: f.kind, label: REVIEW_KIND_LABELS[f.kind] ?? f.groupLabel ?? f.kind };
  }
  return { key: f.group, label: f.groupLabel ?? f.group };
}

export function groupFindings(area: Area, findings: readonly Finding[]): FindingGroup[] {
  const map = new Map<string, FindingGroup>();
  for (const f of findings) {
    const { key, label } = groupOf(area, f);
    let g = map.get(key);
    if (!g) {
      g = { key, label, findings: [], errors: 0, warnings: 0, count: 0 };
      map.set(key, g);
    }
    g.findings.push(f);
    if (f.severity === "error") g.errors += 1;
    if (f.severity === "warning") g.warnings += 1;
    g.count += weight(f);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    if (g.key === "media-size") g.findings.sort((a, b) => mediaBytes(b) - mediaBytes(a));
    else g.findings.sort((a, b) => sevRank(a) - sevRank(b) || weight(b) - weight(a));
  }
  const groupRank = (g: FindingGroup) => (g.errors > 0 ? 0 : g.warnings > 0 ? 1 : 2);
  // Stable sort keeps first-seen order among ties (the engine's deterministic order).
  return groups.sort((a, b) => groupRank(a) - groupRank(b) || b.count - a.count);
}

export interface FindingFilter {
  severity: SeverityFilter;
  search: string;
}

export function filterFindings(findings: readonly Finding[], filter: FindingFilter): Finding[] {
  const q = filter.search.trim().toLowerCase();
  return findings.filter((f) => {
    if (filter.severity === "warning" && f.severity === "info") return false;
    if (filter.severity === "info" && f.severity !== "info") return false;
    if (!q) return true;
    return [f.title, f.detail, f.group, f.groupLabel].some((s) => s !== undefined && s.toLowerCase().includes(q));
  });
}

// ---------------------------------------------------------------------------------------------
// Flattening

interface RowBase {
  key: string;
  level: 1 | 2 | 3;
  posinset: number;
  setsize: number;
  /** Undefined for leaves. */
  expanded?: boolean;
  parentKey?: string;
}

export type TreeRow =
  | (RowBase & { type: "group"; group: FindingGroup })
  | (RowBase & { type: "finding"; finding: Finding })
  | (RowBase & { type: "target"; finding: Finding; target: FindingTarget; index: number });

export const groupKey = (g: FindingGroup) => `g:${g.key}`;
export const findingKey = (f: Finding) => `f:${f.id}`;

export function flattenTree(groups: readonly FindingGroup[], toggled: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  groups.forEach((g, gi) => {
    const gk = groupKey(g);
    const gOpen = !toggled.has(gk);
    rows.push({ type: "group", key: gk, level: 1, posinset: gi + 1, setsize: groups.length, expanded: gOpen, group: g });
    if (!gOpen) return;
    g.findings.forEach((f, fi) => {
      const fk = findingKey(f);
      const expandable = f.targets.length > 1;
      const fOpen = expandable && toggled.has(fk);
      const row: TreeRow = {
        type: "finding",
        key: fk,
        level: 2,
        posinset: fi + 1,
        setsize: g.findings.length,
        parentKey: gk,
        finding: f,
      };
      if (expandable) row.expanded = fOpen;
      rows.push(row);
      if (!fOpen) return;
      f.targets.forEach((t, ti) => {
        rows.push({
          type: "target",
          key: `t:${f.id}:${ti}`,
          level: 3,
          posinset: ti + 1,
          setsize: f.targets.length,
          parentKey: fk,
          finding: f,
          target: t,
          index: ti,
        });
      });
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Labels

function stem(partName: string): string {
  return (partName.split("/").pop() ?? partName).replace(/\.xml$/i, "");
}

/** Short human label for where a target is. Plain text only (rendered as a text child). */
export function describeTarget(t: FindingTarget): string {
  const c = t.container;
  const slideNo = c.slideNumber ?? (c.slideIndex !== undefined ? c.slideIndex + 1 : undefined);
  const shape = t.shapeName ? ` · ${t.shapeName}` : t.shapeId !== undefined ? ` · shape ${t.shapeId}` : "";
  switch (c.kind) {
    case "slide":
      return `Slide ${slideNo ?? "?"}${shape}`;
    case "layout":
      return `Layout “${c.name ?? stem(c.partName)}”${shape}`;
    case "master":
      return `Master “${c.name ?? stem(c.partName)}”${shape}`;
    case "notes":
      return slideNo !== undefined ? `Notes · slide ${slideNo}` : "Notes";
    case "comments":
      return slideNo !== undefined ? `Comments · slide ${slideNo}` : "Comments";
    default:
      return slideNo !== undefined ? `${c.kind} · slide ${slideNo}` : `${c.kind} · ${stem(c.partName)}`;
  }
}
