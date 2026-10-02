/**
 * Area picker (R1, D15): the Problems view (G1, first) and the seven areas in a native dropdown,
 * which suits a narrow pane and is fully keyboard operable (arrow keys, type-ahead, Enter/Space)
 * on every host.
 */
import { useId } from "react";
import { Label, Select, makeStyles, tokens } from "@fluentui/react-components";
import { AREAS, type Area, type AreaSummary } from "@slidecheck/audit-core";
import { areaAccess, usePlan } from "../../license/gate";
import { AREA_LABELS, VIEW_LABELS } from "../context";
import type { PaneView } from "../state/store";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, minWidth: 0 },
});

export interface AreaPickerProps {
  value: PaneView;
  onChange: (view: PaneView) => void;
  /** Per-area counts for the option labels (omitted before the first scan). */
  summary?: AreaSummary;
  /** Problems to fix (G1), for the Problems option label. */
  problemCount?: number;
}

/** The Problems option: never locked (its headline and counts are free, G1). */
export function problemsOptionLabel(problemCount: number | undefined): string {
  if (problemCount === undefined) return VIEW_LABELS.problems;
  return problemCount === 0 ? `${VIEW_LABELS.problems} (ready for show)` : `${VIEW_LABELS.problems} (${problemCount} to fix)`;
}

export function optionLabel(area: Area, summary: AreaSummary | undefined, locked: boolean): string {
  let label = AREA_LABELS[area];
  if (summary && area !== "overview") {
    const c = summary[area];
    label += ` (${c.warning} ${c.warning === 1 ? "warning" : "warnings"}, ${c.info} info)`;
  }
  return locked ? `${label} - Pro` : label;
}

export function AreaPicker({ value, onChange, summary, problemCount }: AreaPickerProps) {
  const s = useStyles();
  const id = useId();
  const { plan } = usePlan();
  return (
    <div className={s.root}>
      <Label htmlFor={id} size="small">
        Area
      </Label>
      <Select id={id} value={value} onChange={(_e, d) => onChange(d.value as PaneView)} data-area-picker="">
        <option value="problems">{problemsOptionLabel(problemCount)}</option>
        {AREAS.map((a) => (
          <option key={a} value={a}>
            {optionLabel(a, summary, areaAccess(plan, a) === "locked")}
          </option>
        ))}
      </Select>
    </div>
  );
}
