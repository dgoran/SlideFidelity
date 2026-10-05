/**
 * D16 "Open pre-fix copy": open the bytes the fix started from (`FixSummary.preFixBytes`) as a new
 * presentation window via `PowerPoint.createPresentation(base64)` (PowerPointApi 1.1).
 */

const CHUNK = 0x8000; // stays well under String.fromCharCode's argument limit

/** Standard base64 of `bytes` (chunked, so large decks don't overflow the call stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Pass `PowerPoint.createPresentation` (injected so tests and non-Office hosts can supply their own). */
export async function openPreFixCopy(bytes: Uint8Array, createPresentation: (base64File: string) => Promise<void>): Promise<void> {
  if (bytes.length === 0) throw new Error("No pre-fix copy is available for this fix.");
  await createPresentation(bytesToBase64(bytes));
}
