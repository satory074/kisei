// アプリの配線: compileNetwork → 検索 → 描画、URL クエリ同期。
// エンジン（純TS）と render（DOM）をつなぐ唯一の場所。
import networkJson from "../data/network.json";
import fareCalendarJson from "../data/fareCalendar.json";
import { applyFareOverrides, baseEdgeId, compileNetwork } from "../engine/compile";
import { validateFareCalendar, type FareCalendar } from "../engine/farecal";
import { groupRoutes, type RouteGroup } from "../engine/group";
import { searchRoutes } from "../engine/search";
import { parseHM } from "../engine/time";
import type { CompiledNetwork, RouteResult } from "../engine/types";
import { compareDays, compareWindow, type DayFare } from "./daycompare";
import { buildFareByDay } from "./fares";
import { createRenderer, type FareCtx } from "./render";
import { decodeQuery, encodeQuery, type SortKey } from "./url";

const ROUTE_CMP: Record<SortKey, (a: RouteResult, b: RouteResult) => number> = {
  cheapest: (a, b) => a.fare.typical - b.fare.typical || a.arriveMin - b.arriveMin,
  fastest: (a, b) => a.arriveMin - b.arriveMin || a.fare.typical - b.fare.typical,
  departure: (a, b) => a.departMin - b.departMin || a.arriveMin - b.arriveMin,
};

/** グループ内を現行コンパレータで整列し、グループ順は「各グループのベスト行程」で比較。
    3ソート（最安/最速/出発順）の意味がそのまま戦略レベルに持ち上がる */
function sortGroups(groups: RouteGroup[], sort: SortKey): RouteGroup[] {
  const cmp = ROUTE_CMP[sort];
  return groups
    .map((g) => ({ ...g, routes: [...g.routes].sort(cmp) }))
    .sort((a, b) => cmp(a.routes[0], b.routes[0]));
}

function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function boot(root: HTMLElement): void {
  let net: CompiledNetwork;
  let calendar: FareCalendar;
  try {
    net = compileNetwork(networkJson);
    const cv = validateFareCalendar(fareCalendarJson, net);
    if (!cv.ok) throw new Error(`fareCalendar.json が不正:\n- ${cv.errors.join("\n- ")}`);
    calendar = cv.calendar;
  } catch (e) {
    const pre = document.createElement("pre");
    pre.className = "error-panel";
    pre.textContent = `データ読み込みエラー:\n${e instanceof Error ? e.message : String(e)}`;
    root.replaceChildren(pre);
    return;
  }

  let sort: SortKey = "cheapest";
  let results: RouteResult[] = [];
  let groups: RouteGroup[] = [];
  // 出発日くらべ（選択日±3の7日）。set-sort は再検索しないので state に保持して使い回す
  let dayFares: DayFare[] = [];
  let lastFareCtx: FareCtx | undefined;
  // 実価格上書き（エッジid → 円）。検索のたびに applyFareOverrides で適用し、URL の fares= に同期
  const fareOverrides = new Map<string, number>();

  const renderer = createRenderer(root, net, (cmd) => {
    switch (cmd.type) {
      case "swap": {
        const f = renderer.getForm();
        renderer.setForm({ from: f.to, to: f.from });
        break;
      }
      case "set-sort":
        sort = cmd.sort;
        if (results.length > 0)
          renderer.renderResults(sortGroups(groups, sort), sort, fareOverrides, lastFareCtx, dayFares);
        else renderer.setSort(sort);
        syncUrl();
        break;
      case "set-date":
        renderer.setForm({ date: cmd.date });
        runSearch(); // ±3日ウィンドウの再センタリングもこれだけで得られる
        break;
      case "set-fare":
        if (cmd.yen === null) fareOverrides.delete(cmd.edgeId);
        else fareOverrides.set(cmd.edgeId, cmd.yen);
        if (results.length > 0) runSearch();
        else syncUrl();
        break;
      case "clear-fares":
        fareOverrides.clear();
        if (results.length > 0) runSearch();
        else syncUrl();
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
    const activeNet = applyFareOverrides(net, fareOverrides);
    // 日別料金: 出発日から4日分（maxTotalMin 48h + 余裕）を dayOffset 配列に解決して渡す。
    // 実価格上書き済みのエッジは除外（優先順位: 実価格 ＞ 日別テーブル ＞ 幅）
    const dateISO = /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : todayISO();
    const fareByDay = buildFareByDay(calendar, dateISO, 4, new Set(fareOverrides.keys()));
    results = searchRoutes(activeNet, {
      originId: f.from,
      destId: f.to,
      departAfterMin,
      fareByDay: fareByDay.size > 0 ? fareByDay : undefined,
    });
    groups = groupRoutes(results, net);
    lastFareCtx = { dateISO, todayISO: todayISO(), calendar };
    dayFares = compareDays(
      net,
      calendar,
      { originId: f.from, destId: f.to, departAfterMin, overrides: fareOverrides },
      compareWindow(dateISO, todayISO()),
    );
    renderer.renderResults(sortGroups(groups, sort), sort, fareOverrides, lastFareCtx, dayFares);
    syncUrl();
  }

  function syncUrl(): void {
    const f = renderer.getForm();
    const qs = encodeQuery({
      from: f.from,
      to: f.to,
      date: f.date,
      time: f.time,
      sort,
      fares: Object.fromEntries(fareOverrides),
    });
    history.replaceState(null, "", `${location.pathname}${qs}`);
  }

  // URL クエリから復元（共有URL対応）。from&to が揃っていれば自動検索
  const q = decodeQuery(location.search);
  if (q.sort) sort = q.sort;
  if (q.fares) {
    const known = new Set(net.edges.map((e) => baseEdgeId(e.id)));
    for (const [id, yen] of Object.entries(q.fares)) {
      if (known.has(id)) fareOverrides.set(id, yen);
    }
  }
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
