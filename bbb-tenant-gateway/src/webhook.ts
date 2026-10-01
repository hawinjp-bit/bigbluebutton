import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebhookEvent } from './types.js';

const STATE_FILE = 'webhooks.json';
const STATE_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const WEBHOOK_EVENTS = new Set<WebhookEvent['event']>(['recording.ready', 'recording.failed']);

/** `v1=` + hex HMAC-SHA256(secret, `v1:<timestamp>:<rawBody>`). */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  const digest = createHmac('sha256', secret)
    .update(`v1:${timestamp}:${rawBody}`, 'utf8')
    .digest('hex');
  return `v1=${digest}`;
}

export interface WebhookDelivery {
  /** `${recordId}:${event}` */
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  body: WebhookEvent;
  attempts: number;
  /** ISO 8601 */
  nextAttemptAt: string;
}

export type WebhookTransport = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

export type WebhookLogger = (line: Record<string, unknown>) => void;

export interface WebhookQueueOptions {
  /** Directory holding webhooks.json; null keeps deliveries in memory only. */
  stateDir: string | null;
  /** Delay before retry N (1-based). A delivery is dropped once it failed more times than there are entries. */
  scheduleMs: number[];
  transport?: WebhookTransport;
  now?: () => Date;
  logger?: WebhookLogger;
}

interface PersistedState {
  version: number;
  deliveries: WebhookDelivery[];
}

export const defaultWebhookTransport: WebhookTransport = async (url, init) => {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: init.headers,
    body: init.body,
  });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status };
};

function defaultLogger(line: Record<string, unknown>): void {
  console.log(JSON.stringify(line));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWebhookEvent(value: unknown): value is WebhookEvent {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.event === 'string'
    && WEBHOOK_EVENTS.has(value.event as WebhookEvent['event'])
    && typeof value.tenant === 'string'
    && typeof value.meetingId === 'string'
    && typeof value.recordId === 'string'
    && typeof value.occurredAt === 'string'
    && (value.error === undefined || typeof value.error === 'string')
  );
}

function isDelivery(value: unknown): value is WebhookDelivery {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.tenantId === 'string'
    && typeof value.url === 'string'
    && typeof value.secret === 'string'
    && isWebhookEvent(value.body)
    && typeof value.attempts === 'number'
    && Number.isInteger(value.attempts)
    && value.attempts >= 0
    && typeof value.nextAttemptAt === 'string'
  );
}

function cloneDelivery(delivery: WebhookDelivery): WebhookDelivery {
  return { ...delivery, body: { ...delivery.body } };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * At-least-once webhook delivery with persisted retries.
 *
 * Deliveries are keyed by `<recordId>:<event>`, so enqueueing the same event
 * twice is a no-op. `processDue` sends everything whose `nextAttemptAt` has
 * passed; a 2xx removes the delivery, anything else (including transport
 * errors) schedules the next attempt from `scheduleMs` and finally drops the
 * delivery with an error log line. Log lines never contain the secret or body.
 */
export class WebhookQueue {
  private readonly deliveries = new Map<string, WebhookDelivery>();
  private readonly stateDir: string | null;
  private readonly scheduleMs: number[];
  private readonly transport: WebhookTransport;
  private readonly now: () => Date;
  private readonly logger: WebhookLogger;
  private writeChain: Promise<void> = Promise.resolve();
  private processing = false;

  constructor(options: WebhookQueueOptions) {
    this.stateDir = options.stateDir;
    this.scheduleMs = [...options.scheduleMs];
    this.transport = options.transport ?? defaultWebhookTransport;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;
  }

  /** Replaces the in-memory queue with the persisted one (no-op without a stateDir or file). */
  async load(): Promise<void> {
    this.deliveries.clear();
    if (this.stateDir === null) return;

    let text: string;
    try {
      text = await readFile(join(this.stateDir, STATE_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed) || parsed.version !== STATE_VERSION || !Array.isArray(parsed.deliveries)) {
      throw new Error(`${STATE_FILE} has an unsupported format`);
    }

    for (const entry of parsed.deliveries as unknown[]) {
      if (!isDelivery(entry)) {
        this.log({
          level: 'warn',
          message: 'webhook state entry skipped',
          id: isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : null,
        });
        continue;
      }
      if (!this.deliveries.has(entry.id)) this.deliveries.set(entry.id, cloneDelivery(entry));
    }
  }

  /** Queues a delivery for immediate sending; a no-op when its id is already queued. */
  async enqueue(input: { tenantId: string; url: string; secret: string; body: WebhookEvent }): Promise<void> {
    const id = `${input.body.recordId}:${input.body.event}`;
    if (this.deliveries.has(id)) return;

    this.deliveries.set(id, {
      id,
      tenantId: input.tenantId,
      url: input.url,
      secret: input.secret,
      body: { ...input.body },
      attempts: 0,
      nextAttemptAt: this.now().toISOString(),
    });
    await this.persist();
  }

  /** Sends every due delivery once. Never throws. */
  async processDue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const nowMs = this.now().getTime();
      const due = [...this.deliveries.values()].filter((delivery) => !(Date.parse(delivery.nextAttemptAt) > nowMs));
      if (due.length === 0) return;

      for (const delivery of due) {
        if (!this.deliveries.has(delivery.id)) continue;
        await this.attempt(delivery);
      }
      await this.persist();
    } catch (error) {
      this.log({ level: 'error', message: 'webhook queue processing failed', error: errorMessage(error) });
    } finally {
      this.processing = false;
    }
  }

  pending(): WebhookDelivery[] {
    return [...this.deliveries.values()].map(cloneDelivery);
  }

  private async attempt(delivery: WebhookDelivery): Promise<void> {
    const sentAt = this.now();
    const timestamp = Math.floor(sentAt.getTime() / 1000);
    const rawBody = JSON.stringify(delivery.body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Gateway-Timestamp': String(timestamp),
      'X-Gateway-Signature': signWebhook(delivery.secret, timestamp, rawBody),
      'X-Gateway-Event-Id': delivery.id,
    };

    let status: number | null = null;
    let failure: string | undefined;
    try {
      const result = await this.transport(delivery.url, { headers, body: rawBody });
      status = typeof result?.status === 'number' ? result.status : null;
    } catch (error) {
      failure = errorMessage(error);
    }

    const attempts = delivery.attempts + 1;
    if (status !== null && status >= 200 && status < 300) {
      this.deliveries.delete(delivery.id);
      this.log({
        level: 'info',
        message: 'webhook delivered',
        id: delivery.id,
        tenantId: delivery.tenantId,
        status,
        attempts,
      });
      return;
    }

    delivery.attempts = attempts;
    if (attempts > this.scheduleMs.length) {
      this.deliveries.delete(delivery.id);
      this.log({
        level: 'error',
        message: 'webhook dropped',
        id: delivery.id,
        tenantId: delivery.tenantId,
        status,
        attempts,
        error: failure,
      });
      return;
    }

    const delayMs = this.scheduleMs[attempts - 1] ?? 0;
    delivery.nextAttemptAt = new Date(sentAt.getTime() + delayMs).toISOString();
    this.log({
      level: 'warn',
      message: 'webhook delivery failed',
      id: delivery.id,
      tenantId: delivery.tenantId,
      status,
      attempts,
      nextAttemptAt: delivery.nextAttemptAt,
      error: failure,
    });
  }

  private persist(): Promise<void> {
    if (this.stateDir === null) return Promise.resolve();
    const snapshot: PersistedState = { version: STATE_VERSION, deliveries: [...this.deliveries.values()] };
    const text = JSON.stringify(snapshot, null, 2);
    const stateDir = this.stateDir;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => writeAtomically(stateDir, text));
    return this.writeChain;
  }

  private log(line: Record<string, unknown>): void {
    try {
      this.logger(line);
    } catch {
      // logging must never break delivery
    }
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
