#!/usr/bin/env bash
#
# Physically purge recordings the tenant gateway has tombstoned.
#
# Runs as root from bbb-tenant-recording-purge.timer (every 5 minutes). The
# gateway (an unprivileged user) only writes tombstones; everything in its
# state directory is treated as UNTRUSTED input:
#
#   1. a tombstone is purge/<recordId>.json; the id comes from the file name,
#      must match ^[a-f0-9]{40}-[0-9]{10,16}$ and must equal the JSON recordId,
#      otherwise the file is quarantined;
#   2. the tombstone is moved into the root-owned inflight directory before
#      anything is acted on, so the gateway user can no longer touch it;
#   3. an id still present under published/*/<id> or unpublished/*/<id> is
#      refused (the gateway must have logically deleted it first);
#   4. the recording must belong to a configured tenant: the tenantid read from
#      deleted/*/<id>/metadata.xml or recording/raw/<id>/events.xml must be a
#      key of /etc/bbb-tenant-gateway/tenants.json;
#   5. under the Wasabi sync lock: bbb-record --delete, rclone purge (values from
#      the root-owned Wasabi env file only), rm -rf the sync marker directory,
#      then delete the inflight tombstone.
#
# Any failure keeps the tombstone for the next tick and makes the run exit 1.
# Only validated record ids ever become part of a path.
#
# Optional root-only overrides (for staging/dry runs):
#   PURGE_DRY_RUN=true          log the destructive steps instead of running them
#   GATEWAY_STATE_DIR, PURGE_STATE_DIR, BBB_DIR, TENANTS_FILE,
#   WASABI_ENV_FILE, WASABI_STATE_DIR, BBB_RECORD_BINARY

set -euo pipefail
umask 077

readonly LOG_TAG="bbb-tenant-recording-purge"
readonly RECORD_ID_PATTERN='^[a-f0-9]{40}-[0-9]{10,16}$'
readonly TENANT_ID_PATTERN='^[a-z0-9][a-z0-9-]{1,62}$'
# Same rules as deploy/recording-wasabi-sync.py (SAFE_NAME / BUCKET_NAME).
readonly SAFE_NAME_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
readonly BUCKET_NAME_PATTERN='^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
readonly MAX_TOMBSTONE_BYTES=65536
readonly LOCK_WAIT_SECONDS=600

gateway_state_dir="${GATEWAY_STATE_DIR:-/var/lib/bbb-tenant-gateway}"
purge_state_dir="${PURGE_STATE_DIR:-/var/lib/bbb-tenant-recording-purge}"
bbb_dir="${BBB_DIR:-/var/bigbluebutton}"
tenants_file="${TENANTS_FILE:-/etc/bbb-tenant-gateway/tenants.json}"
wasabi_env_file="${WASABI_ENV_FILE:-/etc/default/bbb-recording-wasabi}"
wasabi_state_dir="${WASABI_STATE_DIR:-/var/lib/bbb-recording-wasabi}"
bbb_record_binary="${BBB_RECORD_BINARY:-bbb-record}"
dry_run="${PURGE_DRY_RUN:-false}"

tombstone_dir="${gateway_state_dir}/purge"
inflight_dir="${purge_state_dir}/inflight"
quarantine_dir="${purge_state_dir}/quarantine"

log() {
  local message="$*"
  echo "${message}"
  logger -t "${LOG_TAG}" -- "${message}" 2>/dev/null || true
}

log_error() {
  local message="$*"
  echo "${message}" >&2
  logger -t "${LOG_TAG}" -p user.err -- "${message}" 2>/dev/null || true
}

die() {
  log_error "$*"
  exit 1
}

is_dry_run() {
  [[ "${dry_run}" == "true" || "${dry_run}" == "1" || "${dry_run}" == "yes" ]]
}

# Rejects symlinks: the gateway user owns its state directory and must not be
# able to redirect root's directory operations elsewhere.
require_real_directory() {
  local path="$1" what="$2"
  if [[ -L "${path}" ]]; then
    die "${what} ${path} is a symlink; refusing to continue"
  fi
  if [[ ! -d "${path}" ]]; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Wasabi settings: read ONLY from the root-owned env file, never from the
# process environment, never sourced. Sets wasabi_* globals.
# ---------------------------------------------------------------------------
wasabi_enabled="false"
wasabi_destination_base=""
wasabi_rclone_binary=""
wasabi_rclone_config=""
wasabi_tenant_id=""

load_wasabi_settings() {
  local -A values=()
  local line key value
  if [[ ! -f "${wasabi_env_file}" ]]; then
    log "Wasabi env file ${wasabi_env_file} is absent; archive purge disabled"
    return 0
  fi
  if [[ "$(stat -c '%u' "${wasabi_env_file}")" != "0" ]]; then
    die "${wasabi_env_file} is not owned by root; refusing to use it"
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ "${line}" =~ ^[[:space:]]*$ ]] && continue
    [[ "${line}" =~ ^[[:space:]]*[#\;] ]] && continue
    [[ "${line}" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${value}" =~ ^\"(.*)\"$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ "${value}" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    values["${key}"]="${value}"
  done <"${wasabi_env_file}"

  local enabled
  enabled="${values[WASABI_SYNC_ENABLED]:-false}"
  case "${enabled,,}" in
    true|1|yes|on) ;;
    *)
      log "WASABI_SYNC_ENABLED is not true in ${wasabi_env_file}; archive purge skipped"
      return 0
      ;;
  esac

  local remote bucket prefix tenant_id part
  remote="${values[RCLONE_REMOTE]:-}"
  remote="${remote%:}"
  bucket="${values[WASABI_BUCKET]:-}"
  tenant_id="${values[TENANT_ID]:-}"
  prefix="${values[WASABI_PREFIX]:-}"
  if [[ -z "${tenant_id}" || ! "${tenant_id}" =~ ${SAFE_NAME_PATTERN} ]]; then
    die "TENANT_ID in ${wasabi_env_file} is empty or unsafe"
  fi
  if [[ -z "${remote}" || ! "${remote}" =~ ${SAFE_NAME_PATTERN} ]]; then
    die "RCLONE_REMOTE in ${wasabi_env_file} is empty or unsafe"
  fi
  if [[ -z "${bucket}" || ! "${bucket}" =~ ${BUCKET_NAME_PATTERN} ]]; then
    die "WASABI_BUCKET in ${wasabi_env_file} is empty or not a valid bucket name"
  fi
  if [[ -z "${prefix}" ]]; then
    prefix="tenants/${tenant_id}/recordings"
  fi
  prefix="${prefix#/}"
  prefix="${prefix%/}"
  local -a parts=()
  IFS='/' read -r -a parts <<<"${prefix}"
  if [[ "${#parts[@]}" -eq 0 ]]; then
    die "WASABI_PREFIX in ${wasabi_env_file} is empty"
  fi
  for part in "${parts[@]}"; do
    if [[ -z "${part}" || ! "${part}" =~ ${SAFE_NAME_PATTERN} ]]; then
      die "WASABI_PREFIX in ${wasabi_env_file} contains an unsafe path component"
    fi
  done

  wasabi_rclone_binary="${values[RCLONE_BINARY]:-/usr/bin/rclone}"
  wasabi_rclone_config="${values[RCLONE_CONFIG]:-/etc/bbb-recording-wasabi/rclone.conf}"
  if [[ "${wasabi_rclone_binary}" != /* || ! -x "${wasabi_rclone_binary}" ]]; then
    die "RCLONE_BINARY ${wasabi_rclone_binary} is not an executable absolute path"
  fi
  if [[ "${wasabi_rclone_config}" != /* || ! -f "${wasabi_rclone_config}" ]]; then
    die "RCLONE_CONFIG ${wasabi_rclone_config} is not an absolute path to a file"
  fi

  wasabi_enabled="true"
  wasabi_tenant_id="${tenant_id}"
  wasabi_destination_base="${remote}:${bucket}/${prefix}"
  log "Wasabi archive purge enabled for ${wasabi_destination_base}"
}

# ---------------------------------------------------------------------------
# Tombstone intake: purge/<id>.json -> inflight/<id>.json (or quarantine).
# ---------------------------------------------------------------------------
tombstone_json_matches() {
  local file="$1" record_id="$2"
  TOMBSTONE_FILE="${file}" EXPECTED_RECORD_ID="${record_id}" \
  MAX_BYTES="${MAX_TOMBSTONE_BYTES}" python3 - <<'PY'
import json
import os
import sys

path = os.environ["TOMBSTONE_FILE"]
expected = os.environ["EXPECTED_RECORD_ID"]
limit = int(os.environ["MAX_BYTES"])
try:
    if os.path.islink(path) or not os.path.isfile(path):
        sys.exit(1)
    if os.path.getsize(path) > limit:
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as stream:
        payload = json.load(stream)
except (OSError, ValueError, UnicodeDecodeError):
    sys.exit(1)
if not isinstance(payload, dict):
    sys.exit(1)
sys.exit(0 if payload.get("recordId") == expected else 1)
PY
}

quarantine() {
  local file="$1" reason="$2"
  local name target
  name="$(basename -- "${file}")"
  target="${quarantine_dir}/${name}.$(date -u +%Y%m%dT%H%M%SZ).$$"
  if mv -f -- "${file}" "${target}"; then
    log_error "Quarantined tombstone ${name}: ${reason} -> ${target}"
  else
    log_error "Could not quarantine tombstone ${name} (${reason}); leaving it in place"
  fi
}

intake_tombstones() {
  local file name record_id target
  if ! require_real_directory "${tombstone_dir}" "Tombstone directory"; then
    log "No tombstone directory at ${tombstone_dir}; nothing to take in"
    return 0
  fi
  # find -P (the default) never follows symlinks, so -type f excludes them.
  while IFS= read -r -d '' file; do
    name="$(basename -- "${file}")"
    record_id="${name%.json}"
    if [[ ! "${record_id}" =~ ${RECORD_ID_PATTERN} ]]; then
      quarantine "${file}" "file name is not a record id"
      continue
    fi
    target="${inflight_dir}/${record_id}.json"
    if [[ -e "${target}" ]]; then
      # Already in flight from an earlier tick; the newer copy carries no extra information.
      log "Tombstone ${record_id} already in flight; dropping duplicate"
      rm -f -- "${file}"
      continue
    fi
    if ! mv -f -- "${file}" "${target}"; then
      log_error "Could not move tombstone ${record_id} into ${inflight_dir}"
      continue
    fi
    if [[ -L "${target}" || ! -f "${target}" ]]; then
      quarantine "${target}" "not a regular file after move"
      continue
    fi
    if ! tombstone_json_matches "${target}" "${record_id}"; then
      quarantine "${target}" "JSON recordId does not match the file name"
      continue
    fi
    log "Tombstone ${record_id} accepted"
  done < <(find "${tombstone_dir}" -mindepth 1 -maxdepth 1 -type f -name '*.json' -print0)
}

# ---------------------------------------------------------------------------
# Ownership: prints "owned <tenant>", "foreign", "unknown" or "error ...".
# ---------------------------------------------------------------------------
recording_owner() {
  local record_id="$1"
  # The pattern is passed under a different name: TENANT_ID_PATTERN is readonly
  # in this shell, and a command-prefix assignment to a readonly variable fails.
  RECORD_ID="${record_id}" BBB_DIR="${bbb_dir}" TENANTS_FILE="${tenants_file}" \
  TENANT_PATTERN="${TENANT_ID_PATTERN}" python3 - <<'PY'
import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

record_id = os.environ["RECORD_ID"]
bbb_dir = os.environ["BBB_DIR"]
tenants_file = os.environ["TENANTS_FILE"]
tenant_pattern = re.compile(os.environ["TENANT_PATTERN"])


def local_name(tag):
    return tag.rsplit("}", 1)[-1].lower()


def deleted_tenant():
    pattern = os.path.join(bbb_dir, "deleted", "*", record_id, "metadata.xml")
    for metadata_xml in sorted(glob.glob(pattern)):
        try:
            root = ET.parse(metadata_xml).getroot()
        except (ET.ParseError, OSError):
            continue
        for element in root:
            if local_name(element.tag) != "meta":
                continue
            values = {local_name(child.tag): (child.text or "") for child in element}
            if values.get("tenantid"):
                return values["tenantid"]
    return None


def raw_tenant():
    events_xml = os.path.join(bbb_dir, "recording", "raw", record_id, "events.xml")
    if not os.path.isfile(events_xml):
        return None
    try:
        for _, element in ET.iterparse(events_xml, events=("start",)):
            if local_name(element.tag) == "metadata":
                values = {local_name(key): value for key, value in element.attrib.items()}
                return values.get("tenantid") or None
    except (ET.ParseError, OSError):
        return None
    return None


try:
    with open(tenants_file, "r", encoding="utf-8") as stream:
        tenants = json.load(stream).get("tenants") or {}
except (OSError, ValueError, AttributeError):
    print("error tenants.json unreadable")
    sys.exit(2)
if not isinstance(tenants, dict):
    print("error tenants.json malformed")
    sys.exit(2)

tenant = deleted_tenant() or raw_tenant()
if tenant is None:
    print("unknown")
elif tenant_pattern.fullmatch(tenant) and tenant in tenants:
    print(f"owned {tenant}")
else:
    print("foreign")
PY
}

tenant_is_configured() {
  local tenant_id="$1"
  [[ "${tenant_id}" =~ ${TENANT_ID_PATTERN} ]] || return 1
  TENANTS_FILE="${tenants_file}" TENANT_ID="${tenant_id}" python3 - <<'PY'
import json
import os
import sys

try:
    with open(os.environ["TENANTS_FILE"], "r", encoding="utf-8") as stream:
        tenants = json.load(stream).get("tenants") or {}
except (OSError, ValueError, AttributeError):
    sys.exit(2)
sys.exit(0 if isinstance(tenants, dict) and os.environ["TENANT_ID"] in tenants else 1)
PY
}

still_available() {
  local record_id="$1" candidate
  for candidate in "${bbb_dir}"/published/*/"${record_id}" "${bbb_dir}"/unpublished/*/"${record_id}"; do
    if [[ -e "${candidate}" ]]; then
      return 0
    fi
  done
  return 1
}

run_or_log() {
  if is_dry_run; then
    log "[dry-run] $*"
    return 0
  fi
  "$@"
}

# Prints the recursive listing of a prefix. A prefix that was never written
# (the recording was deleted before the sync worker's tick, or the worker was
# enabled later) makes rclone 1.53 exit 3 with "directory not found" on S3;
# that is an empty listing, not a failure.
list_archive() {
  local destination="$1" output rc=0
  output="$("${wasabi_rclone_binary}" lsf --recursive --config "${wasabi_rclone_config}" --retries 3 "${destination}" 2>&1)" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    if [[ "${output}" == *"directory not found"* ]]; then
      printf ''
      return 0
    fi
    printf '%s' "${output}"
    return 1
  fi
  printf '%s' "${output}"
}

purge_archive() {
  local record_id="$1"
  local destination="${wasabi_destination_base}/${record_id}"
  local listing
  if [[ "${wasabi_enabled}" != "true" ]]; then
    log "Archive purge skipped for ${record_id} (Wasabi sync disabled)"
    return 0
  fi
  if ! listing="$(list_archive "${destination}")"; then
    log_error "rclone lsf failed for ${destination}: ${listing}"
    return 1
  fi
  if [[ -z "${listing}" ]]; then
    log "Archive already empty for ${record_id} (${destination})"
    return 0
  fi
  if ! run_or_log "${wasabi_rclone_binary}" purge --config "${wasabi_rclone_config}" --retries 3 "${destination}"; then
    log_error "rclone purge failed for ${destination}"
    return 1
  fi
  if is_dry_run; then
    return 0
  fi
  if ! listing="$(list_archive "${destination}")"; then
    log_error "rclone lsf (verification) failed for ${destination}: ${listing}"
    return 1
  fi
  if [[ -n "${listing}" ]]; then
    log_error "Archive objects remain after purge for ${destination}"
    return 1
  fi
  log "Archive purged for ${record_id} (${destination})"
  return 0
}

process_inflight() {
  local file="$1"
  local name record_id owner tenant marker_dir
  name="$(basename -- "${file}")"
  record_id="${name%.json}"
  if [[ ! "${record_id}" =~ ${RECORD_ID_PATTERN} ]]; then
    quarantine "${file}" "inflight file name is not a record id"
    return 1
  fi

  if still_available "${record_id}"; then
    log_error "Refusing to purge ${record_id}: still under published/ or unpublished/ (gateway must deleteRecordings first); retrying next tick"
    return 1
  fi

  owner="$(recording_owner "${record_id}")" || true
  marker_dir="${wasabi_state_dir}/${record_id}"
  tenant=""
  case "${owner}" in
    owned\ *)
      tenant="${owner#owned }"
      ;;
    unknown)
      if [[ -d "${marker_dir}" && ! -L "${marker_dir}" && "${wasabi_enabled}" == "true" ]] \
        && tenant_is_configured "${wasabi_tenant_id}"; then
        # BBB has nothing left for this id, but the Wasabi worker archived it:
        # that worker verified tenantid == TENANT_ID before uploading.
        tenant="${wasabi_tenant_id}"
        log "No BBB metadata left for ${record_id}; ownership taken from the archive marker (${tenant})"
      else
        log "Nothing left to purge for ${record_id} (no BBB metadata, no archive marker); clearing tombstone"
        run_or_log rm -f -- "${file}" || return 1
        return 0
      fi
      ;;
    foreign)
      log_error "Refusing to purge ${record_id}: tenantid is not a configured tenant"
      return 1
      ;;
    *)
      log_error "Could not determine the owner of ${record_id}: ${owner}"
      return 1
      ;;
  esac

  log "Purging ${record_id} (tenant ${tenant})"
  if ! run_or_log "${bbb_record_binary}" --delete "${record_id}" </dev/null; then
    log_error "bbb-record --delete failed for ${record_id}"
    return 1
  fi
  if ! purge_archive "${record_id}"; then
    return 1
  fi
  if [[ -L "${marker_dir}" ]]; then
    run_or_log rm -f -- "${marker_dir}" || return 1
  elif [[ -e "${marker_dir}" ]]; then
    run_or_log rm -rf -- "${marker_dir}" || return 1
  fi
  run_or_log rm -f -- "${file}" || return 1
  log "Purged ${record_id} (tenant ${tenant})"
  return 0
}

ensure_wasabi_lock_file() {
  local lock_file="${wasabi_state_dir}/sync.lock"
  local owner="bbb-recording-wasabi"
  if [[ ! -d "${wasabi_state_dir}" ]]; then
    mkdir -p -m 0700 "${wasabi_state_dir}"
    if id "${owner}" >/dev/null 2>&1; then
      chown "${owner}:${owner}" "${wasabi_state_dir}" || true
    fi
  fi
  if [[ ! -e "${lock_file}" ]]; then
    # The sync worker (unprivileged) must still be able to open the lock file.
    if id "${owner}" >/dev/null 2>&1; then
      install -o "${owner}" -g "${owner}" -m 0600 /dev/null "${lock_file}"
    else
      install -m 0600 /dev/null "${lock_file}"
    fi
  fi
  echo "${lock_file}"
}

main() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "Run this script as root."
  fi
  command -v python3 >/dev/null || die "python3 is required"
  command -v flock >/dev/null || die "flock is required"
  if [[ ! -f "${tenants_file}" ]]; then
    die "Tenant configuration ${tenants_file} is missing"
  fi
  if [[ "$(stat -c '%u' "${tenants_file}")" != "0" ]]; then
    die "${tenants_file} is not owned by root; refusing to continue"
  fi

  install -d -o root -g root -m 0700 "${purge_state_dir}" "${inflight_dir}" "${quarantine_dir}"
  require_real_directory "${inflight_dir}" "Inflight directory" || die "Inflight directory ${inflight_dir} is missing"
  if [[ -e "${gateway_state_dir}" ]]; then
    require_real_directory "${gateway_state_dir}" "Gateway state directory" || true
  fi

  intake_tombstones

  local -a inflight=()
  local file
  while IFS= read -r -d '' file; do
    inflight+=("${file}")
  done < <(find "${inflight_dir}" -mindepth 1 -maxdepth 1 -type f -name '*.json' -print0 | sort -z)

  if [[ "${#inflight[@]}" -eq 0 ]]; then
    log "No tombstones to purge"
    return 0
  fi

  load_wasabi_settings
  if ! command -v "${bbb_record_binary}" >/dev/null; then
    die "${bbb_record_binary} is not available; ${#inflight[@]} tombstone(s) kept"
  fi

  local lock_file
  lock_file="$(ensure_wasabi_lock_file)"
  exec 9>>"${lock_file}"
  if ! flock -w "${LOCK_WAIT_SECONDS}" 9; then
    die "Could not acquire ${lock_file} within ${LOCK_WAIT_SECONDS}s; ${#inflight[@]} tombstone(s) kept"
  fi

  local failures=0 purged=0
  for file in "${inflight[@]}"; do
    if process_inflight "${file}"; then
      purged=$((purged + 1))
    else
      failures=$((failures + 1))
    fi
  done
  flock -u 9 || true

  log "Purge run finished: processed=${purged} failed=${failures}"
  if [[ "${failures}" -gt 0 ]]; then
    return 1
  fi
  return 0
}

main "$@"
