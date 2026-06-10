// 検索条件 ⇔ クエリ文字列の相互変換（純関数。DOM・location は触らない）。
// 共有URL: ?from=osaka&to=oma&date=2026-08-12&time=09:00&sort=cheapest
export type SortKey = "cheapest" | "fastest" | "departure";

export const SORT_KEYS: readonly SortKey[] = ["cheapest", "fastest", "departure"];

export interface QueryState {
  from: string;
  to: string;
  /** "YYYY-MM-DD"（表示・共有用。エンジンは日付非依存） */
  date: string;
  /** "HH:MM" */
  time: string;
  sort: SortKey;
}

export function encodeQuery(s: QueryState): string {
  const p = new URLSearchParams();
  p.set("from", s.from);
  p.set("to", s.to);
  p.set("date", s.date);
  p.set("time", s.time);
  p.set("sort", s.sort);
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
  return out;
}
