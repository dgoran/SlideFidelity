/**
 * Show-machine fonts editor (G3): the fonts installed on the presenting computer, so SlideCheck
 * doesn't report them as possibly missing. Free (it only changes what the free counts include).
 *
 * - Add / remove typed font names; paste a list (one per line).
 * - Import a `.txt` (one per line) or `.json` (array, or `{ "fonts": [...] }`) file; export either.
 * - "Add fonts used in this deck": the deck's fonts as unchecked checkboxes; only the ones the user
 *   confirms are installed are added.
 * - With the SlideCheck Helper Connected (helper plan U12, R15): "This is a show machine: add its
 *   fonts to the list" merges this computer's font names into the list after a confirmation
 *   dialog; existing entries are kept and duplicates (case-insensitive) dropped.
 *
 * Every change is saved in the store (which the scan service reads through `getOptions`) and marks
 * the results as needing a rescan. Font names (typed, imported, or from the deck) are untrusted and
 * rendered as React text only.
 */
import { useId, useMemo, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Label,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Add16Regular, Dismiss12Regular } from "@fluentui/react-icons";
import { MAX_FONT_NAME_LENGTH, type AuditResult } from "@slidecheck/audit-core";
import { useHelperSnapshot } from "../../helper/HelperStatus";
import type { HelperStore } from "../../helper/state";
import { usePlan } from "../../license/gate";
import { currentResult } from "../brand/themeBrand";
import { MAX_SHOW_FONTS, parseFontLines, parseFontListFile, serializeFontList, type ShowFontsStore } from "../fonts/showFontsStore";
import { usePane } from "../state/PaneContext";
import { downloadText } from "./BrandEditor";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: 0 },
  framed: {
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  heading: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  bar: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: tokens.spacingHorizontalS },
  group: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, border: "none", margin: 0, padding: 0, minWidth: 0 },
  legend: { padding: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  list: {
    listStyleType: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    maxHeight: "160px",
    overflowY: "auto",
  },
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
  row: { display: "flex", alignItems: "flex-end", gap: tokens.spacingHorizontalXS, flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, flex: "1 1 140px", minWidth: 0 },
  checks: { display: "flex", flexDirection: "column", maxHeight: "180px", overflowY: "auto", minWidth: 0, wordBreak: "break-word" },
  error: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorPaletteRedForeground1 },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  fileInput: { fontSize: tokens.fontSizeBase200, maxWidth: "100%" },
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface DeckFontCandidate {
  name: string;
  maybeMissing: boolean;
}

/**
 * The deck's fonts not yet on the list (from the free font list, `font-usage`). With the font flags
 * allowed, the ones that may be missing come first and are marked.
 */
export function deckFontCandidates(result: AuditResult | null, list: readonly string[], flagsAllowed: boolean): DeckFontCandidate[] {
  const listed = new Set(list.map((f) => f.toLowerCase()));
  const missing = new Set<string>();
  if (flagsAllowed) {
    for (const f of result?.findings ?? []) if (f.kind === "font-maybe-missing" || f.kind === "font-missing-here") missing.add(f.data.typeface.toLowerCase());
  }
  const out: DeckFontCandidate[] = [];
  const seen = new Set<string>();
  for (const f of result?.findings ?? []) {
    if (f.kind !== "font-usage") continue;
    const name = f.data.typeface;
    const k = name.toLowerCase();
    if (listed.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ name, maybeMissing: missing.has(k) });
  }
  // Stable: may-be-missing first, otherwise the engine's (alphabetical) order.
  return [...out.filter((c) => c.maybeMissing), ...out.filter((c) => !c.maybeMissing)];
}

export interface ShowFontsEditorProps {
  store: ShowFontsStore;
  /** In settings (open), or inside the Problems view's Fonts category. */
  placement?: "settings" | "problems";
  /** Test hook for export. */
  download?: (filename: string, text: string, type?: string) => void;
  /** The SlideCheck Helper (U12): when Connected, offers to add this computer's fonts. */
  helper?: Pick<HelperStore, "getSnapshot" | "subscribe">;
}

const NO_HELPER: Pick<HelperStore, "getSnapshot" | "subscribe"> = {
  getSnapshot: () => NO_HELPER_SNAPSHOT,
  subscribe: () => () => {},
};
const NO_HELPER_SNAPSHOT = { phase: "silent", platform: "other", health: null, port: null, fonts: null, reason: "host", dismissPersistent: true } as const;

/** Names in `incoming` not yet in `list` (case-insensitive, deduped), up to the list's room. */
export function newFontNames(list: readonly string[], incoming: readonly string[]): string[] {
  const have = new Set(list.map((f) => f.toLowerCase()));
  const out: string[] = [];
  for (const raw of incoming) {
    const name = raw.trim();
    if (!name || name.length > MAX_FONT_NAME_LENGTH) continue;
    const k = name.toLowerCase();
    if (have.has(k)) continue;
    have.add(k);
    out.push(name);
  }
  return out.slice(0, Math.max(0, MAX_SHOW_FONTS - list.length));
}

export function ShowFontsEditor({ store, placement = "settings", download = downloadText, helper = NO_HELPER }: ShowFontsEditorProps) {
  const s = useStyles();
  const fonts = useSyncExternalStore(store.subscribe, store.get, store.get);
  const helperSnap = useHelperSnapshot(helper);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { state, dispatch } = usePane();
  const { isAllowed } = usePlan();
  const result = currentResult(state.scan);
  const headingId = useId();
  const ids = { font: useId(), paste: useId(), file: useId() };

  const [fontText, setFontText] = useState("");
  const [fontError, setFontError] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [message, setMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [deckOpen, setDeckOpen] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  const candidates = useMemo(() => deckFontCandidates(result, fonts, isAllowed("area.fonts.flags")), [result, fonts, isAllowed]);

  const save = (next: readonly string[]) => {
    store.set(next);
    dispatch({ type: "scan/options-changed", option: "show-fonts" });
  };

  /** Add names; returns how many were new. */
  const addMany = (names: readonly string[]): number => {
    const added = newFontNames(fonts, names);
    if (added.length) save([...fonts, ...added]);
    return added.length;
  };

  const machineFonts = helperSnap.phase === "connected" ? helperSnap.fonts : null;
  const machineNew = useMemo(() => (machineFonts ? newFontNames(fonts, machineFonts).length : 0), [fonts, machineFonts]);

  const addMachineFonts = () => {
    setConfirmOpen(false);
    setMessage(addedMessage(machineFonts ? addMany(machineFonts) : 0));
  };

  const addFont = () => {
    const name = fontText.trim();
    if (!name) return setFontError("Type a font name.");
    if (name.length > MAX_FONT_NAME_LENGTH) return setFontError(`Font names are at most ${MAX_FONT_NAME_LENGTH} characters.`);
    if (fonts.some((f) => f.toLowerCase() === name.toLowerCase())) return setFontError("That font is already in the list.");
    if (fonts.length >= MAX_SHOW_FONTS) return setFontError(`At most ${MAX_SHOW_FONTS} fonts.`);
    setFontError("");
    setFontText("");
    setMessage("");
    addMany([name]);
  };

  const addedMessage = (n: number) => (n === 0 ? "No new fonts to add." : `Added ${plural(n, "font")}.`);

  const addPasted = () => {
    const n = addMany(parseFontLines(pasteText));
    setPasteText("");
    setMessage(addedMessage(n));
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 1_000_000) {
      setImportError("The font list wasn't imported: the file is too large.");
      return;
    }
    void file.text().then(
      (text) => {
        const r = parseFontListFile(file.name, text);
        if (!r.ok) {
          setMessage("");
          setImportError(`The font list wasn't imported: ${r.error}`);
          return;
        }
        setImportError("");
        setMessage(addedMessage(addMany(r.fonts)));
      },
      () => setImportError("The font list wasn't imported: the file could not be read."),
    );
  };

  const addChecked = () => {
    const names = candidates.filter((c) => checked.has(c.name)).map((c) => c.name);
    const n = addMany(names);
    setChecked(new Set());
    setMessage(addedMessage(n));
  };

  const onEnter = (fn: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fn();
    }
  };

  const checkedCount = candidates.filter((c) => checked.has(c.name)).length;
  const inProblems = placement === "problems";

  return (
    <section className={inProblems ? `${s.root} ${s.framed}` : s.root} aria-labelledby={headingId} data-show-fonts-editor={placement}>
      {inProblems ? (
        <h4 id={headingId} className={s.heading}>
          Show-machine fonts
        </h4>
      ) : (
        <span id={headingId} className={s.heading}>
          Show-machine fonts
        </span>
      )}
      <p className={s.note}>
        Fonts installed on the presenting computer. SlideCheck won&apos;t report them as possibly missing.
      </p>

      {fonts.length === 0 ? (
        <p className={s.note}>No fonts yet.</p>
      ) : (
        <ul className={s.list} aria-label="Show-machine fonts">
          {fonts.map((f) => (
            <li key={f} className={s.chip} data-show-font="">
              <span className={s.chipText}>{f}</span>
              <Button
                size="small"
                appearance="transparent"
                icon={<Dismiss12Regular />}
                aria-label={`Remove font ${f}`}
                onClick={() => {
                  setMessage("");
                  save(fonts.filter((x) => x !== f));
                }}
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

      <div className={s.field}>
        <Label htmlFor={ids.paste} size="small">
          Paste a list (one font per line)
        </Label>
        <Textarea id={ids.paste} size="small" resize="vertical" value={pasteText} onChange={(_e, d) => setPasteText(d.value)} />
      </div>
      <div className={s.bar}>
        <Button size="small" disabled={pasteText.trim() === ""} onClick={addPasted}>
          Add pasted fonts
        </Button>
      </div>

      {machineFonts && (
        <div className={s.bar} data-machine-fonts="">
          <Button
            size="small"
            appearance="secondary"
            onClick={() => {
              if (machineNew === 0) setMessage("Every font on this computer is already on the list.");
              else setConfirmOpen(true);
            }}
          >
            This is a show machine: add its fonts to the list
          </Button>
          <Dialog open={confirmOpen} onOpenChange={(_e, d) => setConfirmOpen(d.open)} modalType="modal">
            <DialogSurface aria-describedby={`${headingId}-machine`}>
              <DialogBody>
                <DialogTitle>Add this computer&apos;s fonts?</DialogTitle>
                <DialogContent id={`${headingId}-machine`}>
                  {`This adds ${plural(machineNew, "font name")} from this computer to the show-machine list. Fonts already on the list are kept.`}
                </DialogContent>
                <DialogActions>
                  <Button appearance="primary" onClick={addMachineFonts}>
                    {`Add ${plural(machineNew, "font")}`}
                  </Button>
                  <Button appearance="secondary" onClick={() => setConfirmOpen(false)}>
                    Cancel
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      )}

      <fieldset className={s.group}>
        <legend className={s.legend}>Fonts used in this deck</legend>
        <Button size="small" appearance="subtle" aria-expanded={deckOpen} disabled={!result} onClick={() => setDeckOpen((o) => !o)}>
          Add fonts used in this deck…
        </Button>
        {deckOpen && (
          <div className={s.root} data-deck-fonts="">
            {candidates.length === 0 ? (
              <p className={s.note}>Every font in this deck is already on the list.</p>
            ) : (
              <>
                <p className={s.note}>Check only the fonts you have confirmed are installed on the show computer.</p>
                <div className={s.checks}>
                  {candidates.map((c) => (
                    <Checkbox
                      key={c.name}
                      label={c.maybeMissing ? `${c.name} (may be missing)` : c.name}
                      checked={checked.has(c.name)}
                      onChange={(_e, d) => {
                        const next = new Set(checked);
                        if (d.checked === true) next.add(c.name);
                        else next.delete(c.name);
                        setChecked(next);
                      }}
                    />
                  ))}
                </div>
                <div className={s.bar}>
                  <Button size="small" disabled={checkedCount === 0} onClick={addChecked}>
                    {checkedCount === 0 ? "Add checked fonts" : `Add ${plural(checkedCount, "checked font")}`}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className={s.group}>
        <legend className={s.legend}>Import and export</legend>
        <Label htmlFor={ids.file} size="small">
          Import a .txt or .json file
        </Label>
        <input id={ids.file} className={s.fileInput} type="file" accept=".txt,.json,text/plain,application/json" onChange={onFile} />
        <div className={s.bar}>
          <Button size="small" disabled={fonts.length === 0} onClick={() => download("show-machine-fonts.txt", serializeFontList(fonts, "txt"), "text/plain")}>
            Export .txt
          </Button>
          <Button size="small" disabled={fonts.length === 0} onClick={() => download("show-machine-fonts.json", serializeFontList(fonts, "json"), "application/json")}>
            Export .json
          </Button>
        </div>
      </fieldset>

      {importError && (
        <p className={s.error} role="alert">
          {importError}
        </p>
      )}
      <p className={s.note} role="status">
        {message}
      </p>

      {!store.persistent && <p className={s.note}>This device doesn&apos;t allow saving settings, so the list lasts until the pane closes.</p>}
    </section>
  );
}
