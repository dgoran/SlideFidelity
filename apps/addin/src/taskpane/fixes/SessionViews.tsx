/**
 * Preview (R16, D11), progress with Cancel (U12), and the result summary (R16, D16).
 * All labels and reasons that include deck text are rendered as React text only.
 */
import { forwardRef, type ReactNode } from "react";
import { Button, Checkbox, ProgressBar, makeStyles, tokens } from "@fluentui/react-components";
import type { FixPlan, FixProgress, FixSummary, PlannedTarget, TargetResult, UnreachableTarget } from "../../office/fixes";
import type { RescanStatus } from "./controller";
import { applyLabel, confirmLabel, groupBy, plural, unitNoun } from "./model";

const useStyles = makeStyles({
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: 0 },
  heading: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, outlineStyle: "none" },
  sub: { margin: 0, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, wordBreak: "break-word" },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, wordBreak: "break-word" },
  scroll: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalL,
    maxHeight: "160px",
    overflowY: "auto",
    fontSize: tokens.fontSizeBase200,
    wordBreak: "break-word",
  },
  notes: { margin: 0, paddingLeft: tokens.spacingHorizontalL, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  alert: { margin: 0, color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase300, wordBreak: "break-word" },
  notice: {
    margin: 0,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteYellowBackground1,
    fontSize: tokens.fontSizeBase300,
  },
  actions: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalS, alignItems: "center" },
});

function slideName(n: number | undefined): string {
  return n === undefined ? "Slide ?" : `Slide ${n}`;
}

/** Items grouped under their reason, each group in a scrollable list. */
function ReasonGroups<T>({ items, reason, label }: { items: readonly T[]; reason: (t: T) => string; label: (t: T) => string }) {
  const s = useStyles();
  return (
    <>
      {groupBy(items, reason).map(([why, list]) => (
        <div key={why}>
          <p className={s.muted}>{`${why} (${list.length})`}</p>
          <ul className={s.scroll}>
            {list.map((it, i) => (
              <li key={i}>{label(it)}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function Unreachable({ items, title }: { items: readonly UnreachableTarget[]; title: string }) {
  const s = useStyles();
  if (items.length === 0) return null;
  return (
    <div data-unreachable="">
      <p className={s.sub}>{`${title} (${items.length})`}</p>
      <ReasonGroups items={items} reason={(u) => u.reason} label={(u) => u.label} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export interface PreviewViewProps {
  plan: FixPlan;
  replanned: boolean;
  confirmed: boolean;
  onConfirm: (on: boolean) => void;
  onApply: () => void;
  headingId: string;
}

export const PreviewView = forwardRef<HTMLHeadingElement, PreviewViewProps>(function PreviewView(
  { plan, replanned, confirmed, onConfirm, onApply, headingId },
  ref,
) {
  const s = useStyles();
  const n = plan.targets.length;
  const noun = unitNoun(plan.kind);
  const needsConfirm = plan.destructive;
  return (
    <section className={s.section} aria-labelledby={headingId} data-fix-preview="">
      <h4 id={headingId} ref={ref} tabIndex={-1} className={s.heading}>
        Preview
      </h4>
      {replanned && (
        <p className={s.notice} role="status">
          The presentation changed since the last scan. Review the updated preview.
        </p>
      )}
      <p className={s.text}>{`${plural(n, noun)} on ${plural(plan.perSlide.length, "slide")}`}</p>
      {plan.perSlide.length > 0 && (
        <ul className={s.scroll} data-per-slide="" aria-label="Changes per slide" tabIndex={0}>
          {plan.perSlide.map((c) => (
            <li key={c.slideId}>{`${slideName(c.slideNumber)}: ${plural(c.count, noun)}`}</li>
          ))}
        </ul>
      )}
      <Unreachable items={plan.unreachable} title="Can't be changed in place" />
      {plan.notes.length > 0 && (
        <ul className={s.notes} data-fix-notes="">
          {plan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {needsConfirm && n > 0 && (
        <Checkbox label={confirmLabel(plan.kind, n)} checked={confirmed} onChange={(_e, d) => onConfirm(d.checked === true)} />
      )}
      <div className={s.actions}>
        <Button appearance="primary" disabled={n === 0 || (needsConfirm && !confirmed)} onClick={onApply}>
          {applyLabel(plan.kind, n)}
        </Button>
      </div>
    </section>
  );
});

// ---------------------------------------------------------------------------------------------

export function ProgressView({ progress, cancelling, onCancel }: { progress: FixProgress | undefined; cancelling: boolean; onCancel: () => void }) {
  const s = useStyles();
  const label = progress
    ? `Batch ${progress.batch} of ${progress.batches}: ${progress.done} of ${progress.total} done`
    : "Checking the presentation…";
  return (
    <section className={s.section} data-fix-progress="" aria-label="Fix progress">
      <p className={s.text} role="status">
        {label}
      </p>
      <ProgressBar value={progress && progress.total > 0 ? progress.done / progress.total : undefined} aria-label="Fix progress" />
      <div className={s.actions}>
        <Button disabled={cancelling} onClick={onCancel}>
          {cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
      {cancelling && <p className={s.muted}>Stopping after the current batch.</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

export interface SummaryViewProps {
  status: "completed" | "cancelled";
  summary: FixSummary;
  rescan: RescanStatus | undefined;
  copyStatus: { ok: boolean; message: string } | undefined;
  onOpenCopy: () => void;
  onDone: () => void;
  headingId: string;
}

function Bucket({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const s = useStyles();
  if (count === 0) return null;
  return (
    <div>
      <p className={s.sub}>{`${title} (${count})`}</p>
      {children}
    </div>
  );
}

const labelOf = (r: TargetResult) => r.target.label;

export const SummaryView = forwardRef<HTMLHeadingElement, SummaryViewProps>(function SummaryView(
  { status, summary, rescan, copyStatus, onOpenCopy, onDone, headingId },
  ref,
) {
  const s = useStyles();
  const changed = `${summary.changed} changed`;
  return (
    <section className={s.section} aria-labelledby={headingId} data-fix-summary="">
      <h3 id={headingId} ref={ref} tabIndex={-1} className={s.heading}>
        Fix results
      </h3>
      <p className={s.text}>{status === "cancelled" ? `Cancelled. ${changed} before stopping.` : `Done. ${changed}.`}</p>

      <Bucket title="Skipped" count={summary.skipped.length}>
        <ReasonGroups items={summary.skipped} reason={(r) => r.reason ?? "Skipped"} label={labelOf} />
      </Bucket>
      <Bucket title="Failed" count={summary.failed.length}>
        <ReasonGroups items={summary.failed} reason={(r) => r.reason ?? "Failed"} label={labelOf} />
      </Bucket>
      <Bucket title="May or may not have changed" count={summary.unknown.length}>
        <p className={s.muted}>PowerPoint reported an error while applying these. They may or may not have changed; rescan to check.</p>
        <ul className={s.scroll}>
          {summary.unknown.map((r) => (
            <li key={r.target.key}>{r.target.label}</li>
          ))}
        </ul>
      </Bucket>
      <Bucket title="Not run" count={summary.notRun.length}>
        <p className={s.muted}>Not attempted because the fix was cancelled.</p>
        <ul className={s.scroll}>
          {summary.notRun.map((t: PlannedTarget) => (
            <li key={t.key}>{t.label}</li>
          ))}
        </ul>
      </Bucket>
      <Unreachable items={summary.unreachable} title="Not reachable" />

      {rescan && (
        <p className={s.muted} role="status">
          {rescan === "running"
            ? "Updating results…"
            : rescan === "done"
              ? "Results updated."
              : "The results could not be refreshed. Scan again to update them."}
        </p>
      )}

      <div className={s.actions}>
        <Button onClick={onOpenCopy} disabled={summary.preFixBytes.length === 0}>
          Open pre-fix copy
        </Button>
        <Button appearance="primary" onClick={onDone}>
          Done
        </Button>
      </div>
      <p className={s.muted}>The pre-fix copy is the file as it was before this fix. It opens as a new, unsaved presentation.</p>
      {copyStatus && (
        <p className={copyStatus.ok ? s.muted : s.alert} role={copyStatus.ok ? "status" : "alert"}>
          {copyStatus.message}
        </p>
      )}
    </section>
  );
});
