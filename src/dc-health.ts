export interface DcTarget {
  hostname: string;
  port: number;
}

export interface DcHealthSnapshot {
  hostname: string;
  port: number;
  failures: number;
  latencyEwmaMs: number | null;
  cooldownUntil: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  attempts?: number;
  successes?: number;
  totalFailures?: number;
  latencyVarianceMs2?: number | null;
}

interface DcHealthState {
  failures: number;
  latencyEwmaMs: number | null;
  cooldownUntil: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  attempts: number;
  successes: number;
  totalFailures: number;
  latencyVarianceMs2: number | null;
}

/** Isolate-local adaptive endpoint ranking. It stores no client identifiers. */
export class DcHealthRegistry {
  private readonly states = new Map<string, DcHealthState>();
  private cooldownMs: number;
  private enabled = true;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: { cooldownMs?: number; now?: () => number; maxEntries?: number } = {}) {
    this.cooldownMs = clampInteger(options.cooldownMs ?? 15_000, 1_000, 300_000);
    this.now = options.now ?? Date.now;
    this.maxEntries = clampInteger(options.maxEntries ?? 128, 8, 2048);
  }

  configure(cooldownMs: number, enabled = true): void {
    this.cooldownMs = clampInteger(cooldownMs, 1_000, 300_000);
    this.enabled = enabled;
  }

  order<T extends DcTarget>(targets: readonly T[], enabled = this.enabled): T[] {
    if (!enabled) return [...targets];
    const now = this.now();
    return targets.map((target, index) => {
      const state = this.states.get(keyOf(target));
      if (!state) return { target, index, score: 12_000 };
      if (state.cooldownUntil > now) return { target, index, score: 1_000_000 + state.cooldownUntil - now };
      const lastObserved = Math.max(state.lastSuccessAt ?? 0, state.lastFailureAt ?? 0);
      const ageMs = lastObserved ? Math.max(0, now - lastObserved) : 86_400_000;
      // Old observations lose influence; failure penalties decay independently
      // from latency so an endpoint can recover without waiting for a new probe.
      const freshnessPenalty = Math.min(8_000, ageMs / 60_000 * 80);
      const failurePenalty = state.failures * 1_800 * Math.max(0.15, 1 - ageMs / 900_000);
      const latency = state.latencyEwmaMs ?? 4_000;
      const observationFreshness = Math.max(0.1, 1 - ageMs / 3_600_000);
      const variancePenalty = Math.min(2_000, Math.sqrt(Math.max(0, state.latencyVarianceMs2 ?? 0)) * 0.35) * observationFreshness;
      const attempts = Math.max(0, state.attempts ?? 0);
      const totalFailures = Math.max(0, state.totalFailures ?? state.failures);
      const failureRatePenalty = attempts > 0 ? (totalFailures / attempts) * 5_000 * observationFreshness : 0;
      const score = latency + freshnessPenalty + failurePenalty + variancePenalty + failureRatePenalty;
      return { target, index, score };
    }).sort((a, b) => a.score - b.score || a.index - b.index).map(({ target }) => target);
  }

  reportSuccess(target: DcTarget, latencyMs: number): void {
    const key = keyOf(target);
    const previous = this.states.get(key);
    const latency = Math.max(0, Math.min(120_000, latencyMs));
    this.states.set(key, {
      failures: 0,
      latencyEwmaMs: previous?.latencyEwmaMs == null ? latency : previous.latencyEwmaMs * 0.75 + latency * 0.25,
      cooldownUntil: 0,
      lastSuccessAt: this.now(),
      lastFailureAt: previous?.lastFailureAt ?? null,
      attempts: (previous?.attempts ?? 0) + 1,
      successes: (previous?.successes ?? 0) + 1,
      totalFailures: previous?.totalFailures ?? 0,
      latencyVarianceMs2: previous?.latencyEwmaMs == null
        ? 0
        : (previous.latencyVarianceMs2 ?? 0) * 0.75 + ((latency - previous.latencyEwmaMs) ** 2) * 0.25,
    });
    this.trim();
  }

  reportFailure(target: DcTarget): void {
    const key = keyOf(target);
    const previous = this.states.get(key);
    const failures = Math.min(10, (previous?.failures ?? 0) + 1);
    this.states.set(key, {
      failures,
      latencyEwmaMs: previous?.latencyEwmaMs ?? null,
      cooldownUntil: this.now() + Math.min(300_000, this.cooldownMs * 2 ** (failures - 1)),
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastFailureAt: this.now(),
      attempts: (previous?.attempts ?? 0) + 1,
      successes: previous?.successes ?? 0,
      totalFailures: (previous?.totalFailures ?? 0) + 1,
      latencyVarianceMs2: previous?.latencyVarianceMs2 ?? null,
    });
    this.trim();
  }

  snapshot(): DcHealthSnapshot[] {
    return [...this.states.entries()].map(([key, state]) => {
      const separator = key.lastIndexOf(':');
      return { hostname: key.slice(0, separator), port: Number(key.slice(separator + 1)), ...state };
    });
  }

  /** Merge shared Durable Object observations into this isolate's synchronous selector. */
  mergeShared(snapshot: readonly DcHealthSnapshot[]): void {
    for (const entry of snapshot) {
      if (!entry || typeof entry.hostname !== 'string' || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) continue;
      const key = keyOf(entry);
      const incoming: DcHealthState = {
        failures: Math.max(0, Math.min(10, Math.trunc(entry.failures))),
        latencyEwmaMs: entry.latencyEwmaMs === null ? null : Math.max(0, Math.min(120_000, entry.latencyEwmaMs)),
        cooldownUntil: Math.max(0, entry.cooldownUntil),
        lastSuccessAt: entry.lastSuccessAt,
        lastFailureAt: entry.lastFailureAt ?? null,
        attempts: Math.max(0, Math.trunc(entry.attempts ?? 0)),
        successes: Math.max(0, Math.trunc(entry.successes ?? 0)),
        totalFailures: Math.max(0, Math.trunc(entry.totalFailures ?? entry.failures)),
        latencyVarianceMs2: entry.latencyVarianceMs2 == null ? null : Math.max(0, entry.latencyVarianceMs2),
      };
      const current = this.states.get(key);
      const currentAt = Math.max(current?.lastSuccessAt ?? 0, current?.lastFailureAt ?? 0);
      const incomingAt = Math.max(incoming.lastSuccessAt ?? 0, incoming.lastFailureAt ?? 0);
      if (!current || incomingAt >= currentAt) this.states.set(key, incoming);
    }
    this.trim();
  }

  private trim(): void {
    if (this.states.size <= this.maxEntries) return;
    const oldest = [...this.states.entries()].sort((a, b) =>
      (a[1].lastSuccessAt ?? a[1].cooldownUntil) - (b[1].lastSuccessAt ?? b[1].cooldownUntil),
    );
    for (const [key] of oldest.slice(0, this.states.size - this.maxEntries)) this.states.delete(key);
  }
}

function keyOf(target: DcTarget): string { return `${target.hostname.toLowerCase()}:${target.port}`; }
function clampInteger(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : min;
}
