// 損益分岐（break-even）計算。変動運賃モード（飛行機・レンタカー）は時刻表こそ
// 安定しているが価格が数倍動くため、typical 順位だけでは経路を確定できない。
// そこで「固定運賃のみで行ける最安経路」を基準線に、変動レッグの実価格合計が
// いくらまでならその経路が基準より安いか（許容上限額）を出す。意思決定が
// 「予約サイトで実価格が上限を下回るか確認するだけ」に還元される。
import type { FareRange, Mode, RouteResult } from "./types";

/** 時刻表は安定だが価格が大きく変動するモード */
export const VOLATILE_MODES: ReadonlySet<Mode> = new Set<Mode>(["flight", "rentacar"]);

export function hasVolatileLeg(r: RouteResult): boolean {
  return r.legs.some((l) => VOLATILE_MODES.has(l.edge.mode));
}

/** 変動レッグの運賃合計（変動レッグが無ければすべて0） */
export function volatileFare(r: RouteResult): FareRange {
  let low = 0;
  let typical = 0;
  let high = 0;
  for (const l of r.legs) {
    if (!VOLATILE_MODES.has(l.edge.mode)) continue;
    low += l.edge.fare.low;
    typical += l.edge.fare.typical;
    high += l.edge.fare.high;
  }
  return { low, typical, high };
}

/** 変動モードを含まない経路のうち typical 最安（同額なら早着）。無ければ null */
export function findBaseline(routes: readonly RouteResult[]): RouteResult | null {
  let best: RouteResult | null = null;
  for (const r of routes) {
    if (hasVolatileLeg(r)) continue;
    if (
      !best ||
      r.fare.typical < best.fare.typical ||
      (r.fare.typical === best.fare.typical && r.arriveMin < best.arriveMin)
    ) {
      best = r;
    }
  }
  return best;
}

/** r の変動レッグの実価格合計がこの額以下なら baseline より安い（固定レッグは typical 評価） */
export function breakEvenThreshold(r: RouteResult, baseline: RouteResult): number {
  const fixedTypical = r.fare.typical - volatileFare(r).typical;
  return baseline.fare.typical - fixedTypical;
}
