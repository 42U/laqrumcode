import { api } from "../api";
import { useAsync, ErrorBanner } from "../util";

const ORDER = ["concept", "memory", "skill", "core_memory", "turn", "artifact", "retrieval_outcome", "pending_work", "session"];

export function Dashboard() {
  const { data, error, loading } = useAsync(() => api.dashboard(), []);
  if (error) return <><h1>Dashboard</h1><ErrorBanner error={error} /></>;
  if (!data) return <><h1>Dashboard</h1><div class="muted">{loading ? "Loading…" : ""}</div></>;
  const uptime = data.daemon.uptime_s;
  return (
    <div>
      <h1>Dashboard</h1>
      <div class="cards">
        {ORDER.filter((t) => t in data.table_counts).map((t) => (
          <div class="card" key={t}>
            <div class="num">{data.table_counts[t].toLocaleString()}</div>
            <div class="lbl">{t}</div>
          </div>
        ))}
      </div>
      <h2>Embedding coverage</h2>
      <div class="coverage">
        {Object.entries(data.embedding_coverage).map(([t, c]) => {
          const pct = c.total ? Math.round((c.embedded / c.total) * 100) : 100;
          return (
            <div class="cov-row" key={t}>
              <span class="cov-lbl">{t}</span>
              <span class="bar"><span class="fill" style={{ width: pct + "%" }} /></span>
              <span class="cov-pct">{pct}% <span class="muted">({c.embedded.toLocaleString()}/{c.total.toLocaleString()})</span></span>
            </div>
          );
        })}
      </div>
      <p class="muted">daemon pid {data.daemon.pid} · up {Math.floor(uptime / 3600)}h {Math.floor((uptime % 3600) / 60)}m</p>
    </div>
  );
}
