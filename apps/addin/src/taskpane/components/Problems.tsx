/**
 * Problems (Graphics Ops G1): the show-readiness checklist, shown first after a scan.
 *
 * - Headline: "Ready for show" or "N problems to fix" (the view's heading; focused after a scan,
 *   D15).
 * - One row per category (Videos & audio, Fonts, Off-slide objects, Text touching objects, Media &
 *   image size) with a status shown by icon SHAPE and text (check = passed, flag = problems,
 *   "i" = notes only) and the counts. Each row is a disclosure button over the category's findings,
 *   warnings first, with "Show in PowerPoint" and the row actions (fixes) per finding.
 * - Gating (D7, D13): the headline and counts are free; the findings' details and fixes follow
 *   `featureForFinding`, with an inline locked section otherwise.
 *
 * Untrusted-content rule: titles, details, font names, part names, and URLs come from the deck and
 * are rendered only as React text, never as `href`/`src`.
 */
import { forwardRef, useId, useMemo, useState, type ReactNode } from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { CheckmarkCircle16Filled, ChevronDown16Regular, ChevronRight16Regular, Flag16Filled, Info16Regular, SlideSearch16Regular } from "@fluentui/react-icons";
import { formatBytes, type AuditResult, type Finding, type FindingTarget } from "@slidecheck/audit-core";
import { featureForFinding, usePlan, type Feature } from "../../license/gate";
import { primaryTarget } from "../../office/navigate";
import { navigateFromPane, usePaneServices, usePaneSlots } from "../context";
import { buildProblems, isNoteLevel, type CategoryStatus, type ProblemCategory, type ProblemCategoryId, type ProblemsModel } from "../model/problems";
import { describeTarget } from "../model/tree";
import { describeNavigation } from "./FindingsTree";
import { SeverityIcon } from "./FindingRow";
import { LockedSection } from "./LockedSection";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: 0 },
  headline: { margin: 0, fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold, outlineStyle: "none" },
  sub: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" },
  category: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, minWidth: 0 },
  toggle: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`,
    border: "none",
    background: "transparent",
    textAlign: "left",
    cursor: "pointer",
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":focus-visible": {
      outlineStyle: "solid",
      outlineWidth: tokens.strokeWidthThick,
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "-2px",
    },
  },
  label: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" },
  name: { fontWeight: tokens.fontWeightSemibold },
  count: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  chevron: { flexShrink: 0, color: tokens.colorNeutralForeground2, display: "inline-flex" },
  icon: { flexShrink: 0, display: "inline-flex" },
  pass: { color: tokens.colorPaletteGreenForeground1 },
  warning: { color: tokens.colorPaletteRedForeground1 },
  info: { color: tokens.colorPaletteBlueForeground2 },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `0 ${tokens.spacingHorizontalXS} ${tokens.spacingVerticalS} ${tokens.spacingHorizontalXXL}`,
    minWidth: 0,
  },
  items: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  item: { display: "flex", alignItems: "flex-start", gap: tokens.spacingHorizontalXS, minWidth: 0 },
  itemText: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", wordBreak: "break-word" },
  itemTitle: { fontSize: tokens.fontSizeBase300 },
  itemSub: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  actions: { flexShrink: 0, display: "flex", alignItems: "center" },
  more: { alignSelf: "flex-start" },
  hint: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  hintRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  largest: { margin: 0, paddingLeft: tokens.spacingHorizontalL, fontSize: tokens.fontSizeBase200, wordBreak: "break-word" },
  status: { minHeight: "1.2em", fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, margin: 0 },
});

const STATUS_LABEL: Record<CategoryStatus, string> = { pass: "Passed", warning: "Problems", note: "Notes only" };

/** Category status by icon shape (D15): check = passed, flag = problems, "i" = notes. */
function StatusIcon({ status }: { status: CategoryStatus }) {
  const s = useStyles();
  if (status === "pass") {
    return (
      <span role="img" aria-label={STATUS_LABEL.pass} data-status-icon="check" className={mergeClasses(s.icon, s.pass)}>
        <CheckmarkCircle16Filled aria-hidden="true" />
      </span>
    );
  }
  const warning = status === "warning";
  const Icon = warning ? Flag16Filled : Info16Regular;
  return (
    <span role="img" aria-label={STATUS_LABEL[status]} data-status-icon={warning ? "flag" : "info"} className={mergeClasses(s.icon, warning ? s.warning : s.info)}>
      <Icon aria-hidden="true" />
    </span>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function countText(c: Pick<ProblemCategory, "warnings" | "notes">): string {
  const parts: string[] = [];
  if (c.warnings) parts.push(plural(c.warnings, "problem"));
  if (c.notes) parts.push(plural(c.notes, "note"));
  return parts.length ? parts.join(" · ") : "No problems";
}

/** What the locked details of a category are called. */
const LOCKED_TITLES: Record<ProblemCategoryId, string> = {
  playback: "Video and audio details (Pro)",
  fonts: "Font details (Pro)",
  "off-slide": "Off-slide details (Pro)",
  "text-collision": "Text overlap details (Pro)",
  size: "Image issue details (Pro)",
};

const PASS_TEXT: Record<ProblemCategoryId, string> = {
  playback: "Every video and sound is embedded in a format that should play.",
  fonts: "Every font is embedded, a standard Office font, or on the show-machine list.",
  "off-slide": "Nothing hangs off the slides.",
  "text-collision": "No text touches other objects.",
  size: "No oversized, distorted, or low-resolution images.",
};

export interface ProblemsProps {
  result: AuditResult;
  /** Precomputed model (the pane also uses it for the picker label). */
  model?: ProblemsModel;
}

export const Problems = forwardRef<HTMLHeadingElement, ProblemsProps>(function Problems({ result, model: given }, headingRef) {
  const s = useStyles();
  const model = useMemo(() => given ?? buildProblems(result.findings), [given, result]);
  const [open, setOpen] = useState<ReadonlySet<ProblemCategoryId>>(new Set());
  const [status, setStatus] = useState("");
  const services = usePaneServices();

  const toggle = (id: ProblemCategoryId) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const show = async (target: FindingTarget) => {
    setStatus("");
    const r = await navigateFromPane(services, target);
    setStatus(describeNavigation(r, target, (f) => services.capabilities.explain(f)));
  };

  const { slides } = result.stats;
  const failed = result.errors.length;

  return (
    <div className={s.root} data-problems="">
      <h2 id="results-heading" ref={headingRef} tabIndex={-1} className={s.headline} data-problems-headline={model.ready ? "ready" : "problems"}>
        {model.headline}
      </h2>
      <p className={s.sub}>
        {model.ready
          ? `Checked ${plural(slides, "slide")} for broken media, missing fonts, off-slide objects, overlapping text, and heavy images.`
          : "Fix these before the show. Notes are worth a look but may be intentional."}
      </p>
      {failed > 0 && (
        <p className={s.sub}>
          {failed} {failed === 1 ? "check" : "checks"} could not finish. Results may be incomplete.
        </p>
      )}
      <ul className={s.list} aria-label="Show readiness checklist">
        {model.categories.map((c) => (
          <CategoryRow
            key={c.id}
            category={c}
            model={model}
            expanded={open.has(c.id)}
            onToggle={() => toggle(c.id)}
            onShow={(t) => void show(t)}
          />
        ))}
      </ul>
      <p role="status" aria-live="polite" className={s.status}>
        {status}
      </p>
    </div>
  );
});

function SizeHeadline({ model }: { model: ProblemsModel }) {
  const s = useStyles();
  if (!model.size) return null;
  return (
    <span className={s.count} data-size-headline="">
      File size {formatBytes(model.size.totalBytes)} · media {formatBytes(model.size.mediaBytes)}
    </span>
  );
}

interface CategoryRowProps {
  category: ProblemCategory;
  model: ProblemsModel;
  expanded: boolean;
  onToggle: () => void;
  onShow: (t: FindingTarget) => void;
}

function CategoryRow({ category: c, model, expanded, onToggle, onShow }: CategoryRowProps) {
  const s = useStyles();
  const bodyId = useId();
  return (
    <li className={s.category} data-category={c.id} data-status={c.status}>
      <button type="button" className={s.toggle} aria-expanded={expanded} aria-controls={bodyId} data-category-toggle="" onClick={onToggle}>
        <StatusIcon status={c.status} />
        <span className={s.label}>
          <span className={s.name}>{c.label}</span>
          <span className={s.count} data-category-count="">
            {countText(c)}
          </span>
          {c.id === "size" && <SizeHeadline model={model} />}
        </span>
        <span className={s.chevron} aria-hidden="true">
          {expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className={s.body} role="region" aria-label={c.label}>
          <CategoryBody category={c} model={model} onShow={onShow} />
        </div>
      )}
    </li>
  );
}

function CategoryBody({ category: c, model, onShow }: { category: ProblemCategory; model: ProblemsModel; onShow: (t: FindingTarget) => void }) {
  const s = useStyles();
  const { isAllowed } = usePlan();
  const { fixPanelSlot } = usePaneSlots();
  const [showIntentional, setShowIntentional] = useState(false);
  const moreId = useId();

  const all = [...c.findings, ...c.intentional];
  const lockedFeature = all.map((f) => featureForFinding(f)).find((f: Feature) => !isAllowed(f));
  const locked = lockedFeature !== undefined;
  const empty = all.length === 0;

  let extras: ReactNode = null;
  if (c.id === "fonts") extras = <FontsExtras model={model} />;
  if (c.id === "size") extras = <LargestMedia model={model} />;

  // Only the open fix session (and, for fonts, "Replace missing fonts…") shows here.
  const fixArea = c.id === "fonts" ? "fonts" : c.id === "off-slide" ? "review" : null;
  const fixPanel =
    !locked && fixArea && fixPanelSlot
      ? fixPanelSlot({
          area: fixArea,
          findings: c.findings,
          placement: "problems",
          ...(c.id === "fonts" && model.missingFonts.length > 0 ? { initialSources: model.missingFonts } : {}),
        })
      : null;

  return (
    <>
      {empty && <p className={s.hint}>{PASS_TEXT[c.id]}</p>}
      {locked ? (
        <LockedSection
          title={LOCKED_TITLES[c.id]}
          counts={{ warning: c.warnings, info: c.notes }}
          description="Which items these are, where they are, and how to fix them is part of SlideCheck Pro."
        />
      ) : (
        <>
          {fixPanel}
          {c.findings.length > 0 && <ProblemList findings={c.findings} label={`${c.label} problems`} onShow={onShow} />}
          {c.intentional.length > 0 && (
            <>
              <Button
                className={s.more}
                size="small"
                appearance="subtle"
                icon={showIntentional ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                aria-expanded={showIntentional}
                aria-controls={moreId}
                onClick={() => setShowIntentional((v) => !v)}
              >
                {`Possibly intentional (${c.intentional.length})`}
              </Button>
              {showIntentional && (
                <div id={moreId}>
                  <ProblemList findings={c.intentional} label="Possibly intentional" onShow={onShow} />
                </div>
              )}
            </>
          )}
        </>
      )}
      {extras}
    </>
  );
}

function ProblemList({ findings, label, onShow }: { findings: readonly Finding[]; label: string; onShow: (t: FindingTarget) => void }) {
  const s = useStyles();
  const { renderRowActions } = usePaneSlots();
  return (
    <ul className={s.items} aria-label={label}>
      {findings.map((f) => {
        const target = primaryTarget(f);
        const sub = f.detail ?? (target ? describeTarget(target) : undefined);
        const severity = isNoteLevel(f) ? "info" : f.severity;
        return (
          <li key={f.id} className={s.item} data-problem={f.kind} data-severity={severity}>
            <SeverityIcon severity={severity} />
            <span className={s.itemText}>
              <span className={s.itemTitle}>{f.title}</span>
              {sub && <span className={s.itemSub}>{sub}</span>}
            </span>
            <span className={s.actions}>
              {target && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<SlideSearch16Regular />}
                  aria-label="Show in PowerPoint"
                  title="Show in PowerPoint"
                  onClick={() => onShow(target)}
                />
              )}
              {renderRowActions?.(f, { area: f.area, active: true, tabIndex: 0 })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The show-machine font list status and its editor. Shown on every plan: the setting only changes
 * which fonts the (free) counts include.
 */
function FontsExtras({ model }: { model: ProblemsModel }) {
  const s = useStyles();
  const { showFontsSlot } = usePaneSlots();
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const provided = model.fontList?.teamListProvided === true;
  const showHint = model.fontList !== undefined && !provided;
  if (!showFontsSlot && !showHint) return null;
  return (
    <>
      <div className={s.hintRow}>
        {showHint && (
          <p className={s.hint} data-show-fonts-hint="">
            No show-machine font list set — set one to reduce false alarms.
          </p>
        )}
        {showFontsSlot && (
          <Button size="small" appearance="secondary" aria-expanded={editing} aria-controls={editorId} onClick={() => setEditing((v) => !v)}>
            {provided ? "Edit show-machine fonts" : "Set show-machine fonts"}
          </Button>
        )}
      </div>
      {editing && showFontsSlot && <div id={editorId}>{showFontsSlot({ placement: "problems" })}</div>}
    </>
  );
}

function LargestMedia({ model }: { model: ProblemsModel }) {
  const s = useStyles();
  const largest = model.size?.largest ?? [];
  if (largest.length === 0) return null;
  return (
    <div>
      <p className={s.hint}>Largest media</p>
      <ul className={s.largest} data-largest-media="">
        {largest.map((m) => (
          <li key={m.partName}>{`${m.name}: ${formatBytes(m.bytes)}`}</li>
        ))}
      </ul>
    </div>
  );
}
