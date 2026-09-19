interface WindowState {
  count: number;
  resetsAt: number;
}

export class TenantRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  consume(tenantId: string, limit: number, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    let state = this.windows.get(tenantId);
    if (!state || now >= state.resetsAt) {
      state = { count: 0, resetsAt: now + 60_000 };
      this.windows.set(tenantId, state);
    }

    if (state.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((state.resetsAt - now) / 1000)),
      };
    }

    state.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

