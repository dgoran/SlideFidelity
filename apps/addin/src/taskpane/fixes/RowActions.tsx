/**
 * Per-row fix action (`renderRowActions`, D11): a compact button on a finding row that opens the
 * area's inline picker with that finding preselected. Shown only for findings that list a fix and
 * reach at least one target, and only when the plan allows fixes. It follows the tree's roving
 * tab index (D15): focusable only on the active row.
 */
import { Button } from "@fluentui/react-components";
import { Wrench16Regular } from "@fluentui/react-icons";
import type { Finding } from "@slidecheck/audit-core";
import { usePlan } from "../../license/gate";
import { currentResult } from "../brand/themeBrand";
import { useCapabilities, type RowActionContext } from "../context";
import { usePane } from "../state/PaneContext";
import { isBusy, useFixSession, type FixController } from "./controller";
import { initialDraft, isFixable, isFixArea, KIND_FEATURE, type FixArea } from "./model";

type Kind = Finding["fixes"][number];

const ROW_LABELS: Record<Kind, string> = {
  "replace-font": "Replace font",
  "replace-color": "Replace color",
  "delete-shapes": "Delete shape",
  "remove-hyperlink": "Fix link",
  "edit-hyperlink": "Fix link",
  "set-title-size": "Set title size",
  "remove-slide-numbers": "Remove slide numbers",
};

const AREA_KINDS: Record<FixArea, readonly Kind[]> = {
  fonts: ["replace-font", "set-title-size"],
  colors: ["replace-color"],
  review: ["delete-shapes", "remove-slide-numbers"],
  links: ["remove-hyperlink", "edit-hyperlink"],
};

export interface FixRowActionProps {
  controller: FixController;
  finding: Finding;
  ctx: RowActionContext;
}

export function FixRowAction({ controller, finding, ctx }: FixRowActionProps) {
  const plan = usePlan();
  const caps = useCapabilities();
  const { state } = usePane();
  const session = useFixSession(controller);
  const area = ctx.area;
  if (ctx.target !== undefined || !isFixArea(area) || !plan.isAllowed("fixes") || !isFixable(finding)) return null;
  const kinds = AREA_KINDS[area].filter((k) => finding.fixes.includes(k));
  if (kinds.length === 0) return null;

  const supported = kinds.filter((k) => caps.supports(KIND_FEATURE[k]));
  const reason = supported.length === 0 ? caps.explain(KIND_FEATURE[kinds[0]!]) : null;
  const label = ROW_LABELS[kinds[0]!];
  const open = () => {
    const result = currentResult(state.scan);
    controller.open(area, initialDraft(area, result, { finding }, caps.supports("hyperlinkRemove")));
  };
  return (
    <Button
      size="small"
      appearance="subtle"
      icon={<Wrench16Regular />}
      data-row-fix=""
      aria-label={`${label}: ${finding.title}`}
      title={reason ?? `${label}…`}
      tabIndex={ctx.tabIndex}
      disabled={isBusy(session) || supported.length === 0}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
    />
  );
}
