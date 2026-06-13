// 唯一の DOM 層。検索フォーム・ソート・戦略グループカード・フッタを描画する。
// イベントはルートの click リスナー1つで data-action 委譲（moshirasu パターン）。
// 結果は「戦略グループ（details）> 行程カード（details）」の2段。件数が高々
// maxResults(30) なので毎回作り直すが、details の開閉状態は再描画前に捕捉して復元する。
import type { CompiledNetwork, FareRange, Leg, Mode, RouteResult } from "../engine/types";
import { DAY_MIN, fmtDayOffset, fmtDuration, fmtHM } from "../engine/time";
import { MODE_META, fmtYen, fmtYenRange } from "../engine/format";
import { VOLATILE_MODES, describeBreakEven, findBaseline } from "../engine/breakeven";
import { PRIMARY_MODES, routeId, strategyLabel, viaSummary, type RouteGroup } from "../engine/group";
import type { FareCalendar } from "../engine/farecal";
import { baseEdgeId } from "../engine/compile";
import { addDaysISO, daysBetweenISO, fmtDateShort, weekdayISO } from "./fares";
import type { DayFare } from "./daycompare";
import type { SortKey } from "./url";

export type Command =
  | { type: "search" }
  | { type: "swap" }
  | { type: "set-sort"; sort: SortKey }
  | { type: "set-fare"; edgeId: string; yen: number | null }
  | { type: "clear-fares" }
  | { type: "set-date"; date: string }
  | { type: "set-day-fare"; edgeId: string; date: string; yen: number | null }
  | { type: "clear-day-fares" };
export type Dispatch = (cmd: Command) => void;

export interface FormState {
  from: string;
  to: string;
  date: string;
  time: string;
}

/** 日別料金の表示に必要な文脈（検索時の出発日・今日・カレンダー本体） */
export interface FareCtx {
  dateISO: string;
  todayISO: string;
  calendar: FareCalendar;
}

const SORT_LABELS: Record<SortKey, string> = {
  cheapest: "最安",
  fastest: "最速",
  departure: "出発順",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function createRenderer(root: HTMLElement, net: CompiledNetwork, dispatch: Dispatch) {
  const endpointOptions = net.endpoints
    .map((n) => `<option value="${esc(n.id)}">${esc(n.name)}</option>`)
    .join("");

  root.innerHTML = `
    <div class="wrap">
      <header class="site-header">
        <h1>帰省 — 経路くらべ</h1>
        <p class="site-sub">飛行機・新幹線・フェリー・車を組み合わせた経路の所要時間と料金を一覧比較</p>
      </header>

      <section class="card search-panel" aria-label="検索条件">
        <div class="search-row">
          <label class="field">
            <span class="field-label">出発地</span>
            <select id="from">${endpointOptions}</select>
          </label>
          <button type="button" class="swap-btn" data-action="swap" title="出発地と到着地を入れ替え">⇄</button>
          <label class="field">
            <span class="field-label">到着地</span>
            <select id="to">${endpointOptions}</select>
          </label>
        </div>
        <div class="search-row">
          <label class="field">
            <span class="field-label">出発日</span>
            <input type="date" id="date" />
          </label>
          <label class="field">
            <span class="field-label">出発時刻（これ以降に出発）</span>
            <input type="time" id="time" />
          </label>
          <button type="button" class="search-btn" data-action="search">検索</button>
        </div>
      </section>

      <section class="card daybar" id="daybar" hidden aria-label="出発日くらべ"></section>

      <details class="card daygrid" id="daygrid" hidden></details>

      <section class="results-head" id="results-head" hidden>
        <p class="results-count tnum" id="results-count"></p>
        <button type="button" class="clear-fares-btn" id="clear-fares" data-action="clear-fares" hidden>実価格をクリア</button>
        <div class="seg" role="group" aria-label="並び替え">
          ${(Object.keys(SORT_LABELS) as SortKey[])
            .map(
              (k) =>
                `<button type="button" class="seg-btn" data-action="set-sort" data-sort="${k}">${SORT_LABELS[k]}</button>`,
            )
            .join("")}
        </div>
      </section>

      <section id="results" aria-live="polite"></section>

      <footer class="site-footer">
        <p class="disclaimer">⚠️ ${esc(net.meta.disclaimer)}</p>
        <p class="tnum">データ最終更新: ${esc(net.meta.dataLastUpdated)}</p>
        <details class="sources">
          <summary>出典一覧</summary>
          <ul>${sourceList(net)}</ul>
        </details>
      </footer>
    </div>
  `;

  const $ = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const fromSel = $<HTMLSelectElement>("#from");
  const toSel = $<HTMLSelectElement>("#to");
  const dateInput = $<HTMLInputElement>("#date");
  const timeInput = $<HTMLInputElement>("#time");
  const resultsEl = $("#results");
  const resultsHead = $("#results-head");
  const daybarEl = $("#daybar");
  const daygridEl = $("#daygrid");
  const resultsCount = $("#results-count");
  const clearFaresBtn = $<HTMLButtonElement>("#clear-fares");

  root.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "search") dispatch({ type: "search" });
    else if (action === "swap") dispatch({ type: "swap" });
    else if (action === "set-sort") dispatch({ type: "set-sort", sort: target.dataset.sort as SortKey });
    else if (action === "clear-fares") dispatch({ type: "clear-fares" });
    else if (action === "set-date" && target.dataset.date) dispatch({ type: "set-date", date: target.dataset.date });
    else if (action === "clear-day-fares") dispatch({ type: "clear-day-fares" });
  });

  // 実価格入力は change（blur/Enter 時）で反映。input ごとだと再描画でフォーカスを失うため
  root.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const v = input.value.trim();
    const num = Number(v);
    const valid = v !== "" && Number.isFinite(num) && num >= 0 && num <= 9_999_999;
    // 料金入力グリッドのセル（日別×変動レグ）
    const gridEdge = input.dataset?.gridEdge;
    const gridDate = input.dataset?.gridDate;
    if (gridEdge && gridDate) {
      if (v === "") dispatch({ type: "set-day-fare", edgeId: gridEdge, date: gridDate, yen: null });
      else if (valid) dispatch({ type: "set-day-fare", edgeId: gridEdge, date: gridDate, yen: Math.round(num) });
      return;
    }
    // 行程カードの全日共通の実価格上書き
    const edgeId = input.dataset?.fareEdge;
    if (!edgeId) return;
    if (v === "") {
      dispatch({ type: "set-fare", edgeId, yen: null });
      return;
    }
    if (!valid) return;
    dispatch({ type: "set-fare", edgeId, yen: Math.round(num) });
  });

  function getForm(): FormState {
    return { from: fromSel.value, to: toSel.value, date: dateInput.value, time: timeInput.value };
  }

  function setForm(f: Partial<FormState>): void {
    if (f.from !== undefined) fromSel.value = f.from;
    if (f.to !== undefined) toSel.value = f.to;
    if (f.date !== undefined) dateInput.value = f.date;
    if (f.time !== undefined) timeInput.value = f.time;
  }

  function setSort(sort: SortKey): void {
    for (const btn of root.querySelectorAll<HTMLElement>('[data-action="set-sort"]')) {
      btn.classList.toggle("seg-on", btn.dataset.sort === sort);
    }
  }

  function renderMessage(msg: string): void {
    resultsHead.hidden = true;
    daybarEl.hidden = true;
    daygridEl.hidden = true;
    resultsEl.innerHTML = `<p class="empty-msg">${esc(msg)}</p>`;
  }

  function renderResults(
    groups: RouteGroup[],
    sort: SortKey,
    overrides: ReadonlyMap<string, number> = new Map(),
    fareCtx?: FareCtx,
    dayFares?: readonly DayFare[],
    dayGrid?: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ): void {
    setSort(sort);
    clearFaresBtn.hidden = overrides.size === 0;
    const all = groups.flatMap((g) => g.routes);
    if (all.length === 0) {
      renderMessage("条件に合う経路が見つかりませんでした。");
      return;
    }
    resultsHead.hidden = false;
    if (dayFares && dayFares.length > 0 && fareCtx) {
      daybarEl.innerHTML = daybarHtml(dayFares, fareCtx.dateISO);
      daybarEl.hidden = false;
      // 料金入力グリッド: 変動レグ×7日。innerHTML だけ差し替えるので details の open は保たれる
      const legs = collectVolatileLegs(groups);
      if (legs.length > 0) {
        daygridEl.innerHTML = dayGridHtml(
          legs,
          dayFares.map((d) => d.dateISO),
          net,
          dayGrid ?? new Map(),
          overrides,
          fareCtx.calendar,
        );
        daygridEl.hidden = false;
      } else {
        daygridEl.hidden = true;
      }
    } else {
      daybarEl.hidden = true;
      daygridEl.hidden = true;
    }
    const mains = groups.filter((g) => !g.isOther);
    const others = groups.filter((g) => g.isOther);
    resultsCount.textContent = `${mains.length}とおりの行き方（全${all.length}件の行程）`;

    // 再描画（実価格入力・ソート切替）で details の開閉が失われないよう捕捉して復元
    const openGroups = new Set(
      [...resultsEl.querySelectorAll<HTMLElement>(".group-card[open]")].map((el) => el.dataset.key ?? ""),
    );
    const openRoutes = new Set(
      [...resultsEl.querySelectorAll<HTMLElement>(".route-card[open]")].map((el) => el.dataset.route ?? ""),
    );
    const othersWereOpen = !!resultsEl.querySelector(".other-groups[open]");
    // 初回描画は「先頭の戦略 + その最良行程」だけ開いて比較画面を保つ
    if (!resultsEl.querySelector(".group-card") && mains.length > 0) {
      openGroups.add(mains[0].key);
      openRoutes.add(routeId(mains[0].routes[0]));
    }

    const fastestArr = Math.min(...all.map((r) => r.arriveMin));
    const cheapestFare = Math.min(...all.map((r) => r.fare.typical));
    const baseline = findBaseline(all);
    const ctx: CardCtx = {
      net,
      baseline,
      baselineLabel: baseline ? strategyLabel([baseline], net) : "",
      overrides,
      openRoutes,
      fareCtx,
    };
    const card = (g: RouteGroup): string =>
      groupCard(g, ctx, openGroups.has(g.key), g.earliestArriveMin === fastestArr, g.minFareTypical === cheapestFare);
    const othersHtml = others.length
      ? `<details class="other-groups" ${othersWereOpen ? "open" : ""}>
           <summary>遠回り・乗継の多い行き方 ${others.length}とおり</summary>
           ${others.map(card).join("")}
         </details>`
      : "";
    resultsEl.innerHTML = mains.map(card).join("") + othersHtml;
  }

  return { getForm, setForm, setSort, renderResults, renderMessage };
}

function sourceList(net: CompiledNetwork): string {
  // 出典URLごとに代表ラベル（キャリア名 or ホスト名）でまとめる
  const bySource = new Map<string, string>();
  for (const e of net.edges) {
    if (bySource.has(e.source)) continue;
    let label = e.carrier;
    if (!label) {
      try {
        label = new URL(e.source).hostname.replace(/^www\./, "");
      } catch {
        label = e.source;
      }
    }
    bySource.set(e.source, label);
  }
  return [...bySource]
    .map(
      ([url, label]) =>
        `<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a></li>`,
    )
    .join("");
}

interface CardCtx {
  net: CompiledNetwork;
  baseline: RouteResult | null;
  baselineLabel: string;
  overrides: ReadonlyMap<string, number>;
  openRoutes: ReadonlySet<string>;
  fareCtx?: FareCtx;
}

/** 戦略の絵文字列（主要レグのみ・連続同一は畳む）。視覚スキャン用の補助 */
function groupIcons(g: RouteGroup): string {
  const legs = g.routes[0].legs;
  const primary = legs.filter((l) => PRIMARY_MODES.has(l.edge.mode));
  const seq = (primary.length > 0 ? primary : legs).map((l) => MODE_META[l.edge.mode].icon);
  return seq.filter((icon, i) => icon !== seq[i - 1]).join("");
}

/** 料金の主役は typical（比較・ソートの基準）。幅は脇役に格下げして添える */
function fareHtml(f: FareRange): string {
  if (f.low === f.high) return fmtYen(f.typical);
  return `目安 ${fmtYen(f.typical)} <span class="fare-sub">(${fmtYenRange(f)})</span>`;
}

const JA_WEEKDAYS = "日月火水木金土";

/**
 * 出発日くらべバー: 各日の最安総額＋戦略を1行ずつ。クリックでその日へ移動（set-date）。
 * 最安ハイライトは全日同額なら出さない（カレンダー未カバー期間で7日とも同額になるため）。
 */
function daybarHtml(days: readonly DayFare[], selectedISO: string): string {
  const fares = days.map((d) => d.fareTypical).filter((v): v is number => v !== null);
  const min = Math.min(...fares);
  const showMin = fares.length > 0 && Math.max(...fares) > min;
  const row = (d: DayFare): string => {
    const wd = weekdayISO(d.dateISO);
    const wdCls = wd === 0 ? " wd-sun" : wd === 6 ? " wd-sat" : "";
    const isMin = showMin && d.fareTypical === min;
    const isSelected = d.dateISO === selectedISO;
    const cls = `daybar-row tnum${isSelected ? " is-selected" : ""}${isMin ? " is-min" : ""}`;
    const dateCell = `<span class="daybar-date">${fmtDateShort(d.dateISO)} <span class="daybar-wd${wdCls}">${JA_WEEKDAYS[wd]}</span></span>`;
    if (d.fareTypical === null) {
      return `<button type="button" class="${cls}" disabled>${dateCell}<span class="daybar-fare">—</span><span class="daybar-strategy">経路なし</span></button>`;
    }
    return `
      <button type="button" class="${cls}" data-action="set-date" data-date="${esc(d.dateISO)}"
        data-fare="${d.fareTypical}" ${isSelected ? 'aria-current="date"' : ""}>
        ${dateCell}
        <span class="daybar-fare">${fmtYen(d.fareTypical)}${d.isEstimate ? ` <span class="daybar-est">目安</span>` : ""}</span>
        <span class="daybar-strategy">${esc(d.strategyLabel)}</span>
        ${isMin ? `<span class="badge badge-cheap">最安</span>` : ""}
      </button>`;
  };
  return `
    <h2 class="daybar-title">出発日くらべ（${fmtDateShort(days[0].dateISO)}〜${fmtDateShort(days[days.length - 1].dateISO)}）</h2>
    <div class="daybar-rows">${days.map(row).join("")}</div>`;
}

interface VolatileLegInfo {
  edgeId: string;
  mode: Mode;
  fromId: string;
  toId: string;
}

/**
 * グリッドの行にする変動レグ（飛行機・レンタカー）を baseEdgeId で重複排除。飛行機を先頭に。
 * **主要戦略の代表（最安）ルートのレグだけ**を見る。遠回り（その他）ルートは空港ループ等の
 * 人工的なレグ（例: 行きの旅程に「新千歳→伊丹」が混じる）を含むため、入力欄に出すと混乱する。
 */
function collectVolatileLegs(groups: readonly RouteGroup[]): VolatileLegInfo[] {
  const seen = new Map<string, VolatileLegInfo>();
  for (const g of groups) {
    if (g.isOther || g.routes.length === 0) continue;
    const best = g.routes.reduce((a, b) => (b.fare.typical < a.fare.typical ? b : a));
    for (const l of best.legs) {
      if (!VOLATILE_MODES.has(l.edge.mode)) continue;
      const edgeId = baseEdgeId(l.edge.id);
      if (!seen.has(edgeId)) seen.set(edgeId, { edgeId, mode: l.edge.mode, fromId: l.edge.from, toId: l.edge.to });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.mode === b.mode ? (a.edgeId < b.edgeId ? -1 : 1) : a.mode === "flight" ? -1 : 1,
  );
}

/**
 * 料金入力グリッド: 行=変動レグ・列=出発日くらべの7日。セルに実勢価格を入力できる。
 * 空欄のプレースホルダ＝エンジンが使う既定値（全日上書き ＞ カレンダー ＞ 目安typical）。
 * details の中身だけを返す（open 状態は要素側に残す）。
 */
function dayGridHtml(
  legs: readonly VolatileLegInfo[],
  dates: readonly string[],
  net: CompiledNetwork,
  grid: ReadonlyMap<string, ReadonlyMap<string, number>>,
  overrides: ReadonlyMap<string, number>,
  calendar: FareCalendar,
): string {
  const short = (id: string): string => {
    const n = net.nodesById.get(id);
    return n?.shortName ?? n?.name ?? id;
  };
  const edgeTypical = new Map<string, number>();
  for (const e of net.edges) edgeTypical.set(baseEdgeId(e.id), e.fare.typical);
  let count = 0;
  for (const m of grid.values()) count += m.size;

  const head = dates
    .map((d) => {
      const wd = weekdayISO(d);
      const cls = wd === 0 ? " wd-sun" : wd === 6 ? " wd-sat" : "";
      return `<th class="daygrid-day${cls}" scope="col">${fmtDateShort(d)}<span class="daygrid-wd${cls}">${JA_WEEKDAYS[wd]}</span></th>`;
    })
    .join("");

  const rows = legs
    .map((leg) => {
      const userRow = grid.get(leg.edgeId);
      const label = `${MODE_META[leg.mode].icon} ${esc(short(leg.fromId))}→${esc(short(leg.toId))}`;
      const cells = dates
        .map((date) => {
          const val = userRow?.get(date);
          const fallback =
            overrides.get(leg.edgeId) ?? calendar.edges[leg.edgeId]?.byDate[date] ?? edgeTypical.get(leg.edgeId) ?? 0;
          return `<td><input type="number" min="0" step="100" inputmode="numeric"
            class="daygrid-input${val !== undefined ? " has-value" : ""}"
            data-grid-edge="${esc(leg.edgeId)}" data-grid-date="${esc(date)}"
            value="${val ?? ""}" placeholder="${fallback}"
            aria-label="${esc(short(leg.fromId))}→${esc(short(leg.toId))} ${fmtDateShort(date)}の料金"></td>`;
        })
        .join("");
      return `<tr><th class="daygrid-leg" scope="row">${label}</th>${cells}</tr>`;
    })
    .join("");

  const clearBtn =
    count > 0
      ? `<button type="button" class="daygrid-clear" data-action="clear-day-fares">入力をすべてクリア</button>`
      : "";
  return `
    <summary class="daygrid-summary">料金を表で入力（実勢価格）${
      count > 0 ? `<span class="daygrid-count">${count}件入力済み</span>` : ""
    }</summary>
    <div class="daygrid-body">
      <p class="daygrid-hint">予約サイトで見た価格を入れると、その日の最安と上の「出発日くらべ」に反映されます。空欄はカレンダー／目安で自動計算。</p>
      <div class="daygrid-scroll">
        <table class="daygrid-table tnum">
          <thead><tr><th class="daygrid-corner" scope="col">交通手段＼日</th>${head}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${clearBtn}
    </div>`;
}

/**
 * レグ運賃セルと補足ノート。優先順位は 実価格上書き ＞ 日別料金 ＞ 幅（目安）。
 * 日別料金は「8/12の料金」と日付を明示し、転記の鮮度（30日超で警告）も添える。
 */
function legFare(
  leg: Leg,
  edgeId: string,
  overrideYen: number | undefined,
  ctx: CardCtx,
): { fareCell: string; calNote: string } {
  if (overrideYen !== undefined) {
    return {
      fareCell: `<span class="leg-fare tnum is-override">実価格 ${fmtYen(overrideYen)}</span>`,
      calNote: "",
    };
  }
  if (leg.calendarFare !== undefined && ctx.fareCtx) {
    const legDate = addDaysISO(ctx.fareCtx.dateISO, Math.floor(leg.depMin / DAY_MIN));
    const entry = ctx.fareCtx.calendar.edges[edgeId];
    const stale = entry && daysBetweenISO(entry.fetchedAt, ctx.fareCtx.todayISO) > 30;
    return {
      fareCell: `<span class="leg-fare tnum is-calendar">${fmtDateShort(legDate)}の料金 ${fmtYen(leg.calendarFare)}</span>`,
      calNote: entry
        ? `<div class="leg-cal-note">${fmtDateShort(legDate)}の料金データ（${esc(entry.fetchedAt)}取得）${
            stale ? " ⚠ 取得から30日以上経過" : ""
          }</div>`
        : "",
    };
  }
  // 変動レグなのにこの日のデータが無い場合は「目安で計算」を明示
  const noData =
    VOLATILE_MODES.has(leg.edge.mode) && ctx.fareCtx?.calendar.edges[edgeId]
      ? `<div class="leg-cal-note">この日の料金データなし（目安の幅で計算）</div>`
      : "";
  return {
    fareCell: `<span class="leg-fare tnum">${fmtYenRange(leg.edge.fare)}</span>`,
    calNote: noData,
  };
}

function groupCard(
  g: RouteGroup,
  ctx: CardCtx,
  open: boolean,
  isFastest: boolean,
  isCheapest: boolean,
): string {
  const badges = [
    isFastest ? `<span class="badge badge-fast">最速</span>` : "",
    isCheapest ? `<span class="badge badge-cheap">最安</span>` : "",
  ].join("");
  return `
    <details class="group-card" ${open ? "open" : ""} data-key="${esc(g.key)}"
      data-typical="${g.minFareTypical}" data-arrive="${g.earliestArriveMin}" data-depart="${g.earliestDepartMin}">
      <summary class="group-summary">
        <div class="group-summary-top">
          <span class="group-icons">${groupIcons(g)}</span>
          <span class="group-label">${esc(g.label)}</span>
          ${badges}
        </div>
        <div class="group-stats tnum">
          <span class="group-duration">最短 <b>${fmtDuration(g.minDurationMin)}</b></span>
          <span class="group-fare">目安 <b>${fmtYen(g.minFareTypical)}</b>${g.routes.length > 1 ? "〜" : ""}</span>
          <span class="group-count">${g.routes.length}件の行程</span>
        </div>
      </summary>
      <div class="group-routes">${g.routes.map((r) => routeCard(r, ctx)).join("")}</div>
    </details>
  `;
}

function routeCard(r: RouteResult, ctx: CardCtx): string {
  const nodeName = (id: string): string => ctx.net.nodesById.get(id)?.name ?? id;
  const rows: string[] = [];
  r.legs.forEach((leg, i) => {
    if (i > 0) {
      rows.push(
        `<div class="leg-wait tnum">乗換・待ち ${fmtDuration(leg.waitMin)}（${esc(nodeName(leg.edge.from))}）</div>`,
      );
    }
    const meta = MODE_META[leg.edge.mode];
    const name = [leg.edge.carrier, leg.tripName].filter(Boolean).join(" ");
    const edgeId = baseEdgeId(leg.edge.id);
    const overrideYen = ctx.overrides.get(edgeId);
    const fareInput = VOLATILE_MODES.has(leg.edge.mode)
      ? `<label class="fare-override tnum">実価格¥
           <input type="number" min="0" step="100" inputmode="numeric"
             placeholder="${leg.calendarFare ?? leg.edge.fare.typical}" value="${overrideYen ?? ""}"
             data-fare-edge="${esc(edgeId)}" title="予約サイトで見た実際の価格を入れると総額と順位に反映されます">
         </label>`
      : "";
    const { fareCell, calNote } = legFare(leg, edgeId, overrideYen, ctx);
    rows.push(`
      <div class="leg-row">
        <span class="mode-chip mode-${leg.edge.mode}">${meta.icon} ${meta.label}</span>
        <div class="leg-main">
          ${name ? `<div class="leg-carrier">${esc(name)}</div>` : ""}
          <div class="leg-times tnum">
            ${esc(nodeName(leg.edge.from))} ${fmtHM(leg.depMin)}${fmtDayOffset(leg.depMin)}
            → ${esc(nodeName(leg.edge.to))} ${fmtHM(leg.arrMin)}${fmtDayOffset(leg.arrMin)}
          </div>
          ${leg.edge.notes ? `<div class="leg-notes">${esc(leg.edge.notes)}</div>` : ""}
          ${calNote}
          ${fareInput}
        </div>
        ${fareCell}
      </div>
    `);
  });

  const breakEven = ctx.baseline ? describeBreakEven(r, ctx.baseline, ctx.baselineLabel) : null;
  const via = viaSummary(r, ctx.net);
  const id = routeId(r);
  return `
    <details class="route-card${r.isPareto ? " is-pareto" : ""}" ${ctx.openRoutes.has(id) ? "open" : ""}
      data-route="${esc(id)}" data-typical="${r.fare.typical}" data-arrive="${r.arriveMin}" data-depart="${r.departMin}">
      <summary class="route-summary">
        <div class="route-summary-top tnum">
          <span class="route-times">${fmtHM(r.departMin)} → ${fmtHM(r.arriveMin)}<span class="day-offset">${fmtDayOffset(r.arriveMin)}</span></span>
          <span class="route-duration">${fmtDuration(r.durationMin)}</span>
          <span class="route-fare">${fareHtml(r.fare)}</span>
          <span class="route-transfers">乗換${r.transfers}回</span>
        </div>
        ${via ? `<div class="route-via">経由: ${esc(via)}</div>` : ""}
      </summary>
      <div class="route-legs">
        ${rows.join("")}
        ${breakEven ? `<p class="breakeven-note">${esc(breakEven)}</p>` : ""}
      </div>
    </details>
  `;
}
