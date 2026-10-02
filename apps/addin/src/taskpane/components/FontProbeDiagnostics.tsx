import { useMemo } from "react";
import { canvasMeasure, createFontProbe } from "../../office/fontProbe";

/**
 * Development-only experiment: shows what the font probe detects in this host's web view.
 * Rendered only while the development unlock is active (localhost dev builds).
 */
const SAMPLES: { family: string; where: string }[] = [
  { family: "Arial", where: "built into macOS" },
  { family: "Helvetica Neue", where: "built into macOS" },
  { family: "Gotham", where: "user-installed" },
  { family: "Montserrat", where: "user-installed" },
  { family: "Segoe UI", where: "macOS list" },
  { family: "Calibri", where: "macOS list + Office" },
  { family: "Aptos", where: "Office only" },
  { family: "Cambria", where: "Office only" },
  { family: "Candara", where: "Office only" },
  { family: "Zqx Not A Real Font", where: "does not exist" },
];

export function FontProbeDiagnostics() {
  const rows = useMemo(() => {
    const probe = createFontProbe(canvasMeasure());
    return SAMPLES.map((s) => ({ ...s, result: probe.probe(s.family) }));
  }, []);
  return (
    <section data-font-probe-diagnostics="" style={{ fontSize: 12, padding: "4px 8px" }}>
      <h3 style={{ margin: "4px 0", fontSize: 13 }}>Font probe (dev experiment)</h3>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {rows.map((r) => (
          <li key={r.family} data-probe-family={r.family} data-probe-result={r.result}>
            {r.family} ({r.where}): {r.result}
          </li>
        ))}
      </ul>
    </section>
  );
}
