# 「会議ごとの録画と、録画の取得 API」のご依頼への回答

- 宛先: luna-one（SaaS 側、`modules/meeting-ingest`）ご担当者様
- 差出: meet.ooak.jp Tenant Gateway 運用
- 日付: 2026-10-02
- 対象テナント: `lunar-one`（ベース URL `https://meet.ooak.jp/tenant-api/v1/tenants/lunar-one`）
- 関連文書: 英語の API 仕様 `docs/recording-api.md`、OpenAPI 3.1 `docs/openapi.yaml`（いずれも bbb-tenant-gateway リポジトリ内）

このたびはご依頼ありがとうございます。2026-10-02 付のご依頼文の各項目について、以下のとおり回答いたします。

## 1. 結論

依頼 A（会議ごとの `record`）、依頼 B（録画の一覧・ダウンロード・削除 API）、依頼 C（録画完成の Webhook）のすべてを実装済みです。本番（`meet.ooak.jp`）への適用日は **2026-10-02** です。

- 既存 4 エンドポイントの要求・応答は項目の追加のみで、形は変えていません。
- エラー形式は従来どおり `{ "error": { "code", "message", "requestId" } }` です。新しいエラーコードは 404 / 409 / 416 / 429 / 503 に追加しました（§3.3 の表）。
- 検証用テナント `lunar-one-staging` を用意しました。token の受け渡し方法は §5 の 5 をご覧ください。

## 2. 依頼 A への回答（会議ごとの `record`）

### 3.1 テナント設定

`lunar-one` の `allowRecording` は **true** に設定済みです。Gateway 側は「許可 / 禁止」だけを持ち、許可のときは `POST /meetings` の `record` を会議ごとに尊重します。SaaS 側の環境変数 `BBB_TENANT_RECORDING` による一律指定から、会議ごとの指定に切り替えていただいて問題ありません。

### 3.2 `POST /meetings` の `record`

- `record: true` のとき、BigBlueButton には `record=true` かつ `autoStartRecording=true` で会議を作成します。最初の参加者が入室した時点から録画が始まり、参加者の操作は不要です。
- `record: false`（省略時も同じ）のとき、従来どおり録画なしで作成します。
- `allowStartStopRecording` は、ご希望どおり **false** に設定しました。司会者は録画を一時停止・再開できません。
- 録画中であることは BigBlueButton 標準の録画表示（画面上部の録画インジケーター）で参加者に表示されます。Gateway 側で表示を変更・抑止することはありません。

### 3.3 応答に実際の値を含める

応答に `record` を追加しました。値は Gateway が実際に適用した値です。

```json
{ "meetingId": "luna-<tenantId>-<meetingId>", "createTime": "1759400000000", "created": true, "record": true }
```

同じ `meetingId` への再 POST（`created: false`）では、既に存在する会議の現在の値を返します。再 POST で異なる `record` を送っても、既存の会議の設定は変わりません（応答の `record` で現在の値をご確認ください）。

### 3.4 テナントが録画禁止のときの `record: true`

黙って録画なしで作ることはありません。`403` + `error.code = "recording_not_allowed"` を返し、会議は作成しません。この挙動は以前から同じで、変更していません（§5 の 4 も参照）。

### 3.5 `GET /meetings/{meetingId}` への項目追加

`record` と `recording` を追加しました（既存の `meetingId` と `running` は変更なし）。

```json
{
  "meetingId": "luna-<tenantId>-<meetingId>",
  "running": true,
  "record": true,
  "recording": { "state": "recording", "recordId": "3a1c8eb5…-1759400000000" }
}
```

- `recording.state` は `none` | `recording` | `processing` | `ready` | `failed` です。
- `recording.recordId` は会議が作成された時点から入ります（BigBlueButton の内部会議 ID で、依頼 B の一覧と同じ ID です）。会議が存在せず Gateway にも記録がない場合のみ `null` です。
- `state` が `none` または `failed` で理由があるときは `recording.reason` が付きます（`no_recording_marks`、`deleted`、`expired`、`timeout`、または BigBlueButton の失敗マーカー名）。
- `running` の意味は従来どおり「参加者が 1 人以上いる」です。作成直後で誰も入室していない会議は `running: false` で、`state` は `none` です。入室後は `recording` になり、会議終了後は処理の進み具合に応じて `processing` → `ready`（または `failed`）に変わります。

## 3. 依頼 B への回答（録画の取得 API）

### 4.1 一覧 `GET /meetings/{meetingId}/recordings`

ご提示の形のまま実装しました。応答は `{ "items": [ … ] }` で、各項目は次のとおりです。

| 項目 | 型 | 内容 |
| --- | --- | --- |
| `recordId` | string | 録画 ID（`GET /meetings/{id}` の `recording.recordId` と同じ） |
| `meetingId` | string | SaaS が指定した会議 ID |
| `state` | `processing` / `ready` / `failed` | 処理状態 |
| `startedAt`, `endedAt` | string / null | 会議の開始・終了（ISO 8601 UTC） |
| `durationSec` | integer / null | 録画の長さ（秒）。`ready` のときのみ |
| `mime` | `"video/mp4"` / null | `ready` のときのみ |
| `sizeBytes` | integer / null | ファイルサイズ。ダウンロードの `Content-Length` と一致 |
| `filename` | string / null | `<meetingId>-<recordId>.mp4` |
| `downloadUrl` | string / null | `ready` のときのみ。ダウンロードエンドポイントの絶対 URL |
| `playbackUrl` | null | 常に null（4.4 参照） |
| `createdAt` | string / null | mp4 が公開された日時。`ready` のときのみ |
| `expiresAt` | string / null | Gateway 側の自動削除予定日時（`endedAt` + 30 日） |
| `error` | string / null | `failed` の理由 |

- `state` が `processing` のときはメディア関連の項目はすべて null、`failed` のときは `error` に理由を入れます。
- 削除済み・保持期限切れの録画は一覧に出ません。
- 同じ `meetingId` で会議を終了後に再作成した場合は、録画ごとに 1 件ずつ（別の `recordId` で）並びます。`startedAt` の昇順です。
- `record: true` でも参加者が音声・映像・画面共有などを一切行わず「録画マーク」が残らなかった会議は、BigBlueButton が録画を生成しません。この場合は `state: "failed"`、`error: "no_recording_marks"` の項目になります（Webhook も `recording.failed` を送ります）。「録画は存在しない」として扱い、DELETE するか無視してください。

**形式**: mp4（H.264 1280x720 + AAC、映像 + 音声）を 1 本生成します。BigBlueButton 既定の presentation 形式（HTML 再生）は Gateway からは提供しません。音声のみの会議でも mp4 が生成されます（映像トラックはプレゼン領域や空の画面になります）ので、ffmpeg で音声を取り出していただく形で問題ありません。

**一時停止・再開**: `allowStartStopRecording=false` のため通常は発生しませんが、仮に録画区間が分かれた場合も BigBlueButton が 1 本の mp4 に結合して出力します。録画されていない区間は含まれません。したがって `durationSec` は録画区間の合計で、`endedAt - startedAt` より短いことがあります。一覧は常に 1 会議セッションにつき 1 件です。

**`ready` になるまでの目安**: 会議終了後、処理時間はおおむね会議時間の数分〜十数% 程度です。短い会議なら 1〜2 分です。実測（2026-10-02、約 2.5 分の会議）では、終了から 15 秒で presentation 形式、49 秒で mp4（video 形式）が完成し、API が `ready` を返したのは終了の約 50 秒後でした。毎時同期と「今すぐ同期」で確認いただく運用で問題ありませんが、依頼 C の Webhook を使っていただければ完成直後に通知します。

### 4.2 ダウンロード `GET /meetings/{meetingId}/recordings/{recordId}/download`

**Bearer 付きストリーム方式**です（署名付き URL ではありません）。一覧の `downloadUrl` に、既存と同じ `Authorization: Bearer <tenant token>` を付けて GET してください。

- 応答ヘッダ: `Content-Type: video/mp4`、`Content-Length`（必ず付きます）、`Accept-Ranges: bytes`、`ETag`、`Content-Disposition: attachment; filename="…"`、`Cache-Control: no-store`
- `Range` 対応: 単一範囲（`bytes=start-end`、`bytes=start-`、`bytes=-suffix`）に `206` + `Content-Range` で応答します。範囲外の指定（開始位置がファイルサイズ以上）、`bytes=<start>-<end>` で start > end の指定、および `bytes=-0` は `416` + `error.code = "range_not_satisfiable"`（`Content-Range: bytes */<size>` 付き）です。複数範囲や不正な `Range` は無視して全体を `200` で返します。
- `HEAD` にも対応しています（ヘッダのみ）。
- 1 リクエストの合計時間に上限はありません。ただし nginx の無通信タイムアウトが 600 秒で、600 秒間まったくバイトが流れなかった場合に応答が打ち切られます。途中で切れた場合は `ETag` を確認のうえ `Range` で再開してください。
- Gateway の再起動（デプロイ時）中はダウンロード中のストリームが約 10 秒後に切断されます。この場合も SaaS 側で `ETag` を確認のうえ `Range` で再開してください。
- `state` が `ready` でない録画へのダウンロードは `409` + `error.code = "recording_not_ready"`、存在しない・他テナント・削除済みの録画は `404` + `error.code = "recording_not_found"` です。
- 同時ダウンロード数はテナントあたり 4 本までです。超過時は `429` + `error.code = "too_many_downloads"`、`Retry-After: 5` を返します。ダウンロードも毎分のリクエスト数（120 回）に 1 回として数えます。

### 4.3 削除 `DELETE /meetings/{meetingId}/recordings/{recordId}`

削除は 2 段階です。

1. API 呼び出し時（即時）: 録画を論理削除し、`202` + `{ "recordId": "…", "status": "deleting" }` を返します。この時点で一覧から消え、`GET /meetings/{id}` は `state: "none"`、`reason: "deleted"` になり、ダウンロードおよび 2 回目の DELETE は `404` + `error.code = "recording_not_found"` です。BigBlueButton 側でも再生用ファイルは同期的に公開領域から外されます。
2. 物理削除（10 分以内）: Gateway が残した削除要求を root 権限の purge タイマー（5 分ごと）が処理し、BigBlueButton の実体（公開・未公開・raw・ステータス・ログ）と Wasabi のアーカイブ（`wasabi:webrtc/tenants/lunar-one/recordings/<recordId>/`）をすべて物理削除します。失敗した場合は削除要求が残り、次回のタイマーで再試行します。

- 処理中（`processing`）の録画は削除できず `409` + `error.code = "recording_not_ready"` です。`ready` または `failed` になってから呼んでください。
- 既存の `DELETE /meetings/{meetingId}`（会議の終了）は録画を消しません。従来どおりです。
- 安全弁として、Gateway 側でも会議終了から **30 日**で自動削除します。一覧の `expiresAt` にその日時（`endedAt` + 30 日）を入れています。期限後、毎時の掃除処理で上記の削除経路を通ります。SaaS 側の保持（既定 90 日、最長 1 年）は SaaS 側で保管したファイルに対して行っていただく前提です。

### 4.4 再生 URL（`playbackUrl`）

`playbackUrl` は**常に null** です。この環境の BigBlueButton の再生 URL は、URL を知っていれば誰でも再生できる形で、署名付き・期限付きにする機能がありません。そのため Gateway からは返しません。録画へ到達する経路は Bearer 付きのダウンロード API だけです。なお `recordId` は会議 ID の SHA-1 とミリ秒単位の作成時刻から成り、推測は現実的に不可能です。削除（手動・自動）時には再生用ファイルも消えます。

## 4. 依頼 C への回答（録画完成の通知）

実装済みです。テナントごとに登録された URL へ POST します。

**本文**（JSON、空白なし）:

```json
{ "event": "recording.ready", "tenant": "lunar-one", "meetingId": "luna-<tenantId>-<meetingId>", "recordId": "3a1c8eb5…-1759400000000", "occurredAt": "2026-10-02T02:10:00Z" }
```

- `event`: `recording.ready` | `recording.failed`。`recording.failed` のときは `"error": "<理由>"` が付きます。
- `recording.failed` は、録画マークがなかった場合（`error: "no_recording_marks"`）や、作成から 48 時間経っても処理の痕跡がない場合（`error: "timeout"`）にも送ります。SaaS 側が待ち続けないようにするためです。

**ヘッダ**:

| ヘッダ | 値 |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Gateway-Timestamp` | 送信試行時の UNIX 秒 |
| `X-Gateway-Signature` | `v1=<hex>` |
| `X-Gateway-Event-Id` | `<recordId>:<event>`（再送でも同じ値） |

**署名の計算式**: `hex = HMAC-SHA256(secret, "v1:" + timestamp + ":" + raw body)` です。署名対象は受信したままの生のバイト列で、JSON を解釈して再整形したものではありません。

検証コード例（Node.js）:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const ts = headers['x-gateway-timestamp'] ?? '';
  const sig = headers['x-gateway-signature'] ?? '';
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = 'v1=' + createHmac('sha256', secret).update(`v1:${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

検証コード例（Python）:

```python
import hmac, hashlib, time

def verify(secret: str, headers: dict, raw_body: bytes) -> bool:
    ts = headers.get("X-Gateway-Timestamp", "")
    sig = headers.get("X-Gateway-Signature", "")
    if not ts.isdigit() or abs(int(time.time()) - int(ts)) > 300:
        return False
    expected = "v1=" + hmac.new(secret.encode(), b"v1:" + ts.encode() + b":" + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)
```

計算例（検証用の値）は `docs/recording-api.md` §7.4 に、秘密鍵 `example-secret-0123456789`、timestamp `1759400000` での期待値を載せています。

**再送**: 2xx 以外（タイムアウト 10 秒、リダイレクトも失敗扱い）のときは 1 分、5 分、15 分、1 時間、6 時間後に再送します（計 6 回）。それでも届かなければ破棄しますが、状態は `GET …/recordings` でいつでも取得できます。再送時は `X-Gateway-Timestamp` と署名が新しい値になります。

**冪等性**: `recordId` + `event`（= `X-Gateway-Event-Id`）で冪等に処理してください。同じ `recordId` に対して `recording.ready` と `recording.failed` はそれぞれ最大 1 回で、`ready` の後に `failed` を送ることはありません。

**登録方法**: 通知先 URL（HTTPS）と、16 文字以上の秘密鍵を Gateway 運用者にお渡しください。チャットや依頼文には書かず、サーバー上のファイル（例: `hostinger` 上の root のみ読める一時ファイル）で受け渡す形でお願いします。運用者が Gateway の環境ファイルとテナント設定に登録し、再起動後に有効になります。

## 5. §7 の 1〜6 への回答

1. **可否と時期**: A / B / C すべて実装済み、本番適用 2026-10-02。
2. **API 仕様**: Markdown 版 `docs/recording-api.md`、OpenAPI 3.1 版 `docs/openapi.yaml`。項目名と `state` の値は本回答の §2・§3 のとおりです。ダウンロードは Bearer 付きストリーム方式です。新規のエラーコードは次のとおりです。

   | HTTP | `error.code` | 場面 |
   | --- | --- | --- |
   | 403 | `recording_not_allowed` | 録画禁止テナントでの `record: true`（既存） |
   | 404 | `recording_not_found` | 不明・他テナント・削除済みの `recordId` |
   | 409 | `recording_not_ready` | `ready` でない録画のダウンロード、処理中の録画の削除 |
   | 413 | `payload_too_large` | 32 KiB を超える JSON リクエスト本文 |
   | 415 | `unsupported_media_type` | 対応していない charset / Content-Encoding のリクエスト本文 |
   | 416 | `range_not_satisfiable` | 範囲外の `Range`（start > end、`bytes=-0` を含む） |
   | 429 | `rate_limited` / `too_many_downloads` | レート制限・同時ダウンロード上限（`Retry-After` 付き） |
   | 503 | `recording_delete_unavailable` | 削除要求を保存できなかった（何も変更されていないので再試行） |

3. **形式・目安・保持**: mp4（H.264 1280x720 + AAC）1 本。`ready` までは会議時間の数分〜十数% 程度（短い会議で 1〜2 分、実測では約 2.5 分の会議が終了の約 50 秒後に `ready`）。Gateway 側の保持は会議終了から 30 日（`expiresAt`）、その後自動削除。
4. **現在の `allowRecording` と拒否時の挙動**: `lunar-one` の `allowRecording` は現在 **true** です。録画禁止のテナントで `record: true` を受けた場合は、以前から `403` + `recording_not_allowed` で拒否しており、黙って録画なしで作ることはありません。
5. **検証用テナントと token**: `lunar-one-staging` を用意しました。ベース URL は `https://meet.ooak.jp/tenant-api/v1/tenants/lunar-one-staging` です（会議 ID の名前空間は本番と別で、`lunar-one` の会議・録画には届きません）。token はサーバー `hostinger`（meet.ooak.jp）の `/etc/bbb-tenant-gateway/lunar-one-staging.api-key`（root のみ読み取り可）にあります。SaaS 側のご担当者が ssh で読み取り、`/opt/luna-one/.env` に直接入れてください。チャットや文書には書きません。ご希望があれば本番 `lunar-one` の token も同様に再発行できます。
6. **レート制限と同時接続数**: 1 テナントあたり 120 リクエスト/分（ダウンロードを含む）、同時会議 20、同時ダウンロード 4、1 会議の最大参加者 100。超過時は `429`（`rate_limited` または `too_many_downloads`）と `Retry-After` ヘッダ（秒）を返しますので、その秒数待ってから再試行してください。同時会議の超過は `409` + `meeting_limit_reached` です。§6 に記載の毎時同期（未終了の会議ごとに `GET /meetings/{id}`、終了済みで録画未取得の会議ごとに `GET …/recordings` を 1 回ずつ）は、同時会議 20 件の規模では制限内に収まります。

## 6. SaaS 側にお願いしたいこと

1. **Webhook の URL と秘密鍵の受け渡し**: 依頼 C を使う場合、通知先 URL と 16 文字以上の秘密鍵を、チャットではなくサーバー上のファイルでお渡しください。登録完了と有効化の時刻はこちらからご連絡します。
2. **毎時同期の呼び出し頻度**: 現状の設計（会議ごとに 1 回ずつ）で制限内ですが、「今すぐ同期」を短時間に連打する場合は 120 回/分を超えないようにし、`429` の `Retry-After` を尊重してください。
3. **取り込み後の DELETE**: ダウンロードと SHA-256 の確認が済んだら `DELETE …/recordings/{recordId}` を呼んでください。呼ばれなかった録画も 30 日で自動削除しますが、個人情報を含むため早めの削除を推奨します。
4. **`no_recording_marks` の扱い**: `record: true` でも録画が生成されない会議があります（一覧では `failed` + `error: "no_recording_marks"`、Webhook では `recording.failed`）。SaaS 側で「録画なしで終了」として処理してください。
5. **ダウンロードの上限**: 2048 MB の上限を超える録画は `Content-Length`（一覧の `sizeBytes` と同じ）で事前に判定できます。
6. **中断した転送の再開**: 無通信タイムアウトや Gateway の再起動で転送が途中で切れた場合は、`ETag` が一致することを確認したうえで `Range` による再開を行う方式を推奨します（§4.2）。`ETag` が変わっていた場合は最初からやり直してください。

## 7. 変更しない点の確認

- 既存 4 エンドポイント（`POST /meetings`、`POST /meetings/{id}/join`、`GET /meetings/{id}`、`DELETE /meetings/{id}`）の要求・応答は項目の追加のみで、既存項目の名前・型・意味は変えていません。
- 他テナントの `meetingId` を指定された場合、その会議には到達できません。録画 API では `404` + `recording_not_found`、`GET /meetings/{id}` では存在しない会議として扱われます。
- TLS のみです。Gateway 自体は localhost でのみ待ち受け、nginx が HTTPS を終端します。
- アクセスログに token や joinUrl は残しません。ダウンロードのログは requestId、テナント、recordId、ステータス、送信バイト数のみです。
- 録画の保存場所: 本体は `meet.ooak.jp` の `/var/bigbluebutton/published/video/<recordId>/video-0.m4v`（処理の元データは `/var/bigbluebutton/recording/raw/<recordId>`）、アーカイブは Wasabi `wasabi:webrtc/tenants/lunar-one/recordings/<recordId>/`（サーバー側 AES-256 暗号化）です。保持期間は会議終了から 30 日です。
- 削除の確実性: DELETE の応答時点で API からは不可視になり、root 権限の purge タイマーが 10 分以内に本体・元データ・ステータス・アーカイブをすべて物理削除します。purge が失敗した場合は削除要求が残り、成功するまで 5 分ごとに再試行します（失敗は systemd のログで運用側が監視します）。

ご不明な点や、仕様書の記載と実際の挙動に差異がありましたら、requestId を添えてお知らせください。
