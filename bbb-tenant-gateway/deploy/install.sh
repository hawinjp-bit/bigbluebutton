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
listen_port="3199"

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
  "${release_dir}/deploy/bbb-tenant-gateway.nginx"; do
  if [[ ! -f "${required_file}" ]]; then
    echo "Missing release file: ${required_file}" >&2
    exit 1
  fi
done

command -v bbb-conf >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
command -v nginx >/dev/null
command -v python3 >/dev/null

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

install -d -o root -g "${service_group}" -m 0750 "${config_dir}"

CONFIG_DIR="${config_dir}" \
ENVIRONMENT_FILE="${environment_file}" \
SERVICE_GROUP="${service_group}" \
LISTEN_PORT="${listen_port}" \
python3 <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

config_dir = Path(os.environ["CONFIG_DIR"])
environment_file = Path(os.environ["ENVIRONMENT_FILE"])
service_group = os.environ["SERVICE_GROUP"]
listen_port = os.environ["LISTEN_PORT"]
credential_file = config_dir / "lunar-one.api-key"
tenant_file = config_dir / "tenants.json"

if credential_file.exists():
    tenant_key = credential_file.read_text(encoding="utf-8").strip()
    if not tenant_key:
        raise RuntimeError(f"Credential file is empty: {credential_file}")
else:
    tenant_key = f"bbbtk_lunar-one_{secrets.token_urlsafe(32)}"
    descriptor = os.open(credential_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(tenant_key + "\n")

api_key_hash = hashlib.sha256(tenant_key.encode("utf-8")).hexdigest()
bbb_output = subprocess.check_output(["bbb-conf", "--secret"], text=True)
url_match = re.search(r"^\s*URL:\s*(\S+)\s*$", bbb_output, re.MULTILINE)
secret_match = re.search(r"^\s*Secret:\s*(\S+)\s*$", bbb_output, re.MULTILINE)
if not url_match or not secret_match:
    raise RuntimeError("Unable to read the BigBlueButton API URL and secret")

bbb_api_base = url_match.group(1).rstrip("/") + "/api"
bbb_secret = secret_match.group(1)

tenant_config = {
    "version": 1,
    "tenants": {
        "lunar-one": {
            "apiKeySha256Env": "LUNAR_ONE_API_KEY_SHA256",
            "meetingIdPrefix": "lunar-one:",
            "userIdPrefix": "lunar-one:",
            "allowedOrigins": [],
            "allowModerator": True,
            "allowRecording": False,
            "maxConcurrentMeetings": 20,
            "maxParticipantsPerMeeting": 100,
            "requestsPerMinute": 120,
            "media": {
                "cameraBridge": "livekit",
                "screenShareBridge": "livekit",
                "audioBridge": "livekit",
            },
        }
    },
}
tenant_file.write_text(json.dumps(tenant_config, indent=2) + "\n", encoding="utf-8")

def systemd_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

environment = {
    "BBB_API_BASE": bbb_api_base,
    "BBB_SECRET": bbb_secret,
    "BBB_CHECKSUM_ALGORITHM": "sha256",
    "TENANT_CONFIG_FILE": str(tenant_file),
    "LUNAR_ONE_API_KEY_SHA256": api_key_hash,
    "HOST": "127.0.0.1",
    "PORT": listen_port,
}
environment_file.write_text(
    "".join(f"{name}={systemd_quote(value)}\n" for name, value in environment.items()),
    encoding="utf-8",
)

subprocess.run(["chown", f"root:{service_group}", tenant_file, environment_file], check=True)
subprocess.run(["chmod", "0640", tenant_file, environment_file], check=True)
subprocess.run(["chown", "root:root", credential_file], check=True)
subprocess.run(["chmod", "0600", credential_file], check=True)
PY

(
  cd "${release_dir}"
  npm ci --omit=dev --ignore-scripts
)

chown -R root:root "${release_dir}"
find "${release_dir}" -type d -exec chmod 0755 {} +
find "${release_dir}" -type f -exec chmod 0644 {} +
chmod 0755 "${release_dir}/deploy/install.sh"

previous_release=""
if [[ -L "${current_link}" ]]; then
  previous_release="$(readlink -f "${current_link}")"
fi
ln -sfn "${release_dir}" "${current_link}"

install -o root -g root -m 0644 \
  "${release_dir}/deploy/bbb-tenant-gateway.service" \
  "${service_file}"

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
if ! systemctl restart bbb-tenant-gateway.service; then
  if [[ -n "${previous_release}" ]]; then
    ln -sfn "${previous_release}" "${current_link}"
    systemctl restart bbb-tenant-gateway.service || true
  fi
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
  if [[ -n "${previous_release}" ]]; then
    ln -sfn "${previous_release}" "${current_link}"
    systemctl restart bbb-tenant-gateway.service || true
  fi
  exit 1
fi

systemctl reload nginx

echo "BBB tenant gateway deployment completed."
echo "Tenant credential: ${config_dir}/lunar-one.api-key (root-only)"
