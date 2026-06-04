import { useState } from "preact/hooks";
import { api } from "../api";
import { useAsync, fmtDate, ErrorBanner, Pager, Detail } from "../util";

const LIMIT = 50;

export function Concepts() {
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const { data, error, loading } = useAsync(() => api.concepts(q, LIMIT, page * LIMIT), [q, page]);

  const submit = (e: Event) => { e.preventDefault(); setPage(0); setQ(draft); };

  return (
    <div>
      <h1>Concepts</h1>
      <form class="search" onSubmit={submit}>
        <input placeholder="search content…" value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        <button type="submit">Search</button>
        {q && <button type="button" class="ghost" onClick={() => { setDraft(""); setQ(""); setPage(0); }}>Clear</button>}
      </form>
      {error && <ErrorBanner error={error} />}
      {data && (
        <>
          <div class="meta">{data.total.toLocaleString()} concepts{q && <> matching “{q}”</>}</div>
          <table>
            <thead><tr><th>content</th><th>stability</th><th>conf</th><th>access</th><th>created</th></tr></thead>
            <tbody>
              {data.rows.map((c) => (
                <tr class="clickable" key={c.id} onClick={() => setSel(c.id)}>
                  <td class="text">{c.content}</td>
                  <td>{typeof c.stability === "number" ? c.stability.toFixed(2) : "—"}</td>
                  <td>{typeof c.confidence === "number" ? c.confidence.toFixed(2) : "—"}</td>
                  <td>{c.access_count ?? 0}</td>
                  <td class="nowrap">{fmtDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} setPage={setPage} total={data.total} limit={LIMIT} loading={loading} />
        </>
      )}
      {sel && <Detail table="concept" id={sel} onClose={() => setSel(null)} />}
    </div>
  );
}
