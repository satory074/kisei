// ネットワークデータ（network.json）とエンジンが共有する型定義。
// エンジン全体の時刻表現は「出発日0時からの経過分（整数、JST暗黙）」。Date は使わない。

export type NodeKind = "city" | "station" | "airport" | "port" | "poi";

export type Mode =
  | "flight"
  | "shinkansen"
  | "rail"
  | "ferry"
  | "bus"
  | "car"
  | "rentacar"
  | "taxi"
  | "walk";

export interface NetworkNode {
  id: string;
  name: string;
  kind: NodeKind;
  region: string;
  /** 出発地/到着地セレクトに出すか */
  endpoint?: boolean;
  /** kind デフォルトの乗換時間を上書き（分） */
  transferMin?: number;
  /** 戦略ラベル用の短縮名（例 aoj→"青森"）。無ければ name を使う */
  shortName?: string;
  /** この空港/港が市内アクセス扱いになる都市ノードid。
      検索の起終点と一致する側の空港は戦略キーの経由地から除外される（kix/itm/ukb→osaka 等） */
  cityOf?: string;
}

/** 単一値は {low, typical, high} すべて同値の省略記法 */
export type FareValue = number | FareRange;

export interface FareRange {
  low: number;
  typical: number;
  high: number;
}

/** "HH:MM"。日跨ぎ便は "25:30" のような24時超表記も可 */
export type HM = string;

export type Service =
  | { type: "timetable"; trips: { dep: HM; arr: HM; name?: string }[] }
  | { type: "frequency"; first: HM; last: HM; everyMin: number; durationMin: number }
  | { type: "anytime"; durationMin: number; window?: { open: HM; close: HM } };

export interface NetworkEdge {
  id: string;
  from: string;
  to: string;
  mode: Mode;
  carrier?: string;
  service: Service;
  /** 円。航空券など変動運賃は low/typical/high で幅を持たせる */
  fare: FareValue;
  /** person=1人あたり / vehicle=1台あたり（車・レンタカー） */
  costBasis: "person" | "vehicle";
  /** anytime サービスのみ許可。逆向きエッジを自動生成する */
  bidirectional?: boolean;
  /** 出典URL（必須） */
  source: string;
  /** データ確認日 "YYYY-MM-DD"（必須） */
  lastUpdated: string;
  notes?: string;
}

export interface TransferConfig {
  /** ノード種別ごとの乗換（移動・迷い）時間の既定値（分） */
  defaultMin: Record<NodeKind, number>;
  /** モードごとの乗り込みリードタイム（分）。航空=チェックイン等 */
  boardingLeadMin: Record<Mode, number>;
}

export interface NetworkMeta {
  title: string;
  dataLastUpdated: string;
  disclaimer: string;
}

export interface Network {
  meta: NetworkMeta;
  transfer: TransferConfig;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

// ---- コンパイル済み（実行時）表現 ----

export type CompiledService =
  | { type: "timetable"; trips: { dep: number; arr: number; name?: string }[] }
  | { type: "frequency"; first: number; last: number; everyMin: number; durationMin: number }
  | { type: "anytime"; durationMin: number; window?: { open: number; close: number } };

export interface CompiledEdge {
  id: string;
  from: string;
  to: string;
  mode: Mode;
  carrier?: string;
  service: CompiledService;
  fare: FareRange;
  costBasis: "person" | "vehicle";
  source: string;
  lastUpdated: string;
  notes?: string;
}

export interface CompiledNetwork {
  meta: NetworkMeta;
  nodesById: Map<string, NetworkNode>;
  /** from ノードID → 出るエッジ一覧 */
  adjacency: Map<string, CompiledEdge[]>;
  edges: CompiledEdge[];
  transfer: TransferConfig;
  /** endpoint: true のノード（UIセレクト用） */
  endpoints: NetworkNode[];
}

// ---- 探索結果 ----

export interface Leg {
  edge: CompiledEdge;
  /** 出発・到着（出発日0時からの分） */
  depMin: number;
  arrMin: number;
  /** このレグの乗車前の待ち時間（乗換+待ち合わせ。初レグは出発指定時刻からの待ち） */
  waitMin: number;
  tripName?: string;
  /** 日別料金カレンダーで解決した「この出発日の価格」。あれば fare 集計はこちらを使う */
  calendarFare?: number;
}

export interface RouteResult {
  legs: Leg[];
  departMin: number;
  arriveMin: number;
  durationMin: number;
  fare: FareRange;
  transfers: number;
  /** 例 "flight>taxi>ferry" — モード構成の識別キー */
  modeSignature: string;
  /** (arriveMin, fare.typical) でパレート最適か */
  isPareto: boolean;
}

export interface SearchOptions {
  maxLegs: number;
  maxTotalMin: number;
  maxWaitMin: number;
  maxResults: number;
}

export interface SearchQuery {
  originId: string;
  destId: string;
  /** この時刻以降に出発（出発日0時からの分） */
  departAfterMin: number;
  /**
   * 日別料金カレンダー: 元エッジid → dayOffset(0=出発日) 添字の確定価格。
   * null/範囲外は edge.fare の幅へフォールバック。エンジンは Date を持たないため、
   * ISO日付 → dayOffset の解決は app 層（src/app/fares.ts）が済ませて渡す。
   */
  fareByDay?: ReadonlyMap<string, readonly (number | null)[]>;
  opts?: Partial<SearchOptions>;
}
