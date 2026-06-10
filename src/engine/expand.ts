// サービス定義から「notBefore 以降の最初の出発」を求める。
// frequency は仮想便をリスト化せず、その場で1便だけ計算する（爆発の構造的回避）。
// 日跨ぎ（終便を逃したら翌日、"25:30" 表記）のロジックはすべてこのモジュールに集約する。
import type { CompiledService } from "./types";
import { DAY_MIN } from "./time";

export interface Departure {
  dep: number;
  arr: number;
  tripName?: string;
}

/**
 * notBefore（絶対分）以降で最初に乗れる便を返す。maxDay（0始まりの日番号）まで探して無ければ null。
 * 注意: "25:30" のような24時超表記の便は前日の時刻表に属するため、走査は前日から始める。
 */
export function nextDeparture(
  svc: CompiledService,
  notBefore: number,
  maxDay: number,
): Departure | null {
  if (svc.type === "anytime" && !svc.window) {
    // いつでも出発可（車・タクシー・徒歩）。待ちゼロ。
    return { dep: notBefore, arr: notBefore + svc.durationMin };
  }

  const startDay = Math.max(0, Math.floor(notBefore / DAY_MIN) - 1);
  for (let d = startDay; d <= maxDay; d++) {
    const base = d * DAY_MIN;
    switch (svc.type) {
      case "timetable": {
        // trips は dep 昇順（validate 済み）
        for (const t of svc.trips) {
          const dep = base + t.dep;
          if (dep >= notBefore) return { dep, arr: base + t.arr, tripName: t.name };
        }
        break;
      }
      case "frequency": {
        const first = base + svc.first;
        const last = base + svc.last;
        // first 以降、everyMin 間隔の格子に切り上げ
        const k = Math.max(0, Math.ceil((notBefore - first) / svc.everyMin));
        const dep = first + k * svc.everyMin;
        if (dep <= last) return { dep, arr: dep + svc.durationMin };
        break;
      }
      case "anytime": {
        // window あり（レンタカー営業時間など）
        const open = base + svc.window!.open;
        const close = base + svc.window!.close;
        const dep = Math.max(notBefore, open);
        if (dep <= close) return { dep, arr: dep + svc.durationMin };
        break;
      }
    }
  }
  return null;
}
