/**
 * Inline fix pickers (D11): multi-select sources plus a target, per fix type.
 *
 * Untrusted-content rule: font names, hex values, addresses, and shape labels come from the deck
 * and are rendered only as React text (labels, option text). Swatch colors are drawn only from
 * values that passed `normalizeHex` (six hex digits).
 */
import { Button, Checkbox, Field, Input, Select, makeStyles, tokens } from "@fluentui/react-components";
import { useMemo } from "react";
import { HEADER_FOOTER_NOTE, TITLE_SIZE_MAX, TITLE_SIZE_MIN, type TitlePlaceholderType } from "../../office/fixes";
import { CapabilityButton } from "../components/CapabilityButton";
import {
  colorSources,
  colorTargets,
  CUSTOM,
  DELETE_KIND_LABELS,
  DELETE_KINDS,
  deleteSources,
  draftInputError,
  fontSources,
  fontTargets,
  linkSources,
  optionValue,
  parseSize,
  plural,
  slideNumberSources,
  slideNumbersFlagOn,
  titleSizes,
  titleSources,
  type Draft,
} from "./model";
import type { AuditResult, Finding } from "@slidecheck/audit-core";

const usePickerStyles = makeStyles({
  fieldset: {
    margin: 0,
    padding: 0,
    border: "none",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  legend: { padding: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, marginBottom: tokens.spacingVerticalXS },
  list: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "180px",
    overflowY: "auto",
    minWidth: 0,
  },
  item: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, minWidth: 0, wordBreak: "break-word" },
  meta: { flexShrink: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  swatch: {
    flexShrink: 0,
    width: "14px",
    height: "14px",
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  caveat: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  sub: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  address: { margin: 0, wordBreak: "break-all", fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  chips: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS, alignItems: "center" },
});

export interface PickerProps {
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** All findings of the area (unfiltered). */
  findings: readonly Finding[];
  result: AuditResult | null;
  disabled?: boolean;
}

function toggle(list: readonly string[], value: string, on: boolean): string[] {
  const without = list.filter((v) => v !== value);
  return on ? [...without, value] : without;
}

function Swatch({ hex }: { hex: string }) {
  const s = usePickerStyles();
  // `hex` is normalized RRGGBB (validated), never raw deck text.
  return <span aria-hidden="true" className={s.swatch} style={{ backgroundColor: `#${hex}` }} />;
}

// ---------------------------------------------------------------------------------------------

export function FontPicker({ draft, onChange, findings, result, disabled }: PickerProps) {
  const s = usePickerStyles();
  if (draft.type !== "fonts") return null;
  const sources = fontSources(findings);
  const targets = fontTargets(result);
  return (
    <>
      <fieldset className={s.fieldset} disabled={disabled}>
        <legend className={s.legend}>Fonts to replace</legend>
        <div className={s.list}>
          {sources.map((src) => (
            <span key={src.name} className={s.item}>
              <Checkbox
                label={src.name}
                checked={draft.from.includes(src.name)}
                onChange={(_e, d) => onChange({ ...draft, from: toggle(draft.from, src.name, d.checked === true) })}
              />
              <span className={s.meta}>{src.reachable ? plural(src.count, "use") : "can't be changed in place"}</span>
            </span>
          ))}
        </div>
      </fieldset>
      <Field label="Replace with">
        <Select value={draft.target} disabled={disabled} onChange={(_e, d) => onChange({ ...draft, target: d.value })}>
          {targets.theme.length > 0 && (
            <optgroup label="Theme fonts">
              {targets.theme.map((n) => (
                <option key={n} value={optionValue("theme", n)}>
                  {n}
                </option>
              ))}
            </optgroup>
          )}
          {targets.deck.length > 0 && (
            <optgroup label="Fonts in this presentation">
              {targets.deck.map((n) => (
                <option key={n} value={optionValue("deck", n)}>
                  {n}
                </option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM}>Type a font name…</option>
        </Select>
      </Field>
      {draft.target === CUSTOM && (
        <>
          <Field label="Font name">
            <Input value={draft.custom} disabled={disabled} onChange={(_e, d) => onChange({ ...draft, custom: d.value })} />
          </Field>
          <p className={s.caveat}>
            PowerPoint substitutes fonts that aren&apos;t installed. Check that this font is available wherever the presentation is
            opened.
          </p>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function ColorPicker({ draft, onChange, findings, result, disabled }: PickerProps) {
  const s = usePickerStyles();
  if (draft.type !== "colors") return null;
  const sources = colorSources(findings);
  const targets = colorTargets(result);
  const error = draftInputError(draft);
  return (
    <>
      <fieldset className={s.fieldset} disabled={disabled}>
        <legend className={s.legend}>Colors to replace</legend>
        <div className={s.list}>
          {sources.map((src) => (
            <span key={src.hex} className={s.item}>
              <Swatch hex={src.hex} />
              <Checkbox
                label={`#${src.hex}`}
                checked={draft.from.includes(src.hex)}
                onChange={(_e, d) => onChange({ ...draft, from: toggle(draft.from, src.hex, d.checked === true) })}
              />
              <span className={s.meta}>{src.reachable ? plural(src.count, "use") : "can't be changed in place"}</span>
            </span>
          ))}
        </div>
      </fieldset>
      <Field label="Replace with">
        <Select value={draft.target} disabled={disabled} onChange={(_e, d) => onChange({ ...draft, target: d.value })}>
          {targets.length > 0 && (
            <optgroup label="Theme colors">
              {targets.map((c) => (
                <option key={c.hex} value={optionValue("theme", c.hex)}>
                  {`${c.slot} · #${c.hex}`}
                </option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM}>Enter a hex color…</option>
        </Select>
      </Field>
      {draft.target === CUSTOM && (
        <Field label="Hex color" hint={error ? undefined : "Six hex digits, for example #1F4E79."} validationState={error ? "error" : "none"} validationMessage={error ?? undefined}>
          <Input value={draft.custom} disabled={disabled} placeholder="#1F4E79" onChange={(_e, d) => onChange({ ...draft, custom: d.value })} />
        </Field>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function DeletePicker({ draft, onChange, findings, disabled }: PickerProps) {
  const s = usePickerStyles();
  const sources = useMemo(() => deleteSources(findings), [findings]);
  if (draft.type !== "delete") return null;
  const chosen = new Set(draft.findingIds);
  const allIds = sources.map((x) => x.findingId);
  const selected = allIds.filter((id) => chosen.has(id)).length;
  const allState = selected === 0 ? false : selected === allIds.length ? true : "mixed";
  return (
    <fieldset className={s.fieldset} disabled={disabled}>
      <legend className={s.legend}>Shapes to delete</legend>
      <Checkbox
        label="Select all"
        checked={allState}
        onChange={(_e, d) => onChange({ ...draft, findingIds: d.checked === true ? allIds : [] })}
      />
      <div className={s.list}>
        {DELETE_KINDS.map((kind) => {
          const items = sources.filter((x) => x.kind === kind);
          if (items.length === 0) return null;
          return (
            <div key={kind} role="group" aria-label={DELETE_KIND_LABELS[kind]}>
              <p className={s.sub}>{DELETE_KIND_LABELS[kind]}</p>
              {items.map((it) => (
                <span key={it.findingId} className={s.item}>
                  <Checkbox
                    label={it.label}
                    checked={chosen.has(it.findingId)}
                    onChange={(_e, d) => onChange({ ...draft, findingIds: toggle(draft.findingIds, it.findingId, d.checked === true) })}
                  />
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------

export function LinkPicker({ draft, onChange, findings, disabled }: PickerProps) {
  const s = usePickerStyles();
  const sources = useMemo(() => linkSources(findings), [findings]);
  if (draft.type !== "links") return null;

  if (draft.mode === "edit" && draft.address !== null) {
    const error = draftInputError(draft);
    const touched = draft.newAddress.trim() !== "";
    return (
      <>
        <p className={s.sub}>Current address</p>
        <p className={s.address}>{draft.address}</p>
        <Field
          label="New address"
          hint={touched ? undefined : "http, https, or mailto only."}
          validationState={error ? "error" : "none"}
          validationMessage={error ?? undefined}
        >
          <Input value={draft.newAddress} disabled={disabled} onChange={(_e, d) => onChange({ ...draft, newAddress: d.value })} />
        </Field>
        <Button
          appearance="subtle"
          size="small"
          disabled={disabled}
          onClick={() => onChange({ type: "links", mode: "edit", address: null, newAddress: "" })}
        >
          Choose another link
        </Button>
      </>
    );
  }

  const removing = draft.mode === "remove";
  const chosen = new Set(removing ? draft.addresses : []);
  return (
    <fieldset className={s.fieldset} disabled={disabled}>
      <legend className={s.legend}>{removing ? "Links to remove" : "Choose a link to edit"}</legend>
      {removing && sources.length > 1 && (
        <Checkbox
          label="Select all"
          checked={draft.addresses.length === 0 ? false : draft.addresses.length === sources.length ? true : "mixed"}
          onChange={(_e, d) => onChange({ ...draft, addresses: d.checked === true ? sources.map((x) => x.address) : [] })}
        />
      )}
      <div className={s.list}>
        {sources.map((src) => (
          <span key={src.address} className={s.item}>
            {removing ? (
              <Checkbox
                label={src.address}
                checked={chosen.has(src.address)}
                onChange={(_e, d) => onChange({ ...draft, addresses: toggle(draft.addresses, src.address, d.checked === true) })}
              />
            ) : (
              <span className={s.address}>{src.address}</span>
            )}
            <span className={s.meta}>{plural(src.count, "link")}</span>
            <EditLinkButton address={src.address} disabled={disabled} onEdit={() => onChange({ type: "links", mode: "edit", address: src.address, newAddress: "" })} />
          </span>
        ))}
      </div>
    </fieldset>
  );
}

function EditLinkButton({ address, disabled, onEdit }: { address: string; disabled?: boolean; onEdit: () => void }) {
  return (
    <CapabilityButton feature="hyperlinkEdit" size="small" appearance="subtle" disabled={!!disabled} onClick={onEdit} ariaLabel={`Edit link ${address}`}>
      Edit
    </CapabilityButton>
  );
}

// ---------------------------------------------------------------------------------------------
// Slide titles and slide numbers (Graphics Ops bulk fixes)

/** Toggle one slide in an "all" / explicit selection over `ids`; a full selection becomes "all". */
function toggleSlide(slides: "all" | number[], ids: readonly number[], id: number, on: boolean): "all" | number[] {
  const cur = slides === "all" ? [...ids] : slides.filter((x) => ids.includes(x));
  const next = on ? [...cur.filter((x) => x !== id), id] : cur.filter((x) => x !== id);
  return ids.every((x) => next.includes(x)) ? "all" : ids.filter((x) => next.includes(x));
}

function allState(slides: "all" | number[], ids: readonly number[]): boolean | "mixed" {
  if (slides === "all") return true;
  const n = ids.filter((x) => slides.includes(x)).length;
  return n === 0 ? false : n === ids.length ? true : "mixed";
}

const TYPE_LABELS: Record<TitlePlaceholderType, string> = { title: "Slide titles", ctrTitle: "Title slides" };
const sizeText = (sizes: readonly number[]) => (sizes.length ? sizes.map((p) => `${p} pt`).join(" / ") : "size unknown");

export function TitleSizePicker({ draft, onChange, findings, disabled }: PickerProps) {
  const s = usePickerStyles();
  const titles = useMemo(() => titleSources(findings), [findings]);
  if (draft.type !== "title-size") return null;
  const error = draftInputError(draft);
  const chosen = titles.filter((t) => draft.placeholderTypes.includes(t.placeholderType));
  const chips = titleSizes(chosen.length ? chosen : titles);
  const current = parseSize(draft.size);
  const ids = [...new Set(chosen.map((t) => t.slideId))];
  const checked = (id: number) => draft.slides === "all" || draft.slides.includes(id);
  return (
    <>
      <Field
        label="New size (pt)"
        hint={error ? undefined : `${TITLE_SIZE_MIN} to ${TITLE_SIZE_MAX} pt.`}
        validationState={error ? "error" : "none"}
        validationMessage={error ?? undefined}
      >
        <Input
          type="number"
          min={TITLE_SIZE_MIN}
          max={TITLE_SIZE_MAX}
          step={1}
          value={draft.size}
          disabled={disabled}
          onChange={(_e, d) => onChange({ ...draft, size: d.value })}
        />
      </Field>
      {chips.length > 0 && (
        <div className={s.chips} role="group" aria-label="Sizes in this presentation">
          <span className={s.meta}>In this presentation:</span>
          {chips.map((p) => (
            <Button
              key={p}
              size="small"
              appearance={current === p ? "primary" : "outline"}
              aria-pressed={current === p}
              disabled={disabled}
              onClick={() => onChange({ ...draft, size: String(p) })}
            >
              {`${p} pt`}
            </Button>
          ))}
        </div>
      )}
      <fieldset className={s.fieldset} disabled={disabled}>
        <legend className={s.legend}>Titles to change</legend>
        {(["title", "ctrTitle"] as const).map((type) => {
          const n = titles.filter((t) => t.placeholderType === type).length;
          return (
            <span key={type} className={s.item}>
              <Checkbox
                label={TYPE_LABELS[type]}
                disabled={n === 0}
                checked={draft.placeholderTypes.includes(type)}
                onChange={(_e, d) =>
                  onChange({
                    ...draft,
                    placeholderTypes: (["title", "ctrTitle"] as const).filter((t) => (t === type ? d.checked === true : draft.placeholderTypes.includes(t))),
                    slides: "all",
                  })
                }
              />
              <span className={s.meta}>{plural(n, "slide")}</span>
            </span>
          );
        })}
        <Checkbox
          label="Also update layouts and master so new slides match"
          checked={draft.alsoLayouts}
          onChange={(_e, d) => onChange({ ...draft, alsoLayouts: d.checked === true })}
        />
      </fieldset>
      {ids.length > 0 && (
        <fieldset className={s.fieldset} disabled={disabled}>
          <legend className={s.legend}>Slides</legend>
          <Checkbox
            label="All slides"
            checked={allState(draft.slides, ids)}
            onChange={(_e, d) => onChange({ ...draft, slides: d.checked === true ? "all" : [] })}
          />
          <div className={s.list}>
            {chosen.map((t) => (
              <span key={`${t.slideId}:${t.placeholderType}`} className={s.item}>
                <Checkbox
                  label={`Slide ${t.slideNumber}: ${t.text || "(empty title)"}`}
                  checked={checked(t.slideId)}
                  onChange={(_e, d) => onChange({ ...draft, slides: toggleSlide(draft.slides, ids, t.slideId, d.checked === true) })}
                />
                <span className={s.meta}>{`${sizeText(t.sizesPt)}${t.shrink ? " · shrinks to fit" : ""}${t.hidden ? " · hidden" : ""}`}</span>
              </span>
            ))}
          </div>
        </fieldset>
      )}
    </>
  );
}

export function SlideNumbersPicker({ draft, onChange, findings, disabled }: PickerProps) {
  const s = usePickerStyles();
  const sources = useMemo(() => slideNumberSources(findings), [findings]);
  const flagOn = useMemo(() => slideNumbersFlagOn(findings), [findings]);
  if (draft.type !== "slide-numbers") return null;
  const removable = sources.filter((x) => x.removable.length > 0);
  const ids = removable.map((x) => x.slideId);
  const kept = sources.flatMap((x) => x.kept);
  return (
    <>
      <fieldset className={s.fieldset} disabled={disabled}>
        <legend className={s.legend}>Slides with numbers</legend>
        {ids.length > 1 && (
          <Checkbox label="Select all" checked={allState(draft.slides, ids)} onChange={(_e, d) => onChange({ ...draft, slides: d.checked === true ? "all" : [] })} />
        )}
        <div className={s.list}>
          {removable.map((x) => (
            <span key={x.slideId} className={s.item}>
              <Checkbox
                label={`Slide ${x.slideNumber}`}
                checked={draft.slides === "all" || draft.slides.includes(x.slideId)}
                onChange={(_e, d) => onChange({ ...draft, slides: toggleSlide(draft.slides, ids, x.slideId, d.checked === true) })}
              />
              <span className={s.meta}>
                {x.removable.map((r) => (r.kind === "placeholder" ? "number placeholder" : "number text box")).join(", ")}
                {x.hidden ? " · hidden" : ""}
              </span>
            </span>
          ))}
        </div>
      </fieldset>
      {kept.length > 0 && (
        <div data-slide-numbers-kept="">
          <p className={s.sub}>{`Left in place (${kept.length}): the number is part of other text — edit it by hand`}</p>
          <ul className={s.list}>
            {kept.map((k, i) => (
              <li key={i} className={s.meta}>
                {k.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className={s.caveat} data-header-footer-note="">
        {flagOn ? `New slides are set to show numbers. ${HEADER_FOOTER_NOTE}` : HEADER_FOOTER_NOTE}
      </p>
    </>
  );
}
