// 時刻演算。エンジン内の時刻はすべて「出発日0時からの経過分（整数）」。
// タイムゾーンはJST暗黙、Date オブジェクトはこのモジュール以下では一切使わない。

export const DAY_MIN = 1440;

/** "09:30" → 570。"25:10" のような24時超表記も受け付ける（→1510） */
export function parseHM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`時刻形式が不正: "${s}"（HH:MM）`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min >= 60) throw new Error(`分が不正: "${s}"`);
  if (h >= 48) throw new Error(`時が大きすぎる: "${s}"`);
  return h * 60 + min;
}

/** 1510 → "01:10"（日付情報は fmtDayOffset で別途付ける） */
export function fmtHM(min: number): string {
  const m = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function dayOffset(min: number): number {
  return Math.floor(min / DAY_MIN);
}

/** 0日目→""、1日目→"+1日"、2日目→"+2日" */
export function fmtDayOffset(min: number): string {
  const d = dayOffset(min);
  return d <= 0 ? "" : `+${d}日`;
}

/** 755 → "12時間35分"、45 → "45分" */
export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}
