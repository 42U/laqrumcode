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
export interface DirectiveRow {
  id: string; tier: number; category: string; priority: number;
  text: string; active: boolean; created_at?: string; updated_at?: string;
}
export interface IdentityChunkRow {
  id: string; source: string; chunk_index: number; text: string;
  importance?: number; identity_version?: string; active: boolean;
}
export interface SoulData {
  chunks: IdentityChunkRow[];
  versions: { identity_version: string; chunks: number }[];
}
export interface SessionRow {
  id: string; kc_session_id?: string; agent_id?: string;
  started_at?: string; ended_at?: string; last_active?: string;
  turn_count?: number; total_input_tokens?: number; total_output_tokens?: number;
}
export interface RetrievalOutcomeRow {
  id: string; memory_table?: string; memory_id?: string; retrieval_score?: number;
  utilization?: number; recency?: number; importance?: number; access_count?: number;
  was_neighbor?: boolean; context_tokens?: number; session_id?: string; turn_id?: string; created_at?: string;
}
export interface SandboxHit {
  id: string; table: string; role?: string; score: number | null; timestamp: string | number | null; text: string;
}
export interface QueryResult {
  query: string; available: boolean; primary: SandboxHit[]; neighbors: SandboxHit[];
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
  directives: () => get<{ rows: DirectiveRow[] }>("/api/ui/directives"),
  soul: () => get<SoulData>("/api/ui/soul"),
  sessions: (limit: number, offset: number) =>
    get<Page<SessionRow>>(`/api/ui/sessions?${qs({ limit, offset })}`),
  retrievalOutcomes: (limit: number, offset: number) =>
    get<Page<RetrievalOutcomeRow>>(`/api/ui/retrieval-outcomes?${qs({ limit, offset })}`),
  query: (q: string, limit: number) =>
    get<QueryResult>(`/api/ui/query?${qs({ q, limit })}`),
};
