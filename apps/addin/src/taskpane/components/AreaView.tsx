/**
 * One detail area (D13, D14): the findings the plan allows, in the tree, plus an inline locked
 * section for Pro-only findings. Hosts the U12/U13 fix panel slot and the brand editor slot.
 */
import { useMemo } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import type { Area, AuditResult, Finding } from "@slidecheck/audit-core";
import { featureForFinding, usePlan, type Feature } from "../../license/gate";
import { AREA_LABELS, usePaneSlots } from "../context";
import { filterFindings } from "../model/tree";
import { usePane } from "../state/PaneContext";
import { FindingsTree } from "./FindingsTree";
import { LockedSection } from "./LockedSection";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, minHeight: 0, flex: "1 1 auto" },
  empty: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  sub: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

/** What the locked part of an area is called, for the locked section title. */
const LOCKED_TITLES: Partial<Record<Feature, string>> = {
  "area.fonts.flags": "Font flags",
  "area.media.issues": "Image issues",
};

function countSeverities(fs: readonly Finding[]) {
  let warning = 0;
  let info = 0;
  for (const f of fs) {
    if (f.severity === "info") info += 1;
    else warning += 1;
  }
  return { warning, info };
}

export interface AreaViewProps {
  area: Exclude<Area, "overview">;
  result: AuditResult;
  /** Passed to the tree (tests use a fixed height). */
  viewportHeight?: number;
}

export function AreaView({ area, result, viewportHeight }: AreaViewProps) {
  const s = useStyles();
  const { isAllowed } = usePlan();
  const { state } = usePane();
  const { fixPanelSlot, brandSlot } = usePaneSlots();

  const { allowed, locked, lockedTitle } = useMemo(() => {
    const allowed: Finding[] = [];
    const locked: Finding[] = [];
    let lockedFeature: Feature | undefined;
    for (const f of result.findings) {
      if (f.area !== area) continue;
      const feature = featureForFinding(f);
      if (isAllowed(feature)) allowed.push(f);
      else {
        locked.push(f);
        lockedFeature ??= feature;
      }
    }
    const lockedTitle =
      allowed.length === 0 ? `${AREA_LABELS[area]} is a Pro feature` : `${(lockedFeature && LOCKED_TITLES[lockedFeature]) ?? "More findings"} (Pro)`;
    return { allowed, locked, lockedTitle };
  }, [result, area, isAllowed]);

  const visible = useMemo(
    () => (fixPanelSlot ? filterFindings(allowed, { severity: state.severity, search: state.search }) : allowed),
    [fixPanelSlot, allowed, state.severity, state.search],
  );

  const nothing = allowed.length === 0 && locked.length === 0;
  const { slides, shapes } = result.stats;

  return (
    <div className={s.root} data-area-view={area}>
      {(area === "fonts" || area === "colors") && brandSlot?.({ area })}
      {/* Always offered: the fix panel decides (it keeps showing a fix summary after the area empties). */}
      {fixPanelSlot?.({ area, findings: visible })}
      {nothing && (
        <div data-empty-state="">
          <p className={s.empty}>No issues found</p>
          <p className={s.sub}>
            Checked {slides} {slides === 1 ? "slide" : "slides"} and {shapes} {shapes === 1 ? "shape" : "shapes"}.
          </p>
        </div>
      )}
      {allowed.length > 0 && (
        <FindingsTree area={area} findings={allowed} {...(viewportHeight !== undefined ? { viewportHeight } : {})} />
      )}
      {locked.length > 0 && (
        <LockedSection
          title={lockedTitle}
          counts={countSeverities(locked)}
          description="Details and fixes for these findings are part of SlideCheck Pro."
        />
      )}
    </div>
  );
}
