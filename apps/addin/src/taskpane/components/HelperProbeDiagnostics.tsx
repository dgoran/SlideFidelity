import { useEffect, useState } from "react";

/**
 * Development-only spike: can the task pane reach a local "SlideCheck Helper"?
 * Tries plain HTTP on 127.0.0.1 and HTTPS on localhost and shows what happens.
 */
const ENDPOINTS = [
  { label: "HTTP 127.0.0.1:7317", url: "http://127.0.0.1:7317/fonts" },
  { label: "HTTPS localhost:7318", url: "https://localhost:7318/fonts" },
];

type Outcome = { label: string; status: string };

async function probe(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const body = (await res.json()) as { count?: number };
    return `ok ${res.status}, ${body.count ?? "?"} fonts`;
  } catch (e) {
    const err = e as Error;
    return `failed: ${err.name}: ${err.message}`;
  } finally {
    clearTimeout(timer);
  }
}

export function HelperProbeDiagnostics() {
  const [rows, setRows] = useState<Outcome[]>(ENDPOINTS.map((e) => ({ label: e.label, status: "checking…" })));
  useEffect(() => {
    let live = true;
    void Promise.all(ENDPOINTS.map(async (e) => ({ label: e.label, status: await probe(e.url) }))).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, []);
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
    </section>
  );
}
