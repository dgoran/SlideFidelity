import { useEffect, useState } from "react";

/**
 * Development-only spike (helper plan U1/U2): can the task pane reach the SlideCheck Helper spike
 * on https://localhost:47317? Removed once the spikes are recorded.
 */
const ENDPOINTS = [
  { label: "health", url: "https://localhost:47317/v1/health" },
  { label: "fonts", url: "https://localhost:47317/v1/fonts" },
];

type Outcome = { label: string; status: string };

async function probe(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const body = (await res.json()) as { count?: number; ok?: boolean };
    return `ok ${res.status}${body.count !== undefined ? `, ${body.count} fonts` : ""}`;
  } catch (e) {
    const err = e as Error;
    return `failed: ${err.name}: ${err.message}`;
  } finally {
    clearTimeout(timer);
  }
}

export function HelperProbeDiagnostics() {
  const [rows, setRows] = useState<Outcome[]>(ENDPOINTS.map((e) => ({ label: e.label, status: "checking…" })));
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.all(ENDPOINTS.map(async (e) => ({ label: e.label, status: await probe(e.url) }))).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [run]);
  return (
    <section data-helper-probe="" style={{ fontSize: 12, padding: "4px 8px" }}>
      <h3 style={{ margin: "4px 0", fontSize: 13 }}>Helper connection (dev spike)</h3>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {rows.map((r) => (
          <li key={r.label}>
            {r.label}: {r.status}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setRun((n) => n + 1)}>
        Retry
      </button>
    </section>
  );
}
