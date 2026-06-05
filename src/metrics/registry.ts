import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import { config } from "../config";
import { sharedApiRateLimiter } from "../utils/apiRateLimiter";

const PREFIX = "bili_tracker_";

export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ app: "bilibili-dynamic-subscribe" });

if (config.metrics.enabled && config.metrics.collectDefaultMetrics) {
  collectDefaultMetrics({
    prefix: PREFIX,
    register: metricsRegistry,
  });
}

export const buildInfo = new Gauge({
  name: `${PREFIX}build_info`,
  help: "Build and runtime information for bilibili-dynamic-subscribe.",
  labelNames: ["version", "node_version"] as const,
  registers: [metricsRegistry],
});

export const fetchCyclesTotal = new Counter({
  name: `${PREFIX}fetch_cycles_total`,
  help: "Total dynamic fetch cycles.",
  labelNames: ["uid", "result"] as const,
  registers: [metricsRegistry],
});

export const fetchCycleDurationSeconds = new Histogram({
  name: `${PREFIX}fetch_cycle_duration_seconds`,
  help: "Dynamic fetch cycle duration in seconds.",
  labelNames: ["uid"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

export const lastSuccessfulFetchTimestampSeconds = new Gauge({
  name: `${PREFIX}last_successful_fetch_timestamp_seconds`,
  help: "Unix timestamp of the last successful dynamic fetch.",
  labelNames: ["uid"] as const,
  registers: [metricsRegistry],
});

export const dynamicsSeenTotal = new Counter({
  name: `${PREFIX}dynamics_seen_total`,
  help: "Total dynamic cards seen from Bilibili APIs.",
  labelNames: ["uid", "type"] as const,
  registers: [metricsRegistry],
});

export const videosProcessedTotal = new Counter({
  name: `${PREFIX}videos_processed_total`,
  help: "Total newly processed videos.",
  labelNames: ["uid"] as const,
  registers: [metricsRegistry],
});

export const apiRequestsTotal = new Counter({
  name: `${PREFIX}api_requests_total`,
  help: "Total Bilibili API requests.",
  labelNames: ["host", "route", "result"] as const,
  registers: [metricsRegistry],
});

export const apiRequestDurationSeconds = new Histogram({
  name: `${PREFIX}api_request_duration_seconds`,
  help: "Bilibili API request duration in seconds.",
  labelNames: ["host", "route"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

export const apiErrorsByCodeTotal = new Counter({
  name: `${PREFIX}api_errors_by_code_total`,
  help: "Total Bilibili API logical errors by response code.",
  labelNames: ["code"] as const,
  registers: [metricsRegistry],
});

export const rateLimiterActive = new Gauge({
  name: `${PREFIX}rate_limiter_active`,
  help: "Current active operations in the shared API rate limiter.",
  registers: [metricsRegistry],
  collect() {
    this.set(sharedApiRateLimiter.getActiveCount());
  },
});

export const rateLimiterQueued = new Gauge({
  name: `${PREFIX}rate_limiter_queued`,
  help: "Current queued operations in the shared API rate limiter.",
  registers: [metricsRegistry],
  collect() {
    this.set(sharedApiRateLimiter.getQueueLength());
  },
});

export const dbQueryDurationSeconds = new Histogram({
  name: `${PREFIX}db_query_duration_seconds`,
  help: "PostgreSQL query duration in seconds.",
  labelNames: ["operation"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [metricsRegistry],
});

export const dbQueryErrorsTotal = new Counter({
  name: `${PREFIX}db_query_errors_total`,
  help: "Total PostgreSQL query errors.",
  labelNames: ["operation"] as const,
  registers: [metricsRegistry],
});

export const dbPoolConnections = new Gauge({
  name: `${PREFIX}db_pool_connections`,
  help: "PostgreSQL pool connection counts.",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
});

export const minuteBatchesTotal = new Counter({
  name: `${PREFIX}minute_batches_total`,
  help: "Total adaptive minute batches by trigger.",
  labelNames: ["trigger"] as const,
  registers: [metricsRegistry],
});

export const minuteSamplesTotal = new Counter({
  name: `${PREFIX}minute_samples_total`,
  help: "Total adaptive minute samples by outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

export const minuteBatchDurationSeconds = new Histogram({
  name: `${PREFIX}minute_batch_duration_seconds`,
  help: "Adaptive minute batch duration in seconds.",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const notificationsTotal = new Counter({
  name: `${PREFIX}notifications_total`,
  help: "Total notification attempts by channel and result.",
  labelNames: ["channel", "result"] as const,
  registers: [metricsRegistry],
});

export const exportsTotal = new Counter({
  name: `${PREFIX}exports_total`,
  help: "Total export attempts by target and result.",
  labelNames: ["target", "result"] as const,
  registers: [metricsRegistry],
});

export const fatalExitsTotal = new Counter({
  name: `${PREFIX}fatal_exits_total`,
  help: "Total fatal process exits by reason.",
  labelNames: ["reason"] as const,
  registers: [metricsRegistry],
});

export function initializeBuildInfo(version: string): void {
  buildInfo.set({ version, node_version: process.version }, 1);
}
