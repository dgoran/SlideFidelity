/**
 * Brand profile editor (D9, R22; Pro via the `brand` feature).
 *
 * - No custom profile: "Using the deck's theme", listing the theme fonts and colors the last scan
 *   saw, with "Customize" (starts from those) and Import JSON.
 * - Custom profile: allowed fonts (add / remove, typed), allowed colors (hex input + swatches,
 *   including one-click theme colors), tolerance (bounded number), Import / Export JSON, and
 *   Reset to theme.
 *
 * Every change is saved in the brand store (which the scan service reads through `getOptions`)
 * and marks the results as needing a rescan. Imported JSON is untrusted: it goes through
 * `parseBrandJson` and field errors are shown as text. Deck strings (font names, hex values) are
 * rendered as text only; swatch colors are validated hex before they reach a style.
 */
import { useId, useMemo, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent } from "react";
import { Button, Input, Label, Textarea, makeStyles, tokens } from "@fluentui/react-components";
import { Add16Regular, Dismiss12Regular, Settings20Regular } from "@fluentui/react-icons";
import {
  DEFAULT_COLOR_TOLERANCE,
  MAX_BRAND_COLORS,
  MAX_BRAND_FONTS,
  MAX_BRAND_TOLERANCE,
  MAX_FONT_NAME_LENGTH,
  normalizeHex,
  parseBrandJson,
  serializeBrand,
  type BrandFieldError,
  type BrandProfile,
} from "@slidecheck/audit-core";
import { usePlan } from "../../license/gate";
import type { BrandStore } from "../brand/brandStore";
import { currentResult, themeBrandFromResult, themeBrandProfile } from "../brand/themeBrand";
import { usePane } from "../state/PaneContext";
import { HeaderPanel } from "./HeaderPanel";
import { LockedSection } from "./LockedSection";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: 0 },
  framed: {
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  bar: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: tokens.spacingHorizontalS },
  heading: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  sub: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  status: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, flex: "1 1 auto" },
  group: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, border: "none", margin: 0, padding: 0, minWidth: 0 },
  legend: { padding: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    maxWidth: "100%",
    padding: "2px 2px 2px 8px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
  },
  chipText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  swatch: {
    flexShrink: 0,
    width: "14px",
    height: "14px",
    borderRadius: "3px",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  row: { display: "flex", alignItems: "flex-end", gap: tokens.spacingHorizontalXS, flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, flex: "1 1 140px", minWidth: 0 },
  error: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorPaletteRedForeground1 },
  errors: { margin: 0, paddingLeft: tokens.spacingHorizontalL, fontSize: tokens.fontSizeBase200, color: tokens.colorPaletteRedForeground1 },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  fileInput: { fontSize: tokens.fontSizeBase200, maxWidth: "100%" },
});

/** Download text as a file through a Blob URL (our own serialized JSON; never deck data as a URL). */
export function downloadText(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function describeBrand(profile: BrandProfile | null): string {
  if (!profile) return "Using the deck's theme";
  const f = profile.fonts.length;
  const c = profile.colors.length;
  return `Custom brand: ${f} ${f === 1 ? "font" : "fonts"}, ${c} ${c === 1 ? "color" : "colors"}`;
}

function Swatch({ hex }: { hex: string }) {
  const s = useStyles();
  const safe = normalizeHex(hex);
  return <span aria-hidden="true" className={s.swatch} style={safe ? { backgroundColor: `#${safe}` } : undefined} />;
}

export interface BrandEditorProps {
  store: BrandStore;
  /** Where the editor is shown: inline in an area (collapsed by default) or in settings (open). */
  placement?: "fonts" | "colors" | "settings";
  /** Test hook for Export JSON. */
  download?: (filename: string, text: string) => void;
}

export function BrandEditor({ store, placement = "settings", download = downloadText }: BrandEditorProps) {
  const s = useStyles();
  const { isAllowed } = usePlan();
  const profile = useSyncExternalStore(store.subscribe, store.get, store.get);
  const inline = placement !== "settings";
  const [open, setOpen] = useState(!inline);
  const bodyId = useId();
  const headingId = useId();

  if (!isAllowed("brand")) {
    return (
      <LockedSection
        title="Brand profile (Pro)"
        description="Set your brand's fonts and colors so SlideCheck flags everything off-brand."
      />
    );
  }

  return (
    <section className={inline ? `${s.root} ${s.framed}` : s.root} aria-labelledby={headingId} data-brand-editor={placement}>
      <div className={s.bar}>
        {inline ? (
          <h3 id={headingId} className={s.heading}>
            Brand profile
          </h3>
        ) : (
          <span id={headingId} className={s.heading}>
            Brand profile
          </span>
        )}
        <p className={s.status} data-brand-status="">
          {describeBrand(profile)}
        </p>
        {inline && (
          <Button size="small" appearance="subtle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Edit brand"}
          </Button>
        )}
      </div>
      {open && (
        <div id={bodyId} className={s.root}>
          <BrandEditorBody store={store} profile={profile} download={download} />
        </div>
      )}
    </section>
  );
}

function BrandEditorBody({
  store,
  profile,
  download,
}: {
  store: BrandStore;
  profile: BrandProfile | null;
  download: (filename: string, text: string) => void;
}) {
  const s = useStyles();
  const { state, dispatch } = usePane();
  const result = currentResult(state.scan);
  const theme = useMemo(() => themeBrandFromResult(result), [result]);
  const ids = { font: useId(), color: useId(), tol: useId(), paste: useId(), file: useId() };

  const [fontText, setFontText] = useState("");
  const [fontError, setFontError] = useState("");
  const [colorText, setColorText] = useState("");
  const [colorError, setColorError] = useState("");
  const [tolText, setTolText] = useState<string | null>(null);
  const [tolError, setTolError] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [importErrors, setImportErrors] = useState<BrandFieldError[]>([]);
  const [importNote, setImportNote] = useState("");

  const save = (next: BrandProfile | null) => {
    store.set(next);
    dispatch({ type: "scan/options-changed" });
  };

  const base: BrandProfile = profile ?? themeBrandProfile(theme);
  const edit = (patch: Partial<BrandProfile>) => save({ ...base, ...patch });

  const addFont = () => {
    const name = fontText.trim();
    if (!name) return setFontError("Type a font name.");
    if (name.length > MAX_FONT_NAME_LENGTH) return setFontError(`Font names are at most ${MAX_FONT_NAME_LENGTH} characters.`);
    if (base.fonts.some((f) => f.toLowerCase() === name.toLowerCase())) return setFontError("That font is already in the list.");
    if (base.fonts.length >= MAX_BRAND_FONTS) return setFontError(`At most ${MAX_BRAND_FONTS} fonts.`);
    setFontError("");
    setFontText("");
    edit({ fonts: [...base.fonts, name] });
  };

  const addColor = (input: string) => {
    const hex = normalizeHex(input.trim());
    if (!hex) return setColorError('Enter a hex color like "#4472C4".');
    if (base.colors.includes(hex)) return setColorError("That color is already in the list.");
    if (base.colors.length >= MAX_BRAND_COLORS) return setColorError(`At most ${MAX_BRAND_COLORS} colors.`);
    setColorError("");
    setColorText("");
    edit({ colors: [...base.colors, hex] });
  };

  const onTolerance = (text: string) => {
    setTolText(text);
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n) || n < 0 || n > MAX_BRAND_TOLERANCE) {
      setTolError(`Enter a number from 0 to ${MAX_BRAND_TOLERANCE}.`);
      return;
    }
    setTolError("");
    edit({ tolerance: n });
  };

  const importJson = (text: string) => {
    const r = parseBrandJson(text);
    if (!r.ok) {
      setImportNote("");
      setImportErrors(r.errors);
      return;
    }
    setImportErrors([]);
    setImportNote("Brand profile imported.");
    setTolText(null);
    save(r.brand);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 1_000_000) {
      setImportErrors([{ field: "", message: "That file is too large to be a brand profile." }]);
      return;
    }
    void file.text().then(importJson, () => setImportErrors([{ field: "", message: "The file could not be read." }]));
  };

  const onEnter = (fn: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fn();
    }
  };

  const themeColorsToAdd = theme.colors.filter((c) => !base.colors.includes(c.hex));

  return (
    <>
      {!profile && (
        <>
          <p className={s.note}>
            SlideCheck checks fonts and colors against the deck&apos;s theme. Customize to set your own brand.
          </p>
          <fieldset className={s.group}>
            <legend className={s.legend}>Theme fonts</legend>
            {theme.fonts.length ? (
              <ul className={s.list} aria-label="Theme fonts">
                {theme.fonts.map((f) => (
                  <li key={f} className={s.chip}>
                    <span className={s.chipText}>{f}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.note}>Scan the presentation to see its theme fonts.</p>
            )}
          </fieldset>
          <fieldset className={s.group}>
            <legend className={s.legend}>Theme colors</legend>
            {theme.colors.length ? (
              <ul className={s.list} aria-label="Theme colors">
                {theme.colors.map((c) => (
                  <li key={c.hex} className={s.chip}>
                    <Swatch hex={c.hex} />
                    <span className={s.chipText}>#{c.hex}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.note}>Scan the presentation to see its theme colors.</p>
            )}
          </fieldset>
          <div className={s.bar}>
            <Button appearance="primary" size="small" onClick={() => save(themeBrandProfile(theme))}>
              Customize brand
            </Button>
            <Button size="small" onClick={() => download("brand-profile.json", serializeBrand(base))}>
              Export JSON
            </Button>
          </div>
        </>
      )}

      {profile && (
        <>
          <fieldset className={s.group}>
            <legend className={s.legend}>Allowed fonts</legend>
            {profile.fonts.length === 0 ? (
              <p className={s.note}>No fonts yet: the theme fonts are used.</p>
            ) : (
              <ul className={s.list} aria-label="Allowed fonts">
                {profile.fonts.map((f) => (
                  <li key={f} className={s.chip} data-brand-font="">
                    <span className={s.chipText}>{f}</span>
                    <Button
                      size="small"
                      appearance="transparent"
                      icon={<Dismiss12Regular />}
                      aria-label={`Remove font ${f}`}
                      onClick={() => edit({ fonts: profile.fonts.filter((x) => x !== f) })}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className={s.row}>
              <div className={s.field}>
                <Label htmlFor={ids.font} size="small">
                  Add a font
                </Label>
                <Input
                  id={ids.font}
                  size="small"
                  value={fontText}
                  maxLength={MAX_FONT_NAME_LENGTH}
                  aria-invalid={fontError ? true : undefined}
                  aria-describedby={fontError ? `${ids.font}-err` : undefined}
                  onChange={(_e, d) => setFontText(d.value)}
                  onKeyDown={onEnter(addFont)}
                />
              </div>
              <Button size="small" icon={<Add16Regular />} onClick={addFont}>
                Add font
              </Button>
            </div>
            {fontError && (
              <p id={`${ids.font}-err`} className={s.error} role="alert">
                {fontError}
              </p>
            )}
          </fieldset>

          <fieldset className={s.group}>
            <legend className={s.legend}>Allowed colors</legend>
            {profile.colors.length === 0 ? (
              <p className={s.note}>No colors yet: the theme colors are used.</p>
            ) : (
              <ul className={s.list} aria-label="Allowed colors">
                {profile.colors.map((c) => (
                  <li key={c} className={s.chip} data-brand-color="">
                    <Swatch hex={c} />
                    <span className={s.chipText}>#{c}</span>
                    <Button
                      size="small"
                      appearance="transparent"
                      icon={<Dismiss12Regular />}
                      aria-label={`Remove color #${c}`}
                      onClick={() => edit({ colors: profile.colors.filter((x) => x !== c) })}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className={s.row}>
              <div className={s.field}>
                <Label htmlFor={ids.color} size="small">
                  Add a color (hex)
                </Label>
                <Input
                  id={ids.color}
                  size="small"
                  value={colorText}
                  placeholder="#4472C4"
                  maxLength={9}
                  aria-invalid={colorError ? true : undefined}
                  aria-describedby={colorError ? `${ids.color}-err` : undefined}
                  onChange={(_e, d) => setColorText(d.value)}
                  onKeyDown={onEnter(() => addColor(colorText))}
                />
              </div>
              <Button size="small" icon={<Add16Regular />} onClick={() => addColor(colorText)}>
                Add color
              </Button>
            </div>
            {colorError && (
              <p id={`${ids.color}-err`} className={s.error} role="alert">
                {colorError}
              </p>
            )}
            {themeColorsToAdd.length > 0 && (
              <>
                <p className={s.note}>Theme colors</p>
                <ul className={s.list} aria-label="Theme colors to add">
                  {themeColorsToAdd.map((c) => (
                    <li key={c.hex}>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Swatch hex={c.hex} />}
                        aria-label={`Add theme color #${c.hex}`}
                        onClick={() => addColor(c.hex)}
                      >
                        #{c.hex}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </fieldset>

          <div className={s.field}>
            <Label htmlFor={ids.tol} size="small">
              Color tolerance (ΔE 2000, 0 to {MAX_BRAND_TOLERANCE})
            </Label>
            <Input
              id={ids.tol}
              size="small"
              type="number"
              min={0}
              max={MAX_BRAND_TOLERANCE}
              step={0.1}
              value={tolText ?? String(profile.tolerance)}
              aria-invalid={tolError ? true : undefined}
              aria-describedby={`${ids.tol}-hint`}
              onChange={(_e, d) => onTolerance(d.value)}
              onBlur={() => {
                setTolText(null);
                setTolError("");
              }}
            />
            <p id={`${ids.tol}-hint`} className={tolError ? s.error : s.note}>
              {tolError || `Colors this close to a brand color count as on-brand. Default ${DEFAULT_COLOR_TOLERANCE}.`}
            </p>
          </div>

          <div className={s.bar}>
            <Button size="small" onClick={() => download("brand-profile.json", serializeBrand(profile))}>
              Export JSON
            </Button>
            <Button
              size="small"
              onClick={() => {
                setTolText(null);
                setImportErrors([]);
                setImportNote("");
                save(null);
              }}
            >
              Reset to theme
            </Button>
          </div>
        </>
      )}

      <fieldset className={s.group}>
        <legend className={s.legend}>Import JSON</legend>
        <Label htmlFor={ids.file} size="small">
          From a file
        </Label>
        <input id={ids.file} className={s.fileInput} type="file" accept=".json,application/json" onChange={onFile} />
        <Label htmlFor={ids.paste} size="small">
          Or paste brand JSON
        </Label>
        <Textarea id={ids.paste} size="small" resize="vertical" value={pasteText} onChange={(_e, d) => setPasteText(d.value)} />
        <div className={s.bar}>
          <Button size="small" disabled={pasteText.trim() === ""} onClick={() => importJson(pasteText)}>
            Import
          </Button>
        </div>
        {importErrors.length > 0 && (
          <div role="alert">
            <p className={s.error}>The brand profile was not imported:</p>
            <ul className={s.errors} data-import-errors="">
              {importErrors.map((e, i) => (
                <li key={i}>{e.field ? `${e.field}: ${e.message}` : e.message}</li>
              ))}
            </ul>
          </div>
        )}
        {importNote && (
          <p className={s.note} role="status">
            {importNote}
          </p>
        )}
      </fieldset>

      {!store.persistent && <p className={s.note}>This device doesn&apos;t allow saving settings, so the brand profile lasts until the pane closes.</p>}
    </>
  );
}

/** The header settings entry (D9): a gear button opening the brand profile editor. */
export function BrandSettingsEntry({ store, download }: Omit<BrandEditorProps, "placement">) {
  return (
    <HeaderPanel label="Settings" icon={<Settings20Regular />} title="Settings" dataAttr="settings-entry">
      <BrandEditor store={store} placement="settings" {...(download ? { download } : {})} />
    </HeaderPanel>
  );
}
