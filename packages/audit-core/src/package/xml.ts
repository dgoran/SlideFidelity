import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Parsed XML tree used by every OOXML part.
 *
 * Parser choice (U3): fast-xml-parser with `preserveOrder: true`.
 * - Element ORDER matters in PresentationML: the `p:spTree` child order is the
 *   z-order, runs inside `a:p` are ordered text, `p:sldIdLst` is the slide
 *   order, and gradient stops / list-style levels are positional. The
 *   non-ordered mode groups same-named siblings into arrays and loses the
 *   interleaving between different names (e.g. `p:sp` vs `p:pic`), so it
 *   cannot answer "what is the 3rd shape" or "what precedes this run".
 * - Namespace prefixes are kept verbatim (`removeNSPrefix: false`), so
 *   `a:latin` and `p:sp` stay distinguishable from same-local-name elements
 *   in other vocabularies; helpers below also offer local-name matching.
 * - Attributes are kept as raw strings (no number coercion: `val="0070C0"`
 *   must not become a number) and text is not trimmed (`a:t` whitespace is
 *   significant).
 * The raw preserveOrder output is converted once into the small
 * `XmlElement` / `XmlText` shape below, which is easier to type and walk.
 */
export interface XmlElement {
  readonly type: "element";
  /** Qualified name exactly as written, e.g. `p:sp`. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export interface XmlText {
  readonly type: "text";
  readonly text: string;
}

export type XmlNode = XmlElement | XmlText;

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Single-pass XML entity decoding: the five predefined entities plus decimal
 * and hex character references (`&#8226;` in `a:buChar`, emoji in text).
 * Single pass keeps `&amp;#65;` as the literal text `&#65;`. HTML-only names
 * such as `&nbsp;` are not XML entities and are left as written.
 */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return XML_NAMED_ENTITIES[e] ?? m;
  });
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: true,
  entityDecoder: {
    decode: decodeXmlEntities,
    setExternalEntities: () => undefined,
    addInputEntities: () => undefined,
    reset: () => undefined,
    setXmlVersion: () => undefined,
  },
  commentPropName: false,
});

type RawOrdered = Record<string, unknown>;

function convert(raw: readonly unknown[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as RawOrdered;
    for (const key of Object.keys(rec)) {
      if (key === ":@") continue;
      const value = rec[key];
      if (key === "#text") {
        out.push({ type: "text", text: String(value ?? "") });
        continue;
      }
      const rawAttrs = rec[":@"];
      const attrs: Record<string, string> = {};
      if (rawAttrs && typeof rawAttrs === "object") {
        for (const [k, v] of Object.entries(rawAttrs as Record<string, unknown>)) {
          attrs[k] = String(v);
        }
      }
      out.push({
        type: "element",
        name: key,
        attrs,
        children: Array.isArray(value) ? convert(value) : [],
      });
    }
  }
  // Pretty-printing whitespace between elements is not content. Text is only
  // meaningful in leaf elements such as `a:t`, whose whitespace is kept.
  if (out.some((n) => n.type === "element")) {
    return out.filter((n) => n.type === "element" || n.text.trim() !== "");
  }
  return out;
}

/**
 * Parses an XML document and returns its root element.
 * Throws an `Error` when the text has no root element or the parser rejects it.
 */
export function parseXml(text: string): XmlElement {
  // The parser is lenient (unclosed tags still yield a tree), so validate
  // well-formedness first: a truncated part must surface as malformed rather
  // than as a silently partial model.
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    throw new Error(`XML is not well-formed: ${valid.err.msg} (line ${valid.err.line})`);
  }
  const raw: unknown = parser.parse(text);
  if (!Array.isArray(raw)) throw new Error("XML parser returned no document");
  const root = convert(raw).find((n): n is XmlElement => n.type === "element");
  if (!root) throw new Error("XML document has no root element");
  return root;
}

/** Local part of a qualified name: `p:sp` → `sp`. */
export function localName(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
}

/** Namespace prefix of a qualified name: `p:sp` → `p`, `Types` → ``. */
export function prefixOf(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? "" : name.slice(0, i);
}

function matches(el: XmlElement, name: string): boolean {
  // A name with a prefix matches exactly; a bare name matches by local name.
  return name.includes(":") ? el.name === name : localName(el.name) === name;
}

/** Element children only, in document order. */
export function elements(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.type === "element");
}

/**
 * Child elements named `name`. A qualified name (`p:sp`) matches exactly; a
 * bare name (`sp`) matches any prefix by local name.
 */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return elements(el).filter((c) => matches(c, name));
}

/** First child element named `name` (see `childrenNamed` for matching). */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) {
    if (c.type === "element" && matches(c, name)) return c;
  }
  return undefined;
}

/** Follows a path of child names: `childPath(sld, "cSld", "spTree")`. */
export function childPath(el: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  let cur = el;
  for (const n of names) cur = child(cur, n);
  return cur;
}

/** All descendant elements named `name`, depth-first in document order. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    for (const c of node.children) {
      if (c.type !== "element") continue;
      if (matches(c, name)) out.push(c);
      visit(c);
    }
  };
  visit(el);
  return out;
}

/** Attribute value by exact qualified name (`r:id`, `val`). */
export function attr(el: XmlElement | undefined, name: string): string | undefined {
  return el?.attrs[name];
}

/** Integer attribute, or undefined when missing / not an integer. */
export function intAttr(el: XmlElement | undefined, name: string): number | undefined {
  const v = attr(el, name);
  if (v === undefined || !/^-?\d+$/.test(v.trim())) return undefined;
  return Number.parseInt(v, 10);
}

/** OOXML boolean attribute (`1`/`true` → true, `0`/`false` → false). */
export function boolAttr(el: XmlElement | undefined, name: string): boolean | undefined {
  const v = attr(el, name);
  if (v === undefined) return undefined;
  if (v === "1" || v === "true" || v === "on") return true;
  if (v === "0" || v === "false" || v === "off") return false;
  return undefined;
}

/**
 * Attribute in the relationships namespace regardless of the prefix the
 * producer bound it to (almost always `r:`).
 */
export function relAttr(el: XmlElement | undefined, local: string): string | undefined {
  if (!el) return undefined;
  const direct = el.attrs[`r:${local}`];
  if (direct !== undefined) return direct;
  for (const [k, v] of Object.entries(el.attrs)) {
    if (localName(k) === local && prefixOf(k) !== "") return v;
  }
  return undefined;
}

/** Concatenated text of all descendant text nodes. */
export function textContent(el: XmlElement | undefined): string {
  if (!el) return "";
  let out = "";
  for (const c of el.children) out += c.type === "text" ? c.text : textContent(c);
  return out;
}
