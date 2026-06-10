// DOM レベルのスモークテスト: boot → 検索 → カード描画 → ソート切替 → URL復元 を jsdom で検証。
// 実行: npx tsx scripts/domtest.ts
import { JSDOM } from "jsdom";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
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

// ---- 1) 通常ブート → 検索 → カード描画 → ソート ----
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

  const cards = root.querySelectorAll(".route-card");
  assert(cards.length >= 4, `ルートカードが4件以上（実際: ${cards.length}件）`);
  console.log(`[dom] 検索 → ${cards.length}件描画 OK`);

  // 既定ソート=最安: 先頭カードの typical が最小
  const typicals = [...cards].map((c) => Number((c as HTMLElement).dataset.typical));
  assert(typicals[0] === Math.min(...typicals), "最安ソートで先頭が最小運賃");
  // 最安バッジが先頭カードに付く
  assert(!!cards[0].querySelector(".badge-cheap"), "先頭カードに最安バッジ");

  // 待ち時間の接続行がある（このアプリの主役情報）
  assert(!!root.querySelector(".leg-wait"), "乗換・待ち時間の行がある");
  // 上位3件は展開されている
  assert(cards[0].hasAttribute("open"), "1件目は展開済み");
  assert(cards.length <= 3 || !cards[3].hasAttribute("open"), "4件目以降は折りたたみ");

  // 最速に切替 → 先頭が最早到着
  click(dom, root.querySelector('[data-action="set-sort"][data-sort="fastest"]')!);
  const cards2 = root.querySelectorAll(".route-card");
  const arrives = [...cards2].map((c) => Number((c as HTMLElement).dataset.arrive));
  assert(arrives[0] === Math.min(...arrives), "最速ソートで先頭が最早到着");
  assert(!!cards2[0].querySelector(".badge-fast"), "先頭カードに最速バッジ");
  assert(
    root.querySelector('[data-action="set-sort"][data-sort="fastest"]')!.className.includes("seg-on"),
    "最速ボタンがハイライト",
  );
  console.log("[dom] ソート切替 OK");

  // URL に検索条件が同期される
  assert(dom.window.location.search.includes("from=osaka"), "URLに from が入る");
  assert(dom.window.location.search.includes("sort=fastest"), "URLに sort が入る");
  console.log("[dom] URL同期 OK");

  // 入替ボタン
  click(dom, root.querySelector('[data-action="swap"]')!);
  assert((root.querySelector("#from") as HTMLSelectElement).value === "oma", "swap で出発地が大間に");
  assert((root.querySelector("#to") as HTMLSelectElement).value === "osaka", "swap で到着地が大阪に");
  console.log("[dom] swap OK");

  // フッタ: 免責と出典
  assert(!!root.querySelector(".disclaimer"), "免責表示がある");
  assert(root.querySelectorAll(".sources a").length >= 5, "出典リンクが並ぶ");
  console.log("[dom] フッタ OK");
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

  const cards = root.querySelectorAll(".route-card");
  assert(cards.length >= 3, `共有URLで自動検索される（実際: ${cards.length}件）`);
  const arrives = [...cards].map((c) => Number((c as HTMLElement).dataset.arrive));
  assert(arrives[0] === Math.min(...arrives), "sort=fastest が適用されている");
  console.log("[dom] 共有URL復元 OK");
}

console.log("\n✅ DOM smoke test passed");
