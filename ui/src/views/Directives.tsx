import { api } from "../api";
import { useAsync, fmtDate, ErrorBanner } from "../util";

/** Read-only view of the always-loaded core directives (Tier 0) and
 *  session-pinned directives (Tier 1). Editing stays in the MCP core_memory
 *  tool — this UI has no write path by design. */
export function Directives() {
  const { data, error, loading } = useAsync(() => api.directives(), []);
  if (error) return <><h1>Directives</h1><ErrorBanner error={error} /></>;
  if (!data) return <><h1>Directives</h1><div class="muted">{loading ? "Loading…" : ""}</div></>;

  const tiers = [
    { tier: 0, label: "Tier 0 — always loaded, every turn" },
    { tier: 1, label: "Tier 1 — pinned for this session" },
  ];
  return (
    <div>
      <h1>Core directives</h1>
      <div class="meta">{data.rows.length.toLocaleString()} active · read-only (manage via the <code>core_memory</code> tool)</div>
      {tiers.map(({ tier, label }) => {
        const rows = data.rows.filter((d) => d.tier === tier);
        if (rows.length === 0) return null;
        return (
          <div key={tier}>
            <h2>{label} — {rows.length}</h2>
            <table>
              <thead><tr><th>category</th><th>prio</th><th>directive</th><th>added</th></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td class="nowrap"><span class="tag">{d.category}</span></td>
                    <td>{d.priority ?? "—"}</td>
                    <td>{d.text}</td>
                    <td class="nowrap">{fmtDate(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
