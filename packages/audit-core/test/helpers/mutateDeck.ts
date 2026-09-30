/**
 * Edits parts of an existing package through JSZip (KTD10): targeted edge
 * cases are derived from a corpus deck instead of new builder options.
 */
import JSZip from "jszip";
import { relsPartFor, resolveTarget } from "../../src/package/rels";

export interface DeckMutator {
  /** All file paths in the archive. */
  paths(): string[];
  exists(path: string): boolean;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): void;
  writeBytes(path: string, bytes: Uint8Array): void;
  /** Replaces a part's text with `fn(old)`. Throws when the part is missing. */
  editXml(path: string, fn: (xml: string) => string): Promise<void>;
  /** Deletes a file only (no reference cleanup). */
  remove(path: string): void;
  /**
   * Deletes a part and cleans references: its `[Content_Types].xml` override,
   * its own rels part, and every `Relationship` in any rels part whose
   * resolved target is this part.
   */
  removePart(path: string): Promise<void>;
  /** Adds or replaces a content-type override for a part. */
  setContentType(path: string, contentType: string): Promise<void>;
}

const FIXED_DATE = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

export async function mutateDeck(
  bytes: Uint8Array,
  fn: (m: DeckMutator) => Promise<void> | void,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const paths = (): string[] => {
    const out: string[] = [];
    zip.forEach((p, e) => {
      if (!e.dir) out.push(p);
    });
    return out;
  };
  const readText = async (path: string): Promise<string> => {
    const f = zip.file(path);
    if (!f) throw new Error(`mutateDeck: no part ${path}`);
    return f.async("string");
  };
  const writeText = (path: string, text: string): void => {
    zip.file(path, text, { date: FIXED_DATE, createFolders: false });
  };
  const m: DeckMutator = {
    paths,
    exists: (p) => zip.file(p) !== null,
    readText,
    writeText,
    writeBytes: (p, b) => {
      zip.file(p, b, { date: FIXED_DATE, createFolders: false });
    },
    async editXml(path, edit) {
      writeText(path, edit(await readText(path)));
    },
    remove: (p) => {
      zip.remove(p);
    },
    async removePart(path) {
      zip.remove(path);
      zip.remove(relsPartFor(path));
      const ct = await readText("[Content_Types].xml");
      writeText(
        "[Content_Types].xml",
        ct.replace(new RegExp(`<Override PartName="/${escapeRe(path)}"[^>]*/>`, "g"), ""),
      );
      for (const p of paths()) {
        if (!p.endsWith(".rels")) continue;
        const source = p === "_rels/.rels" ? "" : p.replace(/(^|\/)_rels\/([^/]*)\.rels$/, "$1$2");
        const text = await readText(p);
        const next = text.replace(/<Relationship\b[^>]*\/>/g, (rel) => {
          if (/TargetMode="External"/.test(rel)) return rel;
          const target = /Target="([^"]*)"/.exec(rel)?.[1];
          return target !== undefined && resolveTarget(source, target) === path ? "" : rel;
        });
        if (next !== text) writeText(p, next);
      }
    },
    async setContentType(path, contentType) {
      const ct = await readText("[Content_Types].xml");
      const override = `<Override PartName="/${path}" ContentType="${contentType}"/>`;
      const re = new RegExp(`<Override PartName="/${escapeRe(path)}"[^>]*/>`);
      writeText("[Content_Types].xml", re.test(ct) ? ct.replace(re, override) : ct.replace("</Types>", `${override}</Types>`));
    },
  };
  await fn(m);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
