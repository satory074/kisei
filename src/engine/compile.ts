// 検証済み Network を実行時表現に変換する:
// - 時刻文字列 → 分（日跨ぎ便 arr<dep は arr+1440 に正規化）
// - fare の単一値 → {low,typical,high}
// - bidirectional な anytime エッジの逆向きを実体化
// - from → エッジ一覧 の隣接インデックス構築
import type {
  CompiledEdge,
  CompiledNetwork,
  CompiledService,
  FareRange,
  FareValue,
  Network,
  NetworkEdge,
  Service,
} from "./types";
import { DAY_MIN, parseHM } from "./time";
import { validateNetwork } from "./validate";

function normalizeFare(f: FareValue): FareRange {
  return typeof f === "number" ? { low: f, typical: f, high: f } : { ...f };
}

function compileService(svc: Service): CompiledService {
  switch (svc.type) {
    case "timetable":
      return {
        type: "timetable",
        trips: svc.trips.map((t) => {
          const dep = parseHM(t.dep);
          let arr = parseHM(t.arr);
          if (arr < dep) arr += DAY_MIN; // 日跨ぎ便（夜行など）
          return { dep, arr, name: t.name };
        }),
      };
    case "frequency":
      return {
        type: "frequency",
        first: parseHM(svc.first),
        last: parseHM(svc.last),
        everyMin: svc.everyMin,
        durationMin: svc.durationMin,
      };
    case "anytime":
      return {
        type: "anytime",
        durationMin: svc.durationMin,
        window: svc.window
          ? { open: parseHM(svc.window.open), close: parseHM(svc.window.close) }
          : undefined,
      };
  }
}

function compileEdge(e: NetworkEdge, reversed: boolean): CompiledEdge {
  return {
    id: reversed ? `${e.id}@rev` : e.id,
    from: reversed ? e.to : e.from,
    to: reversed ? e.from : e.to,
    mode: e.mode,
    carrier: e.carrier,
    service: compileService(e.service),
    fare: normalizeFare(e.fare),
    costBasis: e.costBasis,
    source: e.source,
    lastUpdated: e.lastUpdated,
    notes: e.notes,
  };
}

/** 逆向き実体化エッジ（"xxx@rev"）を元エッジの id に正規化する */
export function baseEdgeId(id: string): string {
  return id.endsWith("@rev") ? id.slice(0, -"@rev".length) : id;
}

/**
 * 実価格上書き: 対象エッジ（@rev も元 id で対象）の fare を単一値に置換した
 * 新ネットワークを返す。元の net は変更しない。変動運賃（航空券・レンタカー）に
 * 予約サイトで見た実価格を入れて再探索する用途。
 */
export function applyFareOverrides(
  net: CompiledNetwork,
  overrides: ReadonlyMap<string, number>,
): CompiledNetwork {
  if (overrides.size === 0) return net;
  const edges = net.edges.map((e) => {
    const yen = overrides.get(baseEdgeId(e.id));
    return yen === undefined ? e : { ...e, fare: { low: yen, typical: yen, high: yen } };
  });
  const adjacency = new Map<string, CompiledEdge[]>();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e);
  }
  return { ...net, edges, adjacency };
}

/** 検証 → 正規化 → インデックス。検証失敗時はエラー内容を連結して throw */
export function compileNetwork(raw: unknown): CompiledNetwork {
  const v = validateNetwork(raw);
  if (!v.ok) throw new Error(`network.json が不正:\n- ${v.errors.join("\n- ")}`);
  const net: Network = v.network;

  const edges: CompiledEdge[] = [];
  for (const e of net.edges) {
    edges.push(compileEdge(e, false));
    if (e.bidirectional) edges.push(compileEdge(e, true));
  }

  const nodesById = new Map(net.nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, CompiledEdge[]>();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e);
  }

  return {
    meta: net.meta,
    nodesById,
    adjacency,
    edges,
    transfer: net.transfer,
    endpoints: net.nodes.filter((n) => n.endpoint),
  };
}
