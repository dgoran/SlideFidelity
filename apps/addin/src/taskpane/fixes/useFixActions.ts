/**
 * The fix flow (U12): preview → run (D4 rescan-before-fix, batched apply, cancel) → summary →
 * post-fix rescan → "Open pre-fix copy" (D16). All results go into the session store, so the flow
 * keeps going if the panel re-mounts.
 */
import { useCallback, useMemo } from "react";
import {
  FIX_KINDS,
  openPreFixCopy,
  previewFix,
  runFix,
  type FixKindDef,
  type FixKindId,
  type FixParamsMap,
  type IsSetSupported,
  type PowerPointRun,
  type PreviewResult,
  type RunFixDeps,
  type RunFixResult,
} from "../../office/fixes";
import type { RescanForFixResult } from "../../office/scan";
import { currentResult } from "../brand/themeBrand";
import { usePaneServices } from "../context";
import { usePane } from "../state/PaneContext";
import type { FixController, FixSession } from "./controller";
import { draftRequest, type FixRequest } from "./model";

/** Injected host APIs (index.tsx passes the real ones; tests pass fakes). */
export interface FixDeps {
  /** `PowerPoint.run`. */
  run: PowerPointRun;
  /** `PowerPoint.createPresentation` (D16). */
  createPresentation: (base64File: string) => Promise<void>;
  /** Defaults to the probed host capabilities. */
  isSetSupported?: IsSetSupported;
  /** Targets per batch (default: the engine's `BATCH_SIZE`). */
  batchSize?: number;
}

function kindDef(kind: FixKindId): FixKindDef<FixKindId> {
  return FIX_KINDS[kind] as FixKindDef<FixKindId>;
}

function doPreview(req: FixRequest, findings: Parameters<typeof previewFix>[1], isSetSupported: IsSetSupported): PreviewResult {
  return previewFix(kindDef(req.kind), findings, req.params as FixParamsMap[FixKindId], { isSetSupported }) as PreviewResult;
}

function doRun(req: FixRequest, deps: RunFixDeps): Promise<RunFixResult> {
  return runFix(kindDef(req.kind), req.params as FixParamsMap[FixKindId], deps) as Promise<RunFixResult>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface FixActions {
  isSetSupported: IsSetSupported;
  preview(session: FixSession): void;
  apply(session: FixSession): Promise<void>;
  cancel(session: FixSession): void;
  openCopy(session: FixSession): Promise<void>;
}

export function useFixActions(controller: FixController, deps: FixDeps): FixActions {
  const { state, dispatch, scanService } = usePane();
  const { capabilities } = usePaneServices();
  const result = currentResult(state.scan);

  const isSetSupported = useMemo<IsSetSupported>(
    () => deps.isSetSupported ?? ((v) => (capabilities.versions as Readonly<Record<string, boolean>>)[v] ?? false),
    [deps.isSetSupported, capabilities],
  );

  const preview = useCallback(
    (s: FixSession) => {
      const req = draftRequest(s.draft);
      if (!req) return;
      const p = doPreview(req, result?.findings ?? [], isSetSupported);
      controller.update(s.id, { stage: "preview", preview: p, replanned: false, confirmed: false, error: undefined, focus: "preview", focusSeq: s.focusSeq + 1 });
    },
    [controller, result, isSetSupported],
  );

  /** Post-fix rescan through the scan service; the pane stays on its results meanwhile. */
  const rescanAfterFix = useCallback(
    (id: number) => {
      controller.update(id, { rescan: "running" });
      scanService.scan().then(
        (next) => {
          const last = scanService.last;
          dispatch({
            type: "scan/succeeded",
            result: next,
            scannedAt: last?.scannedAt ?? Date.now(),
            ...(last?.result === next && last.inventory ? { inventory: last.inventory } : {}),
          });
          controller.update(id, { rescan: "done" });
        },
        () => {
          dispatch({ type: "scan/possibly-outdated" });
          controller.update(id, { rescan: "failed" });
        },
      );
    },
    [controller, scanService, dispatch],
  );

  const apply = useCallback(
    async (s: FixSession) => {
      const req = draftRequest(s.draft);
      if (!req || s.stage === "running") return;
      const id = s.id;
      const abort = new AbortController();
      controller.update(id, { stage: "running", abort, progress: undefined, cancelling: false, error: undefined, rescan: undefined });
      let rescanned: RescanForFixResult | undefined;
      const runDeps: RunFixDeps = {
        rescanForFix: async () => {
          rescanned = await scanService.rescanForFix();
          return rescanned;
        },
        run: deps.run,
        isSetSupported,
        signal: abort.signal,
        onProgress: (progress) => controller.update(id, { progress }),
        onApplied: () => rescanAfterFix(id),
        ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
      };
      try {
        const r = await doRun(req, runDeps);
        switch (r.status) {
          case "blocked":
          case "invalid":
            controller.update(id, (cur) => ({
              stage: "preview",
              preview: r.status === "blocked" ? r : { status: "invalid", reason: r.reason },
              abort: undefined,
              focus: "preview",
              focusSeq: cur.focusSeq + 1,
            }));
            break;
          case "replanned": {
            // D4: the file changed. Show the new results in the tree and the new plan; ask again.
            const fresh = rescanned;
            if (fresh) {
              dispatch({
                type: "scan/succeeded",
                result: fresh.result,
                scannedAt: scanService.last?.scannedAt ?? Date.now(),
                ...(fresh.inventory ? { inventory: fresh.inventory } : {}),
              });
            }
            controller.update(id, (cur) => ({
              stage: "preview",
              preview: { status: "ready", plan: r.plan },
              replanned: true,
              confirmed: false,
              abort: undefined,
              focus: "preview",
              focusSeq: cur.focusSeq + 1,
            }));
            break;
          }
          default:
            controller.update(id, (cur) => ({
              stage: "done",
              outcome: { status: r.status, summary: r.summary },
              abort: undefined,
              cancelling: false,
              focus: "summary",
              focusSeq: cur.focusSeq + 1,
            }));
        }
      } catch (e) {
        controller.update(id, (cur) => ({
          stage: "preview",
          abort: undefined,
          cancelling: false,
          error: `Couldn't check the presentation before fixing, so nothing was changed. ${message(e)}`,
          focus: "preview",
          focusSeq: cur.focusSeq + 1,
        }));
      }
    },
    [controller, deps.run, deps.batchSize, isSetSupported, scanService, dispatch, rescanAfterFix],
  );

  const cancel = useCallback(
    (s: FixSession) => {
      s.abort?.abort();
      controller.update(s.id, { cancelling: true });
    },
    [controller],
  );

  const openCopy = useCallback(
    async (s: FixSession) => {
      const summary = s.outcome?.summary;
      if (!summary) return;
      try {
        await openPreFixCopy(summary.preFixBytes, deps.createPresentation);
        controller.update(s.id, { copyStatus: { ok: true, message: "The pre-fix copy opened as a new, unsaved presentation." } });
      } catch (e) {
        controller.update(s.id, { copyStatus: { ok: false, message: `Couldn't open the pre-fix copy. ${message(e)}` } });
      }
    },
    [controller, deps.createPresentation],
  );

  return { isSetSupported, preview, apply, cancel, openCopy };
}

