/**
 * A button for a host-API-gated action (R17, KTD4, AE4). When the host lacks the API version the
 * feature needs, the button is disabled and the reason ("Requires a newer version of PowerPoint
 * (PowerPointApi 1.10)") is shown next to it and linked with `aria-describedby`.
 * U12/U13 use this for fix actions such as "Remove link".
 */
import { useId, type ReactNode } from "react";
import { Button, makeStyles, tokens, type ButtonProps } from "@fluentui/react-components";
import type { CapabilityFeature } from "../../office/capabilities";
import { useCapabilities } from "../context";

const useStyles = makeStyles({
  wrap: { display: "inline-flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, minWidth: 0 },
  note: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

export interface CapabilityButtonProps {
  feature: CapabilityFeature;
  /** Extra app-level reason to disable (e.g. nothing selected). */
  disabled?: boolean;
  onClick?: () => void;
  appearance?: ButtonProps["appearance"];
  size?: ButtonProps["size"];
  icon?: ButtonProps["icon"];
  /** Accessible name when the visible text alone is ambiguous (e.g. "Edit" in a list). */
  ariaLabel?: string;
  children?: ReactNode;
}

export function CapabilityButton({ feature, disabled, children, onClick, appearance, size, icon, ariaLabel }: CapabilityButtonProps) {
  const s = useStyles();
  const reason = useCapabilities().explain(feature);
  const noteId = useId();
  return (
    <span className={s.wrap}>
      <Button appearance={appearance} size={size} icon={icon} onClick={onClick} aria-label={ariaLabel} disabled={!!reason || !!disabled} aria-describedby={reason ? noteId : undefined}>
        {children}
      </Button>
      {reason && (
        <span id={noteId} className={s.note}>
          {reason}
        </span>
      )}
    </span>
  );
}
