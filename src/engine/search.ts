// 経路探索の本体。手動整備の小規模グラフ（数十ノード/百数十エッジ）前提の
// DFS 全列挙 + 枝刈り。結果は「パレート集合 ∪ モード構成ごとのベスト」。
//
// 【不変条件】エッジごとに「乗れる最初の便」だけを分岐させる。
// 運賃がエッジ単位（便単位ではない）なので、同じ経路プレフィックスに対して
// 最早便は後続のどの便も支配する（同コストで到着が早いか同じ）。
// 便ごとに運賃が違うデータ（早特など）を入れたくなったら、エッジを分割すること。
import type {
  CompiledEdge,
  CompiledNetwork,
  FareRange,
  Leg,
  RouteResult,
  SearchOptions,
  SearchQuery,
} from "./types";
import { DAY_MIN } from "./time";
import { nextDeparture } from "./expand";
import { markPareto } from "./pareto";

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  // 大阪→(新幹線2本)→八戸→青い森→大湊線→バス→大間 で6レグ+市内アクセス1
  maxLegs: 7,
  maxTotalMin: 48 * 60, // 出発指定時刻から48時間で打ち切り
  // 乗換1回あたりの最大待ち。1日2便の大間フェリーでは「夕方着→翌朝便」の
  // 夜越え待ち（~16時間）が正規の旅程なので18時間まで許容する。
  // 各エッジは最早便しか取らないため、これを緩めても探索は爆発しない。
  maxWaitMin: 18 * 60,
  maxResults: 30,
};

interface FrontierEntry {
  arr: number;
  cost: number;
}

export function searchRoutes(net: CompiledNetwork, q: SearchQuery): RouteResult[] {
  const opts: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, ...q.opts };
  if (!net.nodesById.has(q.originId)) throw new Error(`出発地が不明: ${q.originId}`);
  if (!net.nodesById.has(q.destId)) throw new Error(`到着地が不明: ${q.destId}`);

  const maxDay = Math.ceil((q.departAfterMin + opts.maxTotalMin) / DAY_MIN);
  const results: RouteResult[] = [];

  // (ノード, ここまでのモード構成) 別の (到着時刻, typical累積運賃) 非支配フロンティア。
  // 指数爆発の主ガード。同値含む支配（arr'≤arr かつ cost'≤cost）で刈る。
  // キーをノード単体にすると「車は遅くて高いが見たい」というモード代表（best-per-signature）
  // が中間ノードで刈られてしまうため、モード構成ごとに分けて多様性を守る。
  const frontier = new Map<string, FrontierEntry[]>();
  const isDominatedAt = (key: string, arr: number, cost: number): boolean =>
    (frontier.get(key) ?? []).some((f) => f.arr <= arr && f.cost <= cost);
  const addToFrontier = (key: string, arr: number, cost: number): void => {
    const kept = (frontier.get(key) ?? []).filter((f) => !(arr <= f.arr && cost <= f.cost));
    kept.push({ arr, cost });
    frontier.set(key, kept);
  };

  const transferMinAt = (nodeId: string): number => {
    const node = net.nodesById.get(nodeId)!;
    return node.transferMin ?? net.transfer.defaultMin[node.kind];
  };

  const legs: Leg[] = [];
  const visited = new Set<string>([q.originId]);

  const record = (): void => {
    const first = legs[0];
    const last = legs[legs.length - 1];
    let low = 0;
    let typical = 0;
    let high = 0;
    for (const l of legs) {
      // v1 は1人旅前提: vehicle 単価もそのまま加算（README に明記）
      low += l.edge.fare.low;
      typical += l.edge.fare.typical;
      high += l.edge.fare.high;
    }
    results.push({
      legs: legs.map((l) => ({ ...l })),
      departMin: first.depMin,
      arriveMin: last.arrMin,
      durationMin: last.arrMin - first.depMin,
      fare: { low, typical, high },
      transfers: legs.length - 1,
      modeSignature: legs.map((l) => l.edge.mode).join(">"),
      isPareto: false,
    });
  };

  const dfs = (nodeId: string, arrivedAt: number, costTypical: number, sigSoFar: string): void => {
    if (nodeId === q.destId) {
      record();
      return; // 目的地に着いたら先へは延ばさない
    }
    if (legs.length >= opts.maxLegs) return;

    for (const edge of net.adjacency.get(nodeId) ?? []) {
      if (visited.has(edge.to)) continue;

      const isFirstLeg = legs.length === 0;
      // 乗車可能時刻 = 到着 + 乗換移動（初レグは現地に居るので不要） + モード別乗り込みリード
      const earliest =
        arrivedAt + (isFirstLeg ? 0 : transferMinAt(nodeId)) + net.transfer.boardingLeadMin[edge.mode];
      const d = nextDeparture(edge.service, earliest, maxDay);
      if (!d) continue;

      const waitMin = d.dep - arrivedAt;
      // 初レグの待ちは「家を遅く出ればいい」だけなので上限をかけない（例: 22時検索→翌朝の初便）
      if (!isFirstLeg && waitMin > opts.maxWaitMin) continue;
      if (d.arr - q.departAfterMin > opts.maxTotalMin) continue;

      const nextCost = costTypical + edge.fare.typical;
      const nextSig = sigSoFar ? `${sigSoFar}>${edge.mode}` : edge.mode;
      const frontierKey = `${edge.to}|${nextSig}`;
      if (isDominatedAt(frontierKey, d.arr, nextCost)) continue;
      addToFrontier(frontierKey, d.arr, nextCost);

      visited.add(edge.to);
      legs.push({ edge, depMin: d.dep, arrMin: d.arr, waitMin, tripName: d.tripName });
      dfs(edge.to, d.arr, nextCost, nextSig);
      legs.pop();
      visited.delete(edge.to);
    }
  };

  dfs(q.originId, q.departAfterMin, 0, "");

  markPareto(results);

  // パレート集合 ∪ モード構成ごとのベスト（typical 最安、同額なら早着）。
  // 純パレートだと2〜3件に潰れ「車ならいくら？」の比較ができないため、
  // 支配されていてもモード構成の代表は1件残す。
  const bestBySignature = new Map<string, RouteResult>();
  for (const r of results) {
    const cur = bestBySignature.get(r.modeSignature);
    if (
      !cur ||
      r.fare.typical < cur.fare.typical ||
      (r.fare.typical === cur.fare.typical && r.arriveMin < cur.arriveMin)
    ) {
      bestBySignature.set(r.modeSignature, r);
    }
  }
  const keep = new Set<RouteResult>(bestBySignature.values());
  for (const r of results) if (r.isPareto) keep.add(r);

  return [...keep]
    .sort((a, b) => a.fare.typical - b.fare.typical || a.arriveMin - b.arriveMin)
    .slice(0, opts.maxResults);
}
