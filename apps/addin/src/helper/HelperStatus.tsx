/**
 * SlideFidelity Helper status (helper plan U12, R1, R5; H1, H5, H7): shown in the Problems view's
 * Fonts category and in Settings.
 *
 * - Probing: "Checking for SlideFidelity Helper…".
 * - Connected: "Exact font check: on (SlideFidelity Helper vX)", plus a notify-only update notice (H5)
 *   and a certificate-renewal note when fewer than 90 days remain (H1).
 * - Offered: the install offer (`HelperOffer`).
 * - Waiting: "Waiting for SlideFidelity Helper…" with Cancel.
 * - Silent (web, iPad, mobile, or dismissed): "Using show-machine list". In Settings, a dismissed
 *   user on desktop can still start the install.
 * - Outdated: "SlideFidelity Helper vX is too old for this version of SlideFidelity" with a download.
 *
 * Helper-reported strings (versions, notes) are untrusted and rendered as React text only; pages
 * open only through the store (https-checked, `openBrowserWindow`).
 */
import { useSyncExternalStore } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { HelperOffer } from "./HelperOffer";
import { certNeedsRenewal, type HelperSnapshot, type HelperStore } from "./state";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, minWidth: 0, wordBreak: "break-word" },
  framed: {
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  heading: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  line: { margin: 0, fontSize: tokens.fontSizeBase300 },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  bar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
});

export type HelperStatusStore = Pick<
  HelperStore,
  "getSnapshot" | "subscribe" | "install" | "cancelInstall" | "notNow" | "dontAskAgain" | "openDownloadPage" | "openUpdatePage"
>;

export function useHelperSnapshot(store: Pick<HelperStore, "getSnapshot" | "subscribe">): HelperSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function connectedText(version: string): string {
  return `Exact font check: on (SlideFidelity Helper v${version})`;
}

export function certText(days: number): string {
  const n = Math.max(0, days);
  return `The helper's certificate expires in ${n} ${n === 1 ? "day" : "days"}. Reinstall SlideFidelity Helper to renew it.`;
}

export interface HelperStatusProps {
  store: HelperStatusStore;
  placement: "problems" | "settings";
}

export function HelperStatus({ store, placement }: HelperStatusProps) {
  const s = useStyles();
  const snap = useHelperSnapshot(store);
  const inSettings = placement === "settings";
  return (
    <section className={inSettings ? s.root : `${s.root} ${s.framed}`} aria-label="SlideFidelity Helper" data-helper-status={snap.phase} data-placement={placement}>
      {inSettings && <span className={s.heading}>SlideFidelity Helper</span>}
      <Body snap={snap} store={store} inSettings={inSettings} />
    </section>
  );
}

function Body({ snap, store, inSettings }: { snap: HelperSnapshot; store: HelperStatusStore; inSettings: boolean }) {
  const s = useStyles();
  switch (snap.phase) {
    case "probing":
      return (
        <p className={s.note} role="status">
          Checking for SlideFidelity Helper…
        </p>
      );
    case "connected": {
      const h = snap.health;
      return (
        <>
          <p className={s.line} role="status">
            {connectedText(h?.version ?? "?")}
          </p>
          {h?.update && (
            <div className={s.bar} data-helper-update="">
              <p className={s.note}>{`Helper update available (v${h.update.version})`}</p>
              <Button size="small" appearance="secondary" onClick={() => store.openUpdatePage()}>
                Get the update
              </Button>
            </div>
          )}
          {h?.update?.notes && <p className={s.note}>{h.update.notes}</p>}
          {certNeedsRenewal(h) && (
            <div className={s.bar} data-helper-cert="">
              <p className={s.note}>{certText(h.certDaysRemaining)}</p>
              <Button size="small" appearance="secondary" onClick={() => store.openDownloadPage()}>
                Download SlideFidelity Helper
              </Button>
            </div>
          )}
        </>
      );
    }
    case "offered":
      return <HelperOffer store={store} />;
    case "waiting":
      return (
        <>
          <p className={s.line} role="status">
            Waiting for SlideFidelity Helper…
          </p>
          <p className={s.note}>Run the installer you downloaded. SlideFidelity connects to the helper automatically.</p>
          <div className={s.bar}>
            <Button size="small" appearance="secondary" onClick={() => store.cancelInstall()}>
              Cancel
            </Button>
          </div>
        </>
      );
    case "outdated":
      return (
        <>
          <p className={s.line} role="status">
            {`SlideFidelity Helper v${snap.health?.version ?? "?"} is too old for this version of SlideFidelity`}
          </p>
          <div className={s.bar}>
            <Button size="small" appearance="primary" onClick={() => store.install()}>
              Download the latest SlideFidelity Helper
            </Button>
          </div>
        </>
      );
    case "silent":
      return (
        <>
          <p className={s.note} role="status">
            Using show-machine list
          </p>
          {inSettings && snap.reason !== "host" && (
            <div className={s.bar}>
              <Button size="small" appearance="secondary" onClick={() => store.install()}>
                Install SlideFidelity Helper
              </Button>
            </div>
          )}
          {inSettings && snap.reason === "dismissed" && !snap.dismissPersistent && (
            <p className={s.note}>This device doesn&apos;t allow saving settings, so this choice lasts until the pane closes.</p>
          )}
        </>
      );
  }
}
