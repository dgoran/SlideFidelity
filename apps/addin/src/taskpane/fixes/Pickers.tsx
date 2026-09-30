/**
 * Inline fix pickers (D11): multi-select sources plus a target, per fix type.
 *
 * Untrusted-content rule: font names, hex values, addresses, and shape labels come from the deck
 * and are rendered only as React text (labels, option text). Swatch colors are drawn only from
 * values that passed `normalizeHex` (six hex digits).
 */
import { Button, Checkbox, Field, Input, Select, makeStyles, tokens } from "@fluentui/react-components";
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
  plural,
  type Draft,
} from "./model";
import type { AuditResult, Finding } from "@slidecheck/audit-core";

export const usePickerStyles = makeStyles({
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
  if (draft.type !== "delete") return null;
  const sources = deleteSources(findings);
  const allIds = sources.map((x) => x.findingId);
  const selected = allIds.filter((id) => draft.findingIds.includes(id)).length;
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
                    checked={draft.findingIds.includes(it.findingId)}
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
  if (draft.type !== "links") return null;
  const sources = linkSources(findings);

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
                checked={draft.addresses.includes(src.address)}
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
