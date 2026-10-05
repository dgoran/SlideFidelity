/**
 * Account (U15, D8, D12, D15): the header entry, its panel, and non-blocking notices.
 *
 * Panel states, straight from the licensing core's `LicenseState`:
 * - anonymous: "Sign in to start your 30-day free trial", with a note after a session expired or a
 *   saved sign-in was rejected;
 * - signed in: the email, Sign out, and Delete account (with a confirm step and error display);
 * - trial: days left (and a non-blocking notice at 3 days or fewer);
 * - offline grace: a banner with the date Pro lapses; grace ended: why Pro is paused;
 * - free / expired: Manage subscription (+ "Your trial has ended");
 * - Refresh with the last-checked time; a note when sign-in cannot be saved on this device.
 *
 * No prices or checkout inside the pane (U15): purchases happen on the website.
 */
import { useId, useState, type ReactNode } from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Dismiss16Regular, Person20Regular } from "@fluentui/react-icons";
import { TRIAL_WARNING_DAYS, LicenseError, type LicenseState } from "../../license/license";
import { ctaLabel } from "../../license/gate";
import { useAccount } from "../license/LicenseBridge";
import { HeaderPanel } from "./HeaderPanel";

const useStyles = makeStyles({
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, minWidth: 0 },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, overflowWrap: "anywhere" },
  sub: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  strong: { fontWeight: tokens.fontWeightSemibold },
  row: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalS, alignItems: "center" },
  banner: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    margin: 0,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorPaletteMarigoldBackground1,
    border: `1px solid ${tokens.colorPaletteMarigoldBorder1}`,
  },
  info: { backgroundColor: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}` },
  error: { backgroundColor: tokens.colorPaletteRedBackground1, border: `1px solid ${tokens.colorPaletteRedBorder1}` },
  bannerBody: { flex: "1 1 auto", display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, minWidth: 0 },
  label: { maxWidth: "12em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  danger: { color: tokens.colorPaletteRedForeground1 },
});

export const PLAN_LABELS: Record<LicenseState["plan"], string> = {
  anonymous: "Not signed in",
  free: "Free",
  trial: "Pro trial",
  pro: "Pro",
  expired: "Free",
};

const defaultFormatDate = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
const defaultFormatDateTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export interface Formatters {
  formatDate?: (t: number) => string;
  formatDateTime?: (t: number) => string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function Banner({ tone = "warning", children, data }: { tone?: "warning" | "info" | "error"; children: ReactNode; data?: string }) {
  const s = useStyles();
  const extra = data ? { [`data-${data}`]: "" } : {};
  return (
    <div
      className={mergeClasses(s.banner, tone === "info" && s.info, tone === "error" && s.error)}
      role={tone === "error" ? "alert" : "status"}
      {...extra}
    >
      <div className={s.bannerBody}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Header entry

export function AccountEntry(props: Formatters) {
  const { state } = useAccount();
  const s = useStyles();
  const email = state.account?.email;
  const planText = PLAN_LABELS[state.plan];
  const label = email ? `Account: ${email}, ${planText}` : "Account: not signed in";
  return (
    <HeaderPanel
      label={label}
      icon={<Person20Regular />}
      buttonContent={<span className={s.label}>{email ? planText : "Sign in"}</span>}
      title="Account"
      dataAttr="account-entry"
    >
      <AccountPanel {...props} />
    </HeaderPanel>
  );
}

// ---------------------------------------------------------------------------------------------
// Panel

export function AccountPanel({ formatDate = defaultFormatDate, formatDateTime = defaultFormatDateTime }: Formatters) {
  const s = useStyles();
  const { state, service, signIn, manageSubscription, signingIn, signInNotice } = useAccount();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const confirmId = useId();

  const signedIn = state.plan !== "anonymous";

  const doRefresh = () => {
    setRefreshing(true);
    void service
      .refresh()
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  const doDelete = () => {
    setDeleting(true);
    setDeleteError(null);
    service.deleteAccount().then(
      () => {
        setDeleting(false);
        setConfirmDelete(false);
      },
      (e: unknown) => {
        setDeleting(false);
        setDeleteError(e instanceof LicenseError ? e.message : "Something went wrong and your account was not deleted. Try again.");
      },
    );
  };

  return (
    <div className={s.section} data-account-panel={state.plan}>
      {signInNotice && (
        <Banner tone="info" data="signin-notice">
          <p className={s.text}>{signInNotice}</p>
        </Banner>
      )}

      {!signedIn && (
        <div className={s.section} data-account-state="anonymous">
          {state.reason === "session-expired" && (
            <p className={s.sub} data-reason="session-expired">
              Your session has expired. Sign in again to continue.
            </p>
          )}
          {state.reason === "token-rejected" && (
            <p className={s.sub} data-reason="token-rejected">
              Your saved sign-in couldn&apos;t be verified, so it was removed. Sign in again.
            </p>
          )}
          <p className={s.text}>Sign in with your email to unlock the full audit, the Inspector, and fixes.</p>
          <div className={s.row}>
            <Button appearance="primary" onClick={signIn} disabled={signingIn}>
              {ctaLabel("sign-in-trial")}
            </Button>
          </div>
          {signingIn && <p className={s.sub}>Finish signing in in the SlideFidelity window…</p>}
        </div>
      )}

      {signedIn && state.account && (
        <div className={s.section} data-account-state={state.plan}>
          <p className={s.text}>
            Signed in as <span className={s.strong} data-account-email="">{state.account.email}</span>
          </p>
          <p className={s.sub} data-plan-label="">
            Plan: {PLAN_LABELS[state.plan]}
          </p>

          {state.plan === "trial" && state.trialDaysLeft !== undefined && (
            <p className={s.text} data-trial-days="">
              {state.trialDaysLeft === 0 ? "Your trial ends today." : `${plural(state.trialDaysLeft, "day")} left in your trial.`}
              {state.trialEndsAt !== undefined && <span className={s.sub}> Ends {formatDate(state.trialEndsAt)}.</span>}
            </p>
          )}
          {state.plan === "trial" && state.trialDaysLeft !== undefined && state.trialDaysLeft <= TRIAL_WARNING_DAYS && (
            <Banner data="trial-ending">
              <p className={s.text}>Your trial is ending soon. Subscribe on the website to keep Pro.</p>
            </Banner>
          )}

          {state.offline && state.graceUntil !== undefined && (
            <Banner data="offline-grace">
              <p className={s.text}>
                You&apos;re offline. Pro stays active until {formatDate(state.graceUntil)}; connect before then so SlideFidelity can check
                your subscription.
              </p>
            </Banner>
          )}
          {state.offline && state.graceUntil === undefined && (
            <p className={s.sub} data-offline="">
              Can&apos;t reach SlideFidelity right now. Your plan is shown as last checked.
            </p>
          )}

          {state.reason === "grace-ended" && (
            <Banner data="grace-ended">
              <p className={s.text}>
                SlideFidelity couldn&apos;t confirm your subscription for more than 7 days, so Pro features are paused. Connect to the
                internet and press Refresh.
              </p>
            </Banner>
          )}
          {state.reason === "token-rejected" && (
            <p className={s.sub} data-reason="token-rejected">
              Your plan couldn&apos;t be verified. Press Refresh to try again.
            </p>
          )}

          {(state.plan === "free" || state.plan === "expired") && (
            <div className={s.section} data-manage="">
              {state.reason === "trial-ended" && (
                <p className={s.text} data-reason="trial-ended">
                  Your trial has ended.
                </p>
              )}
              {state.reason === "subscription-ended" && (
                <p className={s.text} data-reason="subscription-ended">
                  Your subscription has ended.
                </p>
              )}
              <p className={s.sub}>Subscribe or manage billing on the SlideFidelity website.</p>
              <div className={s.row}>
                <Button appearance="primary" onClick={manageSubscription}>
                  {ctaLabel("manage-subscription")}
                </Button>
              </div>
            </div>
          )}
          {state.plan === "pro" && (
            <div className={s.row}>
              <Button onClick={manageSubscription}>{ctaLabel("manage-subscription")}</Button>
            </div>
          )}

          <div className={s.row}>
            <Button onClick={doRefresh} disabled={refreshing}>
              {refreshing ? "Checking…" : "Refresh"}
            </Button>
            <span className={s.sub} data-last-checked="">
              {state.lastChecked === null ? "Not checked yet" : `Last checked ${formatDateTime(state.lastChecked)}`}
            </span>
          </div>

          <div className={s.row}>
            <Button onClick={() => void service.signOut()}>Sign out</Button>
            {!confirmDelete && (
              <Button
                appearance="subtle"
                className={s.danger}
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDelete(true);
                }}
              >
                Delete account…
              </Button>
            )}
          </div>

          {confirmDelete && (
            <div className={s.section} role="group" aria-labelledby={confirmId} data-delete-confirm="">
              <p id={confirmId} className={s.text}>
                Delete your SlideFidelity account? Any subscription is cancelled and this can&apos;t be undone.
              </p>
              <div className={s.row}>
                <Button appearance="primary" onClick={doDelete} disabled={deleting}>
                  {deleting ? "Deleting…" : "Delete my account"}
                </Button>
                <Button onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  Keep my account
                </Button>
              </div>
              {deleteError && (
                <Banner tone="error" data="delete-error">
                  <p className={s.text}>{deleteError}</p>
                </Banner>
              )}
            </div>
          )}
        </div>
      )}

      {!state.persistent && (
        <p className={s.sub} data-not-persistent="">
          This device doesn&apos;t let SlideFidelity save your sign-in, so you&apos;ll need to sign in again next time.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Notices above the pane body (non-blocking; dismissible for this session)

type NoticeKind = "trial-ending" | "offline-grace" | "grace-ended" | "session-expired";

export function AccountNotices({ formatDate = defaultFormatDate }: Formatters) {
  const s = useStyles();
  const { state, signIn, manageSubscription, service } = useAccount();
  const [dismissed, setDismissed] = useState<ReadonlySet<NoticeKind>>(new Set());

  const notices: { kind: NoticeKind; body: ReactNode; action?: ReactNode }[] = [];
  if (state.plan === "trial" && state.trialDaysLeft !== undefined && state.trialDaysLeft <= TRIAL_WARNING_DAYS) {
    notices.push({
      kind: "trial-ending",
      body:
        state.trialDaysLeft === 0
          ? "Your SlideFidelity Pro trial ends today."
          : `Your SlideFidelity Pro trial ends in ${plural(state.trialDaysLeft, "day")}.`,
      action: (
        <Button size="small" onClick={manageSubscription}>
          {ctaLabel("manage-subscription")}
        </Button>
      ),
    });
  }
  if (state.offline && state.graceUntil !== undefined) {
    notices.push({ kind: "offline-grace", body: `You're offline. Pro stays active until ${formatDate(state.graceUntil)}.` });
  }
  if (state.reason === "grace-ended") {
    notices.push({
      kind: "grace-ended",
      body: "Pro features are paused because SlideFidelity couldn't check your subscription for more than 7 days.",
      action: (
        <Button size="small" onClick={() => void service.refresh().catch(() => {})}>
          Refresh
        </Button>
      ),
    });
  }
  if (state.plan === "anonymous" && state.reason === "session-expired") {
    notices.push({
      kind: "session-expired",
      body: "Your session has expired. Sign in again to keep your trial or subscription.",
      action: (
        <Button size="small" onClick={signIn}>
          Sign in
        </Button>
      ),
    });
  }

  const visible = notices.filter((n) => !dismissed.has(n.kind));
  if (visible.length === 0) return null;
  return (
    <div className={s.section} data-account-notices="">
      {visible.map((n) => (
        <div key={n.kind} className={s.banner} role="status" data-notice={n.kind}>
          <div className={s.bannerBody}>
            <p className={s.text}>{n.body}</p>
            {n.action && <div className={s.row}>{n.action}</div>}
          </div>
          <Button
            size="small"
            appearance="transparent"
            icon={<Dismiss16Regular />}
            aria-label="Dismiss"
            onClick={() => setDismissed((d) => new Set([...d, n.kind]))}
          />
        </div>
      ))}
    </div>
  );
}
