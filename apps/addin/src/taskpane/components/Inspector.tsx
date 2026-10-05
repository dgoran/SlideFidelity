/**
 * Inspector (U11, R4; Pro via the `inspector` feature): a collapsible bottom section showing
 * findings and properties for the current PowerPoint selection.
 *
 * While open (and allowed) it owns one selection watcher: `start()` then `read()` on mount, a new
 * model on every settled selection change, `dispose()` on unmount or collapse. The watcher's
 * `ignoreNext` is registered with the pane's selection echo guard, so "Show in PowerPoint"
 * (`navigateFromPane`) does not repaint the Inspector with the selection it caused.
 *
 * Untrusted-content rule: every deck string (shape names, fonts, addresses, part names) is a
 * React text child. Links are never anchors; a checkable http(s) link can be opened only through
 * `Office.context.ui.openBrowserWindow` after a protocol check.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { ChevronDown16Regular, ChevronUp16Regular, Open16Regular } from "@fluentui/react-icons";
import { formatBytes } from "@slidefidelity/audit-core";
import {
  buildInspectorModel,
  type ColorGroup,
  type FontProperty,
  type ImageProperty,
  type InspectorAreaGroup,
  type InspectorModel,
  type LinkProperty,
  type ShapeIdentity,
  type ShapeInspection,
  type SlideSummary,
} from "../../inspector/model";
import { usePlan } from "../../license/gate";
import { createSelectionWatcher, type SelectionResult, type SelectionWatcher, type SelectionWatcherDeps } from "../../office/selection";
import { AREA_LABELS, usePaneServices } from "../context";
import { usePane } from "../state/PaneContext";
import { currentResult } from "../brand/themeBrand";
import { SeverityIcon } from "./FindingRow";
import { LockedSection } from "./LockedSection";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: tokens.spacingVerticalS,
    minWidth: 0,
  },
  bar: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  heading: { margin: 0, flex: "1 1 auto", fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    maxHeight: "45vh",
    overflowY: "auto",
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  text: { margin: 0, color: tokens.colorNeutralForeground2 },
  sub: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  hint: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorPaletteMarigoldForeground2 },
  title: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, minWidth: 0 },
  h4: { margin: 0, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground2 },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "2px" },
  item: { display: "flex", alignItems: "flex-start", gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200, minWidth: 0 },
  itemText: { minWidth: 0, display: "flex", flexDirection: "column" },
  tag: {
    display: "inline-block",
    padding: "0 6px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground2,
  },
  warnTag: { backgroundColor: tokens.colorPaletteMarigoldBackground2 },
  swatch: {
    flexShrink: 0,
    width: "12px",
    height: "12px",
    marginTop: "2px",
    borderRadius: "2px",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  dl: { margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: tokens.spacingHorizontalS, rowGap: "2px", fontSize: tokens.fontSizeBase200 },
  dt: { color: tokens.colorNeutralForeground3 },
  dd: { margin: 0, minWidth: 0 },
});

// ---------------------------------------------------------------------------------------------
// Link opening (never an anchor; only http/https through the Office browser window)

/** True only for absolute http(s) URLs. */
export function isOpenableUrl(address: string): boolean {
  if (!/^https?:\/\//i.test(address)) return false;
  try {
    const u = new URL(address);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function officeOpenBrowserWindow(url: string): void {
  Office.context.ui.openBrowserWindow(url);
}

const defaultCreateWatcher = (deps: SelectionWatcherDeps): SelectionWatcher => createSelectionWatcher(deps);

// ---------------------------------------------------------------------------------------------
// Component

export interface InspectorProps {
  /** Selection watcher factory (tests inject a fake). */
  createWatcher?: (deps: SelectionWatcherDeps) => SelectionWatcher;
  /** Opens a checked http(s) link. Defaults to `Office.context.ui.openBrowserWindow`. */
  openBrowserWindow?: (url: string) => void;
  defaultOpen?: boolean;
}

export function Inspector({ createWatcher = defaultCreateWatcher, openBrowserWindow = officeOpenBrowserWindow, defaultOpen = true }: InspectorProps) {
  const s = useStyles();
  const { isAllowed } = usePlan();
  const [open, setOpen] = useState(defaultOpen);
  const headingId = useId();
  const bodyId = useId();
  const allowed = isAllowed("inspector");

  return (
    <section className={s.root} aria-labelledby={headingId} data-inspector="">
      <div className={s.bar}>
        <h2 id={headingId} className={s.heading}>
          Inspector
        </h2>
        <Button
          size="small"
          appearance="subtle"
          icon={open ? <ChevronDown16Regular /> : <ChevronUp16Regular />}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? "Collapse Inspector" : "Expand Inspector"}
          onClick={() => setOpen((o) => !o)}
        />
      </div>
      {open && (
        <div id={bodyId} className={s.body}>
          {allowed ? (
            <InspectorLive createWatcher={createWatcher} openBrowserWindow={openBrowserWindow} />
          ) : (
            <LockedSection
              title="Inspector (Pro)"
              description="See the fonts, colors, links, image details, and findings of whatever you select in PowerPoint."
            />
          )}
        </div>
      )}
    </section>
  );
}

function InspectorLive({
  createWatcher,
  openBrowserWindow,
}: {
  createWatcher: (deps: SelectionWatcherDeps) => SelectionWatcher;
  openBrowserWindow: (url: string) => void;
}) {
  const s = useStyles();
  const { capabilities, selectionGuard } = usePaneServices();
  const { state } = usePane();
  const [selection, setSelection] = useState<SelectionResult | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const watcher = createWatcher({
      capabilities,
      onChange: (sel) => {
        if (live) setSelection(sel);
      },
    });
    const unregister = selectionGuard?.register(() => watcher.ignoreNext());
    void (async () => {
      const started = await watcher.start();
      if (!live) return;
      if (!started.ok) setWatchError(started.message);
      const sel = await watcher.read();
      if (live) setSelection(sel);
    })();
    return () => {
      live = false;
      unregister?.();
      void watcher.dispose();
    };
  }, [createWatcher, capabilities, selectionGuard]);

  const scan = state.scan;
  const result = currentResult(scan);
  const ready = scan.status === "ready" ? scan : scan.status !== "not-scanned" ? scan.previous : undefined;
  const inventory = ready?.inventory;
  const model = useMemo(
    () => buildInspectorModel(selection, result, inventory ? { inventory } : {}),
    [selection, result, inventory],
  );
  const scanOutdated = ready?.possiblyOutdated === true;

  return (
    <>
      {watchError && model.kind !== "unsupported" && (
        <p className={s.sub}>SlideFidelity can&apos;t follow selection changes on this host; the Inspector shows the selection when it opens.</p>
      )}
      <InspectorView
        model={model}
        scanOutdated={scanOutdated}
        unsupportedReason={capabilities.explain("selectShapes")}
        openBrowserWindow={openBrowserWindow}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Pure view (also used directly by tests)

export interface InspectorViewProps {
  model: InspectorModel;
  /** The scan itself may be stale (selection activity after it; D4 hint). */
  scanOutdated?: boolean;
  unsupportedReason?: string | null;
  openBrowserWindow?: (url: string) => void;
}

export function InspectorView({ model, scanOutdated = false, unsupportedReason, openBrowserWindow = officeOpenBrowserWindow }: InspectorViewProps) {
  const s = useStyles();
  let body: ReactNode;
  let mayBeOutOfDate = false;
  switch (model.kind) {
    case "unsupported":
      body = (
        <p className={s.text}>
          The Inspector needs a newer version of PowerPoint to read the selection.
          {unsupportedReason ? ` ${unsupportedReason}.` : ""}
        </p>
      );
      break;
    case "no-scan":
      body = <p className={s.text}>Scan the presentation, then select a slide or shape to inspect it.</p>;
      break;
    case "error":
      body = (
        <>
          <p className={s.text}>PowerPoint couldn&apos;t report the current selection. Select something again to retry.</p>
          <p className={s.sub}>{model.message}</p>
        </>
      );
      break;
    case "empty":
      body = <p className={s.text}>Select a slide or shape in PowerPoint to see its details.</p>;
      break;
    case "slides":
      mayBeOutOfDate = model.mayBeOutOfDate;
      body = model.slides.map((sl) => <SlideView key={`${sl.liveId}:${sl.index}`} slide={sl} />);
      break;
    case "shape":
      mayBeOutOfDate = model.shape.mayBeOutOfDate;
      body = <ShapeView shape={model.shape} openBrowserWindow={openBrowserWindow} />;
      break;
    case "multi":
      mayBeOutOfDate = model.mayBeOutOfDate;
      body = (
        <>
          <p className={s.title}>{model.count} shapes selected</p>
          {model.notInScanCount > 0 && (
            <p className={s.hint} data-not-in-scan="">
              {model.notInScanCount} of them {model.notInScanCount === 1 ? "is" : "are"} not in the last scan — rescan.
            </p>
          )}
          <div className={s.section}>
            <h3 className={s.h4}>Shapes</h3>
            <ul className={s.list}>
              {model.shapes.map((sh) => (
                <li key={sh.liveId} className={s.item}>
                  <IdentityText identity={sh} />
                </li>
              ))}
            </ul>
          </div>
          <FindingsView groups={model.findings} total={model.counts.total} />
        </>
      );
      break;
  }
  const hint = mayBeOutOfDate || scanOutdated;
  return (
    <div data-inspector-kind={model.kind}>
      {hint && (
        <p className={s.hint} data-may-be-outdated="">
          May be out of date. Rescan to refresh.
        </p>
      )}
      <div className={s.section}>{body}</div>
    </div>
  );
}

function Tag({ children, warn, data }: { children: ReactNode; warn?: boolean; data?: string }) {
  const s = useStyles();
  const extra = data ? { [`data-${data}`]: "" } : {};
  return (
    <span className={mergeClasses(s.tag, warn && s.warnTag)} {...extra}>
      {children}
    </span>
  );
}

function IdentityText({ identity }: { identity: ShapeIdentity }) {
  const s = useStyles();
  return (
    <span className={s.itemText}>
      <span>
        {identity.name || "(unnamed shape)"} <span className={s.sub}>{identity.type}</span>{" "}
        {identity.match?.approximate && <Tag data="approximate">approximate match</Tag>}
      </span>
      {identity.message && (
        <span className={s.hint} {...(identity.status === "not-in-scan" ? { "data-not-in-scan": "" } : {})}>
          {identity.message}
        </span>
      )}
    </span>
  );
}

function FindingsView({ groups, total }: { groups: InspectorAreaGroup[]; total: number }) {
  const s = useStyles();
  if (total === 0) return <p className={s.sub}>No findings for this selection.</p>;
  return (
    <div className={s.section} data-inspector-findings="">
      <h3 className={s.h4}>
        Findings ({total})
      </h3>
      {groups.map((g) => (
        <div key={g.area} className={s.section}>
          <h4 className={s.h4}>{AREA_LABELS[g.area]}</h4>
          <ul className={s.list}>
            {g.findings.map((f) => (
              <li key={f.id} className={s.item} data-inspector-finding={f.kind}>
                <SeverityIcon severity={f.severity} />
                <span className={s.itemText}>
                  <span>{f.title}</span>
                  {f.detail && <span className={s.sub}>{f.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SlideView({ slide }: { slide: SlideSummary }) {
  const s = useStyles();
  const number = slide.slideNumber ?? slide.index + 1;
  const t = slide.transition;
  return (
    <div className={s.section} data-inspector-slide={number}>
      <p className={s.title}>
        Slide {number} {slide.approximate && <Tag data="approximate">approximate match</Tag>}
      </p>
      {slide.status === "not-in-scan" ? (
        <p className={s.hint} data-not-in-scan="">
          {slide.message}
        </p>
      ) : (
        <>
          <dl className={s.dl}>
            {slide.hidden && (
              <>
                <dt className={s.dt}>Hidden</dt>
                <dd className={s.dd}>Yes, skipped in the slide show</dd>
              </>
            )}
            <dt className={s.dt}>Speaker notes</dt>
            <dd className={s.dd}>{slide.notes ? `${slide.notes.characters} characters` : "None"}</dd>
            <dt className={s.dt}>Transition</dt>
            <dd className={s.dd}>
              {t
                ? [
                    t.type ?? "Transition",
                    t.durationMs !== undefined ? `${t.durationMs / 1000} s` : t.speed,
                    t.advanceAfterMs !== undefined ? `advances after ${t.advanceAfterMs / 1000} s` : undefined,
                    t.advanceOnClick ? "on click" : "not on click",
                  ]
                    .filter(Boolean)
                    .join(", ")
                : "None"}
            </dd>
            <dt className={s.dt}>Animations</dt>
            <dd className={s.dd}>{slide.animation ? `${slide.animation.effectCount} effects` : "None"}</dd>
            <dt className={s.dt}>Comments</dt>
            <dd className={s.dd}>{slide.commentCount}</dd>
          </dl>
          <FindingsView groups={slide.findings} total={slide.counts.total} />
        </>
      )}
    </div>
  );
}

function ShapeView({ shape, openBrowserWindow }: { shape: ShapeInspection; openBrowserWindow: (url: string) => void }) {
  const s = useStyles();
  const p = shape.properties;
  return (
    <div className={s.section} data-inspector-shape={shape.status}>
      <p className={s.title}>
        <IdentityText identity={shape} />
      </p>
      {shape.match?.slideNumber !== undefined && <p className={s.sub}>On slide {shape.match.slideNumber}</p>}
      {shape.status === "matched" && (
        <>
          {p.fonts.length > 0 && <FontsView fonts={p.fonts} />}
          {p.hiddenListStyles && (
            <div className={s.section} data-hidden-list-styles="">
              <h3 className={s.h4}>Hidden list styles</h3>
              <p className={s.sub}>
                {p.hiddenListStyles.fonts.join(", ")}
                {p.hiddenListStyles.levels.length > 0 &&
                  ` (list ${p.hiddenListStyles.levels.length === 1 ? "level" : "levels"} ${p.hiddenListStyles.levels.join(", ")})`}
              </p>
            </div>
          )}
          {p.colors.length > 0 && <ColorsView groups={p.colors} />}
          {p.links.length > 0 && <LinksView links={p.links} openBrowserWindow={openBrowserWindow} />}
          {p.images.length > 0 && <ImagesView images={p.images} />}
          {p.autofit && (
            <div className={s.section} data-autofit="">
              <h3 className={s.h4}>Autofit</h3>
              <p className={s.sub}>{p.autofit.label}</p>
            </div>
          )}
          <FindingsView groups={shape.findings} total={shape.counts.total} />
        </>
      )}
    </div>
  );
}

function FontsView({ fonts }: { fonts: FontProperty[] }) {
  const s = useStyles();
  return (
    <div className={s.section}>
      <h3 className={s.h4}>Fonts</h3>
      <ul className={s.list}>
        {fonts.map((f) => (
          <li key={`${f.typeface}|${f.script}|${f.source}|${f.theme ?? ""}`} className={s.item} data-font-row={f.script}>
            <span className={s.itemText}>
              <span>
                {f.typeface} {f.inBrand === false && <Tag warn>not in brand</Tag>}
              </span>
              <span className={s.sub}>
                {[
                  f.scriptLabel,
                  f.sourceLabel,
                  f.theme ? `theme ${f.theme === "major" ? "heading" : "body"} font${f.themeRef ? ` (${f.themeRef})` : ""}` : undefined,
                  f.reachable ? undefined : "not fixable here",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ColorsView({ groups }: { groups: ColorGroup[] }) {
  const s = useStyles();
  return (
    <div className={s.section}>
      <h3 className={s.h4}>Colors</h3>
      {groups.map((g) => (
        <div key={g.property} className={s.section} data-color-property={g.property}>
          <span className={s.sub}>{g.label}</span>
          <ul className={s.list}>
            {g.colors.map((c) => {
              const hex = c.hex && /^[0-9A-Fa-f]{6}$/.test(c.hex) ? c.hex : undefined;
              return (
                <li key={c.findingId} className={s.item}>
                  <span aria-hidden="true" className={s.swatch} style={hex ? { backgroundColor: `#${hex}` } : undefined} />
                  <span>
                    {hex ? `#${hex.toUpperCase()}` : c.names.join(", ") || "Color"}
                    {hex && c.names.length > 0 ? ` (${c.names.join(", ")})` : ""}{" "}
                    {c.inBrand === false && <Tag warn>not in brand</Tag>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

const LINK_FLAG_LABELS: Record<string, string> = { "unsafe-scheme": "unsafe link type", "local-path": "points to a local file" };

function LinksView({ links, openBrowserWindow }: { links: LinkProperty[]; openBrowserWindow: (url: string) => void }) {
  const s = useStyles();
  return (
    <div className={s.section}>
      <h3 className={s.h4}>Links</h3>
      <ul className={s.list}>
        {links.map((l) => {
          const openable = l.checkable && isOpenableUrl(l.address);
          return (
            <li key={`${l.findingId}|${l.address}`} className={s.item} data-link-kind={l.kind}>
              <span className={s.itemText}>
                <span data-link-address="">{l.address}</span>
                <span className={s.sub}>
                  {[l.kind === "linked-file" ? `Linked file${l.linkType ? ` (${l.linkType})` : ""}` : "Hyperlink", l.text ? `“${l.text}”` : undefined]
                    .filter(Boolean)
                    .join(" · ")}{" "}
                  {l.flags.map((f) => (
                    <Tag key={f} warn>
                      {LINK_FLAG_LABELS[f] ?? f}
                    </Tag>
                  ))}
                </span>
              </span>
              {openable && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Open16Regular />}
                  aria-label="Open link in browser"
                  title="Open link in browser"
                  onClick={() => {
                    if (isOpenableUrl(l.address)) openBrowserWindow(l.address);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

function ImagesView({ images }: { images: ImageProperty[] }) {
  const s = useStyles();
  return (
    <div className={s.section}>
      <h3 className={s.h4}>Images</h3>
      {images.map((img) => (
        <dl key={img.partName} className={s.dl} data-image={img.partName}>
          <dt className={s.dt}>Part</dt>
          <dd className={s.dd}>{img.partName}</dd>
          {img.format && (
            <>
              <dt className={s.dt}>Format</dt>
              <dd className={s.dd}>{img.format.toUpperCase()}</dd>
            </>
          )}
          {img.width !== undefined && img.height !== undefined && (
            <>
              <dt className={s.dt}>Native size</dt>
              <dd className={s.dd} data-image-native="">
                {img.width} × {img.height} px
              </dd>
            </>
          )}
          {img.displayed && (
            <>
              <dt className={s.dt}>Displayed</dt>
              <dd className={s.dd}>
                {img.displayed.widthIn} × {img.displayed.heightIn} in
              </dd>
            </>
          )}
          {img.effectivePpi !== undefined && (
            <>
              <dt className={s.dt}>Effective PPI</dt>
              <dd className={s.dd} data-image-ppi="">
                {img.effectivePpi}
              </dd>
            </>
          )}
          {img.scale && (
            <>
              <dt className={s.dt}>Scale</dt>
              <dd className={s.dd} data-image-scale="">
                {pct(img.scale.x)} × {pct(img.scale.y)}
              </dd>
            </>
          )}
          {img.cropPercent && (
            <>
              <dt className={s.dt}>Crop</dt>
              <dd className={s.dd}>
                left {img.cropPercent.left}%, top {img.cropPercent.top}%, right {img.cropPercent.right}%, bottom {img.cropPercent.bottom}%
              </dd>
            </>
          )}
          {img.bytes !== undefined && (
            <>
              <dt className={s.dt}>Size</dt>
              <dd className={s.dd}>
                {formatBytes(img.bytes)}
                {img.shared ? " (shared)" : ""}
              </dd>
            </>
          )}
          {img.issues.length > 0 && (
            <>
              <dt className={s.dt}>Issues</dt>
              <dd className={s.dd}>{img.issues.join(", ")}</dd>
            </>
          )}
        </dl>
      ))}
    </div>
  );
}
