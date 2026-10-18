import {
  apiEndpointAlertTriggered,
  apiEndpointRecentErrorRatio,
  apiEndpointRecentSampleCount,
} from "../metrics/registry";
import { redactForLog } from "../utils/redact";

/**
 * Trim only to keep one line readable; long reports reach Telegram intact
 * because over-long messages are sent as a `.txt` file.
 */
const REASON_LIMIT = 500;

export class EndpointErrorAlerts {
  private readonly endpoints = new Map<string, (string | null)[]>();
  private readonly alerted = new Set<string>();

  constructor(
    private readonly notify: (message: string) => Promise<void>,
    private readonly onError: () => void,
  ) {}

  record(
    host: string,
    route: string,
    result: "success" | "error" | "retry",
    reason?: string,
  ) {
    const key = `${host}${route}`;
    if (result === "retry") return;
    const samples = this.endpoints.get(key) ?? [];
    samples.push(
      result === "error"
        ? redactForLog(reason ?? "error")
            .replace(/\s+/g, " ")
            .slice(0, REASON_LIMIT)
        : null,
    );
    if (samples.length > 20) samples.shift();
    this.endpoints.set(key, samples);
    const failures = samples.filter((sample): sample is string => !!sample);
    const labels = { host, route };
    apiEndpointRecentSampleCount.set(labels, samples.length);
    apiEndpointRecentErrorRatio.set(labels, failures.length / samples.length);
    apiEndpointAlertTriggered.set(labels, this.alerted.has(key) ? 1 : 0);
    if (this.alerted.has(key) || samples.length < 20 || failures.length <= 10)
      return;
    this.alerted.add(key);
    apiEndpointAlertTriggered.set(labels, 1);
    const reasons = new Map<string, number>();
    for (const reason of failures) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const breakdown = [...reasons]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `- ${reason}: ${count}`)
      .join("\n");
    const message =
      `API endpoint error rate: ${key}\n` +
      `Last 20 requests: ${failures.length}/20 failed (${failures.length * 5}%).` +
      (breakdown ? `\n\nFailures by reason:\n${breakdown}` : "");
    void Promise.resolve()
      .then(() => this.notify(message))
      .catch(this.onError);
  }
}
