import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hasTombstone, inspectRecording, RECORD_ID_PATTERN, writeTombstone } from './recordings.js';
import { isRecorded, type MeetingStateStore } from './state-store.js';
import type {
  BbbClientLike,
  BbbRecordingState,
  GatewayConfig,
  MeetingRecord,
  MeetingSession,
  SessionOutcome,
  TenantConfig,
  WebhookEvent,
} from './types.js';
import type { WebhookQueue } from './webhook.js';

/** A pending session with no marker and no BigBlueButton entry after this long is reported as failed. */
export const PENDING_TIMEOUT_MS = 48 * 3_600_000;
/** State entries are forgotten after this long. */
export const STATE_RETENTION_MS = 90 * 86_400_000;
const ALL_STATES: BbbRecordingState[] = ['processing', 'processed', 'published', 'unpublished', 'deleted'];
const DAY_MS = 86_400_000;
/** Format directories assumed under published/ and unpublished/ when they cannot be listed. */
const FALLBACK_FORMATS = ['video', 'presentation'];

export type MonitorLogger = (line: Record<string, unknown>) => void;

export interface RecordingMonitorDeps {
  config: GatewayConfig;
  bbb: BbbClientLike;
  store: MeetingStateStore;
  webhooks: WebhookQueue;
  now?: () => Date;
  logger?: MonitorLogger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Format subdirectories of a BBB public tree; [] when the tree is absent, a fixed guess when unreadable. */
async function formatDirectories(base: string): Promise<string[]> {
  try {
    return await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return FALLBACK_FORMATS;
  }
}

/**
 * Watches recorded sessions until they reach a terminal state, notifies the
 * tenant webhook (at most one `recording.ready` and one `recording.failed`
 * per recordId, never `failed` after `ready`) and enforces retention.
 */
export class RecordingMonitor {
  private readonly config: GatewayConfig;
  private readonly bbb: BbbClientLike;
  private readonly store: MeetingStateStore;
  private readonly webhooks: WebhookQueue;
  private readonly now: () => Date;
  private readonly logger: MonitorLogger;
  /** How long state entries are kept: long enough for every tenant's retention sweep to see them. */
  private readonly stateRetentionMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private sweeping = false;

  constructor(deps: RecordingMonitorDeps) {
    this.config = deps.config;
    this.bbb = deps.bbb;
    this.store = deps.store;
    this.webhooks = deps.webhooks;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? ((line) => console.log(JSON.stringify(line)));
    let maxRetentionDays = 0;
    for (const tenant of this.config.tenants.values()) {
      maxRetentionDays = Math.max(maxRetentionDays, tenant.recordingRetentionDays);
    }
    this.stateRetentionMs = Math.max(STATE_RETENTION_MS, maxRetentionDays * DAY_MS + PENDING_TIMEOUT_MS + 7 * DAY_MS);
  }

  start(): void {
    if (this.pollTimer || this.sweepTimer) return;
    this.pollTimer = setInterval(() => void this.pollOnce(), this.config.recording.pollIntervalMs);
    this.sweepTimer = setInterval(() => void this.sweepOnce(), this.config.recording.retentionSweepIntervalMs);
    this.pollTimer.unref();
    this.sweepTimer.unref();
    // Deletions that BigBlueButton rejected while the previous process ran are re-issued at once.
    void this.retryBbbDeletes();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = null;
    this.sweepTimer = null;
  }

  /** Re-evaluates one session right away (BigBlueButton callback), then flushes due webhooks. */
  async checkNow(recordId: string): Promise<void> {
    try {
      const found = this.store.findByRecordId(recordId);
      if (found && isRecorded(found.meeting, found.session) && found.session.outcome === undefined) {
        await this.evaluate(found.meeting, found.session);
      }
    } catch (error) {
      this.log({ level: 'error', message: 'recording check failed', recordId, error: errorMessage(error) });
    }
    await this.webhooks.processDue();
  }

  /** One poller tick: delete retries, every pending session, state pruning, then due webhooks. Never throws. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.retryBbbDeletes();
      for (const meeting of this.store.listAll()) {
        for (const session of meeting.sessions) {
          if (!isRecorded(meeting, session)) continue;
          if (session.outcome !== undefined) continue;
          try {
            await this.evaluate(meeting, session);
          } catch (error) {
            this.log({
              level: 'error',
              message: 'recording poll failed',
              tenantId: meeting.tenantId,
              recordId: session.recordId,
              error: errorMessage(error),
            });
          }
        }
      }
      await this.store.prune(this.stateRetentionMs);
    } catch (error) {
      this.log({ level: 'error', message: 'recording poll failed', error: errorMessage(error) });
    } finally {
      this.polling = false;
    }
    await this.webhooks.processDue();
  }

  /**
   * Re-issues BigBlueButton deleteRecordings for every logically deleted session whose id is still
   * under published/ or unpublished/ (BBB was down, answered notFound while a format was still
   * processing, or published a format after the purge finished). Idempotent; never throws.
   * A missing tombstone is rewritten so the root purge worker cleans up the late format too.
   */
  async retryBbbDeletes(): Promise<void> {
    const { paths, stateDir } = this.config.recording;
    let trees: Array<{ base: string; formats: string[] }> | undefined;
    for (const meeting of this.store.listAll()) {
      for (const session of meeting.sessions) {
        if (session.outcome !== 'deleted' && session.outcome !== 'expired') continue;
        if (!RECORD_ID_PATTERN.test(session.recordId)) continue;
        try {
          trees ??= await Promise.all([paths.publishedDir, paths.unpublishedDir].map(async (base) => ({
            base,
            formats: await formatDirectories(base),
          })));
          if (!(await this.publiclyPresent(trees, session.recordId))) continue;

          let result: boolean | null = null;
          let error: string | undefined;
          try {
            result = await this.bbb.deleteRecording(session.recordId);
          } catch (caught) {
            error = errorMessage(caught);
          }
          this.log({
            level: error ? 'warn' : 'info',
            message: 'recording delete re-issued',
            tenantId: meeting.tenantId,
            recordId: session.recordId,
            result,
            error,
          });

          if (!(await hasTombstone(stateDir, session.recordId))) {
            await writeTombstone(stateDir, {
              recordId: session.recordId,
              tenantId: meeting.tenantId,
              meetingId: meeting.meetingId,
              requestedAt: this.now().toISOString(),
            });
            this.log({
              level: 'info',
              message: 'recording tombstone rewritten',
              tenantId: meeting.tenantId,
              recordId: session.recordId,
            });
          }
        } catch (error) {
          this.log({
            level: 'error',
            message: 'recording delete retry failed',
            tenantId: meeting.tenantId,
            recordId: session.recordId,
            error: errorMessage(error),
          });
        }
      }
    }
  }

  private async publiclyPresent(trees: Array<{ base: string; formats: string[] }>, recordId: string): Promise<boolean> {
    for (const { base, formats } of trees) {
      for (const format of formats) {
        if (await pathExists(join(base, format, recordId))) return true;
      }
    }
    return false;
  }

  /** Retention sweep (D6): expires recordings older than the tenant's retention. Never throws. */
  async sweepOnce(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const tenant of this.config.tenants.values()) {
        try {
          await this.sweepTenant(tenant);
        } catch (error) {
          this.log({ level: 'error', message: 'retention sweep failed', tenantId: tenant.id, error: errorMessage(error) });
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Tombstone first, then the stored outcome, then BigBlueButton. Throws TombstoneWriteError only. */
  async deleteRecording(
    tenant: TenantConfig,
    meetingId: string,
    recordId: string,
    outcome: 'deleted' | 'expired',
  ): Promise<void> {
    if (!RECORD_ID_PATTERN.test(recordId)) throw new Error('Invalid recordId');
    await writeTombstone(this.config.recording.stateDir, {
      recordId,
      tenantId: tenant.id,
      meetingId,
      requestedAt: this.now().toISOString(),
    });

    const known = this.store.findByRecordId(recordId);
    if (!known) {
      const createTime = recordId.slice(recordId.indexOf('-') + 1);
      await this.store.upsertSession(tenant.id, meetingId, true, { recordId, createTime });
    }
    await this.store.setOutcome(recordId, outcome);

    let bbbDeleted: boolean | null = null;
    let error: string | undefined;
    try {
      bbbDeleted = await this.bbb.deleteRecording(recordId);
    } catch (caught) {
      error = errorMessage(caught);
    }
    this.log({
      level: error ? 'warn' : 'info',
      message: 'recording delete requested',
      tenantId: tenant.id,
      recordId,
      outcome,
      bbbDeleted,
      error,
    });
  }

  private async evaluate(meeting: MeetingRecord, session: MeetingSession): Promise<void> {
    const { paths, stateDir } = this.config.recording;
    const inspection = await inspectRecording(paths, stateDir, session.recordId, session);
    const tenant = this.config.tenants.get(meeting.tenantId);

    switch (inspection.state) {
      case 'deleted':
        return;
      case 'ready':
        await this.store.setOutcome(session.recordId, 'ready');
        await this.notify(tenant, meeting, session, 'recording.ready');
        return;
      case 'none':
        await this.store.setOutcome(session.recordId, 'no_recording', 'no_recording_marks');
        await this.notify(tenant, meeting, session, 'recording.failed', 'no_recording_marks');
        return;
      case 'failed':
        await this.store.setOutcome(session.recordId, 'failed', inspection.reason);
        await this.notify(tenant, meeting, session, 'recording.failed', inspection.reason ?? 'failed');
        return;
      case 'processing':
        break;
    }

    if (inspection.evidence) return;
    const ageMs = this.now().getTime() - timestampMs(session.createdAt);
    if (ageMs <= PENDING_TIMEOUT_MS) return;
    const listed = await this.bbb.getRecordings({ recordID: session.recordId, states: ALL_STATES });
    if (listed.length > 0) return;
    await this.store.setOutcome(session.recordId, 'timeout', 'timeout');
    await this.notify(tenant, meeting, session, 'recording.failed', 'timeout');
  }

  private async notify(
    tenant: TenantConfig | undefined,
    meeting: MeetingRecord,
    session: MeetingSession,
    event: WebhookEvent['event'],
    error?: string,
  ): Promise<void> {
    const current = this.store.findByRecordId(session.recordId)?.session ?? session;
    if (event === 'recording.ready' && current.notifiedReady) return;
    if (event === 'recording.failed' && (current.notifiedFailed || current.notifiedReady)) return;

    const webhook = tenant?.recordingReadyWebhook;
    if (webhook) {
      const body: WebhookEvent = {
        event,
        tenant: meeting.tenantId,
        meetingId: meeting.meetingId,
        recordId: session.recordId,
        occurredAt: this.now().toISOString(),
      };
      if (error !== undefined) body.error = error;
      await this.webhooks.enqueue({ tenantId: meeting.tenantId, url: webhook.url, secret: webhook.secret, body });
    }
    await this.store.markNotified(session.recordId, event === 'recording.ready' ? 'ready' : 'failed');
    this.log({
      level: 'info',
      message: 'recording outcome',
      tenantId: meeting.tenantId,
      meetingId: meeting.meetingId,
      recordId: session.recordId,
      event,
      error,
      webhook: webhook !== undefined,
    });
  }

  private async sweepTenant(tenant: TenantConfig): Promise<void> {
    const nowMs = this.now().getTime();
    const retentionMs = tenant.recordingRetentionDays * DAY_MS;
    const { paths, stateDir } = this.config.recording;
    const handled = new Set<string>();

    const listed = await this.bbb.getRecordings({ metaTenantId: tenant.id, states: ['published', 'unpublished'] });
    for (const recording of listed) {
      if (!recording.meetingID.startsWith(tenant.meetingIdPrefix)) continue;
      if (recording.metadata.tenantid !== tenant.id) continue;
      if (!RECORD_ID_PATTERN.test(recording.recordID)) continue;
      const endTime = Number(recording.endTime);
      if (!Number.isFinite(endTime) || endTime <= 0 || endTime + retentionMs >= nowMs) continue;
      handled.add(recording.recordID);

      const stored = this.store.findByRecordId(recording.recordID);
      if (stored && stored.meeting.tenantId !== tenant.id) continue;
      const inspection = await inspectRecording(paths, stateDir, recording.recordID, stored?.session, recording.state);
      if (inspection.state === 'deleted') continue;
      if (inspection.state === 'processing') continue;
      const meetingId = stored?.meeting.meetingId ?? recording.meetingID.slice(tenant.meetingIdPrefix.length);
      await this.deleteRecording(tenant, meetingId, recording.recordID, 'expired');
    }

    for (const meeting of this.store.listAll()) {
      if (meeting.tenantId !== tenant.id) continue;
      for (const session of meeting.sessions) {
        if (handled.has(session.recordId)) continue;
        if (session.outcome !== 'failed' && session.outcome !== 'timeout') continue;
        const outcomeMs = timestampMs(session.outcomeAt ?? session.createdAt);
        if (outcomeMs + retentionMs >= nowMs) continue;
        const inspection = await inspectRecording(paths, stateDir, session.recordId, session);
        if (inspection.state === 'deleted') continue;
        await this.deleteRecording(tenant, meeting.meetingId, session.recordId, 'expired');
      }
    }
  }

  private log(line: Record<string, unknown>): void {
    try {
      this.logger(line);
    } catch {
      // logging must never break the monitor
    }
  }
}
