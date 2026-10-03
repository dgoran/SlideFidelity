import { useMemo, useState } from "react";
import { canvasMeasure, createFontProbe } from "../../office/fontProbe";

/**
 * Development-only experiment (Windows): what can the task pane's WebView2 tell about fonts without
 * the helper? Two methods: the canvas width probe, and Chromium's Local Font Access API
 * (`queryLocalFonts()`, needs a click and the host's permission). Sources are what the helper
 * reported on the dev PC. Rendered only while the development unlock is active.
 */
const SAMPLES: { family: string; where: string }[] = [
  { family: "Arial", where: "os" },
  { family: "Segoe UI", where: "os" },
  { family: "Bahnschrift", where: "os, variable" },
  { family: "Bahnschrift SemiBold", where: "os, variable instance" },
  { family: "Segoe UI Variable Display", where: "os, STAT name" },
  { family: "Sitka Heading", where: "os, variable instance" },
  { family: "Avenir", where: "user" },
  { family: "Barlow", where: "user" },
  { family: "Nunito Sans", where: "user, variable" },
  { family: "Nunito Sans 10pt", where: "user" },
  { family: "Leelawadee", where: "office private" },
  { family: "Microsoft Uighur", where: "office private" },
  { family: "Aptos", where: "office cloud" },
  { family: "Aptos Narrow", where: "office cloud" },
  { family: "Abadi", where: "office cloud" },
  { family: "Zqx Not A Real Font", where: "nowhere" },
];

type LocalFont = { family: string; fullName: string };
type LocalFontsResult = { state: "idle" } | { state: "error"; message: string } | { state: "ok"; families: Set<string>; faces: number };

export function FontProbeDiagnostics() {
  const canvasRows = useMemo(() => {
    const probe = createFontProbe(canvasMeasure());
    return SAMPLES.map((s) => ({ ...s, result: probe.probe(s.family) }));
  }, []);
  const [local, setLocal] = useState<LocalFontsResult>({ state: "idle" });
  const hasApi = typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === "function";

  async function queryLocal() {
    try {
      const fonts = (await (window as unknown as { queryLocalFonts: () => Promise<LocalFont[]> }).queryLocalFonts()) ?? [];
      const families = new Set<string>();
      for (const f of fonts) {
        families.add(f.family.toLowerCase());
        families.add(f.fullName.toLowerCase());
      }
      setLocal({ state: "ok", families, faces: fonts.length });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      setLocal({ state: "error", message: `${err.name ?? "Error"}: ${err.message ?? String(e)}` });
    }
  }

  const localResult = (family: string) =>
    local.state === "ok" ? (local.families.has(family.toLowerCase()) ? "listed" : "not listed") : "-";

  return (
    <section data-font-probe-diagnostics="" style={{ fontSize: 12, padding: "4px 8px" }}>
      <h3 style={{ margin: "4px 0", fontSize: 13 }}>Font probe (dev experiment)</h3>
      <div>
        queryLocalFonts: {hasApi ? "present" : "absent"}
        {hasApi && (
          <button type="button" onClick={() => void queryLocal()} style={{ marginLeft: 8 }}>
            Query local fonts
          </button>
        )}
      </div>
      <div data-local-fonts-state={local.state}>
        {local.state === "ok" && `local fonts: ${local.faces} faces, ${local.families.size} names`}
        {local.state === "error" && `local fonts error: ${local.message}`}
      </div>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {canvasRows.map((r) => (
          <li key={r.family} data-probe-family={r.family} data-probe-result={r.result}>
            {r.family} ({r.where}): canvas {r.result}; local {localResult(r.family)}
          </li>
        ))}
      </ul>
    </section>
  );
}
