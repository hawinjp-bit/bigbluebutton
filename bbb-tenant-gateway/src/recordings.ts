import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { BbbRecordingState, MeetingSession, RecordingPaths, SessionOutcome } from './types.js';

/** BigBlueButton internalMeetingID: sha1 hex of the external meeting ID + '-' + createTime. */
export const RECORD_ID_PATTERN = /^[a-f0-9]{40}-\d{10,16}$/;

const VIDEO_FORMAT = 'video';
const VIDEO_FILE = 'video-0.m4v';
const METADATA_FILE = 'metadata.xml';
const PURGE_DIR = 'purge';

export function recordIdFor(bbbMeetingId: string, createTime: string): string {
  return `${createHash('sha1').update(bbbMeetingId, 'utf8').digest('hex')}-${createTime}`;
}

function assertRecordId(recordId: string): void {
  if (!RECORD_ID_PATTERN.test(recordId)) throw new Error('Invalid recordId');
}

/** Raised when the purge tombstone could not be persisted; nothing else has been touched. */
export class TombstoneWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TombstoneWriteError';
  }
}

export interface Tombstone {
  recordId: string;
  tenantId: string;
  meetingId: string;
  requestedAt: string;
}

/** Writes `<stateDir>/purge/<recordId>.json` atomically; the root purge worker consumes it. */
export async function writeTombstone(stateDir: string, tombstone: Tombstone): Promise<void> {
  assertRecordId(tombstone.recordId);
  const directory = join(stateDir, PURGE_DIR);
  const target = join(directory, `${tombstone.recordId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(tombstone, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new TombstoneWriteError((error as Error).message);
  }
}

export async function hasTombstone(stateDir: string, recordId: string): Promise<boolean> {
  if (!RECORD_ID_PATTERN.test(recordId)) return false;
  return exists(join(stateDir, PURGE_DIR, `${recordId}.json`));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface MarkerProbe {
  /** archived/<id>.norecord: the meeting ended without recording marks; nothing will be produced. */
  norecord: boolean;
  /** First present fail marker (relative to the status dir) of the video pipeline, or null. */
  failMarker: string | null;
  /** published/<id>-video.done */
  videoDone: boolean;
}

/** Reads the status markers the gateway cares about; every other marker (e.g. presentation) is ignored. */
export async function probeMarkers(paths: RecordingPaths, recordId: string): Promise<MarkerProbe> {
  assertRecordId(recordId);
  // Video-specific failures first so they win over the pipeline-wide ones when several exist.
  const failMarkers = [
    `processed/${recordId}-${VIDEO_FORMAT}.fail`,
    `published/${recordId}-${VIDEO_FORMAT}.fail`,
    `archived/${recordId}.fail`,
    `sanity/${recordId}.fail`,
  ];
  const [norecord, videoDone, ...fails] = await Promise.all([
    exists(join(paths.statusDir, 'archived', `${recordId}.norecord`)),
    exists(join(paths.statusDir, 'published', `${recordId}-${VIDEO_FORMAT}.done`)),
    ...failMarkers.map((marker) => exists(join(paths.statusDir, ...marker.split('/')))),
  ]);
  const failIndex = fails.findIndex((present) => present);
  return {
    norecord: norecord === true,
    failMarker: failIndex >= 0 ? failMarkers[failIndex] ?? null : null,
    videoDone: videoDone === true,
  };
}

export interface VideoFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function videoDirectories(paths: RecordingPaths, recordId: string): string[] {
  return [join(paths.publishedDir, VIDEO_FORMAT, recordId), join(paths.unpublishedDir, VIDEO_FORMAT, recordId)];
}

/** Locates `video-0.m4v` under published/ then unpublished/. */
export async function findVideoFile(paths: RecordingPaths, recordId: string): Promise<VideoFile | null> {
  assertRecordId(recordId);
  for (const directory of videoDirectories(paths, recordId)) {
    const path = join(directory, VIDEO_FILE);
    try {
      const info = await stat(path);
      if (info.isFile()) return { path, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      // try the next location
    }
  }
  return null;
}

export interface VideoMetadata {
  durationMs: number | null;
  startTime: string | null;
  endTime: string | null;
  /** <meta> children with lowercased keys. */
  meta: Record<string, string>;
}

type XmlValue = string | XmlNode | XmlValue[];
interface XmlNode {
  [tag: string]: XmlValue | undefined;
}

function isNode(value: XmlValue | undefined): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: XmlValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const metadataParser = new XMLParser({ parseTagValue: false, trimValues: true });

/** Parses the format's metadata.xml (published/ then unpublished/). */
export async function readVideoMetadata(paths: RecordingPaths, recordId: string): Promise<VideoMetadata | null> {
  assertRecordId(recordId);
  for (const directory of videoDirectories(paths, recordId)) {
    let text: string;
    try {
      text = await readFile(join(directory, METADATA_FILE), 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = metadataParser.parse(text);
    } catch {
      return null;
    }
    const recording = isNode(parsed as XmlValue) ? (parsed as XmlNode).recording : undefined;
    if (!isNode(recording)) return null;
    const playback = isNode(recording.playback) ? recording.playback : undefined;
    const duration = Number(textOf(playback?.duration));
    const meta: Record<string, string> = {};
    if (isNode(recording.meta)) {
      for (const [key, value] of Object.entries(recording.meta)) {
        if (typeof value === 'string') meta[key.toLowerCase()] = value;
      }
    }
    return {
      durationMs: Number.isFinite(duration) && textOf(playback?.duration) !== null ? duration : null,
      startTime: textOf(recording.start_time),
      endTime: textOf(recording.end_time),
      meta,
    };
  }
  return null;
}

export type ClassifiedState = 'deleted' | 'none' | 'ready' | 'failed' | 'processing';

export interface Classification {
  state: ClassifiedState;
  reason?: string;
}

/**
 * Single source of truth for a recording's state. Order matters:
 * deleted (tombstone / deleted / expired) → none (no recording marks) → ready → failed → processing.
 * A stored `ready` outcome, or BigBlueButton listing the recording as published/unpublished, stands
 * in for the published marker, which BigBlueButton's cron removes after 14 days.
 */
export function classify(input: {
  probe: MarkerProbe;
  video: VideoFile | null;
  tombstone: boolean;
  outcome?: SessionOutcome;
  error?: string;
  /** State from getRecordings when the caller has one; terminal evidence for recordings with no stored outcome. */
  listedState?: BbbRecordingState;
}): Classification {
  const { probe, video, tombstone, outcome, error, listedState } = input;
  if (tombstone || outcome === 'deleted' || outcome === 'expired') {
    return { state: 'deleted', reason: outcome === 'expired' ? 'expired' : 'deleted' };
  }
  if (probe.norecord || outcome === 'no_recording') return { state: 'none', reason: 'no_recording_marks' };
  const videoFailed = probe.failMarker !== null
    && (probe.failMarker.includes(`-${VIDEO_FORMAT}.fail`));
  const listedPublished = listedState === 'published' || listedState === 'unpublished';
  if (video && (probe.videoDone || outcome === 'ready' || listedPublished) && !videoFailed) return { state: 'ready' };
  if (probe.failMarker !== null) return { state: 'failed', reason: probe.failMarker };
  if (outcome === 'failed') return { state: 'failed', reason: error ?? 'failed' };
  if (outcome === 'timeout') return { state: 'failed', reason: 'timeout' };
  return { state: 'processing' };
}

export interface Inspection extends Classification {
  probe: MarkerProbe;
  video: VideoFile | null;
  tombstone: boolean;
  /** true when any gateway-relevant marker or the video file exists. */
  evidence: boolean;
}

/** Gathers markers, file and tombstone for a recordId and classifies it (with BBB's listed state when known). */
export async function inspectRecording(
  paths: RecordingPaths,
  stateDir: string,
  recordId: string,
  session?: Pick<MeetingSession, 'outcome' | 'error'>,
  listedState?: BbbRecordingState,
): Promise<Inspection> {
  const [probe, video, tombstone] = await Promise.all([
    probeMarkers(paths, recordId),
    findVideoFile(paths, recordId),
    hasTombstone(stateDir, recordId),
  ]);
  const classification = classify({
    probe,
    video,
    tombstone,
    outcome: session?.outcome,
    error: session?.error,
    listedState,
  });
  return {
    ...classification,
    probe,
    video,
    tombstone,
    evidence: probe.norecord || probe.failMarker !== null || probe.videoDone || video !== null,
  };
}
