import { useState, useEffect, useCallback } from "preact/hooks";
import { api, UnauthorizedError } from "./api";

/** Tiny data-loading hook: runs fn on mount and whenever deps change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    fn().then(setData).catch((e) => setError(e as Error)).finally(() => setLoading(false));
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { data, error, loading, reload: run };
}

export function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; }
}

export function ErrorBanner({ error }: { error: Error }) {
  if (error instanceof UnauthorizedError) {
    return (
      <div class="banner err">
        Session expired or missing. Re-open with <code>node scripts/open-ui.mjs</code>.
      </div>
    );
  }
  return <div class="banner err">Error: {error.message}</div>;
}

export function Pager(props: { page: number; setPage: (p: number) => void; total: number; limit: number; loading: boolean }) {
  const pages = Math.max(1, Math.ceil(props.total / props.limit));
  return (
    <div class="pager">
      <button disabled={props.page <= 0 || props.loading} onClick={() => props.setPage(props.page - 1)}>‹ Prev</button>
      <span>{props.page + 1} / {pages}</span>
      <button disabled={props.page >= pages - 1 || props.loading} onClick={() => props.setPage(props.page + 1)}>Next ›</button>
    </div>
  );
}

/** Read-only record inspector modal. */
export function Detail({ table, id, onClose }: { table: string; id: string; onClose: () => void }) {
  const { data, error } = useAsync(() => api.node(table, id), [table, id]);
  return (
    <div class="modal-bg" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <span class="mono">{table}:{id}</span>
          <button onClick={onClose}>✕</button>
        </div>
        {error && <ErrorBanner error={error} />}
        {data && (
          <dl class="detail">
            {Object.entries(data).filter(([k]) => k !== "id").map(([k, v]) => (
              <div class="kv" key={k}>
                <dt>{k}</dt>
                <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        {table === "concept" && (
          <a class="btn" href={`#/graph?id=${id}`} onClick={onClose}>View in graph →</a>
        )}
      </div>
    </div>
  );
}
