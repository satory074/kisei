// 料金入力グリッド: ユーザーが「日別×変動レグ」の実勢価格を手入力した上書き表。
// localStorage に「自分の価格調査メモ」として永続化する（URL には載せない＝検索クエリの
// 共有を汚さない）。純粋なパース/直列化/検証/更新のみここに置き、localStorage への
// 読み書きは app/main.ts が担う（副作用の分離）。
// データ形: edgeId(baseEdgeId) → (ISO日付 → 円)。engine の fareByDay と同じ粒度なので、
// fares.ts:buildFareByDay にそのまま重ねて「日別カレンダーJSONより優先」で解決できる。

/** edgeId(baseEdgeId) → (ISO日付 → 円) */
export type DayFareGrid = Map<string, Map<string, number>>;

export const DAY_GRID_STORAGE_KEY = "kisei.dayFareGrid.v1";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_YEN = 9_999_999;

/** localStorage 用のプレーンオブジェクトへ（空エッジは落とす） */
export function serializeDayGrid(grid: DayFareGrid): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [edgeId, byDate] of grid) {
    if (byDate.size === 0) continue;
    out[edgeId] = Object.fromEntries(byDate);
  }
  return out;
}

/**
 * localStorage から復元。未知エッジ・不正日付・非正整数・範囲外は捨てる
 * （壊れた保存値や旧バージョンに強い）。validEdgeIds は現ネットワークの変動エッジ集合。
 */
export function parseDayGrid(raw: unknown, validEdgeIds: ReadonlySet<string>): DayFareGrid {
  const grid: DayFareGrid = new Map();
  if (typeof raw !== "object" || raw === null) return grid;
  for (const [edgeId, byDate] of Object.entries(raw as Record<string, unknown>)) {
    if (!validEdgeIds.has(edgeId) || typeof byDate !== "object" || byDate === null) continue;
    const m = new Map<string, number>();
    for (const [date, yen] of Object.entries(byDate as Record<string, unknown>)) {
      if (ISO_DATE.test(date) && typeof yen === "number" && Number.isInteger(yen) && yen > 0 && yen <= MAX_YEN)
        m.set(date, yen);
    }
    if (m.size > 0) grid.set(edgeId, m);
  }
  return grid;
}

/** セル更新（yen=null で削除）。grid を直接変更して返す。空になったエッジは消す */
export function setDayFare(grid: DayFareGrid, edgeId: string, date: string, yen: number | null): DayFareGrid {
  if (yen === null) {
    const m = grid.get(edgeId);
    if (m) {
      m.delete(date);
      if (m.size === 0) grid.delete(edgeId);
    }
  } else {
    let m = grid.get(edgeId);
    if (!m) {
      m = new Map();
      grid.set(edgeId, m);
    }
    m.set(date, yen);
  }
  return grid;
}

/** グリッドに入力されているセルの総数 */
export function dayGridSize(grid: DayFareGrid): number {
  let n = 0;
  for (const m of grid.values()) n += m.size;
  return n;
}
