// (到着時刻, typical運賃) の2目的のパレート判定。
// 「どちらかを悪化させずにもう一方を改善できない」経路だけが最適。
import type { RouteResult } from "./types";

/** a が b を支配する（両方で同等以上、少なくとも一方で厳密に良い） */
export function dominates(a: RouteResult, b: RouteResult): boolean {
  return (
    a.arriveMin <= b.arriveMin &&
    a.fare.typical <= b.fare.typical &&
    (a.arriveMin < b.arriveMin || a.fare.typical < b.fare.typical)
  );
}

/** 各結果の isPareto を更新する（破壊的） */
export function markPareto(results: RouteResult[]): void {
  for (const r of results) {
    r.isPareto = !results.some((other) => other !== r && dominates(other, r));
  }
}
