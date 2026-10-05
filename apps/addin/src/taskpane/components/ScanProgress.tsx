/** Scanning state (D10): per-area progress with Cancel. */
import { Button, ProgressBar, makeStyles, tokens } from "@fluentui/react-components";
import { CheckmarkCircle16Regular, Circle16Regular } from "@fluentui/react-icons";
import { AREAS, type Area } from "@slidefidelity/audit-core";
import type { ScanPhase } from "../../office/scan";
import { AREA_LABELS } from "../context";
import type { AreaProgress } from "../state/store";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  heading: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  text: { margin: 0, color: tokens.colorNeutralForeground2 },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "grid", gap: tokens.spacingVerticalXXS },
  item: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200 },
  done: { color: tokens.colorPaletteGreenForeground1 },
  cancel: { alignSelf: "flex-start" },
});

export interface ScanProgressProps {
  phase: ScanPhase;
  areas: Record<Area, AreaProgress>;
  completed: number;
  total: number;
  isWeb?: boolean;
  onCancel: () => void;
}

export function ScanProgress({ phase, areas, completed, total, isWeb, onCancel }: ScanProgressProps) {
  const s = useStyles();
  const phaseText =
    phase === "reading"
      ? isWeb
        ? "Waiting for PowerPoint to save, then reading the presentation…"
        : "Reading the presentation…"
      : `Checking ${completed} of ${total} areas…`;
  return (
    <section className={s.root} aria-labelledby="scan-progress-heading" data-scan-progress="">
      <h2 id="scan-progress-heading" className={s.heading}>
        Scanning
      </h2>
      <p className={s.text} role="status" aria-live="polite">
        {phaseText}
      </p>
      <ProgressBar
        value={phase === "reading" ? undefined : total ? completed / total : 0}
        aria-label="Scan progress"
        thickness="large"
      />
      <ul className={s.list} aria-label="Areas">
        {AREAS.map((a) => {
          const done = areas[a] === "done";
          return (
            <li key={a} className={s.item} data-area={a} data-state={areas[a]}>
              {done ? <CheckmarkCircle16Regular className={s.done} aria-hidden="true" /> : <Circle16Regular aria-hidden="true" />}
              <span>
                {AREA_LABELS[a]}: {done ? "done" : "waiting"}
              </span>
            </li>
          );
        })}
      </ul>
      <Button className={s.cancel} onClick={onCancel}>
        Cancel
      </Button>
    </section>
  );
}
