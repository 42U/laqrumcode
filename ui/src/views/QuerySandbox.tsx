import { useState } from "preact/hooks";
import { api, type SandboxHit } from "../api";
import { useAsync, ErrorBanner } from "../util";

const LIMIT = 10;

function Hits({ title, hits }: { title: string; hits: SandboxHit[] }) {
  if (hits.length === 0) return null;
  return (
    <>
      <h2>{title} ({hits.length})</h2>
      <table>
        <thead><tr><th>type</th><th>score</th><th>content</th></tr></thead>
        <tbody>
          {hits.map((h) => (
            <tr key={h.id}>
              <td class="nowrap"><span class="tag">{h.role ?? h.table}</span></td>
              <td>{typeof h.score === "number" ? h.score.toFixed(3) : "—"}</td>
              <td>{h.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Retrieval sandbox: run a query through the same vector-search + graph-expand
 *  pipeline the recall tool uses, and see the scored hits. Read-only — running a
 *  query here never bumps access counts or stages ACAN training rows. */
export function QuerySandbox() {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const { data, error, loading } = useAsync(() => api.query(q, LIMIT), [q]);

  const submit = (e: Event) => { e.preventDefault(); setQ(draft); };

  return (
    <div>
      <h1>Query sandbox</h1>
      <div class="meta">Runs the recall pipeline read-only — no access bumps, no ACAN staging.</div>
      <form class="search" onSubmit={submit}>
        <input placeholder="search the memory graph…" value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        <button type="submit" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
      </form>
      {error && <ErrorBanner error={error} />}
      {data && data.available === false && <div class="banner err">Memory system unavailable.</div>}
      {data && data.available !== false && q && (
        <>
          {data.primary.length === 0 && <p class="muted">No matches for “{q}”.</p>}
          <Hits title="Primary hits" hits={data.primary} />
          <Hits title="Graph neighbors" hits={data.neighbors} />
        </>
      )}
    </div>
  );
}
