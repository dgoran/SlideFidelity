/**
 * A compact header entry that opens a panel (D15): a disclosure button (`aria-expanded`,
 * `aria-controls`) and a non-modal panel below the header. Opening moves focus to the panel;
 * Escape or the Close button closes it and returns focus to the button. Used by the account
 * entry (U15) and the settings entry (brand profile, D9).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, makeStyles, tokens, type ButtonProps } from "@fluentui/react-components";
import { Dismiss16Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  wrap: { position: "relative", display: "inline-flex" },
  panel: {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    zIndex: 10,
    width: "min(320px, calc(100vw - 24px))",
    maxHeight: "min(70vh, 560px)",
    overflowY: "auto",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
    outlineStyle: "none",
  },
  top: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  title: { margin: 0, flex: "1 1 auto", fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
});

export interface HeaderPanelProps {
  /** Accessible name of the toggle button. */
  label: string;
  /** Visible button content (defaults to `label`). */
  buttonContent?: ReactNode;
  icon?: ButtonProps["icon"];
  title: string;
  /** Extra attribute for tests / styling hooks. */
  dataAttr?: string;
  defaultOpen?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
}

export function HeaderPanel({ label, buttonContent, icon, title, dataAttr, defaultOpen = false, children }: HeaderPanelProps) {
  const s = useStyles();
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const titleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  useEffect(() => {
    if (open && opened.current) panelRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const dataProps = dataAttr ? { [`data-${dataAttr}`]: "" } : {};

  return (
    <span className={s.wrap} {...dataProps}>
      <Button
        ref={buttonRef}
        appearance="subtle"
        icon={icon}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={buttonContent === undefined && !icon ? undefined : label}
        title={label}
        onClick={() => {
          opened.current = true;
          setOpen((o) => !o);
        }}
      >
        {buttonContent === undefined ? (icon ? undefined : label) : buttonContent}
      </Button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={s.panel}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <div className={s.top}>
            <h2 id={titleId} className={s.title}>
              {title}
            </h2>
            <Button appearance="subtle" size="small" icon={<Dismiss16Regular />} aria-label={`Close ${title}`} onClick={close} />
          </div>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </span>
  );
}
