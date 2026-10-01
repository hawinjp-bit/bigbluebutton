import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingRecord, MeetingSession, SessionOutcome } from './types.js';

const STATE_FILE = 'meetings.json';
const STATE_VERSION = 1;
const OUTCOMES = new Set<SessionOutcome>(['ready', 'failed', 'no_recording', 'deleted', 'expired', 'timeout']);

interface PersistedState {
  version: number;
  meetings: Record<string, MeetingRecord>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseSession(value: unknown): MeetingSession | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.recordId !== 'string' || typeof value.createTime !== 'string' || typeof value.createdAt !== 'string') {
    return null;
  }
  const session: MeetingSession = {
    recordId: value.recordId,
    createTime: value.createTime,
    createdAt: value.createdAt,
  };
  if (typeof value.record === 'boolean') session.record = value.record;
  if (typeof value.outcome === 'string' && OUTCOMES.has(value.outcome as SessionOutcome)) {
    session.outcome = value.outcome as SessionOutcome;
  }
  const outcomeAt = optionalString(value.outcomeAt);
  if (outcomeAt !== undefined) session.outcomeAt = outcomeAt;
  const error = optionalString(value.error);
  if (error !== undefined) session.error = error;
  if (value.notifiedReady === true) session.notifiedReady = true;
  if (value.notifiedFailed === true) session.notifiedFailed = true;
  return session;
}

function parseMeeting(key: string, value: unknown): MeetingRecord | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.tenantId !== 'string' || typeof value.meetingId !== 'string') return null;
  if (key !== `${value.tenantId}/${value.meetingId}`) return null;
  if (!Array.isArray(value.sessions)) return null;
  const sessions = value.sessions.map(parseSession).filter((session): session is MeetingSession => session !== null);
  return {
    tenantId: value.tenantId,
    meetingId: value.meetingId,
    record: value.record === true,
    sessions,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
}

function cloneSession(session: MeetingSession): MeetingSession {
  return { ...session };
}

function cloneMeeting(meeting: MeetingRecord): MeetingRecord {
  return { ...meeting, sessions: meeting.sessions.map(cloneSession) };
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The record flag that applies to a session: its own when stored, else the meeting's (older state files). */
export function isRecorded(meeting: Pick<MeetingRecord, 'record'>, session: Pick<MeetingSession, 'record'>): boolean {
  return session.record ?? meeting.record;
}

/**
 * Per-meeting recording memory, persisted as `<stateDir>/meetings.json`.
 *
 * Every write goes through a single promise chain and lands via tmp + rename,
 * so concurrent callers never interleave and a crash never leaves a torn file.
 * Returned records are copies; mutate the store only through its methods.
 */
export class MeetingStateStore {
  private readonly meetings = new Map<string, MeetingRecord>();
  private readonly now: () => Date;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateDir: string,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** Replaces the in-memory state with the persisted one (empty when the file does not exist). */
  async load(): Promise<void> {
    this.meetings.clear();
    let text: string;
    try {
      text = await readFile(join(this.stateDir, STATE_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed) || parsed.version !== STATE_VERSION || !isPlainObject(parsed.meetings)) {
      throw new Error(`${STATE_FILE} has an unsupported format`);
    }
    for (const [key, value] of Object.entries(parsed.meetings)) {
      const meeting = parseMeeting(key, value);
      if (meeting) this.meetings.set(key, meeting);
    }
  }

  get(tenantId: string, meetingId: string): MeetingRecord | undefined {
    const meeting = this.meetings.get(`${tenantId}/${meetingId}`);
    return meeting ? cloneMeeting(meeting) : undefined;
  }

  /**
   * Records the meeting's record flag (latest value) and the session's own record flag, and makes
   * sure the session is tracked. An existing session (same recordId) keeps its createdAt, outcome
   * and notification flags; callers that only know "a recording exists" must look the session up
   * first instead of upserting `true` over a stored `false`.
   */
  async upsertSession(
    tenantId: string,
    meetingId: string,
    record: boolean,
    session: { recordId: string; createTime: string },
  ): Promise<MeetingRecord> {
    const key = `${tenantId}/${meetingId}`;
    const nowIso = this.now().toISOString();
    let meeting = this.meetings.get(key);
    if (!meeting) {
      meeting = { tenantId, meetingId, record, sessions: [], updatedAt: nowIso };
      this.meetings.set(key, meeting);
    }
    meeting.record = record;
    meeting.updatedAt = nowIso;
    const existing = meeting.sessions.find((entry) => entry.recordId === session.recordId);
    if (!existing) {
      meeting.sessions.push({ recordId: session.recordId, createTime: session.createTime, createdAt: nowIso, record });
    } else {
      if (existing.createTime !== session.createTime) existing.createTime = session.createTime;
      existing.record = record;
    }
    await this.persist();
    return cloneMeeting(meeting);
  }

  findByRecordId(recordId: string): { meeting: MeetingRecord; session: MeetingSession } | undefined {
    const found = this.locate(recordId);
    if (!found) return undefined;
    return { meeting: cloneMeeting(found.meeting), session: cloneSession(found.session) };
  }

  /** Sets a terminal outcome; the first outcome wins except that `deleted`/`expired` may replace any other. */
  async setOutcome(recordId: string, outcome: SessionOutcome, error?: string): Promise<void> {
    const found = this.locate(recordId);
    if (!found) return;
    const { meeting, session } = found;
    const terminalDeletion = outcome === 'deleted' || outcome === 'expired';
    if (session.outcome !== undefined && session.outcome !== outcome && !terminalDeletion) return;
    if (session.outcome === outcome && session.error === error) return;
    const nowIso = this.now().toISOString();
    session.outcome = outcome;
    session.outcomeAt = nowIso;
    if (error !== undefined) session.error = error;
    else if (terminalDeletion) delete session.error;
    meeting.updatedAt = nowIso;
    await this.persist();
  }

  async markNotified(recordId: string, kind: 'ready' | 'failed'): Promise<void> {
    const found = this.locate(recordId);
    if (!found) return;
    const { meeting, session } = found;
    if (kind === 'ready') {
      if (session.notifiedReady) return;
      session.notifiedReady = true;
    } else {
      if (session.notifiedFailed) return;
      session.notifiedFailed = true;
    }
    meeting.updatedAt = this.now().toISOString();
    await this.persist();
  }

  /** Recorded sessions (session flag, else the meeting's) without an outcome yet, created within `maxAgeMs`. */
  listPending(maxAgeMs: number): Array<{ meeting: MeetingRecord; session: MeetingSession }> {
    const nowMs = this.now().getTime();
    const result: Array<{ meeting: MeetingRecord; session: MeetingSession }> = [];
    for (const meeting of this.meetings.values()) {
      for (const session of meeting.sessions) {
        if (!isRecorded(meeting, session)) continue;
        if (session.outcome !== undefined) continue;
        if (nowMs - timestampMs(session.createdAt) > maxAgeMs) continue;
        result.push({ meeting: cloneMeeting(meeting), session: cloneSession(session) });
      }
    }
    return result;
  }

  listAll(): MeetingRecord[] {
    return [...this.meetings.values()].map(cloneMeeting);
  }

  /**
   * Drops sessions older than `maxAgeMs` and meetings whose sessions are all gone and that are stale.
   * Age counts from the outcome (outcomeAt, else createdAt) once there is one, from createdAt while
   * pending. A `ready` session is never dropped: it still has to expire or be deleted later.
   */
  async prune(maxAgeMs: number): Promise<void> {
    const nowMs = this.now().getTime();
    let changed = false;
    for (const [key, meeting] of this.meetings) {
      const kept = meeting.sessions.filter((session) => {
        if (session.outcome === 'ready') return true;
        const since = session.outcome === undefined ? session.createdAt : session.outcomeAt ?? session.createdAt;
        return nowMs - timestampMs(since) <= maxAgeMs;
      });
      if (kept.length !== meeting.sessions.length) {
        meeting.sessions = kept;
        changed = true;
      }
      if (kept.length === 0 && nowMs - timestampMs(meeting.updatedAt) > maxAgeMs) {
        this.meetings.delete(key);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private locate(recordId: string): { meeting: MeetingRecord; session: MeetingSession } | undefined {
    for (const meeting of this.meetings.values()) {
      const session = meeting.sessions.find((entry) => entry.recordId === recordId);
      if (session) return { meeting, session };
    }
    return undefined;
  }

  private persist(): Promise<void> {
    const snapshot: PersistedState = { version: STATE_VERSION, meetings: {} };
    for (const [key, meeting] of this.meetings) snapshot.meetings[key] = cloneMeeting(meeting);
    const text = JSON.stringify(snapshot, null, 2);
    const stateDir = this.stateDir;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => writeAtomically(stateDir, text));
    return this.writeChain;
  }
}

async function writeAtomically(stateDir: string, text: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = join(stateDir, STATE_FILE);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
