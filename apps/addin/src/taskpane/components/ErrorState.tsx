/** Failed state (D10): a plain-language message per error kind, with Retry. */
import { forwardRef } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import type { ScanErrorKind } from "../../office/scan";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  heading: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold, outlineStyle: "none" },
  text: { margin: 0, color: tokens.colorNeutralForeground2 },
  details: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, overflowWrap: "anywhere" },
  retry: { alignSelf: "flex-start" },
});

interface Copy {
  title: string;
  message: string;
}

export function errorCopy(kind: ScanErrorKind, isWeb = false): Copy {
  switch (kind) {
    case "read-failed":
      return isWeb
        ? {
            title: "Waiting for PowerPoint to save",
            message:
              "PowerPoint on the web has to finish saving before SlideCheck can read the presentation. Wait a moment, then try again.",
          }
        : {
            title: "SlideCheck couldn't read the presentation",
            message: "PowerPoint didn't provide a copy of the file. If the presentation is still saving, wait a moment and try again.",
          };
    case "empty":
      return { title: "This presentation is empty", message: "There is nothing to scan yet. Add a slide, then try again." };
    case "not-a-presentation":
      return {
        title: "This file can't be scanned",
        message: "SlideCheck reads PowerPoint presentations (.pptx). Save the file as a PowerPoint Presentation, then try again.",
      };
    case "damaged-file":
      return {
        title: "Part of this presentation couldn't be read",
        message: "The file may be damaged. Save a copy in PowerPoint and scan again.",
      };
    case "audit-crashed":
      return {
        title: "The scan stopped unexpectedly",
        message: "This can happen with very large presentations. Close other large files and try again.",
      };
    case "cancelled":
      return { title: "Scan cancelled", message: "The scan was cancelled before it finished." };
    case "internal":
      return { title: "Something went wrong", message: "SlideCheck hit an unexpected problem while scanning. Try again." };
  }
}

export interface ErrorStateProps {
  kind: ScanErrorKind;
  /** Technical detail; shown as plain text only. */
  message?: string;
  isWeb?: boolean;
  onRetry: () => void;
}

export const ErrorState = forwardRef<HTMLHeadingElement, ErrorStateProps>(function ErrorState(
  { kind, message, isWeb, onRetry },
  headingRef,
) {
  const s = useStyles();
  const copy = errorCopy(kind, isWeb);
  return (
    <section className={s.root} role="alert" data-error-kind={kind}>
      <h2 ref={headingRef} tabIndex={-1} className={s.heading}>
        {copy.title}
      </h2>
      <p className={s.text}>{copy.message}</p>
      {message && (
        <details className={s.details}>
          <summary>Technical details</summary>
          {message}
        </details>
      )}
      <Button className={s.retry} appearance="primary" onClick={onRetry}>
        Retry
      </Button>
    </section>
  );
});
