// 出発日くらべ: 選択日±3の7日について各日の最安総額を求める純ロジック。
// DOM 無し（smoketest が直接 import する）。エンジンは Date 禁止のため
// ISO 日付の窓計算はここ（app 層）で行い、searchRoutes には日ごとの
// fareByDay を渡すだけ。探索は 0.6ms/回 程度なので 7 回ループで十分速い。
import { applyFareOverrides } from "../engine/compile";
import type { FareCalendar } from "../engine/farecal";
import { strategyLabel } from "../engine/group";
import { searchRoutes } from "../engine/search";
import type { CompiledNetwork } from "../engine/types";
import { addDaysISO, buildFareByDay, daysBetweenISO } from "./fares";

export const WINDOW_DAYS = 7;
export const WINDOW_BACK = 3;

/**
 * 比較ウィンドウ: 選択日±3の7日。過去日は今日へクランプし、前方へ伸ばして常に7日。
 * 共有URL由来の過去の選択日では選択日がウィンドウ外に出るが許容（クリックで自己修復）。
 */
export function compareWindow(selectedISO: string, todayISO: string): string[] {
  const start =
    daysBetweenISO(todayISO, selectedISO) < WINDOW_BACK ? todayISO : addDaysISO(selectedISO, -WINDOW_BACK);
  return Array.from({ length: WINDOW_DAYS }, (_, i) => addDaysISO(start, i));
}

export interface DayCompareQuery {
  originId: string;
  destId: string;
  /** 全日で同じ出発時刻（時刻は変えず日付だけ動かす） */
  departAfterMin: number;
  overrides: ReadonlyMap<string, number>;
}

export interface DayFare {
  dateISO: string;
  /** その日の最安行程の typical 総額。経路なしなら null（防御のみ。ダイヤは毎日同一） */
  fareTypical: number | null;
  /** 最安行程の戦略ラベル（例「飛行機（青森）＋レンタカー」）。fareTypical=null なら "" */
  strategyLabel: string;
  /** 総額に幅が残っているか（low !== high）。fareHtml と同じ規約 */
  isEstimate: boolean;
}

/** 各日付で検索し、最安行程の総額・戦略・確定/目安を返す。runSearch と同じ上書き・除外規約 */
export function compareDays(
  net: CompiledNetwork,
  calendar: FareCalendar,
  q: DayCompareQuery,
  dateISOs: readonly string[],
): DayFare[] {
  const activeNet = applyFareOverrides(net, new Map(q.overrides));
  const excluded = new Set(q.overrides.keys());
  return dateISOs.map((dateISO) => {
    const fareByDay = buildFareByDay(calendar, dateISO, 4, excluded);
    const results = searchRoutes(activeNet, {
      originId: q.originId,
      destId: q.destId,
      departAfterMin: q.departAfterMin,
      fareByDay: fareByDay.size > 0 ? fareByDay : undefined,
    });
    if (results.length === 0) return { dateISO, fareTypical: null, strategyLabel: "", isEstimate: false };
    const best = results[0]; // searchRoutes は typical 昇順
    return {
      dateISO,
      fareTypical: best.fare.typical,
      strategyLabel: strategyLabel([best], net),
      isEstimate: best.fare.low !== best.fare.high,
    };
  });
}
