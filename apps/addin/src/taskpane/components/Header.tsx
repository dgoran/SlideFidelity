/** Header (R1, R3, D4, D10): title, scan status, the Scan / Rescan button, and the account slot. */
import type { ReactNode } from "react";
import { Button, Image, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowClockwise16Regular } from "@fluentui/react-icons";
import type { ScanOptionKind, ScanState } from "../state/store";

const useStyles = makeStyles({
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  brand: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, flex: "1 1 auto", minWidth: 0 },
  titles: { display: "flex", flexDirection: "column", minWidth: 0 },
  title: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  status: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  hint: { color: tokens.colorPaletteMarigoldForeground2 },
  actions: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
});

export function statusText(scan: ScanState, formatTime: (t: number) => string): string {
  switch (scan.status) {
    case "not-scanned":
      return "Not scanned yet";
    case "scanning":
      return "Scanning…";
    case "failed":
      return "Scan failed";
    case "ready":
      return `Scanned at ${formatTime(scan.scannedAt)}`;
  }
}

/** The "rescan to apply" hint for the settings that changed since the scan. */
export function optionsChangedText(changed: readonly ScanOptionKind[] | undefined): string {
  const kinds = new Set(changed ?? []);
  if (kinds.has("show-fonts") && kinds.has("brand")) return "Settings changed. Rescan to apply them.";
  if (kinds.has("show-fonts")) return "Show-machine fonts changed. Rescan to apply them.";
  return "Brand profile changed. Rescan to apply it.";
}

const defaultFormatTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export interface HeaderProps {
  scan: ScanState;
  onScan: () => void;
  accountSlot?: ReactNode;
  settingsSlot?: ReactNode;
  formatTime?: (t: number) => string;
}

export function Header({ scan, onScan, accountSlot, settingsSlot, formatTime = defaultFormatTime }: HeaderProps) {
  const s = useStyles();
  const hasResults = scan.status === "ready" || (scan.status !== "not-scanned" && scan.previous !== undefined);
  const outdated = scan.status === "ready" && scan.possiblyOutdated;
  const optionsChanged = scan.status === "ready" && scan.optionsChanged === true;
  const changedText = scan.status === "ready" ? optionsChangedText(scan.changedOptions) : "";
  return (
    <header className={s.header}>
      <div className={s.brand}>
        <Image width={24} height={24} src="assets/logo-filled.png" alt="" />
        <div className={s.titles}>
          <h1 className={s.title}>SlideFidelity</h1>
          <p className={s.status} data-scan-status="">
            {statusText(scan, formatTime)}
            {outdated && <span className={s.hint}> · The presentation may have changed since this scan.</span>}
            {optionsChanged && (
              <span className={s.hint} data-options-changed="">
                {" "}
                · {changedText}
              </span>
            )}
          </p>
        </div>
      </div>
      <div className={s.actions}>
        <Button
          appearance={scan.status === "not-scanned" || outdated || optionsChanged ? "primary" : "secondary"}
          icon={hasResults ? <ArrowClockwise16Regular /> : undefined}
          disabled={scan.status === "scanning"}
          onClick={onScan}
        >
          {hasResults ? "Rescan" : "Scan"}
        </Button>
        {settingsSlot}
        {accountSlot}
      </div>
    </header>
  );
}
