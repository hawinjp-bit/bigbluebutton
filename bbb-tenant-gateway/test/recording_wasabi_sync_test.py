from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "deploy" / "recording-wasabi-sync.py"
SPEC = importlib.util.spec_from_file_location("recording_wasabi_sync", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class RecordingWasabiSyncTest(unittest.TestCase):
    def settings(self, root: Path):
        return MODULE.Settings(
            rclone_binary=Path("/usr/bin/rclone"),
            rclone_config=root / "rclone.conf",
            remote="wasabi",
            bucket="example-recordings",
            prefix="tenants/lunar-one/recordings",
            tenant_id="lunar-one",
            meeting_id_prefix="lunar-one:",
            published_dir=root / "published",
            raw_dir=root / "raw",
            state_dir=root / "state",
            dry_run=False,
        )

    def add_recording(
        self,
        settings,
        record_id: str,
        tenant_id: str,
        meeting_id: str,
        playback_format: str = "presentation",
        published_metadata: bool = False,
        raw_metadata: bool = True,
    ) -> None:
        published = settings.published_dir / playback_format / record_id
        published.mkdir(parents=True)
        # BigBlueButton lowercases meta_ keys (tenantid) but keeps its own
        # entries camelCase (meetingId); the readers must accept both.
        published_body = (
            f'<recording><meta><tenantid>{tenant_id}</tenantid>'
            f'<meetingId>{meeting_id}</meetingId></meta></recording>'
            if published_metadata
            else "<recording />"
        )
        (published / "metadata.xml").write_text(published_body, encoding="utf-8")
        if raw_metadata:
            raw = settings.raw_dir / record_id
            raw.mkdir(parents=True)
            (raw / "events.xml").write_text(
                f'<recording><metadata tenantid="{tenant_id}" '
                f'meetingId="{meeting_id}" /></recording>',
                encoding="utf-8",
            )

    def test_discovers_only_recordings_with_both_tenant_markers(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = self.settings(Path(directory))
            self.add_recording(settings, "record-1", "lunar-one", "lunar-one:meeting-1")
            self.add_recording(settings, "record-2", "other", "lunar-one:meeting-2")
            self.add_recording(settings, "record-3", "lunar-one", "other:meeting-3")

            recordings = MODULE.discover_recordings(settings)

            self.assertEqual([recording.record_id for recording in recordings], ["record-1"])

    def test_discovers_recording_after_raw_metadata_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = self.settings(Path(directory))
            self.add_recording(
                settings,
                "record-1",
                "lunar-one",
                "lunar-one:meeting-1",
                published_metadata=True,
                raw_metadata=False,
            )

            recordings = MODULE.discover_recordings(settings)

            self.assertEqual([recording.record_id for recording in recordings], ["record-1"])

    def test_sync_copies_checks_and_writes_an_idempotency_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = self.settings(Path(directory))
            self.add_recording(settings, "record-1", "lunar-one", "lunar-one:meeting-1")
            recording = MODULE.discover_recordings(settings)[0]

            with mock.patch.object(MODULE.subprocess, "run") as run:
                uploaded = MODULE.sync_recording(settings, recording)
                uploaded_again = MODULE.sync_recording(settings, recording)

            self.assertTrue(uploaded)
            self.assertFalse(uploaded_again)
            self.assertEqual(run.call_count, 2)
            copy_command = run.call_args_list[0].args[0]
            check_command = run.call_args_list[1].args[0]
            destination = (
                "wasabi:example-recordings/tenants/lunar-one/recordings/"
                "record-1/presentation"
            )
            self.assertEqual(copy_command[1:4], ["copy", str(recording.source), destination])
            self.assertIn("--immutable", copy_command)
            self.assertIn("--s3-no-check-bucket", copy_command)
            self.assertEqual(check_command[1:4], ["check", str(recording.source), destination])
            self.assertTrue(MODULE.marker_path(settings, recording).is_file())

    def test_metadata_readers_lowercase_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events_xml = root / "events.xml"
            events_xml.write_text(
                '<recording><metadata tenantId="lunar-one" MeetingId="lunar-one:m" />'
                "</recording>",
                encoding="utf-8",
            )
            metadata_xml = root / "metadata.xml"
            metadata_xml.write_text(
                "<recording><meta><tenantid>lunar-one</tenantid>"
                "<meetingId>lunar-one:m</meetingId></meta></recording>",
                encoding="utf-8",
            )

            raw_values = MODULE.first_metadata_attributes(events_xml)
            published_values = MODULE.published_metadata_values(metadata_xml)

            self.assertEqual(raw_values, {"tenantid": "lunar-one", "meetingid": "lunar-one:m"})
            self.assertEqual(
                published_values, {"tenantid": "lunar-one", "meetingid": "lunar-one:m"}
            )
            self.assertTrue(MODULE.metadata_matches(raw_values, "lunar-one", "lunar-one:"))
            self.assertTrue(MODULE.metadata_matches(published_values, "lunar-one", "lunar-one:"))
            self.assertFalse(MODULE.metadata_matches({"tenantId": "lunar-one"}, "lunar-one", ""))

    def test_rejects_parent_directory_in_object_prefix(self):
        with self.assertRaises(ValueError):
            MODULE.safe_prefix("tenants/../recordings")


if __name__ == "__main__":
    unittest.main()
