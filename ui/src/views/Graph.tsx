import { useState, useEffect, useRef } from "preact/hooks";
import cytoscape from "cytoscape";
import { api, type GraphData } from "../api";
import { ErrorBanner } from "../util";

function hashId(): string {
  const q = location.hash.split("?")[1] || "";
  return new URLSearchParams(q).get("id") || "";
}

export function Graph() {
  const [draft, setDraft] = useState(hashId());
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const cy = useRef<any>(null);

  const load = (cid: string) => {
    if (!cid) return;
    setError(null);
    api.graph(cid).then(setData).catch((e) => setError(e as Error));
  };
  // Initial load from the hash (?id=) when arriving via "View in graph".
  useEffect(() => { const h = hashId(); if (h) load(h); }, []);

  useEffect(() => {
    if (!data || !container.current) return;
    cy.current?.destroy();
    const els = [
      ...data.nodes.map((n) => ({ data: { id: n.id, label: n.content || n.id, focus: n.id === data.focus ? 1 : 0 } })),
      ...data.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.src, target: e.dst, label: e.rel } })),
    ];
    const c = cytoscape({
      container: container.current,
      elements: els,
      style: [
        { selector: "node", style: { "background-color": "#3b82f6", label: "data(label)", color: "#cbd5e1", "font-size": 9, "text-wrap": "wrap", "text-max-width": "90px", width: 16, height: 16 } },
        { selector: "node[focus = 1]", style: { "background-color": "#f59e0b", width: 30, height: 30, "font-size": 11 } },
        { selector: "edge", style: { width: 1, "line-color": "#475569", "target-arrow-color": "#475569", "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", "font-size": 7, color: "#64748b" } },
      ],
      layout: { name: "cose", animate: false, padding: 30 },
    });
    c.on("tap", "node", (evt: any) => {
      const nid = evt.target.id();
      setDraft(nid);
      location.hash = `#/graph?id=${nid}`;
      load(nid);
    });
    cy.current = c;
    return () => { c.destroy(); cy.current = null; };
  }, [data]);

  const submit = (e: Event) => {
    e.preventDefault();
    location.hash = `#/graph?id=${draft}`;
    load(draft);
  };

  return (
    <div class="graph-view">
      <h1>Graph explorer</h1>
      <form class="search" onSubmit={submit}>
        <input placeholder="concept id (from the Concepts tab)…" value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        <button type="submit">Load</button>
      </form>
      {error && <ErrorBanner error={error} />}
      {data && <div class="meta">{data.nodes.length} nodes · {data.edges.length} edges · focus <span class="mono">{data.focus}</span> · click a node to expand</div>}
      {!data && !error && <div class="muted">Enter a concept id, or open one from the Concepts tab → “View in graph”.</div>}
      <div ref={container} class="cy" />
    </div>
  );
}
