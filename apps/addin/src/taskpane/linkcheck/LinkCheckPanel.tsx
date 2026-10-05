/**
 * Link reachability UI (U9 UI, R11, R18; KTD7, KTD9).
 *
 * - `LinkCheckPanel` (`fixPanelSlot`, Links area only): "Check links", gated by the `linkcheck`
 *   feature (an inline locked section with the D8 call to action otherwise). Before the first check
 *   of the pane session a one-line disclosure says what leaves the device; then a progress line
 *   with Cancel, the summary, and a plain-language message for rate limits and sign-in problems.
 * - `LinkRowStatus` (`renderRowActions`): the address's status on each hyperlink finding row, by
 *   icon SHAPE as well as color, plus text (D15).
 *
 * Untrusted-content rule: addresses and server reasons are deck/server data. They are rendered only
 * as React text (known reasons are mapped to fixed wording); nothing here builds an `href`.
 */
import { useEffect, useId, useMemo, useRef } from "react";
import { Button, makeStyles, mergeClasses, Spinner, tokens } from "@fluentui/react-components";
import {
  CheckmarkCircle16Regular,
  DismissCircle16Filled,
  QuestionCircle16Regular,
  SubtractCircle16Regular,
} from "@fluentui/react-icons";
import type { Area, Finding } from "@slidefidelity/audit-core";
import { usePlan } from "../../license/gate";
import { checkableUrls, type LinkCheckResult, type LinkStatus } from "../../office/linkCheck";
import { currentResult } from "../brand/themeBrand";
import { LockedSection } from "../components/LockedSection";
import type { RowActionContext } from "../context";
import { usePane } from "../state/PaneContext";
import { useLinkCheck, viewFor, type LinkCheckController, type LinkCheckCounts, type LinkCheckState } from "./controller";

export const DISCLOSURE_TEXT =
  "Checking sends the web addresses (http/https only) in this deck to the SlideFidelity service. Nothing else from the deck is sent.";

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
  heading: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  row: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalS, alignItems: "center" },
  text: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, wordBreak: "break-word" },
  summary: { margin: 0, fontSize: tokens.fontSizeBase300 },
  alert: { margin: 0, fontSize: tokens.fontSizeBase300, color: tokens.colorPaletteRedForeground1, wordBreak: "break-word" },
  disclosure: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    maxWidth: "150px",
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "nowrap",
  },
  badgeText: { overflow: "hidden", textOverflow: "ellipsis" },
  icon: { flexShrink: 0, display: "inline-flex" },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  broken: { color: tokens.colorPaletteRedForeground1 },
  unverified: { color: tokens.colorPaletteDarkOrangeForeground1 },
  notChecked: { color: tokens.colorNeutralForeground3 },
});

// ---------------------------------------------------------------------------------------------
// Wording

/** Fixed wording for the backend's `unverified` reasons (anything else is not echoed). */
const UNVERIFIED_REASONS: Record<string, string> = {
  access_denied: "access denied",
  rate_limited: "the site limited requests",
  server_error: "site error",
  timeout: "timed out",
  network_error: "no response",
  too_many_redirects: "too many redirects",
  invalid_redirect: "bad redirect",
  invalid_url: "invalid address",
  blocked: "private address",
  dns_error: "address lookup failed",
};

const NOT_CHECKED_REASONS: Record<string, string> = {
  "not-http": "not a web address",
  "too-long": "address too long",
  "rate-limited": "rate limited",
  unauthorized: "signed out",
  "pro-required": "Pro only",
  "invalid-request": "not accepted",
  "network-error": "no connection",
  "server-error": "service error",
  "no-result": "no answer",
};

const own = (o: Readonly<Record<string, string>>, k: string | undefined): string | undefined =>
  k !== undefined && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

/** Row text for one result: "OK", "Broken (404)", "Could not verify (access denied)", … */
export function statusLabel(r: LinkCheckResult): string {
  switch (r.status) {
    case "ok":
      return "OK";
    case "broken": {
      const why = r.httpStatus !== undefined ? String(r.httpStatus) : r.reason === "nxdomain" ? "site not found" : undefined;
      return why ? `Broken (${why})` : "Broken";
    }
    case "unverified": {
      const why = own(UNVERIFIED_REASONS, r.reason) ?? (r.httpStatus !== undefined ? `HTTP ${r.httpStatus}` : undefined);
      return why ? `Could not verify (${why})` : "Could not verify";
    }
    default: {
      const why = own(NOT_CHECKED_REASONS, r.reason);
      return why ? `Not checked (${why})` : "Not checked";
    }
  }
}

export function summaryText(c: LinkCheckCounts): string {
  return `${c.ok} OK, ${c.broken} broken, ${c.unverified} could not verify, ${c.notChecked} not checked`;
}

/** "about 9 minutes" / "about 1 minute" / "about 3 hours". */
export function waitText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 90) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hours`;
}

export function errorMessage(error: NonNullable<LinkCheckState["error"]>): string {
  const retry = error.retryAfterSeconds !== undefined ? `Try again in ${waitText(error.retryAfterSeconds)}.` : "Try again later.";
  switch (error.code) {
    case "rate_limited":
      return `Too many link checks right now. ${retry}`;
    case "daily_capacity_reached":
      return `Link checking has reached its limit for today. ${retry}`;
    case "unauthorized":
      return "Your sign-in has expired. Sign in again to check links.";
    case "pro_required":
      return "SlideFidelity says this account doesn't include link checking. Open Account to check your plan.";
    case "network_error":
      return "Couldn't reach SlideFidelity. Check your connection and try again.";
    case "server_error":
      return "Some links couldn't be checked because of a problem on our side. Try again later.";
    case "invalid_urls":
      return "Some addresses couldn't be sent for checking.";
  }
}

// ---------------------------------------------------------------------------------------------
// Panel

export interface LinkCheckPanelProps {
  controller: LinkCheckController;
  area: Area;
}

export function LinkCheckPanel({ controller, area }: LinkCheckPanelProps) {
  const { state: pane } = usePane();
  const result = currentResult(pane.scan);
  const plan = usePlan();
  const state = useLinkCheck(controller);
  const urls = useMemo(() => (result ? checkableUrls(result.findings.filter((f) => f.area === "links")) : []), [result]);

  // A new scan clears the results (and aborts a check still running for the old one).
  useEffect(() => controller.sync(result), [controller, result]);

  if (area !== "links" || !result || urls.length === 0) return null;
  if (!plan.isAllowed("linkcheck")) {
    // The whole Links area already shows its own lock and call to action; don't stack a second one.
    if (!plan.isAllowed("area.links")) return null;
    return (
      <div data-linkcheck-panel="">
        <LockedSection title="Check links (Pro)" description="Checking whether web links still work is part of SlideFidelity Pro." />
      </div>
    );
  }
  return <PanelBody controller={controller} view={viewFor(state, result)} onCheck={() => controller.request(result, urls)} urlCount={urls.length} />;
}

function PanelBody({
  controller,
  view,
  onCheck,
  urlCount,
}: {
  controller: LinkCheckController;
  view: LinkCheckState | null;
  onCheck: () => void;
  urlCount: number;
}) {
  const s = useStyles();
  const plan = usePlan();
  const titleId = useId();
  const continueRef = useRef<HTMLButtonElement>(null);
  const phase = view?.phase ?? "idle";
  const checking = phase === "checking";

  useEffect(() => {
    if (phase === "disclosure") continueRef.current?.focus();
  }, [phase]);

  const n = view?.pending.length || urlCount;
  return (
    <section className={s.root} aria-labelledby={titleId} data-linkcheck-panel="">
      <h3 id={titleId} className={s.heading}>
        Link reachability
      </h3>
      <div className={s.row}>
        <Button size="small" disabled={checking || phase === "disclosure"} onClick={onCheck}>
          Check links
        </Button>
        <span className={s.text}>
          {urlCount} web {urlCount === 1 ? "address" : "addresses"}
        </span>
      </div>

      {phase === "disclosure" && (
        <div className={s.disclosure} data-linkcheck-disclosure="" role="group" aria-label="Before checking links">
          <p className={s.text}>{DISCLOSURE_TEXT}</p>
          <div className={s.row}>
            <Button ref={continueRef} size="small" appearance="primary" onClick={() => controller.accept()}>
              Continue
            </Button>
            <Button size="small" onClick={() => controller.decline()}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div role="status" aria-live="polite">
        {checking && (
          <div className={s.row} data-linkcheck-progress="">
            <Spinner size="tiny" aria-hidden="true" />
            <span className={s.text}>
              Checking {n} {n === 1 ? "link" : "links"}…
            </span>
            <Button size="small" onClick={() => controller.cancel()}>
              Cancel
            </Button>
          </div>
        )}
        {!checking && view?.counts && (
          <p className={s.summary} data-linkcheck-summary="">
            {summaryText(view.counts)}
          </p>
        )}
        {!checking && phase === "cancelled" && (
          <p className={s.text} data-linkcheck-message="">
            Link check cancelled. No results were kept.
          </p>
        )}
        {!checking && view?.error && (
          <div className={s.row}>
            <p className={s.alert} data-linkcheck-message="">
              {errorMessage(view.error)}
            </p>
            {view.error.code === "unauthorized" && (
              <Button size="small" appearance="primary" onClick={plan.requestSignIn}>
                Sign in
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Row status

const STATUS_ICON: Record<LinkStatus, { Icon: typeof CheckmarkCircle16Regular; shape: string; cls: "ok" | "broken" | "unverified" | "notChecked" }> = {
  ok: { Icon: CheckmarkCircle16Regular, shape: "check", cls: "ok" },
  broken: { Icon: DismissCircle16Filled, shape: "cross", cls: "broken" },
  unverified: { Icon: QuestionCircle16Regular, shape: "question", cls: "unverified" },
  "not-checked": { Icon: SubtractCircle16Regular, shape: "dash", cls: "notChecked" },
};

export interface LinkRowStatusProps {
  controller: LinkCheckController;
  finding: Finding;
  ctx: RowActionContext;
}

export function LinkRowStatus({ controller, finding, ctx }: LinkRowStatusProps) {
  const s = useStyles();
  const { state: pane } = usePane();
  const view = viewFor(useLinkCheck(controller), currentResult(pane.scan));
  if (!view || ctx.target !== undefined || ctx.area !== "links" || finding.kind !== "hyperlink") return null;
  const address = (finding.data as { address?: unknown } | undefined)?.address;
  if (typeof address !== "string" || !Object.prototype.hasOwnProperty.call(view.byUrl, address)) return null;
  const r = view.byUrl[address]!;
  const { Icon, shape, cls } = STATUS_ICON[r.status];
  const label = statusLabel(r);
  return (
    <span className={mergeClasses(s.badge, s[cls])} data-link-status={r.status} title={label}>
      <span className={s.icon} data-link-status-icon={shape} aria-hidden="true">
        <Icon />
      </span>
      <span className={s.badgeText}>{label}</span>
    </span>
  );
}
