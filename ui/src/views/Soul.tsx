import { api } from "../api";
import { useAsync, ErrorBanner } from "../util";

/** Self-authored identity: the active identity_chunk rows that make up the
 *  soul/self-knowledge, grouped by source, plus the version history (each
 *  soul-evolution writes a new identity_version; older chunks are kept,
 *  soft-deactivated, per the append-only rule). */
export function Soul() {
  const { data, error, loading } = useAsync(() => api.soul(), []);
  if (error) return <><h1>Soul &amp; identity</h1><ErrorBanner error={error} /></>;
  if (!data) return <><h1>Soul &amp; identity</h1><div class="muted">{loading ? "Loading…" : ""}</div></>;

  const sources = [...new Set(data.chunks.map((c) => c.source))];
  return (
    <div>
      <h1>Soul &amp; identity</h1>
      <div class="meta">{data.chunks.length.toLocaleString()} active identity chunks across {sources.length} source{sources.length === 1 ? "" : "s"}</div>
      {data.versions.length > 0 && (
        <>
          <h2>Version history</h2>
          <div class="cards">
            {data.versions.map((v) => (
              <div class="card" key={v.identity_version}>
                <div class="num">{v.chunks}</div>
                <div class="lbl">{v.identity_version}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {sources.map((src) => (
        <div key={src}>
          <h2>{src}</h2>
          {data.chunks.filter((c) => c.source === src).map((c) => (
            <p class="soul-chunk" key={c.id}>{c.text}</p>
          ))}
        </div>
      ))}
      {data.chunks.length === 0 && <p class="muted">No identity chunks yet — the soul is authored at graduation.</p>}
    </div>
  );
}
