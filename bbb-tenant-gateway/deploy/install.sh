#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 /opt/bbb-tenant-gateway/releases/<release>" >&2
  exit 1
fi

release_dir="$(readlink -f "$1")"
install_root="/opt/bbb-tenant-gateway"
current_link="${install_root}/current"
config_dir="/etc/bbb-tenant-gateway"
environment_file="/etc/default/bbb-tenant-gateway"
service_file="/etc/systemd/system/bbb-tenant-gateway.service"
nginx_file="/etc/bigbluebutton/nginx/bbb-tenant-gateway.nginx"
service_user="bbb-tenant-gateway"
service_group="bbb-tenant-gateway"
wasabi_config_dir="/etc/bbb-recording-wasabi"
wasabi_environment_file="/etc/default/bbb-recording-wasabi"
wasabi_service_file="/etc/systemd/system/bbb-recording-wasabi.service"
wasabi_timer_file="/etc/systemd/system/bbb-recording-wasabi.timer"
wasabi_user="bbb-recording-wasabi"
wasabi_group="bbb-recording-wasabi"
purge_service_file="/etc/systemd/system/bbb-tenant-recording-purge.service"
purge_timer_file="/etc/systemd/system/bbb-tenant-recording-purge.timer"
purge_state_dir="/var/lib/bbb-tenant-recording-purge"
listen_port="3199"
internal_port="3198"

case "${release_dir}" in
  "${install_root}/releases/"*) ;;
  *)
    echo "Release directory must be under ${install_root}/releases/." >&2
    exit 1
    ;;
esac

for required_file in \
  "${release_dir}/dist/index.js" \
  "${release_dir}/package.json" \
  "${release_dir}/deploy/bbb-tenant-gateway.service" \
  "${release_dir}/deploy/bbb-tenant-gateway.nginx" \
  "${release_dir}/deploy/bbb-recording-wasabi.service" \
  "${release_dir}/deploy/bbb-recording-wasabi.timer" \
  "${release_dir}/deploy/bbb-recording-wasabi.env.example" \
  "${release_dir}/deploy/recording-wasabi-sync.py" \
  "${release_dir}/deploy/bbb-tenant-recording-purge.service" \
  "${release_dir}/deploy/bbb-tenant-recording-purge.timer" \
  "${release_dir}/deploy/recording-purge.sh" \
  "${release_dir}/deploy/add-tenant.sh" \
  "${release_dir}/deploy/check-config.sh"; do
  if [[ ! -f "${required_file}" ]]; then
    echo "Missing release file: ${required_file}" >&2
    exit 1
  fi
done

command -v bbb-conf >/dev/null
command -v bbb-record >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
command -v nginx >/dev/null
command -v python3 >/dev/null
command -v rclone >/dev/null
command -v flock >/dev/null

if ! getent group "${service_group}" >/dev/null; then
  groupadd --system "${service_group}"
fi
if ! id "${service_user}" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "${service_group}" \
    --home-dir /nonexistent \
    --shell /usr/sbin/nologin \
    "${service_user}"
fi

if ! getent group "${wasabi_group}" >/dev/null; then
  groupadd --system "${wasabi_group}"
fi
if ! id "${wasabi_user}" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "${wasabi_group}" \
    --home-dir /nonexistent \
    --shell /usr/sbin/nologin \
    "${wasabi_user}"
fi

install -d -o root -g "${service_group}" -m 0750 "${config_dir}"
install -d -o root -g "${wasabi_group}" -m 0750 "${wasabi_config_dir}"
# Root-only working directories of the recording purge worker (tombstones in
# flight and quarantined ones). The gateway user must never be able to reach them.
install -d -o root -g root -m 0700 \
  "${purge_state_dir}" \
  "${purge_state_dir}/inflight" \
  "${purge_state_dir}/quarantine"

if [[ ! -f "${wasabi_config_dir}/rclone.conf" ]]; then
  if [[ -f /root/.config/rclone/rclone.conf ]]; then
    install -o root -g "${wasabi_group}" -m 0640 \
      /root/.config/rclone/rclone.conf \
      "${wasabi_config_dir}/rclone.conf"
  else
    install -o root -g "${wasabi_group}" -m 0640 \
      /dev/null \
      "${wasabi_config_dir}/rclone.conf"
  fi
fi
chown root:"${wasabi_group}" "${wasabi_config_dir}/rclone.conf"
chmod 0640 "${wasabi_config_dir}/rclone.conf"

if [[ ! -f "${wasabi_environment_file}" ]]; then
  install -o root -g "${wasabi_group}" -m 0640 \
    "${release_dir}/deploy/bbb-recording-wasabi.env.example" \
    "${wasabi_environment_file}"
else
  chown root:"${wasabi_group}" "${wasabi_environment_file}"
  chmod 0640 "${wasabi_environment_file}"
fi

# Configuration policy (design D8):
#   * tenants.json is created only when absent and never rewritten;
#   * the env file is MERGED: installer-authoritative keys are overwritten,
#     new keys are added only when missing, every other key is kept verbatim.
CONFIG_DIR="${config_dir}" \
ENVIRONMENT_FILE="${environment_file}" \
SERVICE_GROUP="${service_group}" \
LISTEN_PORT="${listen_port}" \
INTERNAL_PORT="${internal_port}" \
python3 <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
from urllib.parse import urlsplit

config_dir = Path(os.environ["CONFIG_DIR"])
environment_file = Path(os.environ["ENVIRONMENT_FILE"])
service_group = os.environ["SERVICE_GROUP"]
listen_port = os.environ["LISTEN_PORT"]
default_internal_port = os.environ["INTERNAL_PORT"]
bootstrap_tenant = "lunar-one"
credential_file = config_dir / f"{bootstrap_tenant}.api-key"
tenant_file = config_dir / "tenants.json"

TENANT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
# A systemd EnvironmentFile assignment (comments start with # or ; and never match).
ENV_ASSIGNMENT = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")


def write_secret_file(path: Path, content: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(content)


def tenant_env_name(tenant_id: str) -> str:
    name = tenant_id.upper().replace("-", "_") + "_API_KEY_SHA256"
    if not ENV_NAME.match(name):
        raise RuntimeError(f"Tenant {tenant_id} does not map to a valid environment variable name ({name})")
    return name


def systemd_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def systemd_unquote(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        inner = value[1:-1]
        if value[0] == '"':
            return re.sub(r"\\(.)", r"\1", inner)
        return inner
    return value


def parse_environment(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        match = ENV_ASSIGNMENT.match(line)
        if match:
            values[match.group(1)] = systemd_unquote(match.group(2))
    return values


def merge_environment(text: str, overrides: dict[str, str], defaults: dict[str, str]) -> str:
    """Rewrite installer-owned keys in place, add missing defaults, keep everything else verbatim."""
    lines = text.splitlines()
    positions: dict[str, int] = {}
    for index, line in enumerate(lines):
        match = ENV_ASSIGNMENT.match(line)
        if match:
            positions[match.group(1)] = index  # last assignment wins, as in systemd
    for key, value in overrides.items():
        rendered = f"{key}={systemd_quote(value)}"
        if key in positions:
            lines[positions[key]] = rendered
        else:
            lines.append(rendered)
    for key, value in defaults.items():
        if key not in positions and key not in overrides:
            lines.append(f"{key}={systemd_quote(value)}")
    return "\n".join(lines) + "\n"


# --- bootstrap credential for the first tenant (kept from the first release) ---
if not credential_file.exists():
    write_secret_file(credential_file, f"bbbtk_{bootstrap_tenant}_{secrets.token_urlsafe(32)}\n")

# --- BigBlueButton API endpoint and shared secret ---
bbb_output = subprocess.check_output(["bbb-conf", "--secret"], text=True)
url_match = re.search(r"^\s*URL:\s*(\S+)\s*$", bbb_output, re.MULTILINE)
secret_match = re.search(r"^\s*Secret:\s*(\S+)\s*$", bbb_output, re.MULTILINE)
if not url_match or not secret_match:
    raise RuntimeError("Unable to read the BigBlueButton API URL and secret")

bbb_url = url_match.group(1)
bbb_api_base = bbb_url.rstrip("/") + "/api"
bbb_secret = secret_match.group(1)
bbb_host = urlsplit(bbb_url).hostname
if not bbb_host:
    raise RuntimeError(f"Unable to derive the BigBlueButton host name from {bbb_url}")

# --- tenants.json: created only when absent ---
if tenant_file.exists():
    print(f"Keeping existing tenant configuration {tenant_file} (not rewritten by the installer)")
    # The installer never edits an existing file, so point out the one setting
    # a recording tenant is expected to have turned off (moderators pausing
    # the recording leaves gaps the SaaS cannot see).
    try:
        existing_tenants = json.loads(tenant_file.read_text(encoding="utf-8")).get("tenants") or {}
        for existing_id, existing in existing_tenants.items():
            if not isinstance(existing, dict) or not existing.get("allowRecording"):
                continue
            if existing.get("allowStartStopRecording") is not False:
                print(
                    f"WARNING: tenant {existing_id} has allowStartStopRecording=true (or unset): "
                    "moderators can pause recordings. Set it to false in "
                    f"{tenant_file}, validate with deploy/check-config.sh, then restart the gateway."
                )
    except (OSError, ValueError, AttributeError) as error:
        print(f"WARNING: could not inspect {tenant_file}: {error}")
else:
    tenant_config = {
        "version": 1,
        "tenants": {
            bootstrap_tenant: {
                "apiKeySha256Env": tenant_env_name(bootstrap_tenant),
                "meetingIdPrefix": f"{bootstrap_tenant}:",
                "userIdPrefix": f"{bootstrap_tenant}:",
                "allowedOrigins": [],
                "allowModerator": True,
                "allowRecording": True,
                "autoStartRecording": True,
                "allowStartStopRecording": False,
                "maxConcurrentMeetings": 20,
                "maxParticipantsPerMeeting": 100,
                "requestsPerMinute": 120,
                "recordingRetentionDays": 30,
                "maxConcurrentDownloads": 4,
                "media": {
                    "cameraBridge": "livekit",
                    "screenShareBridge": "livekit",
                    "audioBridge": "livekit",
                },
            }
        },
    }
    tenant_file.write_text(json.dumps(tenant_config, indent=2) + "\n", encoding="utf-8")
    print(f"Created tenant configuration {tenant_file}")

# --- env file: merge ---
existing_text = environment_file.read_text(encoding="utf-8") if environment_file.exists() else ""
existing = parse_environment(existing_text)

overrides = {
    "BBB_API_BASE": bbb_api_base,
    "BBB_SECRET": bbb_secret,
    "BBB_CHECKSUM_ALGORITHM": "sha256",
    "TENANT_CONFIG_FILE": str(tenant_file),
    "HOST": "127.0.0.1",
    "PORT": listen_port,
}
for key_file in sorted(config_dir.glob("*.api-key")):
    tenant_id = key_file.name[: -len(".api-key")]
    if not TENANT_ID.match(tenant_id):
        print(f"Skipping credential file with an invalid tenant id: {key_file}")
        continue
    tenant_key = key_file.read_text(encoding="utf-8").strip()
    if not tenant_key:
        raise RuntimeError(f"Credential file is empty: {key_file}")
    overrides[tenant_env_name(tenant_id)] = hashlib.sha256(tenant_key.encode("utf-8")).hexdigest()
    subprocess.run(["chown", "root:root", str(key_file)], check=True)
    subprocess.run(["chmod", "0600", str(key_file)], check=True)

internal_port = existing.get("INTERNAL_PORT", "").strip() or default_internal_port
defaults = {
    "INTERNAL_PORT": default_internal_port,
    "PUBLIC_BASE_URL": f"https://{bbb_host}/tenant-api",
    "RECORDING_READY_CALLBACK_URL": f"http://127.0.0.1:{internal_port}/internal/recording-ready",
}

merged_text = merge_environment(existing_text, overrides, defaults)

if environment_file.exists():
    backup = environment_file.with_name(environment_file.name + ".previous")
    shutil.copy2(environment_file, backup)
    os.chmod(backup, 0o600)

temporary = environment_file.with_name(environment_file.name + ".tmp")
if temporary.exists():
    temporary.unlink()
write_secret_file(temporary, merged_text)
os.replace(temporary, environment_file)

subprocess.run(["chown", f"root:{service_group}", str(tenant_file), str(environment_file)], check=True)
subprocess.run(["chmod", "0640", str(tenant_file), str(environment_file)], check=True)
PY

(
  cd "${release_dir}"
  npm ci --omit=dev --ignore-scripts
)

chown -R root:root "${release_dir}"
find "${release_dir}" -type d -exec chmod 0755 {} +
find "${release_dir}" -type f -exec chmod 0644 {} +
chmod 0755 \
  "${release_dir}/deploy/install.sh" \
  "${release_dir}/deploy/add-tenant.sh" \
  "${release_dir}/deploy/recording-purge.sh" \
  "${release_dir}/deploy/check-config.sh"

previous_release=""
if [[ -L "${current_link}" ]]; then
  previous_release="$(readlink -f "${current_link}")"
fi
ln -sfn "${release_dir}" "${current_link}"

# Point `current` back at the previous release. The purge timer runs
# current/deploy/recording-purge.sh, so it must not stay enabled when the
# previous release does not ship that script.
rollback_release() {
  if [[ -n "${previous_release}" ]]; then
    ln -sfn "${previous_release}" "${current_link}"
    if [[ ! -x "${previous_release}/deploy/recording-purge.sh" ]]; then
      systemctl disable --now bbb-tenant-recording-purge.timer || true
    fi
    systemctl restart bbb-tenant-gateway.service || true
  fi
}

install -o root -g root -m 0644 \
  "${release_dir}/deploy/bbb-tenant-gateway.service" \
  "${service_file}"
install -o root -g root -m 0644 \
  "${release_dir}/deploy/bbb-recording-wasabi.service" \
  "${wasabi_service_file}"
install -o root -g root -m 0644 \
  "${release_dir}/deploy/bbb-recording-wasabi.timer" \
  "${wasabi_timer_file}"
install -o root -g root -m 0644 \
  "${release_dir}/deploy/bbb-tenant-recording-purge.service" \
  "${purge_service_file}"
install -o root -g root -m 0644 \
  "${release_dir}/deploy/bbb-tenant-recording-purge.timer" \
  "${purge_timer_file}"

nginx_backup=""
if [[ -f "${nginx_file}" ]]; then
  nginx_backup="${nginx_file}.previous"
  cp --preserve=mode,ownership,timestamps "${nginx_file}" "${nginx_backup}"
fi
install -o root -g root -m 0644 \
  "${release_dir}/deploy/bbb-tenant-gateway.nginx" \
  "${nginx_file}"

if ! nginx -t; then
  if [[ -n "${nginx_backup}" ]]; then
    mv "${nginx_backup}" "${nginx_file}"
  else
    rm -f "${nginx_file}"
  fi
  exit 1
fi
rm -f "${nginx_backup}"

systemctl daemon-reload
systemctl enable bbb-tenant-gateway.service
systemctl enable --now bbb-recording-wasabi.timer
if ! systemctl restart bbb-tenant-gateway.service; then
  rollback_release
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
  systemctl status bbb-tenant-gateway.service --no-pager || true
  rollback_release
  exit 1
fi

# Only once the new release is confirmed healthy: the timer runs the script
# from `current`, which now definitely ships it.
systemctl enable --now bbb-tenant-recording-purge.timer

systemctl reload nginx

echo "BBB tenant gateway deployment completed."
echo "Tenant credentials: ${config_dir}/<tenant>.api-key (root-only)"
echo "Tenant configuration: ${config_dir}/tenants.json (kept as is; use deploy/add-tenant.sh to add tenants)"
echo "Recording purge worker: bbb-tenant-recording-purge.timer (root, every 5 minutes)"
