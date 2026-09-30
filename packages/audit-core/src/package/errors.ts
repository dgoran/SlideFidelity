/**
 * - `not-a-zip`: the bytes are not a readable ZIP archive.
 * - `not-a-pptx`: a valid ZIP/OPC package whose main part is not a
 *   PresentationML presentation (e.g. a .docx or .xlsx), or has no main part.
 * - `malformed-part`: a part the model requires (presentation.xml, a slide,
 *   layout, master, or theme) is missing or is not parseable XML.
 */
export type PackageErrorCode = "not-a-zip" | "not-a-pptx" | "malformed-part";

export class PackageError extends Error {
  readonly code: PackageErrorCode;
  readonly partName: string | undefined;

  constructor(code: PackageErrorCode, message: string, options?: { partName?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PackageError";
    this.code = code;
    this.partName = options?.partName;
  }
}

export function isPackageError(e: unknown): e is PackageError {
  return e instanceof PackageError;
}
