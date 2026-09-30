/**
 * Inline locked state for Pro-only features (D8, D13, AE5).
 *
 * The call to action depends on the plan, via the gate (single source of truth):
 * anonymous → "Sign in to start your 30-day free trial" (opens sign-in);
 * free / expired → "Manage subscription" (opens the website account page).
 * Trial and Pro see nothing. U15 wires the callbacks through `PlanProvider` (or these props).
 */
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { LockClosed16Regular } from "@fluentui/react-icons";
import { ctaLabel, usePlan } from "../../license/gate";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  text: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  cta: { alignSelf: "flex-start" },
});

export interface LockedSectionProps {
  title: string;
  description?: string;
  /** Counts of the locked findings (D7: counts stay visible, details stay gated). */
  counts?: { warning: number; info: number };
  /** Override the plan context's sign-in handler. */
  onSignIn?: () => void;
  /** Override the plan context's manage-subscription handler. */
  onManageSubscription?: () => void;
}

export function LockedSection({ title, description, counts, onSignIn, onManageSubscription }: LockedSectionProps) {
  const s = useStyles();
  const plan = usePlan();
  const action = plan.lockAction;
  if (!action) return null;
  const onClick =
    action === "sign-in-trial" ? (onSignIn ?? plan.requestSignIn) : (onManageSubscription ?? plan.openManageSubscription);
  const countText =
    counts && counts.warning + counts.info > 0 ? `${counts.warning} warnings and ${counts.info} information items.` : null;
  return (
    <section className={s.root} aria-label={title} data-locked-section="">
      <h3 className={s.title}>
        <LockClosed16Regular aria-hidden="true" />
        {title}
      </h3>
      {countText && <p className={s.text}>{countText}</p>}
      {description && <p className={s.text}>{description}</p>}
      <Button className={s.cta} appearance="primary" size="small" onClick={onClick} data-lock-action={action}>
        {ctaLabel(action)}
      </Button>
    </section>
  );
}
