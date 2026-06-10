// network.json の構造検証。zod は使わない（クライアントバンドル肥大を避けるため手書き）。
// smoketest（コミット前）とブラウザの compileNetwork（データ編集中の即時フィードバック）の両方で走る。
import type { Network } from "./types";
import { parseHM } from "./time";

const NODE_KINDS = ["city", "station", "airport", "port", "poi"] as const;
const MODES = [
  "flight",
  "shinkansen",
  "rail",
  "ferry",
  "bus",
  "car",
  "rentacar",
  "taxi",
  "walk",
] as const;

export type ValidateResult =
  | { ok: true; network: Network }
  | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateNetwork(raw: unknown): ValidateResult {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);

  if (!isRecord(raw)) return { ok: false, errors: ["ルートがオブジェクトではない"] };

  // meta
  const meta = raw.meta;
  if (!isRecord(meta)) err("meta が無い");
  else {
    for (const k of ["title", "dataLastUpdated", "disclaimer"]) {
      if (typeof meta[k] !== "string" || !meta[k]) err(`meta.${k} が無い`);
    }
  }

  // transfer
  const transfer = raw.transfer;
  if (!isRecord(transfer)) err("transfer が無い");
  else {
    const dm = transfer.defaultMin;
    if (!isRecord(dm)) err("transfer.defaultMin が無い");
    else for (const k of NODE_KINDS) {
      if (typeof dm[k] !== "number" || (dm[k] as number) < 0) err(`transfer.defaultMin.${k} が不正`);
    }
    const bl = transfer.boardingLeadMin;
    if (!isRecord(bl)) err("transfer.boardingLeadMin が無い");
    else for (const k of MODES) {
      if (typeof bl[k] !== "number" || (bl[k] as number) < 0) err(`transfer.boardingLeadMin.${k} が不正`);
    }
  }

  // nodes
  const nodeIds = new Set<string>();
  const nodes = raw.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) err("nodes が空");
  else {
    for (const [i, n] of nodes.entries()) {
      const at = `nodes[${i}]`;
      if (!isRecord(n)) { err(`${at} がオブジェクトではない`); continue; }
      if (typeof n.id !== "string" || !n.id) err(`${at}.id が無い`);
      else if (nodeIds.has(n.id)) err(`${at}.id "${n.id}" が重複`);
      else nodeIds.add(n.id);
      if (typeof n.name !== "string" || !n.name) err(`${at}.name が無い`);
      if (!NODE_KINDS.includes(n.kind as never)) err(`${at}.kind が不正: ${String(n.kind)}`);
      if (typeof n.region !== "string" || !n.region) err(`${at}.region が無い`);
      if (n.transferMin !== undefined && (typeof n.transferMin !== "number" || n.transferMin < 0))
        err(`${at}.transferMin が不正`);
    }
  }

  // edges
  const edgeIds = new Set<string>();
  const edges = raw.edges;
  if (!Array.isArray(edges) || edges.length === 0) err("edges が空");
  else {
    for (const [i, e] of edges.entries()) {
      const at = isRecord(e) && typeof e.id === "string" ? `edges[${i}](${e.id})` : `edges[${i}]`;
      if (!isRecord(e)) { err(`${at} がオブジェクトではない`); continue; }
      if (typeof e.id !== "string" || !e.id) err(`${at}.id が無い`);
      else if (edgeIds.has(e.id)) err(`${at}.id が重複`);
      else edgeIds.add(e.id);
      for (const k of ["from", "to"] as const) {
        if (typeof e[k] !== "string" || !nodeIds.has(e[k] as string))
          err(`${at}.${k} "${String(e[k])}" がノードに無い`);
      }
      if (e.from === e.to) err(`${at} from と to が同一`);
      if (!MODES.includes(e.mode as never)) err(`${at}.mode が不正: ${String(e.mode)}`);
      if (e.costBasis !== "person" && e.costBasis !== "vehicle") err(`${at}.costBasis が不正`);
      if (typeof e.source !== "string" || !/^https?:\/\//.test(e.source)) err(`${at}.source がURLではない`);
      if (typeof e.lastUpdated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.lastUpdated))
        err(`${at}.lastUpdated が "YYYY-MM-DD" ではない`);

      // fare（徒歩などは0円を許容、負値のみ不正）
      const f = e.fare;
      if (typeof f === "number") {
        if (f < 0) err(`${at}.fare が負`);
      } else if (isRecord(f)) {
        const { low, typical, high } = f as Record<string, unknown>;
        if ([low, typical, high].some((v) => typeof v !== "number" || (v as number) < 0))
          err(`${at}.fare の low/typical/high が不正`);
        else if (!((low as number) <= (typical as number) && (typical as number) <= (high as number)))
          err(`${at}.fare が low ≤ typical ≤ high になっていない`);
      } else err(`${at}.fare が無い`);

      // service
      const svc = e.service;
      if (!isRecord(svc)) { err(`${at}.service が無い`); continue; }
      const tryHM = (label: string, v: unknown): number | null => {
        if (typeof v !== "string") { err(`${at}.${label} が文字列ではない`); return null; }
        try { return parseHM(v); } catch { err(`${at}.${label} "${v}" がHH:MMではない`); return null; }
      };
      if (svc.type === "timetable") {
        if (!Array.isArray(svc.trips) || svc.trips.length === 0) err(`${at}.service.trips が空`);
        else {
          let prevDep = -1;
          for (const [j, t] of svc.trips.entries()) {
            if (!isRecord(t)) { err(`${at}.trips[${j}] が不正`); continue; }
            const dep = tryHM(`trips[${j}].dep`, t.dep);
            tryHM(`trips[${j}].arr`, t.arr);
            if (dep !== null) {
              if (dep < prevDep) err(`${at}.trips[${j}] が dep 昇順ではない`);
              prevDep = dep;
            }
          }
        }
      } else if (svc.type === "frequency") {
        const first = tryHM("service.first", svc.first);
        const last = tryHM("service.last", svc.last);
        if (first !== null && last !== null && first >= last) err(`${at}.service first >= last`);
        if (typeof svc.everyMin !== "number" || svc.everyMin < 1) err(`${at}.service.everyMin が不正`);
        if (typeof svc.durationMin !== "number" || svc.durationMin < 1) err(`${at}.service.durationMin が不正`);
      } else if (svc.type === "anytime") {
        if (typeof svc.durationMin !== "number" || svc.durationMin < 1) err(`${at}.service.durationMin が不正`);
        if (svc.window !== undefined) {
          if (!isRecord(svc.window)) err(`${at}.service.window が不正`);
          else {
            const open = tryHM("service.window.open", svc.window.open);
            const close = tryHM("service.window.close", svc.window.close);
            if (open !== null && close !== null && open >= close) err(`${at}.service.window open >= close`);
          }
        }
      } else {
        err(`${at}.service.type が不正: ${String(svc.type)}`);
      }

      // bidirectional は anytime のみ（時刻表の逆向きは別エッジとして明示させる）
      if (e.bidirectional === true && (svc as { type?: unknown }).type !== "anytime")
        err(`${at}.bidirectional は anytime サービスのみ可`);
    }
  }

  // endpoint 同士の到達性（時刻無視の無向BFS。データ入れ忘れの早期検出用）
  if (errors.length === 0) {
    const net = raw as unknown as Network;
    const endpoints = net.nodes.filter((n) => n.endpoint);
    if (endpoints.length < 2) err("endpoint: true のノードが2つ未満");
    else {
      const undirected = new Map<string, Set<string>>();
      const link = (a: string, b: string) => {
        if (!undirected.has(a)) undirected.set(a, new Set());
        undirected.get(a)!.add(b);
      };
      for (const e of net.edges) {
        link(e.from, e.to);
        link(e.to, e.from); // 到達性チェックは無向で十分（方向別の網羅は探索テストで担保）
      }
      const start = endpoints[0].id;
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const nxt of undirected.get(cur) ?? []) {
          if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
        }
      }
      for (const ep of endpoints) {
        if (!seen.has(ep.id)) err(`endpoint "${ep.id}" が "${start}" からグラフ上到達不能`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, network: raw as unknown as Network };
}
