export class EndpointErrorAlerts {
  private readonly endpoints = new Map<string, boolean[]>();
  private readonly alerted = new Set<string>();

  constructor(
    private readonly notify: (message: string) => Promise<void>,
    private readonly onError: () => void,
  ) {}

  record(host: string, route: string, result: "success" | "error" | "retry") {
    const key = `${host}${route}`;
    if (result === "retry" || this.alerted.has(key)) return;
    const samples = this.endpoints.get(key) ?? [];
    samples.push(result === "error");
    if (samples.length > 20) samples.shift();
    this.endpoints.set(key, samples);
    const failures = samples.filter(Boolean).length;
    if (samples.length < 20 || failures <= 10) return;
    this.alerted.add(key);
    this.endpoints.delete(key);
    const message = `API endpoint error rate: ${key}\nLast 20 requests: ${failures}/20 failed (${failures * 5}%).`;
    void Promise.resolve()
      .then(() => this.notify(message))
      .catch(this.onError);
  }
}
