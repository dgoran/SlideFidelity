/**
 * Overview (R1, D7, D10): the file-size headline and warning / info counts for EVERY area,
 * including Pro-locked ones (marked with a lock). Details stay gated inside each area.
 */
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { ChevronRight16Regular, LockClosed16Regular } from "@fluentui/react-icons";
import { AREAS, formatBytes, type Area, type AuditResult, type FileSizeBreakdownData } from "@slidefidelity/audit-core";
import { areaAccess, usePlan } from "../../license/gate";
import { AREA_LABELS } from "../context";
import { SeverityIcon } from "./FindingRow";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  headline: { margin: 0, fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold },
  sub: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  empty: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" },
  row: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`,
    border: "none",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: "transparent",
    textAlign: "left",
    cursor: "pointer",
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  name: { flex: "1 1 auto", minWidth: 0, display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  counts: { display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalS, fontSize: tokens.fontSizeBase200 },
  count: { display: "inline-flex", alignItems: "center", gap: "2px" },
  zero: { color: tokens.colorNeutralForeground3 },
});

export interface OverviewProps {
  result: AuditResult;
  onSelectArea: (area: Area) => void;
}

function fileSize(result: AuditResult): FileSizeBreakdownData | undefined {
  for (const f of result.findings) if (f.kind === "file-size-breakdown") return f.data;
  return undefined;
}

const DETAIL_AREAS = AREAS.filter((a) => a !== "overview");

export function Overview({ result, onSelectArea }: OverviewProps) {
  const s = useStyles();
  const { plan } = usePlan();
  // The runner sets `perArea = summarize(findings)` over this same findings list.
  const summary = result.stats.perArea;
  const size = fileSize(result);
  const issues = DETAIL_AREAS.reduce((n, a) => n + summary[a].warning + summary[a].error, 0);
  const failedChecks = result.errors.length;
  const { slides, shapes } = result.stats;

  return (
    <div className={s.root} data-overview="">
      {size && (
        <div>
          <p className={s.headline} data-file-size="">
            File size: {formatBytes(size.totalBytes)}
          </p>
          <p className={s.sub}>
            Media {formatBytes(size.categories.media)} · Fonts {formatBytes(size.categories.fonts)} · Other{" "}
            {formatBytes(size.categories.xml + size.categories.other)}
          </p>
        </div>
      )}
      {issues === 0 && (
        <div data-empty-state="">
          <p className={s.empty}>No issues found</p>
          <p className={s.sub}>
            Checked {slides} {slides === 1 ? "slide" : "slides"} and {shapes} {shapes === 1 ? "shape" : "shapes"} across{" "}
            {DETAIL_AREAS.length} areas.
          </p>
        </div>
      )}
      {failedChecks > 0 && (
        <p className={s.sub}>
          {failedChecks} {failedChecks === 1 ? "check" : "checks"} could not finish. Results may be incomplete.
        </p>
      )}
      <ul className={s.list} aria-label="Areas">
        {DETAIL_AREAS.map((a) => {
          const c = summary[a];
          const locked = areaAccess(plan, a) === "locked";
          return (
            <li key={a}>
              <button type="button" className={s.row} data-area={a} onClick={() => onSelectArea(a)}>
                <span className={s.name}>
                  {AREA_LABELS[a]}
                  {locked && <LockClosed16Regular role="img" aria-label="Pro feature" data-locked="" />}
                </span>
                <span className={s.counts}>
                  <span className={mergeClasses(s.count, c.warning === 0 && s.zero)} data-count="warning">
                    <SeverityIcon severity="warning" />
                    {c.warning}
                  </span>
                  <span className={mergeClasses(s.count, c.info === 0 && s.zero)} data-count="info">
                    <SeverityIcon severity="info" />
                    {c.info}
                  </span>
                </span>
                <ChevronRight16Regular aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
