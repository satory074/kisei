// 損益分岐（break-even）計算。変動運賃モード（飛行機・レンタカー）は時刻表こそ
// 安定しているが価格が数倍動くため、typical 順位だけでは経路を確定できない。
// そこで「固定運賃のみで行ける最安経路」を基準線に、変動レッグの実価格合計が
// いくらまでならその経路が基準より安いか（許容上限額）を出す。意思決定が
// 「予約サイトで実価格が上限を下回るか確認するだけ」に還元される。
import type { FareRange, Mode, RouteResult } from "./types";
import { fmtYen } from "./format";

/** 時刻表は安定だが価格が大きく変動するモード */
export const VOLATILE_MODES: ReadonlySet<Mode> = new Set<Mode>(["flight", "rentacar"]);

/** 損益分岐の平文で使う変動モードの日本語名 */
const VOLATILE_LABELS: Partial<Record<Mode, string>> = { flight: "航空券", rentacar: "レンタカー" };

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

/**
 * 損益分岐の日本語平文。「✈️🚗の実価格合計が¥◯以下なら基準より安い」のような
 * 記号混じり表示は初見で解読できない、というフィードバックを受けて文章で説明する。
 * baselineLabel は baseline 経路の戦略ラベル（例「新幹線＋鉄道・バス」）。
 * 変動レッグの無い経路（=基準側）は null。
 */
export function describeBreakEven(
  r: RouteResult,
  baseline: RouteResult,
  baselineLabel: string,
): string | null {
  if (!hasVolatileLeg(r)) return null;
  const v = volatileFare(r);
  const volatileLegs = r.legs.filter((l) => VOLATILE_MODES.has(l.edge.mode));
  const modes = [...new Set(volatileLegs.map((l) => l.edge.mode))];
  const label = modes.map((m) => VOLATILE_LABELS[m] ?? m).join("と");
  const base = `「${baselineLabel}」（${fmtYen(baseline.fare.typical)}）`;

  // 実価格・確定価格が入っていて幅が無い → 差額を確定表示
  if (v.low === v.high) {
    const diff = r.fare.typical - baseline.fare.typical;
    if (diff < 0) return `この価格なら ${base} より ${fmtYen(-diff)} 安くなります`;
    if (diff > 0) return `この価格だと ${base} より ${fmtYen(diff)} 高くなります`;
    return `この価格だと ${base} と同額です`;
  }

  const t = breakEvenThreshold(r, baseline);
  if (t >= v.high) return `${label}が繁忙期価格でも ${base} より安く済む見込みです`;
  if (t < v.low)
    return `${label}を最安（計${fmtYen(v.low)}）で取れても ${base} より高くなります（時間を優先する行き方です）`;
  const subject = volatileLegs.length > 1 ? `${label}の合計を` : `${label}を`;
  return `${subject} ${fmtYen(t)} 以下で取れれば ${base} より安くなります`;
}
