// アプリの配線: compileNetwork → 検索 → 描画、URL クエリ同期。
// エンジン（純TS）と render（DOM）をつなぐ唯一の場所。
import networkJson from "../data/network.json";
import { compileNetwork } from "../engine/compile";
import { searchRoutes } from "../engine/search";
import { parseHM } from "../engine/time";
import type { CompiledNetwork, RouteResult } from "../engine/types";
import { createRenderer } from "./render";
import { decodeQuery, encodeQuery, type SortKey } from "./url";

function sortResults(results: RouteResult[], sort: SortKey): RouteResult[] {
  const cmp: Record<SortKey, (a: RouteResult, b: RouteResult) => number> = {
    cheapest: (a, b) => a.fare.typical - b.fare.typical || a.arriveMin - b.arriveMin,
    fastest: (a, b) => a.arriveMin - b.arriveMin || a.fare.typical - b.fare.typical,
    departure: (a, b) => a.departMin - b.departMin || a.arriveMin - b.arriveMin,
  };
  return [...results].sort(cmp[sort]);
}

function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function boot(root: HTMLElement): void {
  let net: CompiledNetwork;
  try {
    net = compileNetwork(networkJson);
  } catch (e) {
    const pre = document.createElement("pre");
    pre.className = "error-panel";
    pre.textContent = `データ読み込みエラー:\n${e instanceof Error ? e.message : String(e)}`;
    root.replaceChildren(pre);
    return;
  }

  let sort: SortKey = "cheapest";
  let results: RouteResult[] = [];

  const renderer = createRenderer(root, net, (cmd) => {
    switch (cmd.type) {
      case "swap": {
        const f = renderer.getForm();
        renderer.setForm({ from: f.to, to: f.from });
        break;
      }
      case "set-sort":
        sort = cmd.sort;
        if (results.length > 0) renderer.renderResults(sortResults(results, sort), sort);
        else renderer.setSort(sort);
        syncUrl();
        break;
      case "search":
        runSearch();
        break;
    }
  });

  function runSearch(): void {
    const f = renderer.getForm();
    if (!f.from || !f.to || f.from === f.to) {
      renderer.renderMessage("出発地と到着地に別の地点を選んでください。");
      return;
    }
    let departAfterMin: number;
    try {
      departAfterMin = parseHM(f.time || "09:00");
    } catch {
      departAfterMin = 9 * 60;
    }
    results = searchRoutes(net, { originId: f.from, destId: f.to, departAfterMin });
    renderer.renderResults(sortResults(results, sort), sort);
    syncUrl();
  }

  function syncUrl(): void {
    const f = renderer.getForm();
    const qs = encodeQuery({ from: f.from, to: f.to, date: f.date, time: f.time, sort });
    history.replaceState(null, "", `${location.pathname}${qs}`);
  }

  // URL クエリから復元（共有URL対応）。from&to が揃っていれば自動検索
  const q = decodeQuery(location.search);
  if (q.sort) sort = q.sort;
  const endpoints = net.endpoints.map((n) => n.id);
  renderer.setForm({
    from: q.from && endpoints.includes(q.from) ? q.from : endpoints[0],
    to: q.to && endpoints.includes(q.to) ? q.to : (endpoints.find((id) => id !== endpoints[0]) ?? endpoints[0]),
    date: q.date ?? todayISO(),
    time: q.time ?? "09:00",
  });
  renderer.setSort(sort);
  if (q.from && q.to) runSearch();
  else renderer.renderMessage("出発地・到着地・出発時刻を選んで「検索」を押してください。");
}
