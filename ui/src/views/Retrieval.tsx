import { useState } from "preact/hooks";
import { api } from "../api";
import { useAsync, fmtDate, ErrorBanner, Pager } from "../util";

const LIMIT = 50;

const pct = (n?: number) => (typeof n === "number" ? `${Math.round(n * 100)}%` : "—");
const fix = (n?: number) => (typeof n === "number" ? n.toFixed(2) : "—");

/** Retrieval-outcome explorer: the rows that feed ACAN training. The per-row
 *  query_embedding vector is never sent by the server. Read-only. */
export function Retrieval() {
  const [page, setPage] = useState(0);
  const { data, error, loading } = useAsync(() => api.retrievalOutcomes(LIMIT, page * LIMIT), [page]);

  return (
    <div>
      <h1>Retrieval outcomes</h1>
      {error && <ErrorBanner error={error} />}
      {data && (
        <>
          <div class="meta">{data.total.toLocaleString()} outcomes (ACAN training feed)</div>
          <table>
            <thead><tr><th>table</th><th>memory id</th><th>score</th><th>util</th><th>recency</th><th>neighbor</th><th>when</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td class="nowrap"><span class="tag">{r.memory_table ?? "?"}</span></td>
                  <td class="text mono">{r.memory_id ?? "—"}</td>
                  <td>{fix(r.retrieval_score)}</td>
                  <td>{pct(r.utilization)}</td>
                  <td>{fix(r.recency)}</td>
                  <td>{r.was_neighbor ? "yes" : ""}</td>
                  <td class="nowrap">{fmtDate(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} setPage={setPage} total={data.total} limit={LIMIT} loading={loading} />
        </>
      )}
    </div>
  );
}
