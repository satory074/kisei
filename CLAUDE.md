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

- **テストフレームワークは無い**（moshirasu 方式の fail-fast assert スクリプト）。`smoketest.ts` はデータ検証・時刻演算・日跨ぎ・パレート・合成フィクスチャ探索・損益分岐（平文4分岐含む）・実価格上書き・日別料金（validate+fareByDay探索）・戦略グルーピング・実データシナリオ（例示4モードパターン+グループ数5〜15の検証）・URL round-trip。`domtest.ts` は jsdom で boot→検索→**戦略グループ2段カード**描画→ソート→実価格上書き/クリア（open状態維持含む）→日別料金表示→共有URL復元（`fares=` 含む）。
- **tsx は型を消すだけで検査しない**。scripts/ や engine を変更したら `npm run typecheck` を必ず通すこと。
- デプロイ: main へ push → `.github/workflows/deploy.yml` が **test → build → Pages 公開**（テストが落ちるとデプロイされない）。

## Architecture（大きな流れ）

**`src/data/network.json` が構造の単一の真実、`src/data/fareCalendar.json` が日別価格のスナップショット。** `src/engine/` が純TS探索エンジン、`src/app/` が唯一のDOM層。実行時フェッチは一切ない（JSON は client バンドルに同梱）。

```
network.json → compile.ts(validate→正規化→隣接索引) → search.ts(DFS, fareByDayで日別価格解決)
  → group.ts(戦略グルーピング) → app/render.ts(戦略グループ2段カード描画)
fareCalendar.json → farecal.ts(validate) → app/fares.ts(ISO日付→dayOffset解決) → search.ts
```

**UIの第一画面は「8とおりの行き方」の戦略比較**（30件のフラットな行程リストではない）。`group.ts` が検索結果を主要モード（flight/shinkansen/ferry/car/rentacar）のセグメント列でグルーピングする後処理レイヤ。探索エンジン本体には手を入れていない。

### エンジンの不変条件（src/engine/ — 破ると壊れる前提）

- **DOM・Date オブジェクト禁止。** 時刻はすべて「出発日0時からの経過分（整数、JST暗黙）」。日跨ぎ便は `"25:30"` 式の24時超表記、または compile 時の `arr < dep → arr+1440` 正規化で表現。
- **日跨ぎ・翌日繰越のロジックは `expand.ts: nextDeparture()` だけにある**（off-by-one の温床なので集約。24時超表記の便を拾うため走査は前日から始まる）。`frequency` サービスは仮想便をリスト実体化せず、その場で1便だけ計算する（爆発の構造的回避）。
- **エッジごとに「乗れる最初の便」だけを分岐させる**（search.ts の核心不変条件）。運賃がエッジ単位だから最早便が後続便を支配する。**便ごとに運賃が違うデータ（早特など）を入れたくなったらエッジを分割する**こと。
- 枝刈りフロンティアのキーは **「ノード × ここまでのモード構成」**。ノード単体にすると「車は遅くて高いが比較のために見たい」というモード代表が中間ノードで刈られる（実際に起きたバグ）。
- 乗車可能時刻 = 到着 + ノード種別ごとの乗換時間（初レグは無し）+ **モード別乗り込みリード**（航空45分・フェリー30分など、`network.json` の `transfer` で定義）。
- 既定値の理由: `maxWaitMin=18h`（大間フェリーは1日2便で「夕方着→翌朝便」の夜越え待ち~16hが正規の旅程）、`maxLegs=7`（新幹線2本+青い森+大湊線+バス+市内アクセスで6〜7レグ）。安易に縮めない。
- 結果 = **パレート集合（到着時刻×typical運賃） ∪ モード構成ごとのベスト**。純パレートだと2〜3件に潰れて「車ならいくら？」の横断比較ができないため。非最適は `isPareto: false` で UI が区別。**maxResults=30 のキャップはグルーピング前に効く**（現状12グループで問題なし。戦略が増えて行程枠を食い合うようなら opts 拡張を検討）。
- **戦略グルーピング（`group.ts`）**: 検索結果の後処理。`strategyKey` は主要モードのレグのみでキー化（アクセスレグ rail/bus/taxi/walk の違いで分裂しない）、連続同一モードは畳む（ferry は航路別なので畳まない）、flight の経由地はノードの `cityOf` がホーム側（検索起終点の市内アクセス）なら落とす（伊丹/関西/神戸の違いを統合）。主要3セグメント以上は `isOther`（UIで「遠回り」フォールド）。`groupRoutes` は分割の完全性（全行程がちょうど1グループ）を保証。
- **損益分岐（`breakeven.ts`）**: 変動運賃モードは `VOLATILE_MODES`（flight/rentacar）に集約。固定運賃のみの最安経路（基準）に対し「変動分の実価格合計がいくら以下なら基準より安いか」を純関数で計算。表示は `describeBreakEven` の**日本語平文**（「航空券を ¥X 以下で取れれば「新幹線＋鉄道・バス」（¥Y）より安くなります」）で、行程カード展開内の末尾に出す（サマリーには出さない。記号式表示は「解読不能」フィードバックで廃止済み）。
- **実価格上書き（`compile.ts: applyFareOverrides`）**: エッジ id → 円 のマップで fare を単一値に置換した**新しい** CompiledNetwork を返す（元は不変・空マップは no-op）。bidirectional の逆向き実体化エッジ（`xxx@rev`）にも `baseEdgeId()` 正規化で効く。network.json には実価格を取り込まない（価格は予約時点に属する情報。データは幅 low/typical/high と鮮度のみ）。
- **日別料金（`farecal.ts` + `src/data/fareCalendar.json`）**: 変動エッジの日別最安値（ソラハピ等から手動転記）を持ち、`SearchQuery.fareByDay`（元エッジid → dayOffset 添字の価格配列）で渡すと、レグ確定時に**出発日の確定価格へ幅を潰して**枝刈り・パレート・ソートの全評価軸に効かせる（日跨ぎ便も出発日の価格）。エンジンは Date 禁止のため ISO日付→dayOffset の解決は `app/fares.ts`（Date可）が行う。**優先順位: 実価格上書き ＞ 日別テーブル ＞ {low,typical,high}**（main.ts が override 済みエッジを fareByDay から除外するだけで成立）。

### サービス3形式（Service 型）

- `timetable`: 明示便リスト（フェリー・飛行機・はやぶさ・ローカル線）
- `frequency`: 間隔運転（のぞみ・リムジンバス等。first/last/everyMin/durationMin）
- `anytime`: いつでも出発（車・タクシー・徒歩。`window` でレンタカー営業時間を表現）
- `bidirectional: true` は **anytime のみ可**（validate が強制。時刻表の逆方向は別エッジとして明示する）

### app 層（src/app/）

- `render.ts` が唯一の DOM。結果は **戦略グループ（`details.group-card`）> 行程カード（`details.route-card`）の2段構造**。初期展開は「先頭グループ + その先頭行程」のみ、`isOther` グループは「遠回り・乗継の多い行き方」フォールドへ。ルートの click リスナー1本で `data-action` 委譲（search / swap / set-sort / clear-fares）。実価格入力欄（`input[data-fare-edge]`）だけはルートの **change リスナー**で委譲（input イベントだと毎キー再描画でフォーカスを失うため change=blur/Enter 時に反映）。毎回 innerHTML 再生成だが、**再描画前に details の open 状態を `data-key`/`data-route` で捕捉して復元する**（忘れると実価格入力のたびにカードが閉じる）。
- 料金表示は typical（ソート基準）が主役で low〜high の幅は `.fare-sub` の脇役。日別料金で確定したレグは「8/12の料金 ¥13,310」+ 転記日、30日超は鮮度警告。
- `main.ts` が配線 + URL クエリ同期（`?from=osaka&to=oma&date=…&time=…&sort=…&fares=エッジid:円,…` を replaceState、ブート時に復元して自動検索）。検索のたび `groupRoutes` でグループ化し、`sortGroups` が「グループ内整列 + グループ順は各ベスト行程比較」で3ソート（最安/最速/出発順）の意味を戦略レベルへ持ち上げる。展開状態は URL に入れない（既存パラメータ完全互換、`url.ts` は無変更）。
- 上書き・日別料金で経路の順位自体が変わる（typical での枝刈り・パレート・ソートすべてに効く）。上書き中の経路が表示から消えても解除できるよう、結果ヘッダに「実価格をクリア」ボタンを出す。
- Date を使ってよいのは app 層だけ（今日の日付の初期値、`fares.ts` のISO日付演算など）。

## データ更新の作法（src/data/network.json）

- 編集したら `npm test`。validate が **全エッジの `source`（出典URL）+ `lastUpdated`（YYYY-MM-DD）を必須化**、運賃 `low ≤ typical ≤ high`、timetable の dep 昇順、endpoint 間の到達性などを強制する。
- 変動運賃（航空券）は `{low, typical, high}` の幅で持つ（low=最安日 / typical=通常期 / high=繁忙期）。単一値は3値同値の省略記法。**偽精度を出さない**。
- 概算値・逆算値は必ず `notes` に明記（例: 下北交通バスの運賃概算、北斗の着時刻=所要3h30で算出）。
- 車・レンタカーは `costBasis: "vehicle"`（1台あたり。v1 は1人旅前提でそのまま合算）。
- 時刻・運賃は 2026-06-10 時点の調査値。**フェリーは季節ダイヤ（夏期は大間航路が3便に増便）・JRは3月改正**なので年1回見直す。
- zod は意図的に不使用（クライアントバンドルに載るため手書き validate。ブラウザ側でも compileNetwork が同じ検証を実行し、エラーパネルを出す）。

## 日別料金の転記手順（src/data/fareCalendar.json）

1. ソラハピ最安値カレンダー（`https://www.sorahapi.jp/calendar/{FROM}/{TO}/`、例 `ITM/AOJ`）を開き、日別最安値を読む（約4ヶ月先まで表示される）。
2. `fareCalendar.json` の該当エッジの `byDate` を丸ごと置き換え、`fetchedAt` を転記日に更新する。エッジは **network.json の元エッジ id**（`@rev` 不可）で、`mode` が flight/rentacar（`VOLATILE_MODES`）のもののみ validate が通す。
3. `npm test`（validateFareCalendar が未知エッジ・非変動モード・不正日付・非正整数価格・出典URL欠落を弾く）。
4. **rentacar は対象外**（日別定価が存在しない。幅 + 実価格入力で運用）。フェリーの季節ダイヤ（A/B/C期間）のカレンダー化は将来課題。
5. カレンダーに無い日付は自動で従来の幅（目安）にフォールバックするので、転記が古くても壊れはしない（30日超は画面に鮮度警告が出る）。

## 重要な制約・gotcha

- **base path は `/kisei`**。カスタムドメインにするなら `astro.config.mjs` の `base` を空に。
- Tailwind v4 の Vite プラグインは Astro と型が合わないため `astro.config.mjs` で `/** @type {any} */` キャスト済み。
- v1 の既知の制限（README に明記）: 曜日・季節ダイヤ非対応（毎日同一ダイヤ）、車のフェリー航送ルート非対応、青森⇔伊丹の ANA 復路など時刻未確認の便は未収載。
- このリポジトリは `satory074/kisei`。以前は todayai リポジトリ内（todayai/kisei）にあったが、現在は `Basecamp/src/kisei` の独立プロジェクト。
