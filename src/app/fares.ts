// 日別料金カレンダーの app 層ヘルパー。エンジンは Date 禁止なので、
// 「出発日からの dayOffset → ISO日付 → 価格」の解決はここで済ませて
// searchRoutes には fareByDay（dayOffset 添字の配列）の形で渡す。
import type { FareCalendar } from "../engine/farecal";

/** "YYYY-MM-DD" に日数を足す（UTC基準でうるう年も正しく繰り上がる） */
export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** b - a の日数差 */
export function daysBetweenISO(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "2026-08-12" → "8/12"（カード上の短い日付表示） */
export function fmtDateShort(dateISO: string): string {
  const [, m, d] = dateISO.split("-").map(Number);
  return `${m}/${d}`;
}

/** "YYYY-MM-DD" → 曜日番号 0(日)〜6(土)。UTC基準（日付のみなのでTZ非依存） */
export function weekdayISO(dateISO: string): number {
  return new Date(`${dateISO}T00:00:00Z`).getUTCDay();
}

/**
 * カレンダーを「エッジid → dayOffset(0=出発日) 添字の価格配列」へ解決する。
 * 優先順位: ユーザー日別手入力(userByDate) ＞ 日別カレンダーJSON ＞ 幅(load側のフォールバック)。
 * `excludeEdgeIds`（全日共通の実価格上書き済みエッジ）はカレンダーJSONを抑止する
 * ＝そのエッジは applyFareOverrides 済みの単一値を使う。ただし**その日に手入力があれば
 * 日別手入力が勝つ**（日別 ＞ 全日共通 ＞ カレンダー ＞ 幅）。手入力もカレンダーも無い
 * 全日上書きエッジは従来どおり載せない（＝上書き値へフォールバック）。
 * 値が1つも無いエッジは載せない。
 */
export function buildFareByDay(
  cal: FareCalendar,
  baseDateISO: string,
  days: number,
  excludeEdgeIds: ReadonlySet<string>,
  userByDate?: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, (number | null)[]> {
  const map = new Map<string, (number | null)[]>();
  const edgeIds = new Set<string>([...Object.keys(cal.edges), ...(userByDate ? userByDate.keys() : [])]);
  for (const edgeId of edgeIds) {
    const userE = userByDate?.get(edgeId);
    const calE = excludeEdgeIds.has(edgeId) ? undefined : cal.edges[edgeId];
    const arr = Array.from({ length: days }, (_, i) => {
      const date = addDaysISO(baseDateISO, i);
      return userE?.get(date) ?? calE?.byDate[date] ?? null;
    });
    if (arr.some((v) => v !== null)) map.set(edgeId, arr);
  }
  return map;
}
