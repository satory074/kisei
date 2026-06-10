// 戦略グルーピング。検索結果（フラットな RouteResult[]）を「どの組み合わせで行くか」
// （飛行機(青森)+レンタカー / 新幹線+鉄道・バス / 車で直行 …）の単位に束ねる純関数群。
// UIの第一画面を「30件の行程リスト」ではなく「5〜8択の戦略比較」にするための後処理レイヤで、
// 探索エンジン本体（search.ts）には手を入れない。エンジン流儀（DOM・Date禁止）を踏襲。
import type { CompiledNetwork, Mode, NetworkNode, RouteResult } from "./types";
import { MODE_META } from "./format";

/** 戦略を構成する主要モード。rail/bus/taxi/walk はアクセスレグ扱いでキーに含めない
    （アクセス手段の違いで同じ戦略が分裂するのを防ぐ） */
export const PRIMARY_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "flight",
  "shinkansen",
  "ferry",
  "car",
  "rentacar",
]);

export interface RouteGroup {
  /** 例 "flight@aoj>rentacar"。主要レグが無い経路は modeSignature にフォールバック */
  key: string;
  /** 例 "飛行機（青森）＋レンタカー" */
  label: string;
  /** 所属する行程（並び替えは app 層の責務） */
  routes: RouteResult[];
  minFareTypical: number;
  minDurationMin: number;
  earliestArriveMin: number;
  earliestDepartMin: number;
  /** 主要セグメント3つ以上の遠回り・乗継過多戦略。UIで「その他」に格下げする */
  isOther: boolean;
}

/** 主要レグを畳んだ戦略セグメント（fromId/toId は畳み込み後の端点） */
interface Segment {
  mode: Mode;
  fromId: string;
  toId: string;
}

/** 主要レグ列を抽出し、連続する同一モードを1セグメントに畳む。
    ferry は航路ごとに別戦略（青森航路 vs 大間航路）なので畳まない。 */
function primarySegments(r: RouteResult): Segment[] {
  const segs: Segment[] = [];
  for (const l of r.legs) {
    if (!PRIMARY_MODES.has(l.edge.mode)) continue;
    const prev = segs[segs.length - 1];
    if (prev && prev.mode === l.edge.mode && l.edge.mode !== "ferry") {
      prev.toId = l.edge.to; // 新幹線の乗継・車の途中休憩などを1セグメントへ
    } else {
      segs.push({ mode: l.edge.mode, fromId: l.edge.from, toId: l.edge.to });
    }
  }
  return segs;
}

/** 経路の起終点（検索の origin/dest と一致する） */
function endpointsOf(r: RouteResult): { originId: string; destId: string } {
  return { originId: r.legs[0].edge.from, destId: r.legs[r.legs.length - 1].edge.to };
}

/** 空港ノードが「起終点都市の市内アクセス」かどうか。
    該当する側は戦略の経由地として情報量が無い（大阪の人にとって伊丹/関西/神戸の違いは
    戦略ではなくアクセスの違い）ので、キー・ラベルから落とす。 */
function isHomeSide(node: NetworkNode | undefined, originId: string, destId: string): boolean {
  if (!node) return false;
  if (node.id === originId || node.id === destId) return true;
  return node.cityOf === originId || node.cityOf === destId;
}

/** flight セグメントの経由地ノードid列（ホーム側を除外、from→to 順） */
function flightVias(seg: Segment, r: RouteResult, net: CompiledNetwork): string[] {
  const { originId, destId } = endpointsOf(r);
  return [seg.fromId, seg.toId].filter((id) => !isHomeSide(net.nodesById.get(id), originId, destId));
}

function segmentKey(seg: Segment, r: RouteResult, net: CompiledNetwork): string {
  if (seg.mode === "flight") {
    const vias = flightVias(seg, r, net);
    return vias.length ? `flight@${vias.join("~")}` : "flight";
  }
  if (seg.mode === "ferry") {
    // 航路はソート済みペア＝方向非依存（往路と復路で同じ戦略キーになる）
    return `ferry@${[seg.fromId, seg.toId].sort().join("~")}`;
  }
  return seg.mode;
}

/** 経路の戦略キー。同じキー = 同じ「行き方」、UIで1カードに束ねる単位 */
export function strategyKey(r: RouteResult, net: CompiledNetwork): string {
  const segs = primarySegments(r);
  if (segs.length === 0) return r.modeSignature; // アクセスモードのみの経路（汎用データ対策）
  return segs.map((s) => segmentKey(s, r, net)).join(">");
}

function shortNameOf(net: CompiledNetwork, nodeId: string): string {
  const n = net.nodesById.get(nodeId);
  return n?.shortName ?? n?.name ?? nodeId;
}

/** 最終主要レグの後に続く公共交通ラストマイル（rail/bus）のラベル。
    taxi/walk は端数アクセスなのでラベルに出さない。グループ内全行程の和集合・固定順で決定的。 */
function trailingAccessLabel(routes: readonly RouteResult[]): string {
  const found = new Set<Mode>();
  for (const r of routes) {
    let lastPrimary = -1;
    for (let i = 0; i < r.legs.length; i++) {
      if (PRIMARY_MODES.has(r.legs[i].edge.mode)) lastPrimary = i;
    }
    for (let i = lastPrimary + 1; i < r.legs.length; i++) {
      const m = r.legs[i].edge.mode;
      if (m === "rail" || m === "bus") found.add(m);
    }
  }
  const parts: string[] = [];
  if (found.has("rail")) parts.push(MODE_META.rail.label);
  if (found.has("bus")) parts.push(MODE_META.bus.label);
  return parts.length ? `＋${parts.join("・")}` : "";
}

/** グループの日本語ラベル。routes は同一 strategyKey であること */
export function strategyLabel(routes: readonly RouteResult[], net: CompiledNetwork): string {
  const rep = routes[0];
  const segs = primarySegments(rep);
  if (segs.length === 0) {
    // フォールバック: モードラベルを連結
    return rep.legs.map((l) => MODE_META[l.edge.mode].label).join("＋");
  }
  if (segs.length === 1 && segs[0].mode === "car") return "車で直行";

  const parts = segs.map((seg) => {
    const base = MODE_META[seg.mode].label;
    if (seg.mode === "flight") {
      const vias = flightVias(seg, rep, net);
      return vias.length ? `${base}（${vias.map((id) => shortNameOf(net, id)).join("〜")}）` : base;
    }
    if (seg.mode === "ferry") {
      // 表示は実際の進行方向（from→to）。キーは方向非依存だが同一検索内では方向が揃う
      return `${base}（${shortNameOf(net, seg.fromId)}〜${shortNameOf(net, seg.toId)}）`;
    }
    return base;
  });
  return parts.join("＋") + trailingAccessLabel(routes);
}

/** 行程の平文経由サマリー（例 "伊丹空港 → 青森空港"）。
    主要レグの端点ノード名を起終点を除いて並べる。絵文字チェーンに代わる経路識別子。 */
export function viaSummary(r: RouteResult, net: CompiledNetwork): string {
  const { originId, destId } = endpointsOf(r);
  const ids: string[] = [];
  const push = (id: string) => {
    if (id === originId || id === destId) return;
    if (ids[ids.length - 1] === id) return; // 連続重複（乗継点）を畳む
    ids.push(id);
  };
  // 畳み込み前の主要レグ単位で列挙する（新幹線乗継の東京駅などの乗継点を見せたい）
  const primary = r.legs.filter((l) => PRIMARY_MODES.has(l.edge.mode));
  for (const l of primary.length > 0 ? primary : r.legs) {
    push(l.edge.from);
    push(l.edge.to);
  }
  return ids.map((id) => net.nodesById.get(id)?.name ?? id).join(" → ");
}

/** 再描画時の open 状態復元・DOM上の行程識別に使う安定id */
export function routeId(r: RouteResult): string {
  return r.legs.map((l) => `${l.edge.id}@${l.depMin}`).join("|");
}

/** 検索結果を戦略グループへ分割する。全行程がちょうど1グループに属する。
    返り順は typical 最安 →（同額なら）早着（app 層の sortGroups が並び替える前の既定） */
export function groupRoutes(results: readonly RouteResult[], net: CompiledNetwork): RouteGroup[] {
  const byKey = new Map<string, { routes: RouteResult[]; segCount: number }>();
  for (const r of results) {
    const key = strategyKey(r, net);
    const cur = byKey.get(key);
    if (cur) cur.routes.push(r);
    else byKey.set(key, { routes: [r], segCount: primarySegments(r).length });
  }
  const groups: RouteGroup[] = [];
  for (const [key, { routes, segCount }] of byKey) {
    groups.push({
      key,
      label: strategyLabel(routes, net),
      routes,
      minFareTypical: Math.min(...routes.map((r) => r.fare.typical)),
      minDurationMin: Math.min(...routes.map((r) => r.durationMin)),
      earliestArriveMin: Math.min(...routes.map((r) => r.arriveMin)),
      earliestDepartMin: Math.min(...routes.map((r) => r.departMin)),
      isOther: segCount >= 3,
    });
  }
  return groups.sort(
    (a, b) => a.minFareTypical - b.minFareTypical || a.earliestArriveMin - b.earliestArriveMin,
  );
}
