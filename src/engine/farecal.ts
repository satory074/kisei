// 日別料金カレンダー。航空券など変動運賃エッジの「特定日の実勢価格」を手動転記した
// スナップショット（src/data/fareCalendar.json）の型・検証・参照。
// network.json が「構造の真実」なのに対し、こちらは転記頻度の高い「価格の真実」なので
// ファイルを分離している。エンジン流儀（DOM・Date禁止。日付はISO文字列の同値比較のみ）。
import type { CompiledEdge } from "./types";
import { VOLATILE_MODES } from "./breakeven";
import { baseEdgeId } from "./compile";

export interface FareCalendarEdge {
  /** 転記日 "YYYY-MM-DD"。鮮度表示と陳腐化警告に使う */
  fetchedAt: string;
  /** 転記元URL（ソラハピ最安値カレンダー等） */
  source: string;
  /** 出発日 "YYYY-MM-DD" → その日の価格（円）。レグの出発日で引く */
  byDate: Record<string, number>;
}

export interface FareCalendar {
  /** network.json の元エッジid（@rev 不可）→ 日別価格 */
  edges: Record<string, FareCalendarEdge>;
}

export type FareCalendarValidateResult =
  | { ok: true; calendar: FareCalendar }
  | { ok: false; errors: string[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** fareCalendar.json の構造検証。エッジは network に実在し、かつ変動運賃モードであること */
export function validateFareCalendar(
  raw: unknown,
  net: { edges: readonly CompiledEdge[] },
): FareCalendarValidateResult {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);

  if (!isRecord(raw)) return { ok: false, errors: ["fareCalendar のルートがオブジェクトではない"] };
  if (!isRecord(raw.edges)) return { ok: false, errors: ["fareCalendar.edges が無い"] };

  const modeById = new Map(net.edges.map((e) => [baseEdgeId(e.id), e.mode]));
  for (const [edgeId, entry] of Object.entries(raw.edges)) {
    const at = `fareCalendar.edges["${edgeId}"]`;
    const mode = modeById.get(edgeId);
    if (mode === undefined) {
      err(`${at}: エッジが network に無い`);
      continue;
    }
    if (!VOLATILE_MODES.has(mode)) err(`${at}: ${mode} は変動運賃モードではない`);
    if (!isRecord(entry)) {
      err(`${at} がオブジェクトではない`);
      continue;
    }
    if (typeof entry.fetchedAt !== "string" || !ISO_DATE.test(entry.fetchedAt))
      err(`${at}.fetchedAt が "YYYY-MM-DD" ではない`);
    if (typeof entry.source !== "string" || !/^https?:\/\//.test(entry.source))
      err(`${at}.source がURLではない`);
    if (!isRecord(entry.byDate)) {
      err(`${at}.byDate が無い`);
      continue;
    }
    for (const [date, yen] of Object.entries(entry.byDate)) {
      if (!ISO_DATE.test(date)) err(`${at}.byDate["${date}"] が "YYYY-MM-DD" ではない`);
      if (typeof yen !== "number" || !Number.isInteger(yen) || yen <= 0)
        err(`${at}.byDate["${date}"] の価格が正の整数ではない`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, calendar: raw as unknown as FareCalendar };
}

/** 指定エッジ・指定日の価格。無ければ null（呼び出し側が {low,typical,high} へフォールバック） */
export function fareOnDate(cal: FareCalendar, edgeId: string, dateISO: string): number | null {
  return cal.edges[baseEdgeId(edgeId)]?.byDate[dateISO] ?? null;
}
