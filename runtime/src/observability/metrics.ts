export interface MetricSpec {
  name: string;
  labelNames: readonly string[];
  maxSeries?: number;
  ttlMs?: number;
  collect?: () => Promise<Array<Record<string, string> & { value: number }>>;
}

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
  updatedAt: number;
  stale: boolean;
}

export interface RegistryOptions {
  defaultTtlMs?: number;
  defaultMaxSeries?: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_SERIES = 500;

export class MetricRegistry {
  private readonly specs = new Map<string, MetricSpec>();
  private readonly series = new Map<string, { value: number; updatedAt: number }>();
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(private readonly options: RegistryOptions = {}) {}

  register(spec: MetricSpec): void {
    if (this.specs.has(spec.name)) return;
    this.specs.set(spec.name, spec);
  }

  private requireSpec(name: string): MetricSpec {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Metric not registered: ${name}`);
    return spec;
  }

  private assertLabels(spec: MetricSpec, labels: Record<string, string>): void {
    for (const key of Object.keys(labels)) {
      if (!spec.labelNames.includes(key)) {
        throw new Error(`Unknown label '${key}' for metric '${spec.name}'; allowed: ${spec.labelNames.join(', ')}`);
      }
    }
  }

  private seriesKey(name: string, labels: Record<string, string>): string {
    const ordered = specLabelPairs(name, labels);
    return `${name}{${ordered.map(([key, value]) => `${key}="${value}"`).join(',')}}`;
  }

  set(name: string, labels: Record<string, string>, value: number, at = Date.now()): void {
    const spec = this.requireSpec(name);
    this.assertLabels(spec, labels);
    const key = this.seriesKey(name, labels);
    this.enforceSeriesLimit(name, key);
    this.series.delete(key);
    this.series.set(key, { value, updatedAt: at });
  }

  get(name: string, labels: Record<string, string>): number | null {
    const spec = this.requireSpec(name);
    this.assertLabels(spec, labels);
    const entry = this.series.get(this.seriesKey(name, labels));
    if (!entry) return null;
    const ttlMs = spec.ttlMs ?? this.options.defaultTtlMs ?? DEFAULT_TTL_MS;
    if (Date.now() - entry.updatedAt > ttlMs) return null;
    return entry.value;
  }

  getStale(name: string, labels: Record<string, string>): { value: number | null; stale: boolean } {
    const spec = this.requireSpec(name);
    this.assertLabels(spec, labels);
    const key = this.seriesKey(name, labels);
    const entry = this.series.get(key);
    if (!entry) return { value: null, stale: true };
    const ttlMs = spec.ttlMs ?? this.options.defaultTtlMs ?? DEFAULT_TTL_MS;
    const stale = Date.now() - entry.updatedAt > ttlMs;
    return { value: entry.value, stale };
  }

  async ensureFresh(
    name: string,
    labels: Record<string, string>,
    refreshFn?: (name: string, labels: Record<string, string>) => Promise<number>,
    deadlineMs = 5_000,
  ): Promise<number | null> {
    const current = this.get(name, labels);
    if (current !== null) return current;
    const spec = this.requireSpec(name);
    if (!refreshFn && !spec.collect) return null;
    const key = this.seriesKey(name, labels);
    const pending = this.refreshes.get(key);
    if (pending) await pending;
    const existing = this.get(name, labels);
    if (existing !== null) return existing;
    const promise = this.refreshOne(name, labels, refreshFn, deadlineMs);
    this.refreshes.set(key, promise);
    try {
      await promise;
    } catch {
      return null;
    } finally {
      this.refreshes.delete(key);
    }
    return this.get(name, labels);
  }

  async refreshAll(deadlineMs = 5_000): Promise<void> {
    const specNames = [...this.specs.keys()];
    await Promise.allSettled(specNames.map((name) => this.refreshSpec(name, deadlineMs)));
  }

  private async refreshSpec(name: string, deadlineMs: number): Promise<void> {
    const spec = this.requireSpec(name);
    if (!spec.collect) return;
    const samples = await this.withDeadline(spec.collect(), deadlineMs);
    for (const sample of samples) {
      const { value, ...labels } = sample;
      this.set(name, labels, value);
    }
  }

  private async refreshOne(
    name: string,
    labels: Record<string, string>,
    refreshFn?: (name: string, labels: Record<string, string>) => Promise<number>,
    deadlineMs = 5_000,
  ): Promise<void> {
    const spec = this.requireSpec(name);
    const value = refreshFn
      ? await this.withDeadline(refreshFn(name, labels), deadlineMs)
      : await this.withDeadline(this.collectOne(spec, labels), deadlineMs);
    if (value !== undefined && value !== null) this.set(name, labels, value);
  }

  private async collectOne(spec: MetricSpec, labels: Record<string, string>): Promise<number> {
    if (!spec.collect) return 0;
    const samples = await spec.collect();
    const key = this.seriesKey(spec.name, labels);
    const match = samples.find((sample) => {
      const { value: _value, ...sampleLabels } = sample;
      return this.seriesKey(spec.name, sampleLabels) === key;
    });
    return match?.value ?? 0;
  }

  private async withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Metric refresh exceeded ${deadlineMs}ms deadline`)), deadlineMs);
      timer.unref();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private enforceSeriesLimit(name: string, incomingKey: string): void {
    const spec = this.requireSpec(name);
    const maxSeries = spec.maxSeries ?? this.options.defaultMaxSeries ?? DEFAULT_MAX_SERIES;
    if (this.series.size < maxSeries) return;
    if (!this.series.has(incomingKey)) {
      const oldestKey = this.series.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.series.delete(oldestKey);
    }
  }

  snapshot(): Array<{ name: string; labels: Record<string, string>; value: number; updatedAt: number }> {
    const rows: Array<{ name: string; labels: Record<string, string>; value: number; updatedAt: number }> = [];
    for (const [key, entry] of this.series) {
      const brace = key.indexOf('{');
      const name = key.slice(0, brace);
      const labels: Record<string, string> = {};
      const body = key.slice(brace + 1, -1);
      for (const part of body.split(',')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        labels[part.slice(0, eq)] = part.slice(eq + 2, -1);
      }
      rows.push({ name, labels, value: entry.value, updatedAt: entry.updatedAt });
    }
    return rows;
  }
}

function specLabelPairs(name: string, labels: Record<string, string>): Array<[string, string]> {
  void name;
  return Object.entries(labels).sort(([left], [right]) => (left < right ? -1 : 1));
}

let defaultRegistry: MetricRegistry | null = null;
export function getMetricRegistry(): MetricRegistry {
  if (!defaultRegistry) defaultRegistry = new MetricRegistry();
  return defaultRegistry;
}
