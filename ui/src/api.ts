// Typed client for the daemon's read-only /api/ui/* endpoints (src/ui-server.ts).
// Cookie auth is same-origin; a 401 means the session cookie is missing/expired.

export class UnauthorizedError extends Error {
  constructor() { super("unauthorized"); }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin" });
  if (r.status === 401) throw new UnauthorizedError();
  if (!r.ok) throw new Error(`request failed: ${r.status}`);
  return (await r.json()) as T;
}

export interface DashboardData {
  table_counts: Record<string, number>;
  embedding_coverage: Record<string, { total: number; embedded: number }>;
  daemon: { uptime_s: number; pid: number };
}
export interface Page<T> { total: number; limit: number; offset: number; rows: T[]; }
export interface MemoryRow {
  id: string; text: string; category: string; importance: number;
  status: string; access_count: number; created_at: string; source?: string;
}
export interface ConceptRow {
  id: string; content: string; stability: number; confidence: number;
  access_count: number; created_at: string; source?: string;
}
export interface GraphData {
  focus: string;
  nodes: { id: string; content: string; stability: number }[];
  edges: { rel: string; src: string; dst: string }[];
}

const qs = (o: Record<string, string | number>) =>
  Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

export const api = {
  dashboard: () => get<DashboardData>("/api/ui/dashboard"),
  memories: (q: string, limit: number, offset: number) =>
    get<Page<MemoryRow>>(`/api/ui/memories?${qs({ q, limit, offset })}`),
  concepts: (q: string, limit: number, offset: number) =>
    get<Page<ConceptRow>>(`/api/ui/concepts?${qs({ q, limit, offset })}`),
  graph: (id: string) => get<GraphData>(`/api/ui/graph?${qs({ id })}`),
  node: (table: string, id: string) =>
    get<Record<string, unknown>>(`/api/ui/node/${table}/${encodeURIComponent(id)}`),
};
