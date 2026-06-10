// 唯一の DOM 層。検索フォーム・ソート・ルートカード・フッタを描画する。
// イベントはルートの click リスナー1つで data-action 委譲（moshirasu パターン）。
// 結果リストは件数が高々 maxResults(30) なので毎回作り直す（keyed 更新は不要規模）。
import type { CompiledNetwork, RouteResult } from "../engine/types";
import { fmtDayOffset, fmtDuration, fmtHM } from "../engine/time";
import { MODE_META, fmtYenRange } from "../engine/format";
import type { SortKey } from "./url";

export type Command = { type: "search" } | { type: "swap" } | { type: "set-sort"; sort: SortKey };
export type Dispatch = (cmd: Command) => void;

export interface FormState {
  from: string;
  to: string;
  date: string;
  time: string;
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

      <section class="results-head" id="results-head" hidden>
        <p class="results-count tnum" id="results-count"></p>
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
  const resultsCount = $("#results-count");

  root.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "search") dispatch({ type: "search" });
    else if (action === "swap") dispatch({ type: "swap" });
    else if (action === "set-sort") dispatch({ type: "set-sort", sort: target.dataset.sort as SortKey });
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
    resultsEl.innerHTML = `<p class="empty-msg">${esc(msg)}</p>`;
  }

  function renderResults(results: RouteResult[], sort: SortKey): void {
    setSort(sort);
    if (results.length === 0) {
      renderMessage("条件に合う経路が見つかりませんでした。");
      return;
    }
    resultsHead.hidden = false;
    resultsCount.textContent = `${results.length}件のルート`;
    const fastestArr = Math.min(...results.map((r) => r.arriveMin));
    const cheapestFare = Math.min(...results.map((r) => r.fare.typical));
    resultsEl.innerHTML = results
      .map((r, i) => routeCard(net, r, i < 3, r.arriveMin === fastestArr, r.fare.typical === cheapestFare))
      .join("");
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

function routeCard(
  net: CompiledNetwork,
  r: RouteResult,
  open: boolean,
  isFastest: boolean,
  isCheapest: boolean,
): string {
  const nodeName = (id: string): string => net.nodesById.get(id)?.name ?? id;
  const badges = [
    isFastest ? `<span class="badge badge-fast">最速</span>` : "",
    isCheapest ? `<span class="badge badge-cheap">最安</span>` : "",
  ].join("");

  const rows: string[] = [];
  r.legs.forEach((leg, i) => {
    if (i > 0) {
      rows.push(
        `<div class="leg-wait tnum">乗換・待ち ${fmtDuration(leg.waitMin)}（${esc(nodeName(leg.edge.from))}）</div>`,
      );
    }
    const meta = MODE_META[leg.edge.mode];
    const name = [leg.edge.carrier, leg.tripName].filter(Boolean).join(" ");
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
        </div>
        <span class="leg-fare tnum">${fmtYenRange(leg.edge.fare)}</span>
      </div>
    `);
  });

  return `
    <details class="route-card${r.isPareto ? " is-pareto" : ""}" ${open ? "open" : ""}
      data-typical="${r.fare.typical}" data-arrive="${r.arriveMin}" data-depart="${r.departMin}">
      <summary class="route-summary">
        <div class="route-summary-top">
          ${badges}
          <span class="route-times tnum">${fmtHM(r.departMin)} → ${fmtHM(r.arriveMin)}<span class="day-offset">${fmtDayOffset(r.arriveMin)}</span></span>
        </div>
        <div class="route-summary-stats tnum">
          <span class="route-duration">${fmtDuration(r.durationMin)}</span>
          <span class="route-fare">${fmtYenRange(r.fare)}</span>
          <span class="route-transfers">乗換${r.transfers}回</span>
        </div>
        <div class="route-modes">${r.legs.map((l) => MODE_META[l.edge.mode].icon).join(" → ")}</div>
      </summary>
      <div class="route-legs">${rows.join("")}</div>
    </details>
  `;
}
