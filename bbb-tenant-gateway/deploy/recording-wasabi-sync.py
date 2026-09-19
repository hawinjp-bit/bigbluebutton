#!/usr/bin/env python3

"""Copy completed tenant recordings to Wasabi without deleting local files."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
BUCKET_NAME = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")


def env_boolean(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    if value.lower() in {"1", "true", "yes", "on"}:
        return True
    if value.lower() in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required when Wasabi sync is enabled")
    return value


def safe_prefix(value: str) -> str:
    parts = [part for part in value.strip("/").split("/") if part]
    if not parts or any(not SAFE_NAME.fullmatch(part) for part in parts):
        raise ValueError("WASABI_PREFIX must contain only safe path components")
    return "/".join(parts)


@dataclass(frozen=True)
class Settings:
    rclone_binary: Path
    rclone_config: Path
    remote: str
    bucket: str
    prefix: str
    tenant_id: str
    meeting_id_prefix: str
    published_dir: Path
    raw_dir: Path
    state_dir: Path
    dry_run: bool

    @classmethod
    def from_environment(cls) -> "Settings":
        tenant_id = required_env("TENANT_ID")
        remote = required_env("RCLONE_REMOTE").removesuffix(":")
        bucket = required_env("WASABI_BUCKET")
        if not SAFE_NAME.fullmatch(tenant_id):
            raise ValueError("TENANT_ID contains unsupported characters")
        if not SAFE_NAME.fullmatch(remote):
            raise ValueError("RCLONE_REMOTE contains unsupported characters")
        if not BUCKET_NAME.fullmatch(bucket):
            raise ValueError("WASABI_BUCKET is not a valid S3 bucket name")

        rclone_binary = Path(os.environ.get("RCLONE_BINARY", "/usr/bin/rclone"))
        rclone_config = Path(os.environ.get(
            "RCLONE_CONFIG", "/etc/bbb-recording-wasabi/rclone.conf"
        ))
        if not rclone_binary.is_file():
            raise ValueError(f"rclone executable does not exist: {rclone_binary}")
        if not rclone_config.is_file():
            raise ValueError(f"rclone configuration does not exist: {rclone_config}")

        return cls(
            rclone_binary=rclone_binary,
            rclone_config=rclone_config,
            remote=remote,
            bucket=bucket,
            prefix=safe_prefix(os.environ.get(
                "WASABI_PREFIX", f"tenants/{tenant_id}/recordings"
            )),
            tenant_id=tenant_id,
            meeting_id_prefix=os.environ.get(
                "MEETING_ID_PREFIX", f"{tenant_id}:"
            ),
            published_dir=Path(os.environ.get(
                "BBB_PUBLISHED_DIR", "/var/bigbluebutton/published"
            )),
            raw_dir=Path(os.environ.get(
                "BBB_RAW_DIR", "/var/bigbluebutton/recording/raw"
            )),
            state_dir=Path(os.environ.get(
                "STATE_DIRECTORY", "/var/lib/bbb-recording-wasabi"
            )),
            dry_run=env_boolean("WASABI_SYNC_DRY_RUN"),
        )


@dataclass(frozen=True)
class Recording:
    record_id: str
    playback_format: str
    source: Path


def first_metadata_attributes(events_xml: Path) -> dict[str, str]:
    try:
        for _, element in ET.iterparse(events_xml, events=("start",)):
            if element.tag.rsplit("}", 1)[-1] == "metadata":
                return dict(element.attrib)
    except (ET.ParseError, OSError) as error:
        print(f"Skipping unreadable recording metadata {events_xml}: {error}", file=sys.stderr)
    return {}


def belongs_to_tenant(events_xml: Path, tenant_id: str, meeting_id_prefix: str) -> bool:
    metadata = first_metadata_attributes(events_xml)
    return (
        metadata.get("tenantId") == tenant_id
        and metadata.get("meetingId", "").startswith(meeting_id_prefix)
    )


def discover_recordings(settings: Settings) -> list[Recording]:
    recordings: list[Recording] = []
    for published_metadata in sorted(settings.published_dir.glob("*/*/metadata.xml")):
        source = published_metadata.parent
        playback_format = source.parent.name
        record_id = source.name
        if not SAFE_NAME.fullmatch(playback_format) or not SAFE_NAME.fullmatch(record_id):
            print(f"Skipping recording with unsafe path: {source}", file=sys.stderr)
            continue
        events_xml = settings.raw_dir / record_id / "events.xml"
        if belongs_to_tenant(
            events_xml, settings.tenant_id, settings.meeting_id_prefix
        ):
            recordings.append(Recording(record_id, playback_format, source))
    return recordings


def marker_path(settings: Settings, recording: Recording) -> Path:
    return settings.state_dir / recording.record_id / f"{recording.playback_format}.json"


def destination(settings: Settings, recording: Recording) -> str:
    return (
        f"{settings.remote}:{settings.bucket}/{settings.prefix}/"
        f"{recording.record_id}/{recording.playback_format}"
    )


def rclone_command(settings: Settings, operation: str, recording: Recording) -> list[str]:
    command = [
        str(settings.rclone_binary),
        operation,
        str(recording.source),
        destination(settings, recording),
        "--config",
        str(settings.rclone_config),
        "--checksum",
    ]
    if operation == "copy":
        command.extend([
            "--immutable",
            "--s3-server-side-encryption",
            "AES256",
            "--transfers",
            "4",
            "--checkers",
            "8",
        ])
    elif operation == "check":
        command.append("--one-way")
    else:
        raise ValueError(f"Unsupported rclone operation: {operation}")
    if settings.dry_run:
        command.append("--dry-run")
    return command


def write_marker(settings: Settings, recording: Recording) -> None:
    marker = marker_path(settings, recording)
    marker.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "recordId": recording.record_id,
        "format": recording.playback_format,
        "destination": destination(settings, recording),
        "uploadedAt": datetime.now(timezone.utc).isoformat(),
    }
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=marker.parent, delete=False
    ) as temporary:
        json.dump(payload, temporary, separators=(",", ":"))
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    os.chmod(temporary_path, 0o600)
    os.replace(temporary_path, marker)


def sync_recording(settings: Settings, recording: Recording) -> bool:
    if marker_path(settings, recording).exists():
        return False
    print(
        f"Uploading recording {recording.record_id} ({recording.playback_format})"
    )
    subprocess.run(rclone_command(settings, "copy", recording), check=True)
    subprocess.run(rclone_command(settings, "check", recording), check=True)
    if not settings.dry_run:
        write_marker(settings, recording)
    return True


def run() -> int:
    import fcntl

    if not env_boolean("WASABI_SYNC_ENABLED"):
        print("Wasabi recording sync is disabled")
        return 0

    settings = Settings.from_environment()
    settings.state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = settings.state_dir / "sync.lock"
    failures = 0
    uploaded = 0
    with lock_path.open("a", encoding="utf-8") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another Wasabi recording sync is already running")
            return 0

        for recording in discover_recordings(settings):
            try:
                if sync_recording(settings, recording):
                    uploaded += 1
            except subprocess.CalledProcessError as error:
                failures += 1
                print(
                    f"Upload failed for {recording.record_id} "
                    f"({recording.playback_format}), rclone exit {error.returncode}",
                    file=sys.stderr,
                )

    print(f"Wasabi recording sync finished: uploaded={uploaded}, failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except ValueError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
