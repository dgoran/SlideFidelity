/** Fix engine (U12) and fix actions (U13): public surface for the task pane. */
import { deleteShapesKind } from "./deleteShapes";
import { editHyperlinkKind, removeHyperlinkKind } from "./hyperlinks";
import { replaceColorsKind } from "./replaceColors";
import { replaceFontsKind } from "./replaceFonts";
import type { FixKindDef, FixKindId } from "./types";

export * from "./types";
export { BATCH_SIZE, IDENTITY_UNCERTAIN, isReachable, makeBatches, previewFix, requiresReason, runFix, targetLabel, UNDO_NOTE } from "./engine";
export { replaceFontsKind, THEME_CONFLICT_REASON } from "./replaceFonts";
export { FIXED_COLOR_NOTE, normalizeHex, replaceColorsKind, TEXT_COLOR_NOTE } from "./replaceColors";
export { deleteShapesKind } from "./deleteShapes";
export { editHyperlinkKind, removeHyperlinkKind, validateHyperlinkAddress } from "./hyperlinks";
export { bytesToBase64, openPreFixCopy } from "./preFixCopy";

/** Every fix kind by id. */
export const FIX_KINDS: { [K in FixKindId]: FixKindDef<K> } = {
  "replace-font": replaceFontsKind,
  "replace-color": replaceColorsKind,
  "delete-shapes": deleteShapesKind,
  "edit-hyperlink": editHyperlinkKind,
  "remove-hyperlink": removeHyperlinkKind,
};
