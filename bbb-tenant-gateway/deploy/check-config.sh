#!/usr/bin/env bash
#
# Validate the deployed gateway configuration exactly as the service loads it.
#
#   sudo /opt/bbb-tenant-gateway/current/deploy/check-config.sh
#
# The environment file is in systemd EnvironmentFile syntax: values are taken
# literally, never shell-expanded. Sourcing it with a shell would expand `$`,
# backticks and `$(...)` inside the double-quoted values the installer writes,
# which is both a different parse from the one the service gets and, for a
# value supplied by a third party (a tenant's webhook secret), a way to run
# commands as root. So the check runs as a transient systemd unit with the
# same User, EnvironmentFile and StateDirectory as bbb-tenant-gateway.service.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

environment_file="${GATEWAY_ENVIRONMENT_FILE:-/etc/default/bbb-tenant-gateway}"
current_dir="${GATEWAY_CURRENT_DIR:-/opt/bbb-tenant-gateway/current}"
service_user="${GATEWAY_SERVICE_USER:-bbb-tenant-gateway}"

for required in "${environment_file}" "${current_dir}/dist/check-config.js"; do
  if [[ ! -f "${required}" ]]; then
    echo "Missing ${required}; run deploy/install.sh first." >&2
    exit 1
  fi
done
command -v systemd-run >/dev/null

exec systemd-run --quiet --wait --pipe --collect \
  --unit "bbb-tenant-gateway-check-config-$$" \
  -p "User=${service_user}" \
  -p "EnvironmentFile=${environment_file}" \
  -p "WorkingDirectory=${current_dir}" \
  -p StateDirectory=bbb-tenant-gateway \
  -p StateDirectoryMode=0700 \
  -E NODE_ENV=production \
  /usr/bin/node dist/check-config.js
