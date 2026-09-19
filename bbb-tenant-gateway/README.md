# BigBlueButton Tenant Gateway

`bbb-tenant-gateway` gives external services tenant-specific credentials while keeping the BigBlueButton shared secret private. It launches users into the supported BigBlueButton HTML5 client; it does not expose the internal SFU signaling protocol as a public API.

## Features

- One hashed API credential per tenant
- Tenant namespaces for meeting and user IDs
- Tenant-specific moderator, recording, participant, concurrency, origin, and request limits
- Tenant-specific selection of the media bridge types supported by BigBlueButton 3.0
- Signed BigBlueButton `create`, `join`, `isMeetingRunning`, and `end` calls
- No BigBlueButton shared secret in tenant configuration or browser code

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

Configure the BigBlueButton connection. `BBB_API_BASE` must include `/bigbluebutton/api`:

```bash
export BBB_API_BASE='https://bbb.example.com/bigbluebutton/api'
export BBB_SECRET='<output from bbb-conf --secret>'
export TENANT_CONFIG_FILE='config/tenants.json'
```

For local HTTP-only development, set `ALLOW_INSECURE_HTTP=true`. Never enable that in production.

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

The installer obtains the upstream URL and shared secret from `bbb-conf --secret` without printing them. It creates the initial `lunar-one` credential at `/etc/bbb-tenant-gateway/lunar-one.api-key` with mode `0600`; retrieve it once through an administrator channel and place it in the tenant backend's secret store.

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
  "record": false
}
```

Response:

```json
{
  "meetingId": "course-42-session-7",
  "createTime": "1700000000000",
  "created": true
}
```

The gateway sends the internal ID `lunar-one:course-42-session-7` to BigBlueButton. Repeating the request is safe; an existing meeting returns HTTP 200 and `created: false`.

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

### End a meeting

```http
DELETE /v1/tenants/lunar-one/meetings/course-42-session-7
```

## Security notes

- A tenant API key authorizes meeting administration for that tenant. Keep it in a backend secret store, never frontend JavaScript.
- `allowedOrigins` is an additional browser control, not authentication.
- The gateway never returns or logs `BBB_SECRET`.
- `createTime` is required on join so a join URL cannot be reused for a later meeting with the same external ID.
- Callback and logout URLs come from trusted tenant configuration, not request bodies.
- Rotate a tenant key by generating a new key and replacing its configured hash. A production deployment can extend the configuration to accept overlapping key IDs during a rotation window.
