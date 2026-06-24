import { useState, useEffect } from "preact/hooks";
import { Dashboard } from "./views/Dashboard";
import { Memories } from "./views/Memories";
import { Concepts } from "./views/Concepts";
import { Graph } from "./views/Graph";
import { Directives } from "./views/Directives";
import { Soul } from "./views/Soul";
import { Sessions } from "./views/Sessions";
import { Retrieval } from "./views/Retrieval";
import { QuerySandbox } from "./views/QuerySandbox";

const ROUTES: [string, string][] = [
  ["#/dashboard", "Dashboard"],
  ["#/memories", "Memories"],
  ["#/concepts", "Concepts"],
  ["#/graph", "Graph"],
  ["#/query", "Query sandbox"],
  ["#/directives", "Directives"],
  ["#/soul", "Soul"],
  ["#/sessions", "Sessions"],
  ["#/retrieval", "Retrieval"],
];

/** Minimal dependency-free hash router. The daemon SPA-falls-back unknown /ui/
 *  routes to index.html, so client-side hash routing is all we need. */
function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/dashboard");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/dashboard");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.split("?")[0];
}

export function App() {
  const route = useHashRoute();
  return (
    <div class="app">
      <nav class="sidebar">
        <div class="brand">laqrum<span>code</span></div>
        {ROUTES.map(([h, label]) => (
          <a class={route === h ? "nav active" : "nav"} href={h}>{label}</a>
        ))}
        <div class="badge">read-only</div>
      </nav>
      <main class="content">
        {route === "#/dashboard" && <Dashboard />}
        {route === "#/memories" && <Memories />}
        {route === "#/concepts" && <Concepts />}
        {route === "#/graph" && <Graph />}
        {route === "#/query" && <QuerySandbox />}
        {route === "#/directives" && <Directives />}
        {route === "#/soul" && <Soul />}
        {route === "#/sessions" && <Sessions />}
        {route === "#/retrieval" && <Retrieval />}
      </main>
    </div>
  );
}
