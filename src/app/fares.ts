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

/**
 * カレンダーを「エッジid → dayOffset(0=出発日) 添字の価格配列」へ解決する。
 * 実価格上書き済みのエッジは除外（優先順位: 実価格 ＞ 日別テーブル ＞ 幅）。
 * 値が1つも無いエッジは載せない。
 */
export function buildFareByDay(
  cal: FareCalendar,
  baseDateISO: string,
  days: number,
  excludeEdgeIds: ReadonlySet<string>,
): Map<string, (number | null)[]> {
  const map = new Map<string, (number | null)[]>();
  for (const [edgeId, entry] of Object.entries(cal.edges)) {
    if (excludeEdgeIds.has(edgeId)) continue;
    const arr = Array.from({ length: days }, (_, i) => entry.byDate[addDaysISO(baseDateISO, i)] ?? null);
    if (arr.some((v) => v !== null)) map.set(edgeId, arr);
  }
  return map;
}
