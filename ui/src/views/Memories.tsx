import { useState } from "preact/hooks";
import { api } from "../api";
import { useAsync, fmtDate, ErrorBanner, Pager, Detail } from "../util";

const LIMIT = 50;

export function Memories() {
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const { data, error, loading } = useAsync(() => api.memories(q, LIMIT, page * LIMIT), [q, page]);

  const submit = (e: Event) => { e.preventDefault(); setPage(0); setQ(draft); };

  return (
    <div>
      <h1>Memories</h1>
      <form class="search" onSubmit={submit}>
        <input placeholder="search text…" value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        <button type="submit">Search</button>
        {q && <button type="button" class="ghost" onClick={() => { setDraft(""); setQ(""); setPage(0); }}>Clear</button>}
      </form>
      {error && <ErrorBanner error={error} />}
      {data && (
        <>
          <div class="meta">{data.total.toLocaleString()} memories{q && <> matching “{q}”</>}</div>
          <table>
            <thead><tr><th>category</th><th>imp</th><th>status</th><th>text</th><th>created</th></tr></thead>
            <tbody>
              {data.rows.map((m) => (
                <tr class="clickable" key={m.id} onClick={() => setSel(m.id)}>
                  <td><span class="tag">{m.category}</span></td>
                  <td>{typeof m.importance === "number" ? m.importance.toFixed(1) : "—"}</td>
                  <td>{m.status}</td>
                  <td class="text">{m.text}</td>
                  <td class="nowrap">{fmtDate(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} setPage={setPage} total={data.total} limit={LIMIT} loading={loading} />
        </>
      )}
      {sel && <Detail table="memory" id={sel} onClose={() => setSel(null)} />}
    </div>
  );
}
