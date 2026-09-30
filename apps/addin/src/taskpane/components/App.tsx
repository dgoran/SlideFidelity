/**
 * The pane shell (R1, D10, D15): explicit states with no auto-scan.
 *
 * - not scanned: a one-line explanation (the Scan button is in the header);
 * - scanning: per-area progress with Cancel;
 * - failed: a plain-language message with Retry;
 * - ready: the area picker, then the Overview or one area's findings, then the Inspector slot.
 *
 * After a scan completes, focus moves to the results heading (or the error heading) (D15).
 * Extension points: pass `slots` (see `PaneSlots` in ../context) for U11/U12/U13/U15/brand editor.
 */
import { useEffect, useRef } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { PaneSlotsContext, AREA_LABELS, usePaneServices, type PaneSlots } from "../context";
import { usePane } from "../state/PaneContext";
import { AreaPicker } from "./AreaPicker";
import { AreaView } from "./AreaView";
import { ErrorState } from "./ErrorState";
import { Header } from "./Header";
import { Overview } from "./Overview";
import { ScanProgress } from "./ScanProgress";

const useStyles = makeStyles({
  root: {
    minHeight: "100vh",
    minWidth: 0,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    overflowX: "hidden",
  },
  main: {
    flex: "1 1 auto",
    minHeight: 0,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
  },
  intro: { margin: 0, color: tokens.colorNeutralForeground2 },
  heading: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold, outlineStyle: "none" },
});

export interface AppProps {
  slots?: PaneSlots;
  /** Fixed tree viewport height (tests). */
  treeViewportHeight?: number;
}

export default function App({ slots = {}, treeViewportHeight }: AppProps) {
  const s = useStyles();
  const { state, startScan, cancelScan, selectArea } = usePane();
  const { isWeb } = usePaneServices();
  const scan = state.scan;
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const errorHeading = useRef<HTMLHeadingElement>(null);
  const prevStatus = useRef(scan.status);

  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = scan.status;
    if (was !== "scanning") return;
    if (scan.status === "ready") resultsHeading.current?.focus();
    else if (scan.status === "failed") errorHeading.current?.focus();
  }, [scan.status]);

  const scanNow = () => void startScan();

  let body;
  if (scan.status === "not-scanned") {
    body = (
      <p className={s.intro}>
        Scan this presentation to find hidden problems: unwanted fonts, off-brand colors, heavy media, unused layouts, links,
        and hidden content. The file is checked on this device and never uploaded.
      </p>
    );
  } else if (scan.status === "scanning") {
    body = (
      <ScanProgress
        phase={scan.phase}
        areas={scan.areas}
        completed={scan.completed}
        total={scan.total}
        isWeb={isWeb}
        onCancel={cancelScan}
      />
    );
  } else if (scan.status === "failed") {
    body = <ErrorState ref={errorHeading} kind={scan.kind} message={scan.message} isWeb={isWeb} onRetry={scanNow} />;
  } else {
    const area = state.area;
    body = (
      <>
        <AreaPicker value={area} onChange={selectArea} summary={scan.result.stats.perArea} />
        <h2 id="results-heading" ref={resultsHeading} tabIndex={-1} className={s.heading}>
          {AREA_LABELS[area]}
        </h2>
        {area === "overview" ? (
          <Overview result={scan.result} onSelectArea={selectArea} />
        ) : (
          <AreaView area={area} result={scan.result} {...(treeViewportHeight !== undefined ? { viewportHeight: treeViewportHeight } : {})} />
        )}
        {slots.inspectorSlot}
      </>
    );
  }

  return (
    <PaneSlotsContext.Provider value={slots}>
      <div className={s.root}>
        <Header scan={scan} onScan={scanNow} accountSlot={slots.accountSlot} settingsSlot={slots.settingsSlot} />
        <main className={s.main} aria-busy={scan.status === "scanning"}>
          {slots.noticeSlot}
          {body}
        </main>
      </div>
    </PaneSlotsContext.Provider>
  );
}
