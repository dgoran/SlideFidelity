/**
 * The findings tree (R1, R2, D14, D15): per-area grouping, warnings first then by count, a
 * severity filter and a search box, in-house windowed rendering, and full keyboard operation.
 *
 * Windowing: every row has the same height, so the visible slice is computed from `scrollTop`
 * and only those rows (plus a small overscan, plus the active row) are mounted. Each mounted
 * row carries `aria-level`/`aria-setsize`/`aria-posinset`/`aria-expanded` so assistive tech
 * still knows the full shape of the tree (D15).
 *
 * Keyboard (focus on a row): Up/Down move, Home/End jump, Right expands (or moves to the first
 * child), Left collapses (or moves to the parent), Enter shows the item in PowerPoint (or
 * toggles a group).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Input, Label, Select, makeStyles, tokens } from "@fluentui/react-components";
import { Search16Regular } from "@fluentui/react-icons";
import type { Area, Finding, FindingTarget } from "@slidecheck/audit-core";
import { primaryTarget, type NavigateResult } from "../../office/navigate";
import { AREA_LABELS, usePaneServices, usePaneSlots } from "../context";
import { describeTarget, filterFindings, flattenTree, groupFindings, type TreeRow } from "../model/tree";
import { usePane } from "../state/PaneContext";
import type { SeverityFilter } from "../state/store";
import { FindingRow } from "./FindingRow";

export const ROW_HEIGHT = 44;
const DEFAULT_VIEWPORT = 440;

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto", gap: tokens.spacingVerticalS },
  toolbar: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalS, alignItems: "flex-end" },
  field: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, minWidth: 0 },
  search: { flex: "1 1 140px", minWidth: 0 },
  severity: { flex: "0 1 130px", minWidth: 0 },
  viewport: {
    position: "relative",
    overflowY: "auto",
    overflowX: "hidden",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  empty: { color: tokens.colorNeutralForeground3, margin: 0, padding: tokens.spacingVerticalS },
  status: { minHeight: "1.2em", fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, margin: 0 },
});

/** Plain-language outcome of "Show in PowerPoint", announced in a polite live region. */
export function describeNavigation(
  r: NavigateResult,
  target: FindingTarget,
  explain: (feature: "selectShapes") => string | null,
): string {
  const where = describeTarget(target);
  switch (r.kind) {
    case "shape":
      return `Selected ${where}.`;
    case "slide": {
      const slide = target.container.slideNumber ?? (target.container.slideIndex ?? 0) + 1;
      if (r.note === "shape-selection-unsupported") {
        return `Went to slide ${slide}. Selecting the shape: ${explain("selectShapes") ?? "not available"}.`;
      }
      if (r.note === "shape-not-found" || r.note === "shape-ambiguous") {
        return `Went to slide ${slide}, but the shape could not be found. The presentation may have changed; rescan to refresh.`;
      }
      return `Went to slide ${slide}.`;
    }
    case "layout-note":
      return `Located on ${r.containerKind} “${r.name}”. Add-ins cannot open the slide master view; open View › Slide Master to see it.`;
    case "not-found":
      return "Could not find this item in the presentation. It may have been deleted or moved; rescan to refresh.";
    case "not-navigable":
      return "This item is not on a slide, so it cannot be shown.";
    case "error":
      return "PowerPoint could not show this item. Try again.";
  }
}

export interface FindingsTreeProps {
  area: Area;
  /** The findings the plan allows in this area (gating is applied by the caller). */
  findings: readonly Finding[];
  /** Fixed viewport height in px. Defaults to the measured height (440 when unmeasurable). */
  viewportHeight?: number;
  /** Extra rows rendered above and below the visible window. */
  overscan?: number;
}

export function FindingsTree({ area, findings, viewportHeight, overscan = 4 }: FindingsTreeProps) {
  const s = useStyles();
  const { state, dispatch } = usePane();
  const { navigator, capabilities } = usePaneServices();
  const { renderRowActions } = usePaneSlots();
  const baseId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);

  const toggled = state.toggled[area];
  const rows = useMemo(() => {
    const visible = filterFindings(findings, { severity: state.severity, search: state.search });
    return flattenTree(groupFindings(area, visible), toggled);
  }, [area, findings, state.severity, state.search, toggled]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState(0);
  const [status, setStatus] = useState("");

  const found = activeKey === null ? -1 : rows.findIndex((r) => r.key === activeKey);
  const activeIndex = rows.length === 0 ? -1 : found >= 0 ? found : 0;
  const height = viewportHeight ?? (measured || DEFAULT_VIEWPORT);

  useLayoutEffect(() => {
    if (viewportHeight !== undefined) return undefined;
    const el = viewportRef.current;
    if (!el) return undefined;
    const measure = () => setMeasured(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportHeight]);

  // After a keyboard move, focus the (now mounted) active row.
  useEffect(() => {
    if (!focusPending.current || activeIndex < 0) return;
    focusPending.current = false;
    document.getElementById(`${baseId}-row-${activeIndex}`)?.focus();
  });

  const scrollIntoView = useCallback(
    (index: number) => {
      const el = viewportRef.current;
      const rowTop = index * ROW_HEIGHT;
      let next = scrollTop;
      if (rowTop < scrollTop) next = rowTop;
      else if (rowTop + ROW_HEIGHT > scrollTop + height) next = rowTop + ROW_HEIGHT - height;
      if (next !== scrollTop) {
        if (el) el.scrollTop = next;
        setScrollTop(next);
      }
    },
    [scrollTop, height],
  );

  const moveTo = (index: number) => {
    if (rows.length === 0) return;
    const i = Math.max(0, Math.min(rows.length - 1, index));
    focusPending.current = true;
    setActiveKey(rows[i]!.key);
    scrollIntoView(i);
  };

  const toggle = (row: TreeRow) => dispatch({ type: "tree/toggle", area, key: row.key });

  const targetOf = (row: TreeRow): FindingTarget | undefined =>
    row.type === "target" ? row.target : row.type === "finding" ? primaryTarget(row.finding) : undefined;

  const show = async (target: FindingTarget) => {
    setStatus("");
    const r = await navigator.navigate(target);
    setStatus(describeNavigation(r, target, (f) => capabilities.explain(f)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.getAttribute("role") !== "treeitem" || activeIndex < 0) return;
    const row = rows[activeIndex]!;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        moveTo(activeIndex + 1);
        break;
      case "ArrowUp":
        moveTo(activeIndex - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.expanded === false) toggle(row);
        else if (row.expanded === true) moveTo(activeIndex + 1);
        break;
      case "ArrowLeft":
        if (row.expanded === true) toggle(row);
        else if (row.parentKey) moveTo(rows.findIndex((r) => r.key === row.parentKey));
        break;
      case "Enter": {
        const t = targetOf(row);
        if (t) void show(t);
        else if (row.expanded !== undefined) toggle(row);
        break;
      }
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  // The visible window, plus the active row so roving focus always has a mounted element.
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + overscan);
  const indices: number[] = [];
  for (let i = first; i < last; i++) indices.push(i);
  if (activeIndex >= 0 && (activeIndex < first || activeIndex >= last)) indices.push(activeIndex);

  const searchId = `${baseId}-search`;
  const severityId = `${baseId}-severity`;
  const label = `${AREA_LABELS[area]} findings`;

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <div className={`${s.field} ${s.search}`}>
          <Label htmlFor={searchId} size="small">
            Search
          </Label>
          <Input
            id={searchId}
            type="search"
            size="small"
            contentBefore={<Search16Regular />}
            value={state.search}
            onChange={(_e, d) => dispatch({ type: "filter/search", search: d.value })}
          />
        </div>
        <div className={`${s.field} ${s.severity}`}>
          <Label htmlFor={severityId} size="small">
            Show
          </Label>
          <Select
            id={severityId}
            size="small"
            value={state.severity}
            onChange={(_e, d) => dispatch({ type: "filter/severity", severity: d.value as SeverityFilter })}
          >
            <option value="all">All</option>
            <option value="warning">Warnings</option>
            <option value="info">Information</option>
          </Select>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className={s.empty}>No findings match the current filter.</p>
      ) : (
        <div
          ref={viewportRef}
          role="tree"
          aria-label={label}
          className={s.viewport}
          style={{ height: viewportHeight ?? undefined, maxHeight: viewportHeight ?? "60vh", minHeight: 120 }}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onKeyDown={onKeyDown}
        >
          <div style={{ position: "relative", height: rows.length * ROW_HEIGHT }}>
            {indices.map((i) => {
              const row = rows[i]!;
              const active = i === activeIndex;
              const target = targetOf(row);
              const finding = row.type === "group" ? undefined : row.finding;
              const actions =
                finding && renderRowActions
                  ? renderRowActions(finding, {
                      area,
                      ...(row.type === "target" ? { target: row.target } : {}),
                      active,
                      tabIndex: active ? 0 : -1,
                    })
                  : undefined;
              return (
                <FindingRow
                  key={row.key}
                  id={`${baseId}-row-${i}`}
                  row={row}
                  top={i * ROW_HEIGHT}
                  height={ROW_HEIGHT}
                  active={active}
                  onActivate={() => setActiveKey(row.key)}
                  onToggle={() => toggle(row)}
                  {...(target ? { onShow: () => void show(target) } : {})}
                  actions={actions}
                />
              );
            })}
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className={s.status}>
        {status}
      </p>
    </div>
  );
}
