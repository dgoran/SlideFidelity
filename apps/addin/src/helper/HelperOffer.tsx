/**
 * The SlideFidelity Helper install offer (helper plan U12, R5; H2): shown on desktop Mac/PC when no
 * helper answers. Install opens the download page for this platform and waits for the helper;
 * Not now hides the offer for this session; Don't ask again hides it for good.
 */
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import type { HelperStore } from "./state";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, minWidth: 0 },
  title: { margin: 0, fontSize: tokens.fontSizeBase300 },
  secondary: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  bar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
});

export const OFFER_TEXT = "Install SlideFidelity Helper for exact missing-font checks";
export const OFFER_SECONDARY = "Already installed? Approve the SlideFidelity Helper certificate prompt, or sign out and back in.";

export function HelperOffer({ store }: { store: Pick<HelperStore, "install" | "notNow" | "dontAskAgain"> }) {
  const s = useStyles();
  return (
    <div className={s.root} data-helper-offer="">
      <p className={s.title}>{OFFER_TEXT}</p>
      <p className={s.secondary}>{OFFER_SECONDARY}</p>
      <div className={s.bar}>
        <Button size="small" appearance="primary" onClick={() => store.install()}>
          Install
        </Button>
        <Button size="small" appearance="secondary" onClick={() => store.notNow()}>
          Not now
        </Button>
        <Button size="small" appearance="subtle" onClick={() => store.dontAskAgain()}>
          Don&apos;t ask again
        </Button>
      </div>
    </div>
  );
}
