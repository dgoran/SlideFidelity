/**
 * A small fake of the PowerPoint JavaScript API request model, for fix-engine tests.
 *
 * Semantics it enforces (the parts batching code gets wrong):
 * - Property reads throw `PropertyNotLoaded` unless the object was `load()`ed and a `sync()` ran.
 *   Loaded values are a snapshot taken at sync time.
 * - Writes and deletes are queued and only take effect on `sync()`, in queue order with loads.
 * - Operations on a deleted shape / hyperlink fail at sync with `ItemNotFound`.
 * - `failSync()` injects a failure: the chosen sync applies its first `afterOps` queued operations,
 *   then throws, like a non-atomic Office.js batch.
 *
 * Covered surface: `presentation.slides` (id, shapes, hyperlinks), shapes (id, name, type, left,
 * top, width, height, visible, delete, textFrame.textRange, fill, lineFormat, getTable, group),
 * text ranges (text, font.name/color/size, getSubstring), table cells (text, font, fill,
 * isNullObject), groups (shapes), hyperlinks (address, delete), `presentation.slideMasters`
 * (id, name, shapes, layouts → id, name, shapes) and `shape.placeholderFormat.type` (1.8).
 */
import {
  makeFinding,
  type Finding,
  type FindingTarget,
  type FontUsageRef,
  type TargetContainerKind,
  type TargetLocator,
} from "@slidecheck/audit-core";

export interface FakeFont {
  name: string;
  color: string;
  /** Points. */
  size?: number;
}

export interface FakeRun {
  text: string;
  font: FakeFont;
}

export interface FakeFill {
  type: string;
  foregroundColor: string;
}

export interface FakeCell {
  runs: FakeRun[];
  fill?: FakeFill;
}

export interface FakeShape {
  id: string;
  name: string;
  type?: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  /** Text frame content; absent for shapes without text. */
  runs?: FakeRun[];
  fill?: FakeFill;
  line?: { color: string };
  table?: { cells: FakeCell[][] };
  /** Group children (type "Group"). */
  shapes?: FakeShape[];
  /** Office.js placeholder type ("Title", "CenterTitle", "SlideNumber", ...): the shape type is "Placeholder". */
  placeholderType?: string;
  /** Set by the fake when the shape is deleted. */
  deleted?: boolean;
}

export interface FakeHyperlink {
  address: string;
  deleted?: boolean;
}

export interface FakeSlide {
  id: string;
  shapes: FakeShape[];
  hyperlinks?: FakeHyperlink[];
}

export interface FakeLayout {
  id: string;
  name: string;
  shapes: FakeShape[];
}

export interface FakeMaster {
  id: string;
  name: string;
  shapes: FakeShape[];
  layouts: FakeLayout[];
}

export interface FakeDeck {
  slides: FakeSlide[];
  masters?: FakeMaster[];
}

export interface SyncFailure {
  /** 1-based global sync number to fail. */
  onSync?: number;
  /** Fail the n-th (1-based) sync whose queue holds at least one write. */
  onWriteSync?: number;
  /** Queued operations applied before the failure (default 0). */
  afterOps?: number;
  message?: string;
}

export type FakeRunFn = <T>(batch: (context: PowerPoint.RequestContext) => Promise<T>) => Promise<T>;

export interface FakePowerPoint {
  /** The live model; mutate it to simulate edits made after a scan. */
  deck: FakeDeck;
  run: FakeRunFn;
  /** Total `sync()` calls across all contexts. */
  readonly syncCount: number;
  /** Number of `run()` calls. */
  readonly runCount: number;
  /** Human-readable log of every write/delete that took effect. */
  readonly writes: string[];
  /** Syncs that contained at least one write, by global sync number. */
  readonly writeSyncs: number[];
  failSync(failure: SyncFailure): void;
}

// ---------------------------------------------------------------------------------------------
// Text helpers

function textOf(runs: readonly FakeRun[]): string {
  return runs.map((r) => r.text).join("");
}

/** Split runs so that `at` falls on a run boundary. */
function splitAt(runs: FakeRun[], at: number): void {
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    const end = pos + r.text.length;
    if (at > pos && at < end) {
      const left: FakeRun = { text: r.text.slice(0, at - pos), font: { ...r.font } };
      const right: FakeRun = { text: r.text.slice(at - pos), font: { ...r.font } };
      runs.splice(i, 1, left, right);
      return;
    }
    pos = end;
  }
}

function runsIn(runs: readonly FakeRun[], start: number, length: number): FakeRun[] {
  if (length === 0) {
    // An empty range reports the formatting at its insertion point.
    let pos = 0;
    for (const r of runs) {
      if (start <= pos + r.text.length) return [r];
      pos += r.text.length;
    }
    return runs.length ? [runs[runs.length - 1]!] : [];
  }
  const out: FakeRun[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (end > start && pos < start + length) out.push(r);
    pos = end;
  }
  return out;
}

function uniform(runs: readonly FakeRun[], prop: keyof FakeFont): string | number | null {
  if (runs.length === 0) return null;
  const first = runs[0]!.font[prop];
  return first !== undefined && runs.every((r) => r.font[prop] === first) ? first : null;
}

function setFontProp<P extends keyof FakeFont>(runs: FakeRun[], start: number, length: number, prop: P, value: NonNullable<FakeFont[P]>): void {
  const total = textOf(runs).length;
  if (length === 0 && total === 0) {
    for (const r of runs) r.font[prop] = value;
    return;
  }
  splitAt(runs, start);
  splitAt(runs, start + length);
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (pos >= start && end <= start + length && r.text.length > 0) r.font[prop] = value;
    pos = end;
  }
}

// ---------------------------------------------------------------------------------------------
// Request context and proxies

class NotLoaded extends Error {
  constructor(prop: string) {
    super(`PropertyNotLoaded: ${prop}`);
    this.name = "PropertyNotLoaded";
  }
}

class ItemNotFound extends Error {
  constructor(what: string) {
    super(`ItemNotFound: ${what}`);
    this.name = "ItemNotFound";
  }
}

interface Op {
  write: boolean;
  apply: () => void;
}

interface World {
  deck: FakeDeck;
  syncCount: number;
  runCount: number;
  writes: string[];
  writeSyncs: number[];
  failures: SyncFailure[];
  writeQueueCount: number;
}

class Ctx {
  queue: Op[] = [];
  presentation: { slides: SlideCollection; slideMasters: MasterCollection };
  constructor(readonly world: World) {
    this.presentation = {
      slides: new SlideCollection(this, () => world.deck.slides),
      slideMasters: new MasterCollection(this, () => world.deck.masters ?? []),
    };
  }
  enqueue(op: Op): void {
    this.queue.push(op);
  }
  write(desc: string, apply: () => void): void {
    this.enqueue({
      write: true,
      apply: () => {
        apply();
        this.world.writes.push(desc);
      },
    });
  }
  sync(): Promise<void> {
    const w = this.world;
    w.syncCount += 1;
    const n = w.syncCount;
    const ops = this.queue;
    this.queue = [];
    const hasWrite = ops.some((o) => o.write);
    if (hasWrite) w.writeQueueCount += 1;
    const wq = w.writeQueueCount;
    const failure = w.failures.find((f) => f.onSync === n || (hasWrite && f.onWriteSync === wq));
    const limit = failure ? (failure.afterOps ?? 0) : ops.length;
    let wrote = false;
    try {
      for (let i = 0; i < Math.min(limit, ops.length); i++) {
        const op = ops[i]!;
        op.apply();
        if (op.write) wrote = true;
      }
    } catch (e) {
      if (wrote) w.writeSyncs.push(n);
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    if (wrote) w.writeSyncs.push(n);
    if (failure) return Promise.reject(new Error(failure.message ?? `GeneralException: injected failure on sync ${n}`));
    return Promise.resolve();
  }
}

abstract class FakeObject {
  protected values = new Map<string, unknown>();
  private synced = false;
  constructor(protected ctx: Ctx) {}
  /** Current live value of a property, computed at sync time. */
  protected abstract live(prop: string): unknown;
  protected assertAlive(): void {}
  load(props?: string | string[]): this {
    const list = (Array.isArray(props) ? props : (props ?? "").split(","))
      .map((p) => p.trim())
      .filter(Boolean);
    this.ctx.enqueue({
      write: false,
      apply: () => {
        this.assertAlive();
        this.synced = true;
        for (const p of list) this.values.set(p, this.live(p));
      },
    });
    return this;
  }
  protected read<T>(prop: string): T {
    if (!this.values.has(prop)) throw new NotLoaded(prop);
    return this.values.get(prop) as T;
  }
  protected loadedOnce(): boolean {
    return this.synced;
  }
  /** Loaded by a parent collection's `items/...` load. */
  hydrate(props: string[]): void {
    this.assertAlive();
    this.synced = true;
    for (const p of props) this.values.set(p, this.live(p));
  }
}

class FontProxy extends FakeObject {
  constructor(
    ctx: Ctx,
    private runs: () => FakeRun[],
    private start: () => number,
    private length: () => number,
    private alive: () => void,
    private label: string,
  ) {
    super(ctx);
  }
  protected override assertAlive(): void {
    this.alive();
  }
  protected live(prop: string): unknown {
    if (prop !== "name" && prop !== "color" && prop !== "size") return undefined;
    return uniform(runsIn(this.runs(), this.start(), this.length()), prop);
  }
  get size(): number | null {
    return this.read("size");
  }
  set size(v: number | null) {
    if (v === null) return;
    this.ctx.write(`${this.label} font.size=${v}`, () => {
      this.alive();
      setFontProp(this.runs(), this.start(), this.length(), "size", v);
    });
  }
  get name(): string | null {
    return this.read("name");
  }
  set name(v: string | null) {
    this.set("name", v);
  }
  get color(): string | null {
    return this.read("color");
  }
  set color(v: string | null) {
    this.set("color", v);
  }
  private set(prop: "name" | "color", v: string | null): void {
    if (v === null) return;
    this.ctx.write(`${this.label} font.${prop}=${v}`, () => {
      this.alive();
      setFontProp(this.runs(), this.start(), this.length(), prop, v);
    });
  }
}

class TextRangeProxy extends FakeObject {
  readonly font: FontProxy;
  constructor(
    ctx: Ctx,
    private runs: () => FakeRun[],
    private start: number,
    private len: number | null,
    private alive: () => void,
    private label: string,
  ) {
    super(ctx);
    this.font = new FontProxy(ctx, runs, () => this.start, () => this.length(), alive, `${label}[${start}+${len ?? "*"}]`);
  }
  private length(): number {
    return this.len ?? textOf(this.runs()).length - this.start;
  }
  protected override assertAlive(): void {
    this.alive();
  }
  protected live(prop: string): unknown {
    if (prop === "text") return textOf(this.runs()).slice(this.start, this.start + this.length());
    if (prop === "start") return this.start;
    if (prop === "length") return this.length();
    return undefined;
  }
  get text(): string {
    return this.read("text");
  }
  getSubstring(start: number, length?: number): TextRangeProxy {
    return new TextRangeProxy(this.ctx, this.runs, this.start + start, length ?? null, this.alive, this.label);
  }
}

class FillProxy extends FakeObject {
  constructor(
    ctx: Ctx,
    private get_: () => FakeFill | undefined,
    private set_: (f: FakeFill) => void,
    private alive: () => void,
    private label: string,
  ) {
    super(ctx);
  }
  protected override assertAlive(): void {
    this.alive();
  }
  protected live(prop: string): unknown {
    const f = this.get_();
    if (prop === "type") return f?.type ?? "NoFill";
    if (prop === "foregroundColor") return f?.foregroundColor ?? "";
    return undefined;
  }
  get type(): string {
    return this.read("type");
  }
  get foregroundColor(): string {
    return this.read("foregroundColor");
  }
  setSolidColor(color: string): void {
    this.ctx.write(`${this.label} fill=${color}`, () => {
      this.alive();
      this.set_({ type: "Solid", foregroundColor: color });
    });
  }
}

class LineProxy extends FakeObject {
  constructor(
    ctx: Ctx,
    private shape: FakeShape,
    private alive: () => void,
  ) {
    super(ctx);
  }
  protected override assertAlive(): void {
    this.alive();
  }
  protected live(prop: string): unknown {
    if (prop === "color") return this.shape.line?.color ?? "";
    return undefined;
  }
  get color(): string {
    return this.read("color");
  }
  set color(v: string) {
    this.ctx.write(`shape ${this.shape.id} line=${v}`, () => {
      this.alive();
      this.shape.line = { ...(this.shape.line ?? {}), color: v };
    });
  }
}

class CellProxy extends FakeObject {
  readonly font: FontProxy;
  readonly fill: FillProxy;
  constructor(
    ctx: Ctx,
    private cell: () => FakeCell | undefined,
    private alive: () => void,
    label: string,
  ) {
    super(ctx);
    const runs = (): FakeRun[] => {
      // Null object: reads come back null, writes are no-ops (as in Office.js).
      return this.cell()?.runs ?? [];
    };
    this.font = new FontProxy(ctx, runs, () => 0, () => textOf(runs()).length, alive, label);
    this.fill = new FillProxy(
      ctx,
      () => this.cell()?.fill,
      (f) => {
        const c = this.cell();
        if (!c) throw new ItemNotFound(label);
        c.fill = f;
      },
      alive,
      label,
    );
  }
  protected override assertAlive(): void {
    this.alive();
  }
  protected live(prop: string): unknown {
    const c = this.cell();
    if (prop === "text") return c ? textOf(c.runs) : "";
    return undefined;
  }
  get isNullObject(): boolean {
    if (!this.loadedOnce()) throw new NotLoaded("isNullObject");
    return this.cell() === undefined;
  }
  get text(): string {
    return this.read("text");
  }
}

class TableProxy {
  constructor(
    private ctx: Ctx,
    private shape: FakeShape,
    private alive: () => void,
  ) {}
  getCellOrNullObject(row: number, col: number): CellProxy {
    return new CellProxy(
      this.ctx,
      () => {
        this.alive();
        if (!this.shape.table) throw new Error(`InvalidArgument: shape ${this.shape.id} is not a table`);
        return this.shape.table.cells[row]?.[col];
      },
      this.alive,
      `shape ${this.shape.id} cell ${row},${col}`,
    );
  }
}

class ShapeProxy extends FakeObject {
  constructor(
    ctx: Ctx,
    readonly data: FakeShape,
    private parent: () => FakeShape[],
  ) {
    super(ctx);
  }
  private readonly alive = (): void => {
    if (this.data.deleted) throw new ItemNotFound(`shape ${this.data.id}`);
  };
  protected override assertAlive(): void {
    this.alive();
  }
  protected live(prop: string): unknown {
    const d = this.data;
    switch (prop) {
      case "id":
        return d.id;
      case "name":
        return d.name;
      case "type":
        return d.type ?? (d.placeholderType ? "Placeholder" : d.shapes ? "Group" : d.table ? "Table" : d.runs ? "TextBox" : "GeometricShape");
      case "left":
        return d.left ?? 0;
      case "top":
        return d.top ?? 0;
      case "width":
        return d.width ?? 100;
      case "height":
        return d.height ?? 50;
      case "visible":
        return d.visible ?? true;
      default:
        return undefined;
    }
  }
  get id(): string {
    return this.read("id");
  }
  get name(): string {
    return this.read("name");
  }
  get type(): string {
    return this.read("type");
  }
  get left(): number {
    return this.read("left");
  }
  get top(): number {
    return this.read("top");
  }
  get width(): number {
    return this.read("width");
  }
  get height(): number {
    return this.read("height");
  }
  get visible(): boolean {
    return this.read("visible");
  }
  get textFrame(): { textRange: TextRangeProxy } {
    const runs = (): FakeRun[] => {
      if (!this.data.runs) throw new Error(`InvalidArgument: shape ${this.data.id} has no text frame`);
      return this.data.runs;
    };
    return { textRange: new TextRangeProxy(this.ctx, runs, 0, null, this.alive, `shape ${this.data.id} text`) };
  }
  get fill(): FillProxy {
    return new FillProxy(
      this.ctx,
      () => this.data.fill,
      (f) => {
        this.data.fill = f;
      },
      this.alive,
      `shape ${this.data.id}`,
    );
  }
  get lineFormat(): LineProxy {
    return new LineProxy(this.ctx, this.data, this.alive);
  }
  get group(): { shapes: ShapeCollection } {
    return {
      shapes: new ShapeCollection(this.ctx, () => {
        this.alive();
        if (!this.data.shapes) throw new Error(`InvalidArgument: shape ${this.data.id} is not a group`);
        return this.data.shapes;
      }),
    };
  }
  get placeholderFormat(): PlaceholderFormatProxy {
    return new PlaceholderFormatProxy(this.ctx, this.data, this.alive);
  }
  getTable(): TableProxy {
    return new TableProxy(this.ctx, this.data, this.alive);
  }
  delete(): void {
    this.ctx.write(`delete shape ${this.data.id}`, () => {
      this.alive();
      const list = this.parent();
      const i = list.indexOf(this.data);
      if (i >= 0) list.splice(i, 1);
      this.data.deleted = true;
    });
  }
}

class PlaceholderFormatProxy extends FakeObject {
  constructor(
    ctx: Ctx,
    private shape: FakeShape,
    private alive: () => void,
  ) {
    super(ctx);
  }
  protected override assertAlive(): void {
    this.alive();
    if (!this.shape.placeholderType) throw new Error(`GeneralException: shape ${this.shape.id} is not a placeholder`);
  }
  protected live(prop: string): unknown {
    return prop === "type" ? this.shape.placeholderType : undefined;
  }
  get type(): string {
    return this.read("type");
  }
}

class HyperlinkProxy extends FakeObject {
  constructor(
    ctx: Ctx,
    readonly data: FakeHyperlink,
    private parent: () => FakeHyperlink[],
  ) {
    super(ctx);
  }
  private readonly alive = (): void => {
    if (this.data.deleted) throw new ItemNotFound(`hyperlink ${this.data.address}`);
  };
  protected override assertAlive(): void {
    this.alive();
  }
  protected live(prop: string): unknown {
    if (prop === "address") return this.data.address;
    return undefined;
  }
  get address(): string {
    return this.read("address");
  }
  set address(v: string) {
    const was = this.data.address;
    this.ctx.write(`hyperlink ${was} -> ${v}`, () => {
      this.alive();
      this.data.address = v;
    });
  }
  delete(): void {
    this.ctx.write(`delete hyperlink ${this.data.address}`, () => {
      this.alive();
      const list = this.parent();
      const i = list.indexOf(this.data);
      if (i >= 0) list.splice(i, 1);
      this.data.deleted = true;
    });
  }
}

abstract class Collection<T extends FakeObject> {
  private loaded: T[] | undefined;
  constructor(protected ctx: Ctx) {}
  protected abstract list(): T[];
  load(props?: string): this {
    const sub = (props ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.startsWith("items/"))
      .map((p) => p.slice("items/".length));
    this.ctx.enqueue({
      write: false,
      apply: () => {
        const items = this.list();
        for (const it of items) it.hydrate(sub);
        this.loaded = items;
      },
    });
    return this;
  }
  get items(): T[] {
    if (!this.loaded) throw new NotLoaded("items");
    return this.loaded;
  }
}

class ShapeCollection extends Collection<ShapeProxy> {
  constructor(
    ctx: Ctx,
    private shapes: () => FakeShape[],
  ) {
    super(ctx);
  }
  protected list(): ShapeProxy[] {
    const arr = this.shapes();
    return arr.map((s) => new ShapeProxy(this.ctx, s, this.shapes));
  }
}

class HyperlinkCollection extends Collection<HyperlinkProxy> {
  constructor(
    ctx: Ctx,
    private links: () => FakeHyperlink[],
  ) {
    super(ctx);
  }
  protected list(): HyperlinkProxy[] {
    return this.links().map((h) => new HyperlinkProxy(this.ctx, h, this.links));
  }
}

class SlideProxy extends FakeObject {
  readonly shapes: ShapeCollection;
  readonly hyperlinks: HyperlinkCollection;
  constructor(
    ctx: Ctx,
    readonly data: FakeSlide,
  ) {
    super(ctx);
    this.shapes = new ShapeCollection(ctx, () => data.shapes);
    this.hyperlinks = new HyperlinkCollection(ctx, () => {
      data.hyperlinks ??= [];
      return data.hyperlinks;
    });
  }
  protected live(prop: string): unknown {
    return prop === "id" ? this.data.id : undefined;
  }
  get id(): string {
    return this.read("id");
  }
}

class SlideCollection extends Collection<SlideProxy> {
  constructor(
    ctx: Ctx,
    private slides: () => FakeSlide[],
  ) {
    super(ctx);
  }
  protected list(): SlideProxy[] {
    return this.slides().map((s) => new SlideProxy(this.ctx, s));
  }
}

class LayoutProxy extends FakeObject {
  readonly shapes: ShapeCollection;
  constructor(
    ctx: Ctx,
    readonly data: FakeLayout | FakeMaster,
  ) {
    super(ctx);
    this.shapes = new ShapeCollection(ctx, () => data.shapes);
  }
  protected live(prop: string): unknown {
    if (prop === "id") return this.data.id;
    if (prop === "name") return this.data.name;
    return undefined;
  }
  get id(): string {
    return this.read("id");
  }
  get name(): string {
    return this.read("name");
  }
}

class LayoutCollection extends Collection<LayoutProxy> {
  constructor(
    ctx: Ctx,
    private layouts: () => FakeLayout[],
  ) {
    super(ctx);
  }
  protected list(): LayoutProxy[] {
    return this.layouts().map((l) => new LayoutProxy(this.ctx, l));
  }
}

class MasterProxy extends LayoutProxy {
  readonly layouts: LayoutCollection;
  constructor(ctx: Ctx, data: FakeMaster) {
    super(ctx, data);
    this.layouts = new LayoutCollection(ctx, () => data.layouts);
  }
}

class MasterCollection extends Collection<MasterProxy> {
  constructor(
    ctx: Ctx,
    private masters: () => FakeMaster[],
  ) {
    super(ctx);
  }
  protected list(): MasterProxy[] {
    return this.masters().map((m) => new MasterProxy(this.ctx, m));
  }
}

// ---------------------------------------------------------------------------------------------

export function createFakePowerPoint(deck: FakeDeck): FakePowerPoint {
  const world: World = { deck, syncCount: 0, runCount: 0, writes: [], writeSyncs: [], failures: [], writeQueueCount: 0 };
  const run: FakeRunFn = async (batch) => {
    world.runCount += 1;
    const ctx = new Ctx(world);
    const result = await batch(ctx as unknown as PowerPoint.RequestContext);
    await ctx.sync();
    return result;
  };
  return {
    get deck() {
      return world.deck;
    },
    set deck(d: FakeDeck) {
      world.deck = d;
    },
    run,
    get syncCount() {
      return world.syncCount;
    },
    get runCount() {
      return world.runCount;
    },
    get writes() {
      return world.writes;
    },
    get writeSyncs() {
      return world.writeSyncs;
    },
    failSync(f: SyncFailure) {
      world.failures.push(f);
    },
  };
}

/** Plain text of a fake shape's text frame, for assertions. */
export function fakeText(shape: FakeShape): string {
  return textOf(shape.runs ?? []);
}

/** Convenience run builder. */
export function run(text: string, name: string, color = "#000000"): FakeRun {
  return { text, font: { name, color } };
}

// ---------------------------------------------------------------------------------------------
// Finding fixtures (plain data shaped like the audit-core checks' output)

export interface TargetSpec {
  slideId?: number;
  slideNumber?: number;
  slideIndex?: number;
  shapeId: number;
  shapeName?: string;
  /** Points (converted to EMU bounds). */
  left?: number;
  top?: number;
  path?: number[];
  locator?: TargetLocator;
  reachable?: boolean;
  containerKind?: TargetContainerKind;
  partName?: string;
  containerName?: string;
}

export function target(spec: TargetSpec): FindingTarget {
  const kind = spec.containerKind ?? "slide";
  const slideNumber = spec.slideNumber ?? 1;
  const container: FindingTarget["container"] = {
    kind,
    partName: spec.partName ?? (kind === "slide" ? `ppt/slides/slide${slideNumber}.xml` : `ppt/${kind}s/${kind}1.xml`),
  };
  if (kind === "slide" || kind === "chart" || kind === "diagram") {
    container.slideId = spec.slideId ?? 255 + slideNumber;
    container.slideNumber = slideNumber;
    container.slideIndex = spec.slideIndex ?? slideNumber - 1;
  }
  if (spec.containerName !== undefined) container.name = spec.containerName;
  const t: FindingTarget = {
    container,
    shapeId: spec.shapeId,
    shapeName: spec.shapeName ?? `Shape ${spec.shapeId}`,
    path: spec.path ?? [],
    bounds: { x: (spec.left ?? 0) * 12700, y: (spec.top ?? 0) * 12700, cx: 100 * 12700, cy: 50 * 12700 },
  };
  if (spec.locator) t.locator = spec.locator;
  if (spec.reachable !== undefined) t.reachable = spec.reachable;
  return t;
}

export function fontUsageFinding(typeface: string, entries: { target: FindingTarget; usage?: Partial<FontUsageRef> }[]): Finding {
  const usages: FontUsageRef[] = entries.map((e) => ({ script: "latin", source: "direct", ...e.usage }));
  const reachableCount = entries.filter((e) => e.target.reachable === true).length;
  return makeFinding({
    area: "fonts",
    kind: "font-usage",
    severity: "info",
    title: typeface,
    group: typeface,
    count: entries.length,
    targets: entries.map((e) => e.target),
    fixes: ["replace-font"],
    reachable: reachableCount > 0,
    data: {
      typeface,
      usages,
      breakdown: [],
      reachableCount,
      unreachableCount: entries.length - reachableCount,
      inBrand: null,
      embedding: "none",
    },
  });
}

export function colorUsageFinding(hex: string, targets: FindingTarget[]): Finding {
  const reachableCount = targets.filter((t) => t.reachable === true).length;
  return makeFinding({
    area: "colors",
    kind: "color-usage",
    severity: "warning",
    title: `#${hex}`,
    group: hex,
    count: targets.length,
    targets,
    fixes: ["replace-color"],
    reachable: reachableCount > 0,
    data: {
      hex,
      kinds: ["srgb"],
      names: [],
      count: targets.length,
      reachableCount,
      contexts: ["fill"],
      byMaster: [],
      brandSource: "theme",
    },
  });
}

export function shapeReviewFinding(
  kind: "hidden-shape" | "off-slide-shape" | "empty-placeholder",
  t: FindingTarget,
  key?: string,
): Finding {
  const base = {
    area: "review" as const,
    severity: "warning" as const,
    title: kind,
    group: kind,
    targets: [t],
    fixes: ["delete-shapes" as const],
    reachable: t.reachable ?? true,
    ...(key ? { key } : {}),
  };
  const shape = { shapeName: t.shapeName ?? "", shapeKind: "sp" as const, containerKind: "slide" as const };
  if (kind === "off-slide-shape") {
    return makeFinding({ ...base, kind, data: { ...shape, direction: "right", inherited: false } });
  }
  if (kind === "empty-placeholder") {
    return makeFinding({ ...base, kind, data: { ...shape, placeholderType: "body" } });
  }
  return makeFinding({ ...base, kind, data: shape });
}

export function hyperlinkFinding(address: string, t: FindingTarget, trigger: "click" | "hover" = "click"): Finding {
  return makeFinding({
    area: "links",
    kind: "hyperlink",
    severity: "info",
    title: address,
    group: address,
    targets: [t],
    fixes: ["edit-hyperlink", "remove-hyperlink"],
    reachable: t.reachable ?? false,
    data: {
      address,
      scheme: address.split(":")[0] ?? "",
      trigger,
      location: "text",
      relId: "rId9",
      containerKind: "slide",
      checkable: address.startsWith("http"),
    },
  });
}

/** `isSetSupported` for a host that supports PowerPointApi up to `max` (e.g. "1.9"). */
export function supportsUpTo(max: string): (version: string) => boolean {
  const [maj, min] = max.split(".").map(Number);
  return (v) => {
    const [a, b] = v.split(".").map(Number);
    return a! < maj! || (a === maj && b! <= min!);
  };
}
