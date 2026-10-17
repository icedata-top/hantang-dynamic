const WINDOW_MS = 5 * 60_000;
const COOLDOWN_MS = 30 * 60_000;

type Sample = { time: number; failed: boolean };
type Endpoint = { samples: Sample[]; lastAlert?: number };

export class EndpointErrorAlerts {
  private readonly endpoints = new Map<string, Endpoint>();
  private nextCleanup = 0;

  constructor(
    private readonly notify: (message: string) => Promise<void>,
    private readonly onError: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  record(host: string, route: string, result: "success" | "error" | "retry") {
    if (result === "retry") return;
    const now = this.now();
    if (now >= this.nextCleanup) {
      for (const [key, endpoint] of this.endpoints) {
        if (
          endpoint.samples[endpoint.samples.length - 1].time <=
            now - WINDOW_MS &&
          (endpoint.lastAlert === undefined ||
            now - endpoint.lastAlert >= COOLDOWN_MS)
        ) {
          this.endpoints.delete(key);
        }
      }
      this.nextCleanup = now + WINDOW_MS;
    }
    const key = `${host}${route}`;
    const endpoint = this.endpoints.get(key) ?? { samples: [] };
    endpoint.samples = endpoint.samples.filter((s) => s.time > now - WINDOW_MS);
    endpoint.samples.push({ time: now, failed: result === "error" });
    this.endpoints.set(key, endpoint);
    const total = endpoint.samples.length;
    const failures = endpoint.samples.filter((s) => s.failed).length;
    if (
      total < 20 ||
      failures / total < 0.5 ||
      (endpoint.lastAlert !== undefined &&
        now - endpoint.lastAlert < COOLDOWN_MS)
    ) {
      return;
    }
    endpoint.lastAlert = now;
    const message = `API endpoint error rate: ${key}\nLast 5 minutes: ${failures}/${total} requests failed (${Math.round((failures / total) * 100)}%).`;
    void Promise.resolve()
      .then(() => this.notify(message))
      .catch(this.onError);
  }
}
