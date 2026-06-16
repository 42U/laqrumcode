import { useState } from "preact/hooks";
import { api } from "../api";
import { useAsync, fmtDate, ErrorBanner, Pager } from "../util";

const LIMIT = 50;

/** Session history timeline: most recent first, with turn counts and token
 *  totals. Read-only. */
export function Sessions() {
  const [page, setPage] = useState(0);
  const { data, error, loading } = useAsync(() => api.sessions(LIMIT, page * LIMIT), [page]);

  return (
    <div>
      <h1>Sessions</h1>
      {error && <ErrorBanner error={error} />}
      {data && (
        <>
          <div class="meta">{data.total.toLocaleString()} sessions</div>
          <table>
            <thead><tr><th>started</th><th>agent</th><th>turns</th><th>in tok</th><th>out tok</th><th>ended</th></tr></thead>
            <tbody>
              {data.rows.map((s) => (
                <tr key={s.id}>
                  <td class="nowrap">{fmtDate(s.started_at)}</td>
                  <td class="nowrap">{s.agent_id ?? "—"}</td>
                  <td>{(s.turn_count ?? 0).toLocaleString()}</td>
                  <td>{(s.total_input_tokens ?? 0).toLocaleString()}</td>
                  <td>{(s.total_output_tokens ?? 0).toLocaleString()}</td>
                  <td class="nowrap">{s.ended_at ? fmtDate(s.ended_at) : <span class="tag">open</span>}</td>
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
