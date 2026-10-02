/**
 * React binding for the pane store and the scan service (D10: no auto-scan).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import type { ScanService } from "../../office/scan";
import { toScanError } from "../../office/scan";
import { initialPaneState, paneReducer, type PaneAction, type PaneState, type PaneView } from "./store";

export interface PaneContextValue {
  state: PaneState;
  dispatch: Dispatch<PaneAction>;
  /** Start (or restart) a full scan. Outcomes of a superseded scan are ignored. */
  startScan: () => Promise<void>;
  cancelScan: () => void;
  selectArea: (area: PaneView) => void;
  /**
   * The scan service itself, for U12: `rescanForFix()` before every fix (D4) and `last.bytes`
   * (D16 pre-fix copy). After a fix, U12 should dispatch `scan/succeeded` with the new result
   * and its `inventory` (from `RescanForFixResult.inventory` / `scanService.last.inventory`).
   */
  scanService: ScanService;
}

const PaneContext = createContext<PaneContextValue | null>(null);

export interface PaneProviderProps {
  scanService: ScanService;
  initialState?: PaneState;
  now?: () => number;
  /**
   * Optional activity source for the non-blocking "may be out of date" hint (D4). Called once;
   * returns an unsubscribe function. index.tsx wires `DocumentSelectionChanged`.
   */
  subscribeActivity?: (onActivity: () => void) => () => void;
  children?: ReactNode;
}

export function PaneProvider({ scanService, initialState, now, subscribeActivity, children }: PaneProviderProps) {
  const [state, dispatch] = useReducer(paneReducer, initialState ?? initialPaneState());
  const generation = useRef(0);

  const startScan = useCallback(async () => {
    const gen = ++generation.current;
    const live = () => gen === generation.current;
    dispatch({ type: "scan/started" });
    try {
      const result = await scanService.scan({
        onPhase: (phase) => live() && dispatch({ type: "scan/phase", phase }),
        onProgress: (e) => live() && dispatch({ type: "scan/progress", ...e }),
      });
      if (!live()) return;
      const last = scanService.last;
      dispatch({
        type: "scan/succeeded",
        result,
        scannedAt: last?.scannedAt ?? (now ?? Date.now)(),
        ...(last?.result === result && last.inventory ? { inventory: last.inventory } : {}),
      });
    } catch (e) {
      if (!live()) return;
      const err = toScanError(e);
      if (err.kind === "cancelled") dispatch({ type: "scan/cancelled" });
      else dispatch({ type: "scan/failed", kind: err.kind, message: err.message });
    }
  }, [scanService, now]);

  const cancelScan = useCallback(() => scanService.cancel(), [scanService]);
  const selectArea = useCallback((area: PaneView) => dispatch({ type: "area/selected", area }), []);

  useEffect(() => () => scanService.cancel(), [scanService]);

  useEffect(() => {
    if (!subscribeActivity) return undefined;
    return subscribeActivity(() => dispatch({ type: "scan/possibly-outdated" }));
  }, [subscribeActivity]);

  const value = useMemo(
    () => ({ state, dispatch, startScan, cancelScan, selectArea, scanService }),
    [state, startScan, cancelScan, selectArea, scanService],
  );
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function usePane(): PaneContextValue {
  const v = useContext(PaneContext);
  if (!v) throw new Error("usePane must be used inside <PaneProvider>");
  return v;
}
