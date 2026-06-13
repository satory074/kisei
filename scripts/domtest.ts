// DOM レベルのスモークテスト: boot → 検索 → 戦略グループ描画 → ソート切替 → URL復元 を jsdom で検証。
// 実行: npx tsx scripts/domtest.ts
import { JSDOM } from "jsdom";
import networkJson from "../src/data/network.json";
import fareCalendarJson from "../src/data/fareCalendar.json";
import { compileNetwork } from "../src/engine/compile";
import { validateFareCalendar } from "../src/engine/farecal";
import { parseHM } from "../src/engine/time";
import { compareDays, compareWindow, type DayFare } from "../src/app/daycompare";
import { addDaysISO } from "../src/app/fares";

const FARE_CAL = fareCalendarJson as { edges: Record<string, { byDate: Record<string, number> }> };

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}

// 出発日くらべの期待値計算用（main.ts と同じ入力で compareDays を直接呼ぶ）
const NET = compileNetwork(networkJson);
const CALV = validateFareCalendar(fareCalendarJson, NET);
if (!CALV.ok) {
  console.error(`❌ FAILED: fareCalendar.json が不正: ${CALV.errors.join(", ")}`);
  process.exit(1);
}
const CAL = CALV.calendar;

/** main.ts の todayISO と同じローカル時刻基準 */
function localTodayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** バーの描画がエンジン計算（compareDays）と一致するか丸ごと検証 */
function assertDaybarMatches(root: Element, expected: readonly DayFare[], label: string): void {
  const rows = [...root.querySelectorAll<HTMLElement>("#daybar .daybar-row")];
  assert(rows.length === expected.length, `${label}: ${expected.length}日ぶんの行（実際: ${rows.length}）`);
  expected.forEach((d, i) => {
    assert(rows[i].dataset.date === d.dateISO, `${label}: ${i}行目の日付が ${d.dateISO}`);
    assert(Number(rows[i].dataset.fare) === d.fareTypical, `${label}: ${i}行目の運賃が ${d.fareTypical}`);
    assert(!!rows[i].querySelector(".daybar-est") === d.isEstimate, `${label}: ${i}行目の目安マーカー`);
  });
  const fares = expected.map((d) => d.fareTypical).filter((v): v is number => v !== null);
  const min = Math.min(...fares);
  const minRows = rows.filter((r) => r.classList.contains("is-min"));
  if (Math.max(...fares) > min) {
    assert(
      minRows.length >= 1 && minRows.every((r) => Number(r.dataset.fare) === min),
      `${label}: 最安行がハイライトされる`,
    );
    assert(!!root.querySelector("#daybar .badge-cheap"), `${label}: 最安バッジがある`);
  } else {
    assert(minRows.length === 0 && !root.querySelector("#daybar .badge-cheap"), `${label}: 全日同額はバッジ無し`);
  }
}

function setupDom(url: string): JSDOM {
  const dom = new JSDOM(`<!DOCTYPE html><body><main id="app"></main></body>`, {
    url,
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.location = dom.window.location;
  g.history = dom.window.history;
  g.requestAnimationFrame = () => 0;
  return dom;
}

function click(dom: JSDOM, elm: Element): void {
  elm.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

// ---- 1) 通常ブート → 検索 → 戦略グループ描画 → ソート ----
{
  const dom = setupDom("https://example.com/kisei/");
  const { boot } = await import("../src/app/main");
  const root = dom.window.document.getElementById("app")!;
  boot(root as unknown as HTMLElement);

  // フォームが描画される
  assert(!!root.querySelector("#from"), "出発地セレクトがある");
  assert(!!root.querySelector("#to"), "到着地セレクトがある");
  assert(!!root.querySelector("#date"), "日付入力がある");
  assert(!!root.querySelector("#time"), "時刻入力がある");
  assert(!!root.querySelector('[data-action="search"]'), "検索ボタンがある");
  assert(!!root.querySelector(".empty-msg"), "初期状態は案内メッセージ");
  console.log("[dom] フォーム描画 OK");

  // 大阪→大間 09:00 で検索
  (root.querySelector("#from") as HTMLSelectElement).value = "osaka";
  (root.querySelector("#to") as HTMLSelectElement).value = "oma";
  (root.querySelector("#time") as HTMLInputElement).value = "09:00";
  click(dom, root.querySelector('[data-action="search"]')!);

  // 第一画面は戦略の比較（フラット30件ではない）
  const allGroups = root.querySelectorAll(".group-card");
  const mainGroups = root.querySelectorAll("#results > .group-card");
  const cards = root.querySelectorAll(".route-card");
  assert(allGroups.length >= 5 && allGroups.length <= 15, `戦略が5〜15とおり（実際: ${allGroups.length}）`);
  assert(mainGroups.length >= 4 && mainGroups.length <= 10, `主要戦略が4〜10（実際: ${mainGroups.length}）`);
  assert(cards.length >= 4, `行程カードが4件以上（実際: ${cards.length}件）`);
  assert(cards.length > allGroups.length, "行程がグループに集約されている");
  const labels = [...root.querySelectorAll(".group-label")].map((el) => el.textContent?.trim());
  assert(labels.includes("車で直行"), `「車で直行」がある（実際: ${labels.join(" / ")}）`);
  assert(!!root.querySelector(".other-groups"), "「遠回り・乗継の多い行き方」フォールドがある");
  console.log(`[dom] 検索 → ${mainGroups.length}+その他${allGroups.length - mainGroups.length}戦略・${cards.length}行程 OK`);

  // 既定ソート=最安: 先頭グループの typical が主要グループ中最小・最安バッジ付き
  const typicals = [...mainGroups].map((c) => Number((c as HTMLElement).dataset.typical));
  assert(typicals[0] === Math.min(...typicals), "最安ソートで先頭グループが最小運賃");
  assert(!!mainGroups[0].querySelector(":scope > summary .badge-cheap"), "先頭グループに最安バッジ");
  assert(root.querySelectorAll("#results .badge-cheap").length === 1, "結果側の最安バッジは1つ");

  // 出発日くらべバー: 今日基準の7日ウィンドウが描画され、エンジン計算と一致する
  const today = localTodayISO();
  const win0 = compareWindow(today, today);
  const dq0 = {
    originId: "osaka",
    destId: "oma",
    departAfterMin: parseHM("09:00"),
    overrides: new Map<string, number>(),
  };
  assert(!(root.querySelector("#daybar") as HTMLElement).hidden, "出発日くらべバーが表示される");
  assert(root.querySelector(".daybar-title")!.textContent!.includes("出発日くらべ"), "バーのタイトルがある");
  assertDaybarMatches(root, compareDays(NET, CAL, dq0, win0), "初回検索");
  const selRows = root.querySelectorAll<HTMLElement>("#daybar .daybar-row.is-selected");
  assert(
    selRows.length === 1 && selRows[0].dataset.date === (root.querySelector("#date") as HTMLInputElement).value,
    "選択日マークが日付入力と一致",
  );
  console.log("[dom] 出発日くらべ表示 OK");

  // 初期展開: 先頭グループとその先頭行程だけ開く
  assert(mainGroups[0].hasAttribute("open"), "先頭グループは展開済み");
  assert(!mainGroups[1].hasAttribute("open"), "2番目のグループは折りたたみ");
  const firstRoutes = mainGroups[0].querySelectorAll(".route-card");
  assert(firstRoutes[0].hasAttribute("open"), "先頭グループの先頭行程は展開済み");

  // 行程の識別は平文経由 + 待ち時間の接続行
  assert(!!root.querySelector(".route-via"), "経由の平文表示がある");
  assert(!!root.querySelector(".leg-wait"), "乗換・待ち時間の行がある");

  // 料金表示: typical 主役 + 幅は脇役
  assert(!!root.querySelector(".route-fare .fare-sub"), "運賃幅が脇役表示になっている");
  assert(
    [...root.querySelectorAll(".group-fare")].some((el) => el.textContent!.includes("目安")),
    "グループ運賃に目安表示",
  );

  // 損益分岐: 記号表示・基準バッジは廃止し、平文ノートが行程詳細内にある
  assert(!root.querySelector(".route-breakeven"), "旧・記号式の損益分岐ラインが無い");
  assert(!root.querySelector(".badge-base"), "「基準」バッジが無い");
  const notes = [...root.querySelectorAll(".breakeven-note")];
  assert(notes.length >= 1, "平文の損益分岐ノートがある");
  assert(
    notes.some((n) => /取れれば|高くなります|安くなります|見込み/.test(n.textContent ?? "")),
    `損益分岐が日本語平文（実際: ${notes[0]?.textContent}）`,
  );
  assert(
    notes.every((n) => n.closest(".route-legs") !== null),
    "損益分岐ノートは行程詳細内（サマリーではない）",
  );

  // 最速に切替 → 先頭グループが最早到着・開閉状態は維持される
  click(dom, root.querySelector('[data-action="set-sort"][data-sort="fastest"]')!);
  const mainGroups2 = root.querySelectorAll("#results > .group-card");
  const arrives = [...mainGroups2].map((c) => Number((c as HTMLElement).dataset.arrive));
  assert(arrives[0] === Math.min(...arrives), "最速ソートで先頭グループが最早到着");
  assert(!!mainGroups2[0].querySelector(":scope > summary .badge-fast"), "先頭グループに最速バッジ");
  assert(
    root.querySelector('[data-action="set-sort"][data-sort="fastest"]')!.className.includes("seg-on"),
    "最速ボタンがハイライト",
  );
  // バーはソートの影響を受けない（再検索なし・時系列順のまま）
  const rowsAfterSort = root.querySelectorAll<HTMLElement>("#daybar .daybar-row");
  assert(rowsAfterSort.length === 7 && rowsAfterSort[0].dataset.date === win0[0], "ソート切替でバーは不変");
  console.log("[dom] ソート切替 OK");

  // URL に検索条件が同期される
  assert(dom.window.location.search.includes("from=osaka"), "URLに from が入る");
  assert(dom.window.location.search.includes("sort=fastest"), "URLに sort が入る");
  console.log("[dom] URL同期 OK");

  // 実価格上書き: 変動レッグ（✈️/🚙）の入力欄に実価格を入れると再探索・URL同期される
  // 再描画をまたいで開閉状態が維持されることも確認（2番目のグループを開いておく）
  const secondKey = (mainGroups2[1] as HTMLElement).dataset.key!;
  mainGroups2[1].setAttribute("open", "");
  const fareInput = root.querySelector<HTMLInputElement>("input[data-fare-edge]");
  assert(!!fareInput, "変動レッグに実価格入力欄がある");
  const overriddenEdgeId = fareInput!.dataset.fareEdge!;
  fareInput!.value = "9999";
  fareInput!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert(
    dom.window.location.search.includes(`fares=${overriddenEdgeId}%3A9999`) ||
      dom.window.location.search.includes(`fares=${overriddenEdgeId}:9999`),
    `URLに fares が入る（実際: ${dom.window.location.search}）`,
  );
  const sameInput = root.querySelector<HTMLInputElement>(`input[data-fare-edge="${overriddenEdgeId}"]`);
  assert(!!sameInput && sameInput.value === "9999", "再描画後も入力値が保持される");
  assert(!!root.querySelector(".leg-fare.is-override"), "上書きされたレグ運賃がマークされる");
  assert(
    root.querySelector<HTMLElement>(`.group-card[data-key="${secondKey}"]`)?.hasAttribute("open") === true,
    "再描画後も開いていたグループは開いたまま",
  );
  const clearBtn = root.querySelector<HTMLButtonElement>("#clear-fares")!;
  assert(!clearBtn.hidden, "実価格クリアボタンが表示される");
  console.log("[dom] 実価格上書き OK");

  // クリアで元に戻る
  click(dom, clearBtn);
  assert(!dom.window.location.search.includes("fares="), "クリアで URL から fares が消える");
  assert(clearBtn.hidden, "クリアボタンが隠れる");
  const inputAfter = root.querySelector<HTMLInputElement>("input[data-fare-edge]")!;
  assert(inputAfter.value === "", "クリアで入力欄が空に戻る");
  console.log("[dom] 実価格クリア OK");

  // 出発日くらべの日クリック → その日へ移動して再検索・URL同期・選択マーク移動
  const dayBtn = root.querySelectorAll<HTMLElement>("#daybar .daybar-row")[2];
  const targetDate = dayBtn.dataset.date!;
  assert(targetDate === addDaysISO(today, 2), "3行目は今日+2日（クランプ窓）");
  click(dom, dayBtn);
  assert((root.querySelector("#date") as HTMLInputElement).value === targetDate, "クリックで日付入力が変わる");
  assert(dom.window.location.search.includes(`date=${targetDate}`), "URLの date が更新される");
  assert(
    root.querySelector<HTMLElement>("#daybar .daybar-row.is-selected")?.dataset.date === targetDate,
    "選択日マークが移動する",
  );
  assert(root.querySelectorAll("#results > .group-card").length >= 4, "クリック後も結果が描画される");
  assertDaybarMatches(root, compareDays(NET, CAL, dq0, compareWindow(targetDate, today)), "日クリック後");
  console.log("[dom] 出発日くらべクリック OK");

  // 日別料金: カレンダーに無い日付で検索してもエラーなく「目安」のまま動く
  (root.querySelector("#date") as HTMLInputElement).value = "2030-01-01";
  click(dom, root.querySelector('[data-action="search"]')!);
  assert(root.querySelectorAll(".group-card").length >= 5, "カレンダー該当なしの日でも検索できる");
  assert(!root.querySelector(".leg-fare.is-calendar"), "該当日が無ければ日別料金表示は出ない");
  // カレンダー未カバー期間は全日同額 → 最安バッジを出さない
  const rows2030 = [...root.querySelectorAll<HTMLElement>("#daybar .daybar-row")];
  assert(rows2030.length === 7, "2030年でもバーは7日");
  assert(new Set(rows2030.map((r) => r.dataset.fare)).size === 1, "カレンダー無しは全日同額");
  assert(!root.querySelector("#daybar .badge-cheap"), "同額時は最安バッジを出さない");

  // fareCalendar.json にデータが入っていれば、その日付で「◯/◯の料金」表示が出る
  // （Phase 5 の転記後に実効。空の間はスキップ）
  const calDates = Object.values(FARE_CAL.edges).flatMap((e) => Object.keys(e.byDate));
  if (calDates.length > 0) {
    (root.querySelector("#date") as HTMLInputElement).value = calDates[0];
    click(dom, root.querySelector('[data-action="search"]')!);
    assert(!!root.querySelector(".leg-fare.is-calendar"), `日別料金が表示される（${calDates[0]}）`);
    assert(!!root.querySelector(".leg-cal-note"), "料金データの鮮度ノートが出る");
    console.log(`[dom] 日別料金表示 OK（${calDates[0]}）`);
  }
  // カレンダーに今日以降の日があれば、バーもその日基準でエンジン計算と一致する
  // （過去日はウィンドウが今日へクランプされるため未来日に限る。データ陳腐化で自然スキップ）
  const calFuture = calDates.filter((d) => d >= today).sort()[0];
  if (calFuture) {
    (root.querySelector("#date") as HTMLInputElement).value = calFuture;
    click(dom, root.querySelector('[data-action="search"]')!);
    assertDaybarMatches(root, compareDays(NET, CAL, dq0, compareWindow(calFuture, today)), `日別料金日 ${calFuture}`);
    console.log(`[dom] 出発日くらべ×日別料金 OK（${calFuture}）`);
  }
  console.log("[dom] 日別料金フォールバック OK");

  // 入替ボタン
  click(dom, root.querySelector('[data-action="swap"]')!);
  assert((root.querySelector("#from") as HTMLSelectElement).value === "oma", "swap で出発地が大間に");
  assert((root.querySelector("#to") as HTMLSelectElement).value === "osaka", "swap で到着地が大阪に");
  console.log("[dom] swap OK");

  // フッタ: 免責と出典
  assert(!!root.querySelector(".disclaimer"), "免責表示がある");
  assert(root.querySelectorAll(".sources a").length >= 5, "出典リンクが並ぶ");
  console.log("[dom] フッタ OK");

  // 出発地=到着地は案内メッセージになり、バーも隠れる（swap 後 from=oma）
  (root.querySelector("#to") as HTMLSelectElement).value = "oma";
  click(dom, root.querySelector('[data-action="search"]')!);
  assert(!!root.querySelector(".empty-msg"), "from=to で案内メッセージ");
  assert((root.querySelector("#daybar") as HTMLElement).hidden, "from=to でバーが隠れる");
  console.log("[dom] from=to ガード OK");
}

// ---- 2) 共有URLからの復元（自動検索） ----
{
  const dom = setupDom("https://example.com/kisei/?from=oma&to=osaka&date=2026-08-12&time=06:00&sort=fastest");
  // 新しい jsdom グローバルで再import（モジュールキャッシュは同一だが boot は引数 root 基準で動く）
  const { boot } = await import("../src/app/main");
  const root = dom.window.document.getElementById("app")!;
  boot(root as unknown as HTMLElement);

  assert((root.querySelector("#from") as HTMLSelectElement).value === "oma", "URLから出発地を復元");
  assert((root.querySelector("#to") as HTMLSelectElement).value === "osaka", "URLから到着地を復元");
  assert((root.querySelector("#time") as HTMLInputElement).value === "06:00", "URLから時刻を復元");
  assert((root.querySelector("#date") as HTMLInputElement).value === "2026-08-12", "URLから日付を復元");

  const mainGroups = root.querySelectorAll("#results > .group-card");
  assert(mainGroups.length >= 3, `共有URLで自動検索される（実際: ${mainGroups.length}戦略）`);
  const arrives = [...mainGroups].map((c) => Number((c as HTMLElement).dataset.arrive));
  assert(arrives[0] === Math.min(...arrives), "sort=fastest が適用されている");

  // 出発日くらべ: 共有URLの日付基準のウィンドウ（過去になったら今日へクランプ → 選択マーク無し）
  const winShared = compareWindow("2026-08-12", localTodayISO());
  const rowsShared = [...root.querySelectorAll<HTMLElement>("#daybar .daybar-row")];
  assert(rowsShared.length === 7, "共有URLでもバーは7日");
  assert(
    rowsShared.every((r, i) => r.dataset.date === winShared[i]),
    "ウィンドウが共有日付基準",
  );
  const selShared = root.querySelector<HTMLElement>("#daybar .daybar-row.is-selected");
  if (winShared.includes("2026-08-12")) {
    assert(selShared?.dataset.date === "2026-08-12", "共有日付に選択マーク");
  } else {
    assert(!selShared, "過去日付は選択マーク無し（クランプ）");
  }
  console.log("[dom] 共有URL復元 OK");
}

// ---- 3) 共有URLの fares=（実価格上書き）復元 ----
{
  const dom = setupDom(
    "https://example.com/kisei/?from=osaka&to=oma&date=2026-08-12&time=09:00&sort=cheapest&fares=flight-itm-aoj:9999",
  );
  const { boot } = await import("../src/app/main");
  const root = dom.window.document.getElementById("app")!;
  boot(root as unknown as HTMLElement);

  assert(root.querySelectorAll(".group-card").length >= 3, "fares 付きURLでも自動検索される");
  assert(!(root.querySelector("#clear-fares") as HTMLButtonElement).hidden, "復元時にクリアボタンが出る");
  const input = root.querySelector<HTMLInputElement>('input[data-fare-edge="flight-itm-aoj"]');
  assert(!!input && input.value === "9999", "URLの実価格が入力欄に復元される");
  console.log("[dom] fares 復元 OK");
}

console.log("\n✅ DOM smoke test passed");
