// 表示用整形（純関数）。render と テストの両方から使う。
import type { FareRange, Mode } from "./types";

export function fmtYen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}

/** 幅があれば "¥12,000〜¥35,000"、単一値なら "¥4,000" */
export function fmtYenRange(f: FareRange): string {
  if (f.low === f.high) return fmtYen(f.typical);
  return `${fmtYen(f.low)}〜${fmtYen(f.high)}`;
}

export const MODE_META: Record<Mode, { icon: string; label: string }> = {
  flight: { icon: "✈️", label: "飛行機" },
  shinkansen: { icon: "🚄", label: "新幹線" },
  rail: { icon: "🚃", label: "鉄道" },
  ferry: { icon: "⛴️", label: "フェリー" },
  bus: { icon: "🚌", label: "バス" },
  car: { icon: "🚗", label: "車" },
  rentacar: { icon: "🚙", label: "レンタカー" },
  taxi: { icon: "🚕", label: "タクシー" },
  walk: { icon: "🚶", label: "徒歩" },
};
