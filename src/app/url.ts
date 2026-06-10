// 検索条件 ⇔ クエリ文字列の相互変換（純関数。DOM・location は触らない）。
// 共有URL: ?from=osaka&to=oma&date=2026-08-12&time=09:00&sort=cheapest&fares=flight-itm-aoj:18000
export type SortKey = "cheapest" | "fastest" | "departure";

export const SORT_KEYS: readonly SortKey[] = ["cheapest", "fastest", "departure"];

/** fares の1ペア "エッジid:円"。id は network.json の命名（小文字英数とハイフン） */
const FARE_PAIR_RE = /^([a-z0-9-]+):(\d{1,7})$/;

export interface QueryState {
  from: string;
  to: string;
  /** "YYYY-MM-DD"（表示・共有用。エンジンは日付非依存） */
  date: string;
  /** "HH:MM" */
  time: string;
  sort: SortKey;
  /** 実価格上書き（エッジid → 円）。空なら省略 */
  fares?: Record<string, number>;
}

export function encodeQuery(s: QueryState): string {
  const p = new URLSearchParams();
  p.set("from", s.from);
  p.set("to", s.to);
  p.set("date", s.date);
  p.set("time", s.time);
  p.set("sort", s.sort);
  const pairs = Object.entries(s.fares ?? {})
    .filter(([id, yen]) => FARE_PAIR_RE.test(`${id}:${yen}`))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, yen]) => `${id}:${yen}`);
  if (pairs.length > 0) p.set("fares", pairs.join(","));
  return `?${p.toString()}`;
}

export function decodeQuery(search: string): Partial<QueryState> {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: Partial<QueryState> = {};
  const from = p.get("from");
  const to = p.get("to");
  const date = p.get("date");
  const time = p.get("time");
  const sort = p.get("sort");
  if (from) out.from = from;
  if (to) out.to = to;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date;
  if (time && /^\d{2}:\d{2}$/.test(time)) out.time = time;
  if (sort && (SORT_KEYS as readonly string[]).includes(sort)) out.sort = sort as SortKey;
  const fares = p.get("fares");
  if (fares) {
    const parsed: Record<string, number> = {};
    for (const pair of fares.split(",")) {
      const m = FARE_PAIR_RE.exec(pair);
      if (m) parsed[m[1]] = Number(m[2]);
    }
    if (Object.keys(parsed).length > 0) out.fares = parsed;
  }
  return out;
}
