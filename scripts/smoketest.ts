// エンジン＋データのスモークテスト。実行: npx tsx scripts/smoketest.ts
// セクション: 1) network.json 検証 2) time 3) expand（日跨ぎ） 4) pareto
//             5) search（合成フィクスチャ）+ 損益分岐 + 実価格上書き + 日別料金 + 出発日くらべ
//             6) 実データシナリオ 7) url round-trip
import networkJson from "../src/data/network.json";
import fareCalendarJson from "../src/data/fareCalendar.json";
import { parseHM, fmtHM, fmtDuration, fmtDayOffset, dayOffset, DAY_MIN } from "../src/engine/time";
import { validateNetwork } from "../src/engine/validate";
import { applyFareOverrides, baseEdgeId, compileNetwork } from "../src/engine/compile";
import { nextDeparture } from "../src/engine/expand";
import { dominates, markPareto } from "../src/engine/pareto";
import { searchRoutes } from "../src/engine/search";
import { fmtYenRange } from "../src/engine/format";
import {
  breakEvenThreshold,
  describeBreakEven,
  findBaseline,
  hasVolatileLeg,
  volatileFare,
} from "../src/engine/breakeven";
import { fareOnDate, validateFareCalendar } from "../src/engine/farecal";
import { addDaysISO, buildFareByDay, daysBetweenISO, fmtDateShort, weekdayISO } from "../src/app/fares";
import { WINDOW_BACK, WINDOW_DAYS, compareDays, compareWindow } from "../src/app/daycompare";
import { PRIMARY_MODES, groupRoutes, routeId, strategyKey, strategyLabel, viaSummary } from "../src/engine/group";
import { encodeQuery, decodeQuery } from "../src/app/url";
import type {
  CompiledEdge,
  CompiledNetwork,
  Leg,
  Mode,
  Network,
  NetworkNode,
  RouteResult,
} from "../src/engine/types";

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

  // 平文化（describeBreakEven）の4分岐。flightRoute: 固定分1300 + 変動(20000/30000/45000)
  const fakeBase = (typical: number): RouteResult =>
    ({ legs: [], fare: { low: typical, typical, high: typical } }) as unknown as RouteResult;
  assert(describeBreakEven(carRoute, baseline!, "車で直行") === null, "変動レッグ無しは null");
  // 閾値 < low → 最安でも基準より高い
  const tLow = describeBreakEven(flightRoute, baseline!, "車で直行")!;
  assert(
    tLow.includes("最安") && tLow.includes("高くなります") && tLow.includes("「車で直行」"),
    `閾値<low の平文（実際: ${tLow}）`,
  );
  // low ≤ 閾値 < high → 「◯円以下で取れれば安い」。基準typical=31300 → 閾値30000
  const tMid = describeBreakEven(flightRoute, fakeBase(31300), "新幹線＋鉄道・バス")!;
  assert(
    tMid.includes("航空券を ¥30,000 以下で取れれば") && tMid.includes("「新幹線＋鉄道・バス」（¥31,300）"),
    `閾値中間の平文（実際: ${tMid}）`,
  );
  // 閾値 ≥ high → 繁忙期でも安い
  const tHigh = describeBreakEven(flightRoute, fakeBase(46300), "高い基準")!;
  assert(tHigh.includes("繁忙期価格でも") && tHigh.includes("安く済む見込み"), `閾値≥high の平文（実際: ${tHigh}）`);
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
  // 実価格確定後の平文は差額表示になる（6300 vs 10000 → ¥3,700 安い）
  const settled = describeBreakEven(f2, car2, "車で直行")!;
  assert(
    settled.includes("この価格なら") && settled.includes("¥3,700 安くなります"),
    `確定価格の平文（実際: ${settled}）`,
  );
  // 元の net は不変
  assert(net.edges.find((e) => e.id === "fly-ap-bp")!.fare.typical === 30000, "applyFareOverrides は元を変更しない");
  // bidirectional の @rev エッジにも元 id で効く
  const ovNet2 = applyFareOverrides(net, new Map([["car-a-b", 7777]]));
  const carEdges = ovNet2.edges.filter((e) => baseEdgeId(e.id) === "car-a-b");
  assert(carEdges.length === 2 && carEdges.every((e) => e.fare.typical === 7777), "@rev エッジにも適用");
  // 空マップは同一オブジェクトを返す（no-op）
  assert(applyFareOverrides(net, new Map()) === net, "空の上書きは no-op");
  console.log("[override] OK");

  // ---- 5e) 日別料金（farecal.ts + fares.ts + fareByDay 探索統合） ----
  const calOk = validateFareCalendar(
    {
      edges: {
        "fly-ap-bp": {
          fetchedAt: "2026-06-01",
          source: "https://example.com/cal",
          byDate: { "2026-08-12": 8000 },
        },
      },
    },
    net,
  );
  if (!calOk.ok) {
    console.error(`❌ FAILED: カレンダー検証: ${calOk.errors.join(", ")}`);
    process.exit(1);
  }
  const cal = calOk.calendar;
  const calBad = (raw: unknown, label: string) =>
    assert(!validateFareCalendar(raw, net).ok, `不正カレンダー検出: ${label}`);
  const entry = (over: Record<string, unknown>) => ({
    fetchedAt: "2026-06-01",
    source: "https://example.com/",
    byDate: {},
    ...over,
  });
  calBad({ edges: { "no-such-edge": entry({}) } }, "未知エッジ");
  calBad({ edges: { "acc-a-ap": entry({}) } }, "非変動モード(rail)");
  calBad({ edges: { "fly-ap-bp": entry({ byDate: { "8/12": 1000 } }) } }, "不正日付");
  calBad({ edges: { "fly-ap-bp": entry({ byDate: { "2026-08-12": -100 } }) } }, "負価格");
  calBad({ edges: { "fly-ap-bp": entry({ byDate: { "2026-08-12": 100.5 } }) } }, "非整数価格");
  calBad({ edges: { "fly-ap-bp": entry({ fetchedAt: "6/1" }) } }, "fetchedAt 形式");
  calBad({ edges: { "fly-ap-bp": entry({ source: "sorahapi" }) } }, "source 非URL");

  assert(fareOnDate(cal, "fly-ap-bp", "2026-08-12") === 8000, "fareOnDate ヒット");
  assert(fareOnDate(cal, "fly-ap-bp@rev", "2026-08-12") === 8000, "fareOnDate は @rev でも引ける");
  assert(fareOnDate(cal, "fly-ap-bp", "2026-08-13") === null, "fareOnDate ミスは null");

  // app層の日付ヘルパー
  assert(addDaysISO("2026-08-12", 1) === "2026-08-13", "addDaysISO");
  assert(addDaysISO("2026-12-31", 1) === "2027-01-01", "addDaysISO 年跨ぎ");
  assert(addDaysISO("2028-02-28", 1) === "2028-02-29", "addDaysISO うるう年");
  assert(daysBetweenISO("2026-06-01", "2026-07-02") === 31, "daysBetweenISO");
  assert(fmtDateShort("2026-08-12") === "8/12", "fmtDateShort");

  // buildFareByDay: dayOffset 配列化・実価格上書きエッジの除外・該当日なしの省略
  const byDay = buildFareByDay(cal, "2026-08-12", 4, new Set());
  assert(JSON.stringify(byDay.get("fly-ap-bp")) === JSON.stringify([8000, null, null, null]), "dayOffset 配列");
  assert(buildFareByDay(cal, "2026-08-12", 4, new Set(["fly-ap-bp"])).size === 0, "上書きエッジは除外");
  assert(buildFareByDay(cal, "2026-08-01", 4, new Set()).size === 0, "該当日が無ければ載せない");

  // 探索統合: 当日価格が幅・枝刈り・順位の全評価軸に効く
  const calRes1 = searchRoutes(net, {
    originId: "a",
    destId: "b",
    departAfterMin: parseHM("06:00"),
    fareByDay: byDay,
  });
  const calFlight = calRes1.find((r) => r.modeSignature === "rail>flight>bus")!;
  const calLeg = calFlight.legs.find((l) => l.edge.mode === "flight")!;
  assert(calLeg.calendarFare === 8000, "flight レグに calendarFare が付く");
  assert(
    calFlight.fare.low === 9300 && calFlight.fare.typical === 9300 && calFlight.fare.high === 9300,
    "当日価格で幅が潰れる（500+8000+800）",
  );
  const calCar = calRes1.find((r) => r.modeSignature === "car")!;
  assert(calFlight.fare.typical < calCar.fare.typical, "カレンダー価格で順位が入れ替わる（空路<車）");
  assert(calRes1[0].modeSignature === "rail>flight>bus", "返り値ソートにも反映");
  const vf2 = volatileFare(calFlight);
  assert(vf2.low === 8000 && vf2.high === 8000, "volatileFare も当日価格で潰れる");

  // 22:00 検索 → 翌朝便のレグは +1日（dayOffset=1）の価格を引く
  const byDay2 = new Map<string, (number | null)[]>([["fly-ap-bp", [null, 7000, null, null]]]);
  const calRes2 = searchRoutes(net, {
    originId: "a",
    destId: "b",
    departAfterMin: parseHM("22:00"),
    fareByDay: byDay2,
  });
  const nextDayFlight = calRes2.find((r) => r.modeSignature === "rail>flight>bus")!;
  const fl2 = nextDayFlight.legs.find((l) => l.edge.mode === "flight")!;
  assert(fl2.depMin >= DAY_MIN, "翌日出発の便");
  assert(fl2.calendarFare === 7000, "翌日出発レグは +1日の価格を引く");

  // 該当日なし → calendarFare 無しで幅のままフォールバック
  const calRes3 = searchRoutes(net, {
    originId: "a",
    destId: "b",
    departAfterMin: parseHM("06:00"),
    fareByDay: new Map<string, (number | null)[]>([["fly-ap-bp", [null, null, null, null]]]),
  });
  const fb = calRes3.find((r) => r.modeSignature === "rail>flight>bus")!;
  assert(fb.legs.find((l) => l.edge.mode === "flight")!.calendarFare === undefined, "該当日なしは calendarFare 無し");
  assert(fb.fare.low === 500 + 20000 + 800 && fb.fare.high === 500 + 45000 + 800, "フォールバックは幅のまま");

  // 決定性（fareByDay あり）
  const cj1 = JSON.stringify(
    searchRoutes(net, { originId: "a", destId: "c", departAfterMin: 540, fareByDay: byDay }),
  );
  const cj2 = JSON.stringify(
    searchRoutes(net, { originId: "a", destId: "c", departAfterMin: 540, fareByDay: byDay }),
  );
  assert(cj1 === cj2, "fareByDay ありでも決定性");
  console.log("[farecal] OK");

  // ---- 5f) 出発日くらべ（daycompare.ts） ----
  // compareWindow: ±3で7日、過去日は今日へクランプして前方に伸ばす
  {
    const w = compareWindow("2026-08-12", "2026-06-01");
    assert(w.length === WINDOW_DAYS, "ウィンドウは7日");
    assert(w[0] === "2026-08-09" && w[6] === "2026-08-15", `±3日（実際: ${w[0]}〜${w[6]}）`);
    assert(w[WINDOW_BACK] === "2026-08-12", "選択日が中央");
    const clamped = compareWindow("2026-06-02", "2026-06-01");
    assert(clamped[0] === "2026-06-01" && clamped.length === 7, "今日へクランプして7日維持");
    assert(clamped.includes("2026-06-02"), "クランプ後も選択日を含む");
    const past = compareWindow("2026-01-01", "2026-06-01");
    assert(past[0] === "2026-06-01" && !past.includes("2026-01-01"), "過去の選択日はウィンドウ外（今日始まり）");
    const yearX = compareWindow("2026-12-31", "2026-06-01");
    assert(yearX.includes("2027-01-01") && yearX[6] === "2027-01-03", "年跨ぎウィンドウ");
  }
  assert(weekdayISO("2026-06-13") === 6 && weekdayISO("2026-06-14") === 0, "weekdayISO 土日");
  assert(weekdayISO("2026-08-11") === 2, "weekdayISO 火曜");

  // compareDays: カレンダーのある日は飛行機が安く確定、無い日は車が最安で目安
  const cal2 = (() => {
    const v = validateFareCalendar(
      {
        edges: {
          "fly-ap-bp": {
            fetchedAt: "2026-06-01",
            source: "https://example.com/cal",
            byDate: { "2026-08-11": 9000, "2026-08-12": 8000 },
          },
        },
      },
      net,
    );
    if (!v.ok) {
      console.error(`❌ FAILED: 出発日くらべ用カレンダー検証: ${v.errors.join(", ")}`);
      process.exit(1);
    }
    return v.calendar;
  })();
  const dq = { originId: "a", destId: "b", departAfterMin: parseHM("06:00"), overrides: new Map<string, number>() };
  const win = compareWindow("2026-08-12", "2026-06-01"); // 8/9〜8/15
  const days = compareDays(net, cal2, dq, win);
  assert(days.length === 7, "7日ぶんの結果");
  assert(
    days.every((d, i) => d.dateISO === win[i]),
    "日付がウィンドウ順",
  );
  const d12 = days.find((d) => d.dateISO === "2026-08-12")!;
  assert(d12.fareTypical === 500 + 8000 + 800, `8/12は飛行機が最安（実際: ${d12.fareTypical}）`);
  assert(!d12.isEstimate, "8/12は当日価格で確定（目安でない）");
  assert(d12.strategyLabel.includes("飛行機"), `8/12の戦略は飛行機（実際: ${d12.strategyLabel}）`);
  const d11 = days.find((d) => d.dateISO === "2026-08-11")!;
  assert(d11.fareTypical === 10000, `8/11は車が最安（10300>10000、実際: ${d11.fareTypical}）`);
  assert(d11.strategyLabel === "車で直行", `8/11の戦略は車（実際: ${d11.strategyLabel}）`);
  assert(d11.isEstimate, "8/11は車の幅が残るので目安");
  const d09 = days.find((d) => d.dateISO === "2026-08-09")!;
  assert(d09.fareTypical === 10000 && d09.isEstimate, "カレンダー無しの日は車最安・目安");
  // 整合性: 同条件の直接 searchRoutes と一致
  const direct = searchRoutes(net, {
    originId: "a",
    destId: "b",
    departAfterMin: parseHM("06:00"),
    fareByDay: buildFareByDay(cal2, "2026-08-12", 4, new Set()),
  });
  assert(direct[0].fare.typical === d12.fareTypical, "compareDays と直接探索が一致");
  // 実価格上書き: 全日同額・全確定（上書きエッジは日別テーブルから除外される）
  const ovDays = compareDays(net, cal2, { ...dq, overrides: new Map([["fly-ap-bp", 5000]]) }, win);
  assert(
    ovDays.every((d) => d.fareTypical === 500 + 5000 + 800 && !d.isEstimate),
    "上書き時は全日同額・確定",
  );
  // 決定性
  assert(
    JSON.stringify(compareDays(net, cal2, dq, win)) === JSON.stringify(days),
    "compareDays の決定性",
  );
  console.log("[daycompare] OK");
}

// ---- 5d) 戦略グルーピング（group.ts、合成 RouteResult） ----
{
  const nodes: NetworkNode[] = [
    { id: "osaka", name: "大阪（梅田）", kind: "city", region: "kansai", endpoint: true },
    { id: "shin-osaka", name: "新大阪駅", kind: "station", region: "kansai" },
    { id: "itm", name: "伊丹空港", kind: "airport", region: "kansai", shortName: "伊丹", cityOf: "osaka" },
    { id: "kix", name: "関西空港", kind: "airport", region: "kansai", shortName: "関西", cityOf: "osaka" },
    { id: "tokyo", name: "東京駅", kind: "station", region: "kanto" },
    { id: "sendai", name: "仙台", kind: "city", region: "tohoku" },
    { id: "shin-aomori", name: "新青森駅", kind: "station", region: "tohoku" },
    { id: "aoj", name: "青森空港", kind: "airport", region: "tohoku", shortName: "青森" },
    { id: "hkd", name: "函館空港", kind: "airport", region: "hokkaido", shortName: "函館", cityOf: "hakodate" },
    { id: "hakodate", name: "函館駅", kind: "station", region: "hokkaido", endpoint: true },
    { id: "hakodate-port", name: "函館FT", kind: "port", region: "hokkaido", shortName: "函館" },
    { id: "oma-port", name: "大間FT", kind: "port", region: "tohoku", shortName: "大間" },
    { id: "oma", name: "大間", kind: "city", region: "tohoku", endpoint: true },
  ];
  const gnet = { nodesById: new Map(nodes.map((n) => [n.id, n])) } as unknown as CompiledNetwork;
  let seq = 0;
  const leg = (mode: Mode, from: string, to: string): Leg => {
    seq += 1;
    return {
      edge: { id: `e${seq}-${mode}-${from}-${to}`, from, to, mode } as unknown as CompiledEdge,
      depMin: 500 + seq * 10,
      arrMin: 505 + seq * 10,
      waitMin: 0,
    };
  };
  const route = (legs: Leg[], typical = 10000): RouteResult => ({
    legs,
    departMin: legs[0].depMin,
    arriveMin: legs[legs.length - 1].arrMin,
    durationMin: legs[legs.length - 1].arrMin - legs[0].depMin,
    fare: { low: typical, typical, high: typical },
    transfers: legs.length - 1,
    modeSignature: legs.map((l) => l.edge.mode).join(">"),
    isPareto: false,
  });

  assert(!PRIMARY_MODES.has("rail") && !PRIMARY_MODES.has("bus"), "rail/bus はアクセスモード");

  // アクセスレグ違い（bus vs rail）は同一キー
  const viaBus = route([leg("bus", "osaka", "itm"), leg("flight", "itm", "aoj"), leg("rentacar", "aoj", "oma")]);
  const viaRail = route([leg("rail", "osaka", "itm"), leg("flight", "itm", "aoj"), leg("rentacar", "aoj", "oma")]);
  assert(strategyKey(viaBus, gnet) === "flight@aoj>rentacar", `キー導出（実際: ${strategyKey(viaBus, gnet)}）`);
  assert(strategyKey(viaBus, gnet) === strategyKey(viaRail, gnet), "アクセスレグ違いは同一キー");

  // cityOf でホーム側空港の違い（itm vs kix）が消える
  const viaKix = route([leg("rail", "osaka", "kix"), leg("flight", "kix", "aoj"), leg("rentacar", "aoj", "oma")]);
  assert(strategyKey(viaKix, gnet) === strategyKey(viaBus, gnet), "cityOf でホーム側空港を統合");

  // 到着空港が違えば別戦略
  const viaHkd = route([
    leg("bus", "osaka", "itm"),
    leg("flight", "itm", "hkd"),
    leg("taxi", "hkd", "hakodate-port"),
    leg("ferry", "hakodate-port", "oma-port"),
    leg("walk", "oma-port", "oma"),
  ]);
  assert(
    strategyKey(viaHkd, gnet) === "flight@hkd>ferry@hakodate-port~oma-port",
    `函館経由は別キー（実際: ${strategyKey(viaHkd, gnet)}）`,
  );

  // フェリーのキーは方向非依存（復路と同じ戦略）
  const ferryBack = route([
    leg("walk", "oma", "oma-port"),
    leg("ferry", "oma-port", "hakodate-port"),
    leg("flight", "hkd", "itm"), // hkd は cityOf=hakodate ≠ 起終点なので経由地に残る
  ]);
  assert(strategyKey(ferryBack, gnet).includes("ferry@hakodate-port~oma-port"), "フェリー航路キーは方向非依存");

  // 連続する同一主要モードの畳み込み（新幹線乗継・車の分割）
  const shinkansen2 = route([
    leg("rail", "osaka", "shin-osaka"),
    leg("shinkansen", "shin-osaka", "tokyo"),
    leg("shinkansen", "tokyo", "shin-aomori"),
    leg("rail", "shin-aomori", "shimokita"),
    leg("bus", "shimokita", "oma"),
  ]);
  assert(strategyKey(shinkansen2, gnet) === "shinkansen", "新幹線乗継は1セグメント");
  const car2 = route([leg("car", "osaka", "sendai"), leg("car", "sendai", "oma")]);
  assert(strategyKey(car2, gnet) === "car", "car>car は1セグメント");
  assert(strategyLabel([car2], gnet) === "車で直行", "車単独の特例ラベル");

  // ラベル生成
  assert(strategyLabel([viaBus], gnet) === "飛行機（青森）＋レンタカー", `ラベル（実際: ${strategyLabel([viaBus], gnet)}）`);
  assert(
    strategyLabel([viaHkd], gnet) === "飛行機（函館）＋フェリー（函館〜大間）",
    `函館経由ラベル（実際: ${strategyLabel([viaHkd], gnet)}）`,
  );
  assert(
    strategyLabel([shinkansen2], gnet) === "新幹線＋鉄道・バス",
    `新幹線ラベル（実際: ${strategyLabel([shinkansen2], gnet)}）`,
  );

  // viaSummary は起終点を除いた主要レグ端点の平文
  assert(viaSummary(viaBus, gnet) === "伊丹空港 → 青森空港", `viaSummary（実際: ${viaSummary(viaBus, gnet)}）`);
  assert(viaSummary(shinkansen2, gnet) === "新大阪駅 → 東京駅 → 新青森駅", "新幹線 viaSummary（乗継点を畳む）");

  // 主要レグ無し → modeSignature フォールバック
  const busOnly = route([leg("bus", "osaka", "sendai"), leg("bus", "sendai", "oma")]);
  assert(strategyKey(busOnly, gnet) === "bus>bus", "主要レグ無しは modeSignature");

  // groupRoutes: 分割の完全性・集約値・isOther
  const all = [viaBus, viaRail, viaKix, viaHkd, shinkansen2, car2, busOnly];
  const groups = groupRoutes(all, gnet);
  assert(groups.reduce((s, g) => s + g.routes.length, 0) === all.length, "全行程がちょうど1グループ");
  const flightGroup = groups.find((g) => g.key === "flight@aoj>rentacar")!;
  assert(flightGroup.routes.length === 3, "飛行機(青森)グループに3行程");
  assert(flightGroup.minDurationMin === Math.min(...flightGroup.routes.map((r) => r.durationMin)), "minDuration");
  const otherKeys = groups.filter((g) => g.isOther).map((g) => g.key);
  assert(otherKeys.length === 0, `2セグメントまでは主要戦略（実際 isOther: ${otherKeys.join(", ")}）`);
  const threeSeg = route([
    leg("flight", "itm", "aoj"),
    leg("ferry", "oma-port", "hakodate-port"),
    leg("rentacar", "hakodate", "oma"),
  ]);
  assert(groupRoutes([threeSeg], gnet)[0].isOther, "主要3セグメントは isOther");

  // routeId は legs から決まる安定id
  assert(routeId(viaBus) !== routeId(viaRail), "routeId は行程ごとに異なる");
  assert(routeId(viaBus) === routeId(viaBus), "routeId は安定");
  console.log("[group] OK");
}

// ---- 6) 実データシナリオ（network.json） ----
{
  const net = compileNetwork(networkJson);

  // 実データの fareCalendar.json も常に valid であること（転記ミスの早期検出）
  const calv = validateFareCalendar(fareCalendarJson, net);
  if (!calv.ok) {
    console.error("❌ fareCalendar.json が不正:");
    for (const e of calv.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

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

  // 戦略グルーピング（実データ）: 30件のフラットリストが5〜15戦略に集約される
  const groups = groupRoutes(res, net);
  assert(groups.reduce((s, g) => s + g.routes.length, 0) === res.length, "全行程がちょうど1グループに属す");
  assert(groups.length < res.length, "グループ数 < 行程数（集約されている）");
  assert(groups.length >= 5 && groups.length <= 15, `グループ数が5〜15（実際: ${groups.length}）`);
  const keys = new Set(groups.map((g) => g.key));
  assert(keys.has("flight@aoj>rentacar"), `飛行機(青森)+レンタカー がある（実際: ${[...keys].join(" / ")}）`);
  assert([...keys].some((k) => k.startsWith("flight@hkd>ferry@")), "飛行機(函館)+フェリー がある");
  assert([...keys].some((k) => k.startsWith("shinkansen")), "新幹線系の戦略がある");
  assert(keys.has("car"), "車で直行がある");
  assert(groups.find((g) => g.key === "car")!.label === "車で直行", "車で直行ラベル");
  const mains = groups.filter((g) => !g.isOther);
  assert(mains.length >= 4 && mains.length <= 10, `主要戦略（その他以外）が4〜10（実際: ${mains.length}）`);
  for (const g of groups) {
    assert(g.label.length > 0, `${g.key} にラベルがある`);
    assert(g.minFareTypical === Math.min(...g.routes.map((r) => r.fare.typical)), `${g.key} minFare 整合`);
  }
  // 復路も同様に集約され、フェリー航路キーが往路と共通（方向非依存）
  const backGroups = groupRoutes(back, net);
  assert(backGroups.length >= 5 && backGroups.length <= 15, `復路グループ数（実際: ${backGroups.length}）`);
  const ferryKeys = (gs: { key: string }[]) =>
    new Set(gs.flatMap((g) => g.key.split(">").filter((s) => s.startsWith("ferry@"))));
  const fwd = ferryKeys(groups);
  assert([...ferryKeys(backGroups)].some((k) => fwd.has(k)), "フェリー航路キーが往復で共通");

  // 出発日くらべ（実データ）: カレンダー先頭日を選択日に7日ぶん比較
  const calDates = Object.values(calv.calendar.edges)
    .flatMap((e) => Object.keys(e.byDate))
    .sort();
  assert(calDates.length > 0, "fareCalendar に日別データがある");
  const selected = calDates[0];
  const dayWin = compareWindow(selected, selected);
  const dayFares = compareDays(
    net,
    calv.calendar,
    { originId: "osaka", destId: "oma", departAfterMin: parseHM("09:00"), overrides: new Map() },
    dayWin,
  );
  assert(dayFares.length === 7, "実データでも7日ぶん");
  assert(
    dayFares.every((d) => d.fareTypical !== null && d.fareTypical > 0 && d.strategyLabel.length > 0),
    "全日で最安総額と戦略ラベルが出る",
  );
  const directDay = searchRoutes(net, {
    originId: "osaka",
    destId: "oma",
    departAfterMin: parseHM("09:00"),
    fareByDay: buildFareByDay(calv.calendar, selected, 4, new Set()),
  });
  assert(dayFares[0].fareTypical === directDay[0].fare.typical, "選択日の行が直接探索の最安と一致");
  console.log(`[daycompare] 実データ OK（${selected}〜: ${dayFares.map((d) => d.fareTypical).join("/")}円）`);

  console.log(
    `[scenario] osaka⇔oma OK（往路${res.length}件→${groups.length}戦略（主要${mains.length}） / 復路${back.length}件→${backGroups.length}戦略 / ${elapsed}ms）`,
  );
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
