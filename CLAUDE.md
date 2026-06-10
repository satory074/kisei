# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

kisei（帰省 — 経路くらべ）— 多モーダル（飛行機・新幹線・鉄道・フェリー・バス・車・レンタカー）の経路を**実時刻表ベース**で列挙し、所要時間と料金を一覧比較する Astro 5 + Tailwind v4 の完全静的サイト。GitHub Pages（base path `/kisei`）。公開 URL: `https://satory074.github.io/kisei/`

エンジンは汎用（データにある任意の2地点）、初期データは大阪⇔大間町（下北半島）の帰省コリドー特化。

## Commands

```bash
npm install
npm run dev        # http://localhost:4321/kisei/
npm run build      # 本番ビルド（Astro グラフの型チェック込み）
npm run typecheck  # astro check。tsconfig が **/* を含むので scripts/ も型検査される
npm run test       # tsx scripts/smoketest.ts && tsx scripts/domtest.ts
npx tsx scripts/smoketest.ts   # エンジン+データ検証のみ
npx tsx scripts/domtest.ts     # jsdom UIテストのみ
```

- **テストフレームワークは無い**（moshirasu 方式の fail-fast assert スクリプト）。`smoketest.ts` はデータ検証・時刻演算・日跨ぎ・パレート・合成フィクスチャ探索・実データシナリオ（例示4モードパターンの存在検証）・URL round-trip。`domtest.ts` は jsdom で boot→検索→カード描画→ソート→共有URL復元。
- **tsx は型を消すだけで検査しない**。scripts/ や engine を変更したら `npm run typecheck` を必ず通すこと。
- デプロイ: main へ push → `.github/workflows/deploy.yml` が **test → build → Pages 公開**（テストが落ちるとデプロイされない）。

## Architecture（大きな流れ）

**`src/data/network.json` が単一の真実。** `src/engine/` が純TS探索エンジン、`src/app/` が唯一のDOM層。実行時フェッチは一切ない（JSON は client バンドルに同梱）。

```
network.json → compile.ts(validate→正規化→隣接索引) → search.ts(DFS) → app/render.ts(描画)
```

### エンジンの不変条件（src/engine/ — 破ると壊れる前提）

- **DOM・Date オブジェクト禁止。** 時刻はすべて「出発日0時からの経過分（整数、JST暗黙）」。日跨ぎ便は `"25:30"` 式の24時超表記、または compile 時の `arr < dep → arr+1440` 正規化で表現。
- **日跨ぎ・翌日繰越のロジックは `expand.ts: nextDeparture()` だけにある**（off-by-one の温床なので集約。24時超表記の便を拾うため走査は前日から始まる）。`frequency` サービスは仮想便をリスト実体化せず、その場で1便だけ計算する（爆発の構造的回避）。
- **エッジごとに「乗れる最初の便」だけを分岐させる**（search.ts の核心不変条件）。運賃がエッジ単位だから最早便が後続便を支配する。**便ごとに運賃が違うデータ（早特など）を入れたくなったらエッジを分割する**こと。
- 枝刈りフロンティアのキーは **「ノード × ここまでのモード構成」**。ノード単体にすると「車は遅くて高いが比較のために見たい」というモード代表が中間ノードで刈られる（実際に起きたバグ）。
- 乗車可能時刻 = 到着 + ノード種別ごとの乗換時間（初レグは無し）+ **モード別乗り込みリード**（航空45分・フェリー30分など、`network.json` の `transfer` で定義）。
- 既定値の理由: `maxWaitMin=18h`（大間フェリーは1日2便で「夕方着→翌朝便」の夜越え待ち~16hが正規の旅程）、`maxLegs=7`（新幹線2本+青い森+大湊線+バス+市内アクセスで6〜7レグ）。安易に縮めない。
- 結果 = **パレート集合（到着時刻×typical運賃） ∪ モード構成ごとのベスト**。純パレートだと2〜3件に潰れて「車ならいくら？」の横断比較ができないため。非最適は `isPareto: false` で UI が区別。

### サービス3形式（Service 型）

- `timetable`: 明示便リスト（フェリー・飛行機・はやぶさ・ローカル線）
- `frequency`: 間隔運転（のぞみ・リムジンバス等。first/last/everyMin/durationMin）
- `anytime`: いつでも出発（車・タクシー・徒歩。`window` でレンタカー営業時間を表現）
- `bidirectional: true` は **anytime のみ可**（validate が強制。時刻表の逆方向は別エッジとして明示する）

### app 層（src/app/）

- `render.ts` が唯一の DOM。ルートの click リスナー1本で `data-action` 委譲（search / swap / set-sort）。結果は高々30件なので毎回 innerHTML 再生成（keyed 更新不要の規模）。
- `main.ts` が配線 + URL クエリ同期（`?from=osaka&to=oma&date=…&time=…&sort=…` を replaceState、ブート時に復元して自動検索）。`url.ts` の encode/decode は純関数でテスト対象。
- Date を使ってよいのは app 層だけ（今日の日付の初期値など）。

## データ更新の作法（src/data/network.json）

- 編集したら `npm test`。validate が **全エッジの `source`（出典URL）+ `lastUpdated`（YYYY-MM-DD）を必須化**、運賃 `low ≤ typical ≤ high`、timetable の dep 昇順、endpoint 間の到達性などを強制する。
- 変動運賃（航空券）は `{low, typical, high}` の幅で持つ（low=最安日 / typical=通常期 / high=繁忙期）。単一値は3値同値の省略記法。**偽精度を出さない**。
- 概算値・逆算値は必ず `notes` に明記（例: 下北交通バスの運賃概算、北斗の着時刻=所要3h30で算出）。
- 車・レンタカーは `costBasis: "vehicle"`（1台あたり。v1 は1人旅前提でそのまま合算）。
- 時刻・運賃は 2026-06-10 時点の調査値。**フェリーは季節ダイヤ（夏期は大間航路が3便に増便）・JRは3月改正**なので年1回見直す。
- zod は意図的に不使用（クライアントバンドルに載るため手書き validate。ブラウザ側でも compileNetwork が同じ検証を実行し、エラーパネルを出す）。

## 重要な制約・gotcha

- **base path は `/kisei`**。カスタムドメインにするなら `astro.config.mjs` の `base` を空に。
- Tailwind v4 の Vite プラグインは Astro と型が合わないため `astro.config.mjs` で `/** @type {any} */` キャスト済み。
- v1 の既知の制限（README に明記）: 曜日・季節ダイヤ非対応（毎日同一ダイヤ）、車のフェリー航送ルート非対応、青森⇔伊丹の ANA 復路など時刻未確認の便は未収載。
- このリポジトリは `satory074/kisei`。以前は todayai リポジトリ内（todayai/kisei）にあったが、現在は `Basecamp/src/kisei` の独立プロジェクト。
