import {
  apiEndpointAlertTriggered,
  apiEndpointRecentErrorRatio,
  apiEndpointRecentSampleCount,
} from "../metrics/registry";

export class EndpointErrorAlerts {
  private readonly endpoints = new Map<string, boolean[]>();
  private readonly alerted = new Set<string>();

  constructor(
    private readonly notify: (message: string) => Promise<void>,
    private readonly onError: () => void,
  ) {}

  record(host: string, route: string, result: "success" | "error" | "retry") {
    const key = `${host}${route}`;
    if (result === "retry") return;
    const samples = this.endpoints.get(key) ?? [];
    samples.push(result === "error");
    if (samples.length > 20) samples.shift();
    this.endpoints.set(key, samples);
    const failures = samples.filter(Boolean).length;
    const labels = { host, route };
    apiEndpointRecentSampleCount.set(labels, samples.length);
    apiEndpointRecentErrorRatio.set(labels, failures / samples.length);
    apiEndpointAlertTriggered.set(labels, this.alerted.has(key) ? 1 : 0);
    if (this.alerted.has(key) || samples.length < 20 || failures <= 10) return;
    this.alerted.add(key);
    apiEndpointAlertTriggered.set(labels, 1);
    const message = `API endpoint error rate: ${key}\nLast 20 requests: ${failures}/20 failed (${failures * 5}%).`;
    void Promise.resolve()
      .then(() => this.notify(message))
      .catch(this.onError);
  }
}
