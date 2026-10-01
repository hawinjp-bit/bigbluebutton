# BigBlueButton Tenant Gateway

`bbb-tenant-gateway` gives external services tenant-specific credentials while keeping the BigBlueButton shared secret private. It launches users into the supported BigBlueButton HTML5 client; it does not expose the internal SFU signaling protocol as a public API.

## Features

- One hashed API credential per tenant
- Tenant namespaces for meeting and user IDs
- Tenant-specific moderator, recording, participant, concurrency, origin, and request limits
- Optional tenant policy to start recording automatically when `record: true` is requested
- Tenant-specific selection of the media bridge types supported by BigBlueButton 3.0
- Signed BigBlueButton `create`, `join`, `getMeetingInfo`, `end`, `getRecordings`, and `deleteRecordings` calls
- No BigBlueButton shared secret in tenant configuration or browser code
- Per-meeting `record` flag with the applied value echoed in the create response and the recording state (`none`, `recording`, `processing`, `ready`, `failed`) in the meeting state
- Recording retrieval API: list, Bearer-authenticated streamed MP4 download with `Range` support, and two-phase deletion (invisible at once, physically purged from BigBlueButton and the Wasabi archive by a root timer within 10 minutes)
- Per-tenant recording retention (default 30 days) with an hourly sweep
- Signed `recording.ready` / `recording.failed` webhooks (HMAC-SHA256, retried, at most once per record ID and event)
- Retried, idempotent copies of completed tenant recordings to Wasabi S3-compatible storage
- `deploy/add-tenant.sh` to add a tenant with a fresh key without printing it

The in-memory rate and concurrency checks are suitable for a single gateway process. A multi-replica deployment should replace them with shared, atomic counters in Redis or another coordination service.

## Configure `lunar-one`

Install dependencies and generate a tenant API key:

```bash
npm ci
npm run keygen -- lunar-one
```

The command prints the API key once and its SHA-256 hash. Give the API key to the `lunar-one` backend secret store. Put only the hash in the gateway secret store:

```bash
export LUNAR_ONE_API_KEY_SHA256='<apiKeySha256 from keygen>'
```

Copy `config/tenants.example.json` to the ignored `config/tenants.json` and replace the example origins and return URL.

The example tenant carries a `recordingReadyWebhook` block. Either delete that block or export `LUNAR_ONE_WEBHOOK_SECRET='<at least 16 characters>'` before `npm start` or `node dist/check-config.js`; the variable name is whatever the tenant's `secretEnv` says.

Configure the BigBlueButton connection. `BBB_API_BASE` must include `/bigbluebutton/api`:

```bash
export BBB_API_BASE='https://bbb.example.com/bigbluebutton/api'
export BBB_SECRET='<output from bbb-conf --secret>'
export TENANT_CONFIG_FILE='config/tenants.json'
```

For local HTTP-only development, set `ALLOW_INSECURE_HTTP=true`. Never enable that in production.

The recording feature needs a writable state directory and knows where BigBlueButton keeps recordings:

```bash
export STATE_DIRECTORY='/var/lib/bbb-tenant-gateway'   # required; systemd sets it via StateDirectory=
export PUBLIC_BASE_URL='https://meet.ooak.jp/tenant-api' # prefix of downloadUrl, no trailing slash
export INTERNAL_PORT=3198                                # loopback listener for BBB's recording-ready callback
```

| Variable | Default |
| --- | --- |
| `STATE_DIRECTORY` | required (`meetings.json`, `webhooks.json`, `purge/` tombstones) |
| `INTERNAL_PORT` | `3198` (must differ from `PORT`) |
| `PUBLIC_BASE_URL` | `https://meet.ooak.jp/tenant-api` |
| `RECORDING_READY_CALLBACK_URL` | `http://127.0.0.1:<INTERNAL_PORT>/internal/recording-ready` |
| `RECORDING_PUBLISHED_DIR` | `/var/bigbluebutton/published` |
| `RECORDING_UNPUBLISHED_DIR` | `/var/bigbluebutton/unpublished` |
| `RECORDING_STATUS_DIR` | `/var/bigbluebutton/recording/status` |
| `RECORDING_POLL_INTERVAL_MS` | `60000` |
| `RETENTION_SWEEP_INTERVAL_MS` | `3600000` |
| `WEBHOOK_RETRY_SCHEDULE_MS` | `60000,300000,900000,3600000,21600000` |
| `BBB_TIMEOUT_MS` | `10000` |
| `<secretEnv>` (e.g. `LUNAR_ONE_WEBHOOK_SECRET`) | required when the tenant has `recordingReadyWebhook`; 16+ characters |

Per-tenant options in `tenants.json`: `recordingRetentionDays` (default 30), `maxConcurrentDownloads` (default 4) and an optional `recordingReadyWebhook: { "url", "secretEnv" }` whose secret (16+ characters) is read from the named environment variable.

Validate any manual edit. In local development, `node dist/check-config.js` with the variables exported above is enough. On a host, `/etc/default/bbb-tenant-gateway` must never be sourced by a shell: its values use systemd `EnvironmentFile` syntax (no expansion, no quoting rules of a shell), and sourcing would put secrets into shell history. Run the check under the service's own environment instead, either with the wrapper:

```bash
sudo /opt/bbb-tenant-gateway/current/deploy/check-config.sh
```

or with the command the wrapper runs:

```bash
sudo systemd-run --quiet --wait --pipe --collect \
  -p EnvironmentFile=/etc/default/bbb-tenant-gateway \
  -p WorkingDirectory=/opt/bbb-tenant-gateway/current \
  -E STATE_DIRECTORY=/var/lib/bbb-tenant-gateway -E NODE_ENV=production \
  /usr/bin/node dist/check-config.js
```

## Run

```bash
npm run typecheck
npm test
npm run build
npm start
```

The default listener is `127.0.0.1:3100`. Set `HOST` and `PORT` to override it. Terminate TLS at a trusted reverse proxy and expose the gateway only through HTTPS.

Deployment templates are available in `deploy/`. The systemd unit expects the current release at `/opt/bbb-tenant-gateway/current`, configuration at `/etc/bbb-tenant-gateway/tenants.json`, and secrets in `/etc/default/bbb-tenant-gateway`. The Nginx template publishes a service listening on port 3199 under `/tenant-api/`; adjust the port and path together if they conflict with the target host.

On a BigBlueButton host, unpack a built release below `/opt/bbb-tenant-gateway/releases/` and run its installer as root:

```bash
sudo ./deploy/install.sh /opt/bbb-tenant-gateway/releases/<release>
```

The installer obtains the upstream URL and shared secret from `bbb-conf --secret` without printing them. It creates the initial `lunar-one` credential at `/etc/bbb-tenant-gateway/lunar-one.api-key` with mode `0600`; retrieve it once through an administrator channel and place it in the tenant backend's secret store. On re-install it leaves an existing `tenants.json` untouched and merges the environment file: installer-owned keys are rewritten, new keys (`INTERNAL_PORT`, `PUBLIC_BASE_URL`, `RECORDING_READY_CALLBACK_URL`) are added only if absent, everything else is preserved. The gateway unit uses `StateDirectory=bbb-tenant-gateway` (mode `0700`).

### Deploying this release

Do the steps in this order:

1. `sudo ./deploy/install.sh /opt/bbb-tenant-gateway/releases/<release>`.
2. Edit `/etc/bbb-tenant-gateway/tenants.json`: set `lunar-one.allowStartStopRecording` to `false` (`install.sh` never rewrites an existing `tenants.json`; it prints a `WARNING` when a recording tenant still allows pause/resume), and optionally `recordingRetentionDays` and `maxConcurrentDownloads`. Validate with `sudo /opt/bbb-tenant-gateway/current/deploy/check-config.sh` (or the `systemd-run` command above), then `sudo systemctl restart bbb-tenant-gateway` and `curl -fsS http://127.0.0.1:3199/healthz`.
3. Only then run `sudo ./deploy/add-tenant.sh lunar-one-staging`; it copies `lunar-one`'s current values, so step 2 must be finished first.
4. Hand the SaaS operator the path of the staging key file (`/etc/bbb-tenant-gateway/lunar-one-staging.api-key`), never the value.

### Adding a tenant

```bash
sudo ./deploy/add-tenant.sh lunar-one-staging
```

The script validates the ID (`^[a-z0-9][a-z0-9-]{1,62}$`), generates `/etc/bbb-tenant-gateway/<tenant>.api-key` (root, `0600`) if absent, writes `<TENANT>_API_KEY_SHA256` into `/etc/default/bbb-tenant-gateway` (merge, never rewrite), adds a tenant block cloned from `lunar-one`'s allow-listed settings with its own `meetingIdPrefix`/`userIdPrefix` (`<tenant>:`) and empty `allowedOrigins`, backs up both files, validates the merged configuration (`dist/check-config.js` run with the merged environment, the same check as `deploy/check-config.sh`), restarts the service and checks `/healthz`. The key is never printed; the tenant operator reads the key file over SSH. Webhook and meeting-ended callback settings are per environment and are added by hand afterwards.

### Recording retention and purge

A recording is deleted either by the tenant (`DELETE .../recordings/{recordId}`) or by the hourly retention sweep once it is older than the tenant's `recordingRetentionDays` (default 30 days after the meeting ended; reported as `expiresAt`). Deletion is two-phase: the gateway writes a tombstone into `${STATE_DIRECTORY}/purge/`, marks the recording deleted (it disappears from the API immediately) and asks BigBlueButton to move it out of the published tree. The root-only `bbb-tenant-recording-purge.timer` (every 5 minutes, `deploy/recording-purge.sh`) validates each tombstone, refuses ids still present under `published/` or `unpublished/`, requires the recording to belong to a configured tenant, then runs `bbb-record --delete` and `rclone purge` on the Wasabi prefix under the Wasabi sync lock. A failed purge keeps the tombstone and retries on the next tick; check `journalctl -u bbb-tenant-recording-purge.service`. Ending a meeting (`DELETE /meetings/{id}`) never deletes recordings.

The nginx template also blocks `/tenant-api/internal/` and disables proxy buffering so downloads stream instead of being spooled to disk.

### Wasabi recording archive

The installer also creates a sandboxed `bbb-recording-wasabi` timer. It is disabled at the configuration level until `/etc/default/bbb-recording-wasabi` contains a bucket and `WASABI_SYNC_ENABLED=true`. Configure a Wasabi remote interactively so the secret is not placed in shell history:

```bash
sudo rclone config --config /etc/bbb-recording-wasabi/rclone.conf
sudo chown root:bbb-recording-wasabi /etc/bbb-recording-wasabi/rclone.conf
sudo chmod 0640 /etc/bbb-recording-wasabi/rclone.conf
```

Set the remote, bucket, tenant, and prefix in `/etc/default/bbb-recording-wasabi`, then verify and start one sync:

```bash
sudo -u bbb-recording-wasabi rclone lsd \
  --config /etc/bbb-recording-wasabi/rclone.conf \
  wasabi:BUCKET_NAME
sudo systemctl start bbb-recording-wasabi.service
sudo journalctl -u bbb-recording-wasabi.service --no-pager
```

The worker accepts a recording only when the archived BBB metadata contains both `tenantId=lunar-one` and an external meeting ID beginning with `lunar-one:`. Each completed playback format is copied to:

```text
s3://BUCKET_NAME/tenants/lunar-one/recordings/RECORD_ID/FORMAT/
```

Uploads use HTTPS through rclone, request AES-256 server-side encryption, support a bucket-scoped key without bucket-creation permission, run an integrity check, and write a local idempotency marker only after verification. The worker never deletes local BigBlueButton recordings. BBB playback continues to use the local published copy; Wasabi is the durable archive, not the playback origin.

### meet.ooak.jp branding

`deploy/configure-meet-branding.sh` applies the deployment-specific `meet`
label, replaces user-visible `BigBlueButton` labels in every installed client
locale, redirects the help link to the local portal, and disables the default
PDF presentation. Install it as a persistent post-upgrade customization:

```bash
sudo install -o root -g root -m 0755 \
  deploy/configure-meet-branding.sh \
  /usr/local/sbin/configure-meet-branding
sudo /usr/local/sbin/configure-meet-branding
```

Add `/usr/local/sbin/configure-meet-branding` to
`/etc/bigbluebutton/bbb-conf/apply-config.sh` so package upgrades reapply the
index and locale changes. Restart `bbb-apps-akka.service` and `bbb-web.service`
after applying it. Existing meetings retain presentations already loaded into
that meeting; the disabled default presentation applies to newly created
meetings.

## API

All tenant endpoints require:

```http
Authorization: Bearer <tenant-api-key>
Content-Type: application/json
```

### Create a meeting

```http
POST /v1/tenants/lunar-one/meetings

{
  "meetingId": "course-42-session-7",
  "name": "Course 42",
  "record": true
}
```

Response:

```json
{
  "meetingId": "course-42-session-7",
  "createTime": "1700000000000",
  "created": true,
  "record": true
}
```

The gateway sends the internal ID `lunar-one:course-42-session-7` to BigBlueButton. Repeating the request is safe; an existing meeting returns HTTP 200 and `created: false`, and `record` always reports the value actually in force for the meeting.

When the tenant has `allowRecording` enabled, `record: true` enables recording with the tenant's `autoStartRecording` and `allowStartStopRecording` policy (the production setting for `lunar-one` is `autoStartRecording=true` and `allowStartStopRecording=false`, set during rollout step 2 under "Deploying this release": recording starts automatically and moderators cannot pause it). `record: true` on a tenant with `allowRecording: false` is rejected with `403 recording_not_allowed`. A request with `record: false` is not recorded or uploaded.

### Create a participant join URL

```http
POST /v1/tenants/lunar-one/meetings/course-42-session-7/join

{
  "createTime": "1700000000000",
  "userId": "user-1842",
  "displayName": "Ada Lovelace",
  "role": "VIEWER",
  "autoJoinAudio": false,
  "autoShareWebcam": false
}
```

Response:

```json
{
  "meetingId": "course-42-session-7",
  "joinUrl": "https://bbb.example.com/bigbluebutton/api/join?..."
}
```

Return the URL only to the authenticated participant and navigate that participant's browser directly to it. Do not fetch it on the tenant backend. Do not log the complete URL.

### Check meeting state

```http
GET /v1/tenants/lunar-one/meetings/course-42-session-7
```

Response:

```json
{
  "meetingId": "course-42-session-7",
  "running": true,
  "record": true,
  "recording": { "state": "recording", "recordId": "3a1c8eb5b0f6f2c8c9d1e2f3a4b5c6d7e8f90123-1700000000000" }
}
```

`recording.state` is `none`, `recording`, `processing`, `ready` or `failed`; `recording.reason` explains `none`/`failed` (`no_recording_marks`, `deleted`, `expired`, `timeout`, or a BigBlueButton marker name).

### End a meeting

```http
DELETE /v1/tenants/lunar-one/meetings/course-42-session-7
```

Ending a meeting never deletes its recordings.

### List recordings

```http
GET /v1/tenants/lunar-one/meetings/course-42-session-7/recordings
```

Returns `{ "items": [...] }` with one item per recorded session: `recordId`, `meetingId`, `state` (`processing` | `ready` | `failed`), `startedAt`, `endedAt`, `durationSec`, `mime` (`video/mp4`), `sizeBytes`, `filename`, `downloadUrl`, `playbackUrl` (always `null`), `createdAt`, `expiresAt`, `error`. Only the MP4 (`video`) format is exposed; deleted and expired recordings are omitted.

### Download a recording

```http
GET /v1/tenants/lunar-one/meetings/course-42-session-7/recordings/<recordId>/download
```

Streams the MP4 under the same Bearer token with `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, `ETag` and `Content-Disposition`; a single `Range` returns 206, `HEAD` is supported. `409 recording_not_ready` while processing (and for a meeting that produced nothing), `404 recording_not_found` for unknown, foreign or deleted ids, `429 too_many_downloads` above `maxConcurrentDownloads`. A gateway restart cuts in-flight downloads after about 10 s; resume with `Range`.

### Delete a recording

```http
DELETE /v1/tenants/lunar-one/meetings/course-42-session-7/recordings/<recordId>
```

Returns `202 { "recordId", "status": "deleting" }`. The recording is invisible immediately and physically purged within 10 minutes (see "Recording retention and purge").

### Recording-ready webhook

When a tenant configures `recordingReadyWebhook`, the gateway POSTs `{ event, tenant, meetingId, recordId, occurredAt, error? }` with `X-Gateway-Timestamp`, `X-Gateway-Signature: v1=<hex HMAC-SHA256(secret, "v1:" + timestamp + ":" + rawBody)>` and `X-Gateway-Event-Id`, retrying after 1 min, 5 min, 15 min, 1 h and 6 h.

The full reference, state table, error catalogue and a worked signature example are in `docs/recording-api.md`; the OpenAPI 3.1 description is `docs/openapi.yaml`.

## Security notes

- A tenant API key authorizes meeting administration for that tenant. Keep it in a backend secret store, never frontend JavaScript.
- `allowedOrigins` is an additional browser control, not authentication.
- The gateway never returns or logs `BBB_SECRET`.
- `createTime` is required on join so a join URL cannot be reused for a later meeting with the same external ID.
- Callback and logout URLs come from trusted tenant configuration, not request bodies.
- Rotate a tenant key by generating a new key and replacing its configured hash. A production deployment can extend the configuration to accept overlapping key IDs during a rotation window.
