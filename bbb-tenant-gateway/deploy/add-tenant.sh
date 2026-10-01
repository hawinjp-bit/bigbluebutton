#!/usr/bin/env bash
#
# Add a tenant to a deployed bbb-tenant-gateway (design D9).
#
#   sudo /opt/bbb-tenant-gateway/current/deploy/add-tenant.sh <tenantId>
#
# * generates /etc/bbb-tenant-gateway/<tenant>.api-key (root, 0600) if absent;
# * merges <TENANT>_API_KEY_SHA256 into /etc/default/bbb-tenant-gateway
#   (never rewrites the file);
# * adds a tenant block to /etc/bbb-tenant-gateway/tenants.json built from an
#   explicit allow-list copied from the template tenant (lunar-one), with
#   meetingIdPrefix/userIdPrefix "<tenant>:" and allowedOrigins [];
# * backs up both files, validates the merged configuration with
#   node dist/check-config.js, restarts the gateway and checks /healthz,
#   restoring the backups when anything fails.
#
# The API key is never printed. Set ADD_TENANT_TEMPLATE to copy from another
# existing tenant.

set -euo pipefail
umask 077

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 <tenantId>" >&2
  exit 1
fi

tenant_id="$1"
if [[ ! "${tenant_id}" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]]; then
  echo "Tenant id must match ^[a-z0-9][a-z0-9-]{1,62}$" >&2
  exit 1
fi

template_tenant="${ADD_TENANT_TEMPLATE:-lunar-one}"
if [[ ! "${template_tenant}" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]]; then
  echo "ADD_TENANT_TEMPLATE must be a valid tenant id" >&2
  exit 1
fi

install_root="/opt/bbb-tenant-gateway"
current_dir="${install_root}/current"
config_dir="/etc/bbb-tenant-gateway"
tenants_file="${config_dir}/tenants.json"
environment_file="/etc/default/bbb-tenant-gateway"
state_directory="/var/lib/bbb-tenant-gateway"
credential_file="${config_dir}/${tenant_id}.api-key"
service_name="bbb-tenant-gateway.service"

for required in "${tenants_file}" "${environment_file}" "${current_dir}/dist/check-config.js" "${current_dir}/deploy/check-config.sh"; do
  if [[ ! -f "${required}" ]]; then
    echo "Missing ${required}; run deploy/install.sh first." >&2
    exit 1
  fi
done
command -v node >/dev/null
command -v python3 >/dev/null
command -v systemctl >/dev/null
command -v curl >/dev/null

# <TENANT>_API_KEY_SHA256, asserted to be a valid environment variable name
# (a tenant id starting with a digit cannot be mapped and is rejected here).
env_name="$(printf '%s' "${tenant_id}" | tr 'a-z-' 'A-Z_')_API_KEY_SHA256"
if [[ ! "${env_name}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
  echo "Tenant ${tenant_id} does not map to a valid environment variable name (${env_name})." >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tenants_backup="${tenants_file}.bak-${timestamp}"
environment_backup="${environment_file}.bak-${timestamp}"

restore_backups() {
  cp --preserve=mode,ownership,timestamps "${tenants_backup}" "${tenants_file}"
  cp --preserve=mode,ownership,timestamps "${environment_backup}" "${environment_file}"
  echo "Restored ${tenants_file} and ${environment_file} from the backups taken at ${timestamp}." >&2
}

if [[ -f "${credential_file}" ]]; then
  echo "Using existing credential file ${credential_file}"
else
  CREDENTIAL_FILE="${credential_file}" TENANT_ID="${tenant_id}" python3 - <<'PY'
import os
import secrets

path = os.environ["CREDENTIAL_FILE"]
tenant_id = os.environ["TENANT_ID"]
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
    stream.write(f"bbbtk_{tenant_id}_{secrets.token_urlsafe(32)}\n")
PY
  echo "Generated credential file ${credential_file}"
fi
chown root:root "${credential_file}"
chmod 0600 "${credential_file}"

cp --preserve=mode,ownership,timestamps "${tenants_file}" "${tenants_backup}"
cp --preserve=mode,ownership,timestamps "${environment_file}" "${environment_backup}"
chmod 0600 "${environment_backup}"

# Update tenants.json (allow-list copy) and merge the key hash into the env file.
TENANTS_FILE="${tenants_file}" \
ENVIRONMENT_FILE="${environment_file}" \
CREDENTIAL_FILE="${credential_file}" \
TENANT_ID="${tenant_id}" \
TEMPLATE_TENANT="${template_tenant}" \
ENV_NAME="${env_name}" \
python3 - <<'PY'
import copy
import hashlib
import json
import os
from pathlib import Path
import re

tenants_file = Path(os.environ["TENANTS_FILE"])
environment_file = Path(os.environ["ENVIRONMENT_FILE"])
credential_file = Path(os.environ["CREDENTIAL_FILE"])
tenant_id = os.environ["TENANT_ID"]
template_tenant = os.environ["TEMPLATE_TENANT"]
env_name = os.environ["ENV_NAME"]

ENV_ASSIGNMENT = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
# Settings copied from the template tenant; everything else is per-environment.
ALLOW_LIST = (
    "allowModerator",
    "allowRecording",
    "autoStartRecording",
    "allowStartStopRecording",
    "maxConcurrentMeetings",
    "maxParticipantsPerMeeting",
    "requestsPerMinute",
    "recordingRetentionDays",
    "media",
    "logoutUrl",
)


def systemd_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def merge_environment(text: str, overrides: dict[str, str]) -> str:
    lines = text.splitlines()
    positions: dict[str, int] = {}
    for index, line in enumerate(lines):
        match = ENV_ASSIGNMENT.match(line)
        if match:
            positions[match.group(1)] = index
    for key, value in overrides.items():
        rendered = f"{key}={systemd_quote(value)}"
        if key in positions:
            lines[positions[key]] = rendered
        else:
            lines.append(rendered)
    return "\n".join(lines) + "\n"


def replace_preserving_mode(path: Path, content: str) -> None:
    status = path.stat()
    temporary = path.with_name(path.name + ".tmp")
    if temporary.exists():
        temporary.unlink()
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(content)
    if hasattr(os, "chown"):
        os.chown(temporary, status.st_uid, status.st_gid)
    os.chmod(temporary, status.st_mode & 0o7777)
    os.replace(temporary, path)


# --- tenants.json ---
config = json.loads(tenants_file.read_text(encoding="utf-8"))
tenants = config.get("tenants")
if not isinstance(tenants, dict):
    raise RuntimeError(f"{tenants_file} has no tenants object")

if tenant_id in tenants:
    print(f"Tenant {tenant_id} already exists in {tenants_file}; its block is left unchanged")
else:
    template = tenants.get(template_tenant)
    if not isinstance(template, dict):
        raise RuntimeError(f"Template tenant {template_tenant} is not configured in {tenants_file}")
    block = {
        "apiKeySha256Env": env_name,
        "meetingIdPrefix": f"{tenant_id}:",
        "userIdPrefix": f"{tenant_id}:",
        "allowedOrigins": [],
    }
    for key in ALLOW_LIST:
        if key in template:
            block[key] = copy.deepcopy(template[key])
    tenants[tenant_id] = block
    replace_preserving_mode(tenants_file, json.dumps(config, indent=2) + "\n")
    print(f"Added tenant {tenant_id} to {tenants_file} (copied from {template_tenant})")

# --- env file ---
tenant_key = credential_file.read_text(encoding="utf-8").strip()
if not tenant_key:
    raise RuntimeError(f"Credential file is empty: {credential_file}")
key_hash = hashlib.sha256(tenant_key.encode("utf-8")).hexdigest()
existing_text = environment_file.read_text(encoding="utf-8")
replace_preserving_mode(environment_file, merge_environment(existing_text, {env_name: key_hash}))
print(f"Merged {env_name} into {environment_file}")
PY

# Validate the merged configuration exactly as the service would load it: a
# transient systemd unit with the service's User/EnvironmentFile/StateDirectory.
# The env file is never sourced by a shell (values are literal in systemd
# syntax; sourcing would shell-expand a third party's webhook secret as root).
if ! GATEWAY_ENVIRONMENT_FILE="${environment_file}" GATEWAY_CURRENT_DIR="${current_dir}" \
     "${current_dir}/deploy/check-config.sh"; then
  echo "Configuration validation failed; rolling back." >&2
  restore_backups
  exit 1
fi

# PORT is read with the same literal parser the installer uses, not by sourcing.
listen_port="$(ENVIRONMENT_FILE="${environment_file}" python3 - <<'PY'
import os
import re

ASSIGNMENT = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")


def unquote(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        inner = value[1:-1]
        return re.sub(r"\\(.)", r"\1", inner) if value[0] == '"' else inner
    return value


values = {}
with open(os.environ["ENVIRONMENT_FILE"], "r", encoding="utf-8") as stream:
    for line in stream:
        match = ASSIGNMENT.match(line)
        if match:
            values[match.group(1)] = unquote(match.group(2))
print(values.get("PORT", "3199"))
PY
)"
if [[ ! "${listen_port}" =~ ^[0-9]{1,5}$ ]]; then
  listen_port="3199"
fi

if ! systemctl restart "${service_name}"; then
  echo "Gateway restart failed; rolling back." >&2
  restore_backups
  systemctl restart "${service_name}" || true
  exit 1
fi

healthy="false"
for _attempt in {1..20}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${listen_port}/healthz" >/dev/null; then
    healthy="true"
    break
  fi
  sleep 0.5
done
if [[ "${healthy}" != "true" ]]; then
  systemctl status "${service_name}" --no-pager || true
  echo "Gateway health check failed; rolling back." >&2
  restore_backups
  systemctl restart "${service_name}" || true
  exit 1
fi

echo "Tenant ${tenant_id} is configured."
echo "API key: ${credential_file} (root-only; hand it over out of band, it is never printed)"
echo "Environment variable: ${env_name} in ${environment_file}"
echo "Backups: ${tenants_backup}, ${environment_backup}"
echo "Note: recordingReadyWebhook (url + secretEnv) and meetingEndedCallbackUrl are per-environment;"
echo "      add them to the tenant block in ${tenants_file}, put the webhook secret in ${environment_file},"
echo "      then run: systemctl restart ${service_name}"
