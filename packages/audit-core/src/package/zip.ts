import JSZip from "jszip";
import { PackageError } from "./errors";
import { parseRelationships, relsPartFor, type Relationship } from "./rels";
import { attr, childrenNamed, parseXml, type XmlElement } from "./xml";

export type PackageInput = Uint8Array | ArrayBuffer;

export interface ContentTypes {
  /** Lower-cased extension → content type. */
  readonly defaults: ReadonlyMap<string, string>;
  /** Lower-cased part name (no leading slash) → content type. */
  readonly overrides: ReadonlyMap<string, string>;
}

/** Internal JSZip field; present on every entry of a loaded archive. */
interface JSZipEntryInternals {
  _data?: { uncompressedSize?: number; compressedSize?: number };
}

/**
 * Low-level OPC package: a ZIP of parts plus content types and relationships.
 * Part bodies are read and parsed lazily and cached per part. Nothing here
 * depends on Node or Office APIs, so it runs in a Web Worker (KTD3).
 */
export class OpcPackage {
  private readonly zip: JSZip;
  /** Lower-cased part name → actual ZIP entry name (OPC names are case-insensitive). */
  private readonly index: Map<string, string>;
  private readonly xmlCache = new Map<string, Promise<XmlElement | undefined>>();
  private readonly relsCache = new Map<string, Promise<Relationship[]>>();
  readonly contentTypes: ContentTypes;

  private constructor(zip: JSZip, index: Map<string, string>, contentTypes: ContentTypes) {
    this.zip = zip;
    this.index = index;
    this.contentTypes = contentTypes;
  }

  /**
   * Opens package bytes. Rejects with `PackageError('not-a-zip')` for bytes
   * that are not a ZIP, and `PackageError('not-a-pptx')` for a ZIP that is not
   * an OPC package (no `[Content_Types].xml`).
   */
  static async open(bytes: PackageInput): Promise<OpcPackage> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch (cause) {
      throw new PackageError("not-a-zip", "The file is not a readable ZIP archive.", { cause });
    }
    const index = new Map<string, string>();
    zip.forEach((path, entry) => {
      if (!entry.dir) index.set(path.toLowerCase(), path);
    });
    const ctName = index.get("[content_types].xml");
    if (ctName === undefined) {
      throw new PackageError("not-a-pptx", "The archive has no [Content_Types].xml; it is not an Office document.");
    }
    const ctFile = zip.file(ctName);
    let ctRoot: XmlElement;
    try {
      ctRoot = parseXml(ctFile ? await ctFile.async("string") : "");
    } catch (cause) {
      throw new PackageError("not-a-pptx", "[Content_Types].xml is not valid XML.", { cause, partName: ctName });
    }
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    for (const d of childrenNamed(ctRoot, "Default")) {
      const ext = attr(d, "Extension");
      const ct = attr(d, "ContentType");
      if (ext !== undefined && ct !== undefined) defaults.set(ext.toLowerCase(), ct);
    }
    for (const o of childrenNamed(ctRoot, "Override")) {
      const pn = attr(o, "PartName");
      const ct = attr(o, "ContentType");
      if (pn !== undefined && ct !== undefined) overrides.set(pn.replace(/^\/+/, "").toLowerCase(), ct);
    }
    return new OpcPackage(zip, index, { defaults, overrides });
  }

  /** Every part name in the archive (excluding folders), in ZIP order. */
  get partNames(): string[] {
    return [...this.index.values()];
  }

  /** Actual entry name for a part, matching case-insensitively. */
  private entryName(partName: string): string | undefined {
    return this.index.get(partName.replace(/^\/+/, "").toLowerCase());
  }

  has(partName: string): boolean {
    return this.entryName(partName) !== undefined;
  }

  /** Canonical (as-stored) spelling of a part name, or undefined when absent. */
  canonical(partName: string): string | undefined {
    return this.entryName(partName);
  }

  /** Content type from overrides, then by extension defaults. */
  contentTypeOf(partName: string): string | undefined {
    const key = partName.replace(/^\/+/, "").toLowerCase();
    const override = this.contentTypes.overrides.get(key);
    if (override !== undefined) return override;
    const dot = key.lastIndexOf(".");
    return dot < 0 ? undefined : this.contentTypes.defaults.get(key.slice(dot + 1));
  }

  /**
   * Uncompressed byte size of a part without inflating it (read from the ZIP
   * central directory). Returns undefined for a missing part.
   */
  async size(partName: string): Promise<number | undefined> {
    const name = this.entryName(partName);
    if (name === undefined) return undefined;
    const entry = this.zip.file(name);
    if (!entry) return undefined;
    const internal = (entry as unknown as JSZipEntryInternals)._data;
    if (internal && typeof internal.uncompressedSize === "number") return internal.uncompressedSize;
    // Fallback for entries JSZip did not load from an archive: inflate once.
    return (await entry.async("uint8array")).byteLength;
  }

  /** Compressed byte size in the ZIP, when known. */
  compressedSize(partName: string): number | undefined {
    const name = this.entryName(partName);
    const entry = name === undefined ? null : this.zip.file(name);
    const internal = entry ? (entry as unknown as JSZipEntryInternals)._data : undefined;
    return internal?.compressedSize;
  }

  async readText(partName: string): Promise<string | undefined> {
    const name = this.entryName(partName);
    const entry = name === undefined ? null : this.zip.file(name);
    return entry ? entry.async("string") : undefined;
  }

  async readBytes(partName: string): Promise<Uint8Array | undefined> {
    const name = this.entryName(partName);
    const entry = name === undefined ? null : this.zip.file(name);
    return entry ? entry.async("uint8array") : undefined;
  }

  /**
   * Parsed XML root of a part, cached. Resolves undefined when the part is
   * missing; rejects with `PackageError('malformed-part')` when it is not XML.
   */
  xml(partName: string): Promise<XmlElement | undefined> {
    const key = partName.replace(/^\/+/, "").toLowerCase();
    let cached = this.xmlCache.get(key);
    if (!cached) {
      cached = (async () => {
        const text = await this.readText(partName);
        if (text === undefined) return undefined;
        try {
          return parseXml(text);
        } catch (cause) {
          throw new PackageError("malformed-part", `Part ${partName} is not well-formed XML.`, {
            cause,
            partName,
          });
        }
      })();
      this.xmlCache.set(key, cached);
    }
    return cached;
  }

  /**
   * Relationships whose source is `partName` (`""` for the package root),
   * cached. A part with no rels part has no relationships.
   */
  rels(partName: string): Promise<Relationship[]> {
    const source = partName === "" ? "" : (this.canonical(partName) ?? partName.replace(/^\/+/, ""));
    let cached = this.relsCache.get(source.toLowerCase());
    if (!cached) {
      cached = (async () => {
        const text = await this.readText(relsPartFor(source));
        if (text === undefined) return [];
        // Canonicalise resolved targets to the stored spelling so part names
        // compare with `===` across the model.
        return parseRelationships(source, text).map((r) =>
          r.targetPart === undefined ? r : { ...r, targetPart: this.canonical(r.targetPart) ?? r.targetPart },
        );
      })();
      this.relsCache.set(source.toLowerCase(), cached);
    }
    return cached;
  }
}
