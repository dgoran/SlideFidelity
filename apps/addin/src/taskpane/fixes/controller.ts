/**
 * The fix session store shared by the area fix panel (`fixPanelSlot`) and the tree's row actions
 * (`renderRowActions`). A tiny external store (useSyncExternalStore) rather than component state:
 * the session (and a running fix, and its summary) must survive the panel re-mounting when the
 * tree or area re-renders after the post-fix rescan.
 */
import { useSyncExternalStore } from "react";
import type { FixProgress, FixSummary, PreviewResult } from "../../office/fixes";
import type { Draft, FixArea } from "./model";

export type FixStage = "picking" | "preview" | "running" | "done";
export type RescanStatus = "running" | "done" | "failed";

export interface FixSession {
  id: number;
  area: FixArea;
  draft: Draft;
  stage: FixStage;
  preview?: PreviewResult;
  /** D4: the file changed since the preview; this is the re-planned preview. */
  replanned?: boolean;
  /** Destructive kinds: the explicit confirmation checkbox. */
  confirmed: boolean;
  progress?: FixProgress;
  cancelling?: boolean;
  abort?: AbortController;
  outcome?: { status: "completed" | "cancelled"; summary: FixSummary };
  rescan?: RescanStatus;
  /** Plain-language error (the pre-fix rescan failed, ...). */
  error?: string;
  /** Result line of "Open pre-fix copy". */
  copyStatus?: { ok: boolean; message: string };
  /** Focus request: the view focuses this element once per `focusSeq`. */
  focus: "picker" | "preview" | "summary";
  focusSeq: number;
}

export type SessionPatch = Partial<Omit<FixSession, "id" | "area">>;

export interface FixController {
  get(): FixSession | null;
  subscribe(listener: () => void): () => void;
  open(area: FixArea, draft: Draft): FixSession;
  /** Patch the session `id`; ignored when that session is no longer current. */
  update(id: number, patch: SessionPatch | ((s: FixSession) => SessionPatch)): void;
  close(): void;
}

export function createFixController(): FixController {
  let session: FixSession | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    get: () => session,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(area, draft) {
      session?.abort?.abort();
      seq += 1;
      session = { id: seq, area, draft, stage: "picking", confirmed: false, focus: "picker", focusSeq: 1 };
      emit();
      return session;
    },
    update(id, patch) {
      if (!session || session.id !== id) return;
      const p = typeof patch === "function" ? patch(session) : patch;
      session = { ...session, ...p };
      emit();
    },
    close() {
      if (!session) return;
      session = null;
      emit();
    },
  };
}

export function useFixSession(controller: FixController): FixSession | null {
  return useSyncExternalStore(controller.subscribe, controller.get, controller.get);
}

/** A session is busy while a fix runs (other fix actions are disabled meanwhile). */
export function isBusy(s: FixSession | null): boolean {
  return s?.stage === "running";
}
