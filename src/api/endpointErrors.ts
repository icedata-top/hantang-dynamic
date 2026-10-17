const WINDOW_MS = 5 * 60_000;

type Sample = { time: number; failed: boolean };
type Endpoint = { samples: Sample[] };

export class EndpointErrorAlerts {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly alerted = new Set<string>();
  private nextCleanup = 0;

  constructor(
    private readonly notify: (message: string) => Promise<void>,
    private readonly onError: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  record(host: string, route: string, result: "success" | "error" | "retry") {
    const key = `${host}${route}`;
    if (result === "retry" || this.alerted.has(key)) return;
    const now = this.now();
    if (now >= this.nextCleanup) {
      for (const [key, endpoint] of this.endpoints) {
        if (
          endpoint.samples[endpoint.samples.length - 1].time <=
          now - WINDOW_MS
        ) {
          this.endpoints.delete(key);
        }
      }
      this.nextCleanup = now + WINDOW_MS;
    }
    const endpoint = this.endpoints.get(key) ?? { samples: [] };
    endpoint.samples = endpoint.samples.filter((s) => s.time > now - WINDOW_MS);
    endpoint.samples.push({ time: now, failed: result === "error" });
    this.endpoints.set(key, endpoint);
    const total = endpoint.samples.length;
    const failures = endpoint.samples.filter((s) => s.failed).length;
    if (total < 20 || failures / total < 0.5) {
      return;
    }
    this.alerted.add(key);
    this.endpoints.delete(key);
    const message = `API endpoint error rate: ${key}\nLast 5 minutes: ${failures}/${total} requests failed (${Math.round((failures / total) * 100)}%).`;
    void Promise.resolve()
      .then(() => this.notify(message))
      .catch(this.onError);
  }
}
