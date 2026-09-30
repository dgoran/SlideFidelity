/**
 * One row of the windowed findings tree (group, finding, or target).
 *
 * Untrusted-content rule (review decisions, CSP bullet): every string that comes from the deck
 * (titles, details, group labels, addresses, shape names) is rendered ONLY as a React text child.
 * Never `dangerouslySetInnerHTML`, never an `href`/`src` built from deck data.
 */
import type { CSSProperties, ReactNode } from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  ChevronDown16Regular,
  ChevronRight16Regular,
  ErrorCircle16Filled,
  Flag16Filled,
  Info16Regular,
  SlideSearch16Regular,
} from "@fluentui/react-icons";
import type { Severity } from "@slidecheck/audit-core";
import { describeTarget, type TreeRow } from "../model/tree";
import { primaryTarget } from "../../office/navigate";

const useStyles = makeStyles({
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
    minWidth: 0,
    cursor: "default",
    outlineStyle: "none",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":focus-visible": {
      outlineStyle: "solid",
      outlineWidth: tokens.strokeWidthThick,
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "-2px",
    },
  },
  active: { backgroundColor: tokens.colorNeutralBackground1Selected },
  chevron: {
    flexShrink: 0,
    width: "20px",
    height: "20px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    background: "transparent",
    padding: 0,
    color: tokens.colorNeutralForeground2,
    cursor: "pointer",
  },
  spacer: { flexShrink: 0, width: "20px" },
  text: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" },
  primary: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  group: { fontWeight: tokens.fontWeightSemibold },
  secondary: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: tokens.colorNeutralForeground3,
  },
  meta: { flexShrink: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  icon: { flexShrink: 0, display: "inline-flex" },
  warning: { color: tokens.colorPaletteRedForeground1 },
  error: { color: tokens.colorPaletteDarkOrangeForeground1 },
  info: { color: tokens.colorPaletteBlueForeground2 },
  actions: { flexShrink: 0, display: "flex", alignItems: "center" },
});

const SEVERITY_LABEL: Record<Severity, string> = { warning: "Warning", info: "Information", error: "Check failed" };

/**
 * Severity by icon SHAPE as well as color (D15): warning = flag, info = "i" circle,
 * error (a check failed) = filled circle with a cross.
 */
export function SeverityIcon({ severity }: { severity: Severity }) {
  const s = useStyles();
  const [Icon, shape, cls] =
    severity === "warning"
      ? [Flag16Filled, "flag", s.warning]
      : severity === "error"
        ? [ErrorCircle16Filled, "error", s.error]
        : [Info16Regular, "info", s.info];
  return (
    <span role="img" aria-label={SEVERITY_LABEL[severity]} data-severity-icon={shape} className={mergeClasses(s.icon, cls)}>
      <Icon aria-hidden="true" />
    </span>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface FindingRowProps {
  row: TreeRow;
  id: string;
  top: number;
  height: number;
  active: boolean;
  onActivate: () => void;
  onToggle: () => void;
  /** Present when the row can be shown in PowerPoint. */
  onShow?: () => void;
  /** U12/U13 row actions (already rendered by the tree from `renderRowActions`). */
  actions?: ReactNode;
}

export function FindingRow({ row, id, top, height, active, onActivate, onToggle, onShow, actions }: FindingRowProps) {
  const s = useStyles();
  const style: CSSProperties = { top, height, paddingLeft: `${(row.level - 1) * 16 + 4}px` };
  const tabIndex = active ? 0 : -1;

  let primary: ReactNode;
  let secondary: ReactNode = null;
  let meta: ReactNode = null;
  let icon: ReactNode = null;

  if (row.type === "group") {
    const g = row.group;
    primary = <span className={mergeClasses(s.primary, s.group)}>{g.label}</span>;
    const parts = [plural(g.findings.length, "item")];
    if (g.warnings) parts.unshift(plural(g.warnings, "warning"));
    secondary = <span className={s.secondary}>{parts.join(" · ")}</span>;
    if (g.warnings) icon = <SeverityIcon severity="warning" />;
  } else if (row.type === "finding") {
    const f = row.finding;
    icon = <SeverityIcon severity={f.severity} />;
    primary = <span className={s.primary}>{f.title}</span>;
    const where = primaryTarget(f);
    const sub = f.detail ?? (where ? describeTarget(where) : undefined);
    if (sub) secondary = <span className={s.secondary}>{sub}</span>;
    if (f.count !== undefined) meta = <span className={s.meta}>{f.count}</span>;
  } else {
    primary = <span className={s.primary}>{describeTarget(row.target)}</span>;
  }

  const chevron =
    row.expanded === undefined ? (
      <span className={s.spacer} />
    ) : (
      <button
        type="button"
        className={s.chevron}
        tabIndex={-1}
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          onActivate();
          onToggle();
        }}
      >
        {row.expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
      </button>
    );

  return (
    <div
      role="treeitem"
      id={id}
      aria-level={row.level}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-expanded={row.expanded}
      aria-selected={active}
      tabIndex={tabIndex}
      data-row-key={row.key}
      className={mergeClasses(s.row, active && s.active)}
      style={style}
      onClick={onActivate}
      onFocus={(e) => {
        if (e.target === e.currentTarget && !active) onActivate();
      }}
    >
      {chevron}
      {icon}
      <span className={s.text}>
        {primary}
        {secondary}
      </span>
      {meta}
      <span className={s.actions}>
        {onShow && (
          <Button
            size="small"
            appearance="subtle"
            icon={<SlideSearch16Regular />}
            aria-label="Show in PowerPoint"
            title="Show in PowerPoint"
            tabIndex={tabIndex}
            onClick={(e) => {
              e.stopPropagation();
              onActivate();
              onShow();
            }}
          />
        )}
        {actions}
      </span>
    </div>
  );
}
