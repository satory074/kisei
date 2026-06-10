// エンジン＋データのスモークテスト。実行: npx tsx scripts/smoketest.ts
// セクション: 1) network.json 検証 2) time 3) expand（日跨ぎ） 4) pareto
//             5) search（合成フィクスチャ）+ 損益分岐 + 実価格上書き
//             6) 実データシナリオ 7) url round-trip
import networkJson from "../src/data/network.json";
import { parseHM, fmtHM, fmtDuration, fmtDayOffset, dayOffset, DAY_MIN } from "../src/engine/time";
import { validateNetwork } from "../src/engine/validate";
import { applyFareOverrides, baseEdgeId, compileNetwork } from "../src/engine/compile";
import { nextDeparture } from "../src/engine/expand";
import { dominates, markPareto } from "../src/engine/pareto";
import { searchRoutes } from "../src/engine/search";
import { fmtYenRange } from "../src/engine/format";
import { breakEvenThreshold, findBaseline, hasVolatileLeg, volatileFare } from "../src/engine/breakeven";
import { encodeQuery, decodeQuery } from "../src/app/url";
import type { Network, RouteResult } from "../src/engine/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}

// ---- 1) network.json の検証 ----
{
  const v = validateNetwork(networkJson);
  if (!v.ok) {
    console.error("❌ network.json が不正:");
    for (const e of v.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  // 全エッジに source / lastUpdated（validate 済みだが明示的に再確認）
  for (const e of v.network.edges) {
    assert(e.source.startsWith("http"), `${e.id}: source がURL`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(e.lastUpdated), `${e.id}: lastUpdated 形式`);
  }
  console.log(`[data] network.json OK（ノード${v.network.nodes.length} / エッジ${v.network.edges.length}）`);

  // 検証が壊れたデータをちゃんと弾くか
  const broken = structuredClone(networkJson) as Record<string, unknown>;
  (broken.edges as { fare: unknown }[])[0].fare = { low: 100, typical: 50, high: 200 };
  const bv = validateNetwork(broken);
  assert(!bv.ok, "low>typical の fare を弾く");

  // shortName / cityOf（戦略グルーピング用フィールド）の検証
  const cloneNodes = () => structuredClone(networkJson) as { nodes: Record<string, unknown>[] };
  const b2 = cloneNodes();
  b2.nodes[0].cityOf = "no-such-node";
  assert(!validateNetwork(b2).ok, "存在しない cityOf を弾く");
  const b3 = cloneNodes();
  b3.nodes[0].cityOf = b3.nodes[0].id;
  assert(!validateNetwork(b3).ok, "自分自身を指す cityOf を弾く");
  const b4 = cloneNodes();
  b4.nodes[0].shortName = "";
  assert(!validateNetwork(b4).ok, "空 shortName を弾く");
  console.log("[data] 不正データ検出 OK");
}

// ---- 2) time.ts ----
{
  assert(parseHM("09:30") === 570, 'parseHM("09:30")');
  assert(parseHM("00:00") === 0, 'parseHM("00:00")');
  assert(parseHM("25:30") === 1530, '24時超表記 parseHM("25:30")');
  let threw = false;
  try {
    parseHM("9時30分");
  } catch {
    threw = true;
  }
  assert(threw, "不正形式で throw");
  assert(fmtHM(1530) === "01:30", "fmtHM(1530) → 翌日01:30");
  assert(fmtHM(570) === "09:30", "fmtHM(570)");
  assert(dayOffset(1530) === 1, "dayOffset(1530)");
  assert(fmtDayOffset(570) === "", "当日は空文字");
  assert(fmtDayOffset(1530) === "+1日", "+1日表記");
  assert(fmtDuration(755) === "12時間35分", "fmtDuration(755)");
  assert(fmtDuration(45) === "45分", "fmtDuration(45)");
  assert(fmtDuration(120) === "2時間", "fmtDuration(120)");
  assert(fmtYenRange({ low: 25000, typical: 35000, high: 50000 }) === "¥25,000〜¥50,000", "運賃幅表示");
  assert(fmtYenRange({ low: 3000, typical: 3000, high: 3000 }) === "¥3,000", "単一運賃表示");
  console.log("[time] OK");
}

// ---- 3) expand.ts（日跨ぎロジックの集中テスト） ----
{
  // timetable: 当日内
  const tt = {
    type: "timetable" as const,
    trips: [
      { dep: 420, arr: 510 }, // 07:00→08:30
      { dep: 850, arr: 940 }, // 14:10→15:40
    ],
  };
  let d = nextDeparture(tt, 400, 2);
  assert(d !== null && d.dep === 420, "timetable: 最初の便");
  d = nextDeparture(tt, 421, 2);
  assert(d !== null && d.dep === 850, "timetable: 2便目に繰り下げ");
  // 終便逃し → 翌日初便
  d = nextDeparture(tt, 851, 2);
  assert(d !== null && d.dep === DAY_MIN + 420 && d.arr === DAY_MIN + 510, "timetable: 終便後は翌日初便");
  // maxDay 超過 → null
  d = nextDeparture(tt, 2 * DAY_MIN + 851, 2);
  assert(d === null, "timetable: maxDay 超過で null");
  // 24時超表記の便（25:30 = 翌日01:30 発）を翌日0時台の notBefore が拾えるか
  const late = { type: "timetable" as const, trips: [{ dep: 1530, arr: 1600 }] };
  d = nextDeparture(late, DAY_MIN + 30, 2); // 翌日00:30 以降
  assert(d !== null && d.dep === 1530, "24時超の便を前日時刻表から拾う");

  // frequency: 格子への切り上げ
  const fq = { type: "frequency" as const, first: 360, last: 1260, everyMin: 20, durationMin: 150 };
  d = nextDeparture(fq, 0, 2);
  assert(d !== null && d.dep === 360, "frequency: 初発前は初発");
  d = nextDeparture(fq, 361, 2);
  assert(d !== null && d.dep === 380, "frequency: 20分格子へ切り上げ");
  d = nextDeparture(fq, 380, 2);
  assert(d !== null && d.dep === 380, "frequency: 格子上はそのまま");
  d = nextDeparture(fq, 1261, 2);
  assert(d !== null && d.dep === DAY_MIN + 360, "frequency: 終発後は翌日初発");

  // anytime: 待ちゼロ
  const at = { type: "anytime" as const, durationMin: 90 };
  d = nextDeparture(at, 1000, 2);
  assert(d !== null && d.dep === 1000 && d.arr === 1090, "anytime: 即時出発");

  // anytime + window（レンタカー営業時間）
  const win = { type: "anytime" as const, durationMin: 120, window: { open: 480, close: 1200 } };
  d = nextDeparture(win, 100, 2);
  assert(d !== null && d.dep === 480, "window: 開店まで待つ");
  d = nextDeparture(win, 700, 2);
  assert(d !== null && d.dep === 700, "window: 営業中は即時");
  d = nextDeparture(win, 1201, 2);
  assert(d !== null && d.dep === DAY_MIN + 480, "window: 閉店後は翌日開店");
  console.log("[expand] OK");
}

// ---- 4) pareto.ts ----
{
  const mk = (arriveMin: number, typical: number): RouteResult => ({
    legs: [],
    departMin: 0,
    arriveMin,
    durationMin: arriveMin,
    fare: { low: typical, typical, high: typical },
    transfers: 0,
    modeSignature: "x",
    isPareto: false,
  });
  const fast = mk(600, 40000);
  const cheap = mk(900, 10000);
  const dominatedR = mk(950, 42000);
  assert(dominates(fast, dominatedR), "fast が dominated を支配");
  assert(!dominates(fast, cheap) && !dominates(cheap, fast), "fast と cheap は互いに非支配");
  const all = [fast, cheap, dominatedR];
  markPareto(all);
  assert(fast.isPareto && cheap.isPareto && !dominatedR.isPareto, "パレートマーキング");
  // 同値タイは両方パレート
  const t1 = mk(600, 40000);
  const t2 = mk(600, 40000);
  markPareto([t1, t2]);
  assert(t1.isPareto && t2.isPareto, "同値タイは両方パレート");
  console.log("[pareto] OK");
}

// ---- 5) search.ts（合成フィクスチャ） ----
{
  // ダイヤモンド型: A → (速くて高い flight / 安くて遅い car / 支配される bus) → B → C
  const fixture: Network = {
    meta: { title: "fixture", dataLastUpdated: "2026-01-01", disclaimer: "test" },
    transfer: {
      defaultMin: { city: 10, station: 10, airport: 20, port: 10, poi: 5 },
      boardingLeadMin: {
        flight: 45,
        shinkansen: 10,
        rail: 5,
        ferry: 30,
        bus: 5,
        car: 0,
        rentacar: 20,
        taxi: 0,
        walk: 0,
      },
    },
    nodes: [
      { id: "a", name: "A", kind: "city", region: "r1", endpoint: true },
      { id: "ap", name: "A空港", kind: "airport", region: "r1" },
      { id: "bp", name: "B空港", kind: "airport", region: "r2" },
      { id: "b", name: "B", kind: "city", region: "r2" },
      { id: "c", name: "C", kind: "city", region: "r2", endpoint: true },
    ],
    edges: [
      {
        id: "acc-a-ap",
        from: "a",
        to: "ap",
        mode: "rail",
        service: { type: "frequency", first: "05:00", last: "22:00", everyMin: 10, durationMin: 20 },
        fare: 500,
        costBasis: "person",
        source: "https://example.com/",
        lastUpdated: "2026-01-01",
      },
      {
        id: "fly-ap-bp",
        from: "ap",
        to: "bp",
        mode: "flight",
        service: {
          type: "timetable",
          trips: [
            { dep: "08:00", arr: "09:30", name: "F1" },
            { dep: "18:00", arr: "19:30", name: "F2" },
          ],
        },
        fare: { low: 20000, typical: 30000, high: 45000 },
        costBasis: "person",
        source: "https://example.com/",
        lastUpdated: "2026-01-01",
      },
      {
        id: "acc-bp-b",
        from: "bp",
        to: "b",
        mode: "bus",
        service: { type: "frequency", first: "06:00", last: "23:00", everyMin: 15, durationMin: 25 },
        fare: 800,
        costBasis: "person",
        source: "https://example.com/",
        lastUpdated: "2026-01-01",
      },
      {
        id: "car-a-b",
        from: "a",
        to: "b",
        mode: "car",
        service: { type: "anytime", durationMin: 600 },
        fare: { low: 8000, typical: 10000, high: 10000 },
        costBasis: "vehicle",
        bidirectional: true,
        source: "https://example.com/",
        lastUpdated: "2026-01-01",
      },
      {
        id: "bus-a-b",
        from: "a",
        to: "b",
        mode: "bus",
        service: {
          type: "timetable",
          trips: [{ dep: "09:00", arr: "21:00", name: "高速バス" }],
        },
        fare: 12000,
        costBasis: "person",
        source: "https://example.com/",
        lastUpdated: "2026-01-01",
      },
      {
        id: "ferry-b-c",
        from: "b",
        to: "c",
        mode: "ferry",
        service: {
          type: "timetable",
          trips: [
            { dep: "11:00", arr: "12:30" },
            { dep: "20:30", arr: "22:00" },
          ],
        },
        fare: 3000,
        costBasis: "person",
        source: "https://example.com/",
        lastUpdated: "2026-01-01",
      },
    ],
  };
  const net = compileNetwork(fixture);

  // a→b: flight 経由（速い・高い）と car（安い・遅い）が両方パレート、
  // 高速バス（carより遅く高い＝支配される）は signature 代表として残るが isPareto=false
  const res = searchRoutes(net, { originId: "a", destId: "b", departAfterMin: parseHM("06:00") });
  const sigs = new Set(res.map((r) => r.modeSignature));
  assert(sigs.has("rail>flight>bus"), "フィクスチャ: 空路経由がある");
  assert(sigs.has("car"), "フィクスチャ: 車がある");
  assert(sigs.has("bus"), "フィクスチャ: 支配される高速バスも代表として残る");
  const flightRoute = res.find((r) => r.modeSignature === "rail>flight>bus")!;
  const carRoute = res.find((r) => r.modeSignature === "car")!;
  const busRoute = res.find((r) => r.modeSignature === "bus")!;
  assert(flightRoute.isPareto, "空路はパレート（最速）");
  assert(carRoute.isPareto, "車はパレート（最安）");
  assert(!busRoute.isPareto, "高速バスは支配される");
  assert(flightRoute.arriveMin < carRoute.arriveMin, "空路の方が早着");
  assert(carRoute.fare.typical < flightRoute.fare.typical, "車の方が安い");

  // 乗換の整合: flight の出発は 空港到着 + 乗換20分 + チェックイン45分 以降
  const fl = flightRoute.legs.find((l) => l.edge.mode === "flight")!;
  const acc = flightRoute.legs[0];
  assert(fl.depMin >= acc.arrMin + 20 + 45, "空港乗換+チェックインのリードを確保");
  // waitMin の合計 + 乗車時間 = duration
  const riding = flightRoute.legs.reduce((s, l) => s + (l.arrMin - l.depMin), 0);
  const waits = flightRoute.legs.slice(1).reduce((s, l) => s + l.waitMin, 0);
  assert(riding + waits === flightRoute.durationMin, "乗車+待ち=所要時間");

  // 18:00 検索 → 当日最終便を逃す経路は翌日へ（+1日到着がある）
  const late = searchRoutes(net, { originId: "a", destId: "c", departAfterMin: parseHM("18:00") });
  assert(late.length > 0, "夜検索でも経路が出る");
  assert(
    late.some((r) => dayOffset(r.arriveMin) >= 1),
    "翌日到着の経路がある",
  );

  // 初レグの待ちは無制限（22:00 検索 → 翌朝の便に乗れる）
  const veryLate = searchRoutes(net, { originId: "a", destId: "b", departAfterMin: parseHM("22:00") });
  assert(
    veryLate.some((r) => r.modeSignature.includes("flight")),
    "深夜検索で翌朝の空路が出る（初レグ待ち無制限）",
  );

  // maxWaitMin: 乗換待ちが上限を超える経路は刈られる
  const strictWait = searchRoutes(net, {
    originId: "a",
    destId: "c",
    departAfterMin: parseHM("13:00"),
    opts: { maxWaitMin: 60 },
  });
  assert(
    strictWait.every((r) => r.legs.slice(1).every((l) => l.waitMin <= 60)),
    "maxWaitMin で乗換待ちが刈られる",
  );

  // 決定性: 2回実行で同一結果
  const r1 = JSON.stringify(searchRoutes(net, { originId: "a", destId: "c", departAfterMin: 540 }));
  const r2 = JSON.stringify(searchRoutes(net, { originId: "a", destId: "c", departAfterMin: 540 }));
  assert(r1 === r2, "決定性");
  console.log("[search] フィクスチャ OK");

  // ---- 5b) 損益分岐（breakeven.ts） ----
  assert(hasVolatileLeg(flightRoute) && !hasVolatileLeg(carRoute), "変動レッグ判定");
  const vf = volatileFare(flightRoute);
  assert(vf.low === 20000 && vf.typical === 30000 && vf.high === 45000, "変動分の運賃幅");
  const baseline = findBaseline(res);
  assert(baseline !== null && baseline.modeSignature === "car", "基準=固定運賃のみの最安(car)");
  // 損益分岐 = 基準typical(10000) − 固定レッグ分(rail500+bus800)
  assert(breakEvenThreshold(flightRoute, baseline!) === 10000 - (500 + 800), "損益分岐額");
  assert(findBaseline([flightRoute]) === null, "固定運賃経路が無ければ基準なし");
  console.log("[breakeven] OK");

  // ---- 5c) 実価格上書き（applyFareOverrides） ----
  assert(baseEdgeId("fly-ap-bp@rev") === "fly-ap-bp" && baseEdgeId("fly-ap-bp") === "fly-ap-bp", "baseEdgeId");
  const ovNet = applyFareOverrides(net, new Map([["fly-ap-bp", 5000]]));
  const res2 = searchRoutes(ovNet, { originId: "a", destId: "b", departAfterMin: parseHM("06:00") });
  const f2 = res2.find((r) => r.modeSignature === "rail>flight>bus")!;
  assert(f2.fare.typical === 500 + 5000 + 800, "上書き後の合計運賃");
  assert(f2.fare.low === f2.fare.high && f2.fare.low === f2.fare.typical, "上書きで幅が潰れる");
  const car2 = res2.find((r) => r.modeSignature === "car")!;
  assert(f2.fare.typical < car2.fare.typical, "実価格次第で順位が入れ替わる（空路<車）");
  // 元の net は不変
  assert(net.edges.find((e) => e.id === "fly-ap-bp")!.fare.typical === 30000, "applyFareOverrides は元を変更しない");
  // bidirectional の @rev エッジにも元 id で効く
  const ovNet2 = applyFareOverrides(net, new Map([["car-a-b", 7777]]));
  const carEdges = ovNet2.edges.filter((e) => baseEdgeId(e.id) === "car-a-b");
  assert(carEdges.length === 2 && carEdges.every((e) => e.fare.typical === 7777), "@rev エッジにも適用");
  // 空マップは同一オブジェクトを返す（no-op）
  assert(applyFareOverrides(net, new Map()) === net, "空の上書きは no-op");
  console.log("[override] OK");
}

// ---- 6) 実データシナリオ（network.json） ----
{
  const net = compileNetwork(networkJson);
  const t0 = Date.now();
  const res = searchRoutes(net, { originId: "osaka", destId: "oma", departAfterMin: parseHM("09:00") });
  const elapsed = Date.now() - t0;
  assert(elapsed < 2000, `探索が2秒以内（${elapsed}ms）`);
  assert(res.length <= 30, "maxResults 以内");

  // ユーザー例示の4モードパターンが全部出る
  const sigs = [...new Set(res.map((r) => r.modeSignature))];
  assert(sigs.length >= 4, `モード構成が4種以上（実際: ${sigs.length}種）`);
  const has = (pred: (s: string) => boolean, label: string) =>
    assert(sigs.some(pred), `${label} がある（実際: ${sigs.join(", ")}）`);
  has((s) => s.includes("flight") && s.includes("ferry"), "①飛行機+大間フェリー経路");
  has(
    (s) => s.includes("flight") && s.includes("rail") && s.includes("ferry"),
    "②空路+鉄道+フェリー経路（KIX→CTS→函館→大間 型）",
  );
  has(
    (s) => s.includes("shinkansen") && (s.includes("rentacar") || s.includes("bus")),
    "③新幹線+レンタカー/バス経路",
  );
  has((s) => s === "car", "④車直行経路");

  // 長い乗換待ち（フェリー夜越え等）の経路が maxWaitMin に殺されていないこと
  assert(
    res.some((r) => r.legs.some((l) => l.edge.mode === "ferry")),
    "フェリーを含む経路が残っている",
  );

  // 最速と最安が異なり、両方パレート
  const fastest = [...res].sort((a, b) => a.arriveMin - b.arriveMin)[0];
  const cheapest = [...res].sort((a, b) => a.fare.typical - b.fare.typical)[0];
  assert(fastest !== cheapest, "最速 ≠ 最安");
  assert(fastest.isPareto && cheapest.isPareto, "最速・最安は両方パレート");

  // 損益分岐の前提: 実データでも固定運賃のみの基準経路と変動経路が共存する
  assert(findBaseline(res) !== null, "実データで固定運賃の基準経路がある");
  assert(res.some(hasVolatileLeg), "実データで変動運賃を含む経路がある");

  // 22時出発 → 翌日到着の経路が出る
  const late = searchRoutes(net, { originId: "osaka", destId: "oma", departAfterMin: parseHM("22:00") });
  assert(late.length >= 1 && late.every((r) => dayOffset(r.arriveMin) >= 1), "22時検索は翌日以降到着");

  // 逆方向（帰り）
  const back = searchRoutes(net, { originId: "oma", destId: "osaka", departAfterMin: parseHM("06:00") });
  const backSigs = new Set(back.map((r) => r.modeSignature));
  assert(backSigs.size >= 3, `oma→osaka もモード3種以上（実際: ${backSigs.size}種）`);

  // 構造整合
  for (const r of [...res, ...back]) {
    assert(r.legs.length > 0, "legs が空でない");
    assert(r.arriveMin > r.departMin, "到着 > 出発");
    assert(r.fare.low <= r.fare.typical && r.fare.typical <= r.fare.high, "運賃幅の整合");
    for (let i = 1; i < r.legs.length; i++) {
      assert(r.legs[i].depMin >= r.legs[i - 1].arrMin, "レグの時系列整合");
    }
  }

  // 決定性
  const j1 = JSON.stringify(searchRoutes(net, { originId: "osaka", destId: "oma", departAfterMin: 540 }));
  const j2 = JSON.stringify(searchRoutes(net, { originId: "osaka", destId: "oma", departAfterMin: 540 }));
  assert(j1 === j2, "実データでも決定性");

  console.log(`[scenario] osaka⇔oma OK（往路${res.length}件・${sigs.length}構成 / 復路${back.length}件 / ${elapsed}ms）`);
}

// ---- 7) url.ts round-trip ----
{
  const s = {
    from: "osaka",
    to: "oma",
    date: "2026-08-12",
    time: "09:00",
    sort: "cheapest" as const,
  };
  const decoded = decodeQuery(encodeQuery(s));
  assert(JSON.stringify(decoded) === JSON.stringify(s), "encode→decode round-trip");
  assert(decodeQuery("?sort=bogus").sort === undefined, "不正 sort は無視");
  assert(decodeQuery("?time=9:0").time === undefined, "不正 time は無視");
  assert(decodeQuery("").from === undefined, "空クエリ");

  // fares=（実価格上書き）の round-trip
  const s2 = { ...s, fares: { "flight-itm-aoj": 18000, "rentacar-aomori-oma": 9000 } };
  const decoded2 = decodeQuery(encodeQuery(s2));
  assert(JSON.stringify(decoded2.fares) === JSON.stringify(s2.fares), "fares round-trip");
  assert(!encodeQuery(s).includes("fares="), "fares 未指定なら省略");
  assert(!encodeQuery({ ...s, fares: {} }).includes("fares="), "fares 空でも省略");
  assert(decodeQuery("?fares=bogus").fares === undefined, "不正 fares は無視");
  const partial = decodeQuery("?fares=flight-itm-aoj:18000,bad pair:x,UPPER:1")!.fares;
  assert(JSON.stringify(partial) === JSON.stringify({ "flight-itm-aoj": 18000 }), "不正ペアだけ捨てる");
  console.log("[url] OK");
}

console.log("\n✅ smoketest passed");
