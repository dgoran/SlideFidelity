/**
 * The area fix panel (`fixPanelSlot`, D11): the area's bulk fix actions, or the open fix session
 * (inline picker → preview → progress → summary). Gated by the `fixes` feature (D13: an inline
 * locked section otherwise) and by host capability (CapabilityButton with the reason, KTD4).
 *
 * In the Problems view (G1, `placement: "problems"`) the panel shows only the open fix session of
 * its area, plus "Replace missing fonts…" when it is given the missing fonts (`initialSources`,
 * G3): the same replace-font picker, preselected with the missing fonts it can reach (D2).
 */
import { useEffect, useId, useMemo, useRef } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import type { Area, Finding } from "@slidecheck/audit-core";
import { featureForFinding, usePlan } from "../../license/gate";
import { currentResult } from "../brand/themeBrand";
import { CapabilityButton } from "../components/CapabilityButton";
import { LockedSection } from "../components/LockedSection";
import { usePane } from "../state/PaneContext";
import { isBusy, useFixSession, type FixController, type FixSession } from "./controller";
import {
  colorSources,
  DELETE_ACTION_LABELS,
  DELETE_KINDS,
  deleteSources,
  draftKind,
  draftRequest,
  DRAFT_TITLES,
  FIX_AREA_TITLES,
  fontSources,
  initialDraft,
  isFixArea,
  linkSources,
  type Draft,
  type DraftSeed,
  type FixArea,
} from "./model";
import { ColorPicker, DeletePicker, FontPicker, LinkPicker } from "./Pickers";
import { PreviewView, ProgressView, SummaryView } from "./SessionViews";
import { useFixActions, type FixDeps } from "./useFixActions";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    minWidth: 0,
  },
  bar: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalS, alignItems: "flex-start" },
  heading: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, outlineStyle: "none" },
  actions: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalS, alignItems: "center" },
  alert: { margin: 0, color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase300, wordBreak: "break-word" },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

export interface FixPanelProps {
  controller: FixController;
  deps: FixDeps;
  area: Area;
  placement?: "area" | "problems";
  /** Problems placement: sources to preselect (fonts: family names). */
  initialSources?: readonly string[];
}

export function FixPanel({ controller, deps, area, placement = "area", initialSources }: FixPanelProps) {
  const session = useFixSession(controller);
  const plan = usePlan();
  const { state } = usePane();
  const result = currentResult(state.scan);
  const { isAllowed } = plan;
  const visibleFixable = useMemo(
    () => (result?.findings ?? []).some((f) => f.area === area && f.fixes.length > 0 && isAllowed(featureForFinding(f))),
    [result, area, isAllowed],
  );
  if (!isFixArea(area)) return null;

  const own = session && session.area === area ? session : null;
  if (placement === "problems") {
    // The Problems view shows its own locked details; no second lock here.
    if (!plan.isAllowed("fixes")) return null;
    if (own) return <FixPanelBody controller={controller} deps={deps} area={area} session={own} busy={isBusy(session)} />;
    if (area !== "fonts" || initialSources === undefined) return null;
    return <MissingFontsLauncher controller={controller} sources={initialSources} busy={isBusy(session)} />;
  }
  if (!own && !visibleFixable) return null;
  if (!plan.isAllowed("fixes")) {
    return (
      <LockedSection
        title={`${FIX_AREA_TITLES[area]} (Pro)`}
        description="Fixing these in place (with a preview first) is part of SlideCheck Pro."
      />
    );
  }
  return <FixPanelBody controller={controller} deps={deps} area={area} session={own} busy={isBusy(session)} />;
}

function FixPanelBody({ controller, deps, area, session, busy }: { controller: FixController; deps: FixDeps; area: FixArea; session: FixSession | null; busy: boolean }) {
  const s = useStyles();
  const { state } = usePane();
  const result = currentResult(state.scan);
  const findings = useMemo(() => (result?.findings ?? []).filter((f) => f.area === area), [result, area]);
  const titleId = useId();

  const open = (seed: DraftSeed) => controller.open(area, initialDraft(area, result, seed));

  return (
    <section className={s.root} aria-labelledby={titleId} data-fix-panel={area}>
      {session ? (
        <SessionView controller={controller} deps={deps} session={session} findings={findings} titleId={titleId} />
      ) : (
        <>
          <h3 id={titleId} className={s.heading}>
            {FIX_AREA_TITLES[area]}
          </h3>
          <div className={s.bar}>
            <BulkActions area={area} findings={findings} busy={busy} onOpen={open} />
          </div>
        </>
      )}
    </section>
  );
}

/** "Replace missing fonts…" (G3): opens the fonts picker preselected with the reachable ones. */
function MissingFontsLauncher({ controller, sources, busy }: { controller: FixController; sources: readonly string[]; busy: boolean }) {
  const s = useStyles();
  const { state } = usePane();
  const result = currentResult(state.scan);
  const draft = useMemo(() => initialDraft("fonts", result, { fonts: sources }), [result, sources]);
  const none = draft.type === "fonts" && draft.from.length === 0;
  return (
    <div className={s.bar} data-fix-launch="fonts">
      <CapabilityButton feature="replaceFonts" size="small" disabled={busy || none} onClick={() => controller.open("fonts", draft)}>
        Replace missing fonts…
      </CapabilityButton>
      {none && <p className={s.note}>These fonts can&apos;t be replaced in place (they are only in charts, SmartArt, masters, or theme fonts).</p>}
    </div>
  );
}

function BulkActions({ area, findings, busy, onOpen }: { area: FixArea; findings: readonly Finding[]; busy: boolean; onOpen: (seed: DraftSeed) => void }) {
  const hasFonts = useMemo(() => area === "fonts" && fontSources(findings).length > 0, [area, findings]);
  const hasColors = useMemo(() => area === "colors" && colorSources(findings).length > 0, [area, findings]);
  const deleteKinds = useMemo(() => {
    if (area !== "review") return [];
    const sources = deleteSources(findings);
    return DELETE_KINDS.filter((k) => sources.some((x) => x.kind === k));
  }, [area, findings]);
  const hasLinks = useMemo(() => area === "links" && linkSources(findings).length > 0, [area, findings]);
  switch (area) {
    case "fonts":
      return (
        <CapabilityButton feature="replaceFonts" size="small" disabled={busy || !hasFonts} onClick={() => onOpen({})}>
          Replace fonts…
        </CapabilityButton>
      );
    case "colors":
      return (
        <CapabilityButton feature="replaceColors" size="small" disabled={busy || !hasColors} onClick={() => onOpen({})}>
          Replace colors…
        </CapabilityButton>
      );
    case "review": {
      return (
        <>
          {deleteKinds.map((k) => (
            <CapabilityButton key={k} feature="deleteShapes" size="small" disabled={busy} onClick={() => onOpen({ deleteKind: k })}>
              {DELETE_ACTION_LABELS[k]}
            </CapabilityButton>
          ))}
        </>
      );
    }
    case "links": {
      const none = busy || !hasLinks;
      return (
        <>
          <CapabilityButton feature="hyperlinkRemove" size="small" disabled={none} onClick={() => onOpen({ linkMode: "remove" })}>
            Remove links…
          </CapabilityButton>
          <CapabilityButton feature="hyperlinkEdit" size="small" disabled={none} onClick={() => onOpen({ linkMode: "edit" })}>
            Edit a link…
          </CapabilityButton>
        </>
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------

function SessionView({
  controller,
  deps,
  session,
  findings,
  titleId,
}: {
  controller: FixController;
  deps: FixDeps;
  session: FixSession;
  findings: readonly Finding[];
  titleId: string;
}) {
  const s = useStyles();
  const { state } = usePane();
  const result = currentResult(state.scan);
  const actions = useFixActions(controller, deps);
  const pickerHeading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const summaryHeading = useRef<HTMLHeadingElement>(null);
  const previewId = useId();
  const summaryId = useId();
  const focused = useRef(0);

  // D15: move focus to the picker, the preview, or the summary heading when asked.
  useEffect(() => {
    if (focused.current === session.focusSeq) return;
    focused.current = session.focusSeq;
    const el = session.focus === "summary" ? summaryHeading.current : session.focus === "preview" ? previewHeading.current : pickerHeading.current;
    el?.focus();
  }, [session.focus, session.focusSeq]);

  const kind = draftKind(session.draft);
  const setDraft = (draft: Draft) => controller.update(session.id, { draft, stage: "picking", preview: undefined, replanned: false, confirmed: false, error: undefined });
  const close = () => controller.close();

  if (session.stage === "done" && session.outcome) {
    return (
      <SummaryView
        ref={summaryHeading}
        headingId={summaryId}
        status={session.outcome.status}
        summary={session.outcome.summary}
        rescan={session.rescan}
        copyStatus={session.copyStatus}
        onOpenCopy={() => void actions.openCopy(session)}
        onDone={close}
      />
    );
  }

  const running = session.stage === "running";
  const pickerProps = { draft: session.draft, onChange: setDraft, findings, result, disabled: running };
  const request = draftRequest(session.draft);
  const preview = session.preview;

  return (
    <>
      <h3 id={titleId} ref={pickerHeading} tabIndex={-1} className={s.heading}>
        {DRAFT_TITLES[kind]}
      </h3>
      {session.draft.type === "fonts" && <FontPicker {...pickerProps} />}
      {session.draft.type === "colors" && <ColorPicker {...pickerProps} />}
      {session.draft.type === "delete" && <DeletePicker {...pickerProps} />}
      {session.draft.type === "links" && <LinkPicker {...pickerProps} />}

      {!running && (
        <div className={s.actions}>
          {!(session.draft.type === "links" && session.draft.mode === "edit" && session.draft.address === null) && (
            <Button appearance={session.stage === "preview" ? "secondary" : "primary"} disabled={!request} onClick={() => actions.preview(session)}>
              {session.stage === "preview" ? "Update preview" : "Preview changes"}
            </Button>
          )}
          <Button appearance="subtle" onClick={close}>
            Close
          </Button>
        </div>
      )}

      {session.error && (
        <p className={s.alert} role="alert">
          {session.error}
        </p>
      )}

      {session.stage === "preview" && preview && preview.status !== "ready" && (
        <p className={s.alert} role="alert" ref={previewHeading} tabIndex={-1}>
          {preview.reason}
        </p>
      )}
      {session.stage === "preview" && preview?.status === "ready" && (
        <PreviewView
          ref={previewHeading}
          headingId={previewId}
          plan={preview.plan}
          replanned={session.replanned === true}
          confirmed={session.confirmed}
          onConfirm={(confirmed) => controller.update(session.id, { confirmed })}
          onApply={() => void actions.apply(session)}
        />
      )}
      {running && <ProgressView progress={session.progress} cancelling={session.cancelling === true} onCancel={() => actions.cancel(session)} />}
    </>
  );
}
