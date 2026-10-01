import { MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";

/** Shown whenever the development-only Pro unlock is active (src/license/devUnlock.ts). */
export function DevUnlockBanner() {
  return (
    <MessageBar intent="warning" data-dev-unlock="">
      <MessageBarBody>
        <MessageBarTitle>Development unlock</MessageBarTitle>
        Pro features are enabled because this development build runs from localhost. Production builds can&apos;t do
        this.
      </MessageBarBody>
    </MessageBar>
  );
}
