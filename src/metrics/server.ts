import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { config } from "../config";
import { Database } from "../database";
import {
  type RepairColumnFilterOperators,
  type RepairColumnFilterValue,
  type RepairResult,
  type RepairVideoFilter,
  runRepairVideosWithDatabase,
} from "../scripts/repair-videos";
import { logger } from "../utils/logger";
import { metricsRegistry } from "./registry";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const REPAIR_FILTER_COLUMNS = new Set([
  "aid",
  "bvid",
  "copyright",
  "created_at",
  "ctime",
  "description",
  "dynamic",
  "extras",
  "is_deleted",
  "is_filtered",
  "notes",
  "participle",
  "pic",
  "pubdate",
  "staff",
  "tag",
  "tag_new",
  "tid_v2",
  "title",
  "type_id",
  "updated_at",
  "user_id",
]);

type RepairFilterColumnName =
  | "aid"
  | "bvid"
  | "copyright"
  | "created_at"
  | "ctime"
  | "description"
  | "dynamic"
  | "extras"
  | "is_deleted"
  | "is_filtered"
  | "notes"
  | "participle"
  | "pic"
  | "pubdate"
  | "staff"
  | "tag"
  | "tag_new"
  | "tid_v2"
  | "title"
  | "type_id"
  | "updated_at"
  | "user_id";

let server: Server | null = null;

interface NormalizedRepairRequest {
  all: boolean;
  bvids?: string[];
  filter?: RepairVideoFilter;
  fixAids: boolean;
}

interface RepairJobView {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  request: {
    all: boolean;
    bvidCount: number;
    filter?: RepairVideoFilter;
    fixAids: boolean;
  };
  result?: RepairResult;
  error?: string;
}

let repairJob: RepairJobView | null = null;

function isAuthorized(authorization: string | undefined): boolean {
  const expected = `Bearer ${config.server.authToken}`;
  if (!authorization) {
    return false;
  }

  const authorizationBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);
  if (authorizationBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(authorizationBuffer, expectedBuffer);
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  payload: string,
): void {
  res.statusCode = statusCode;
  res.end(payload);
}

function ensureMetricsAuthorization(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!config.server.authToken) return true;

  if (!isAuthorized(req.headers.authorization)) {
    sendText(res, 401, "Unauthorized\n");
    return false;
  }

  return true;
}

function ensureRepairAuthorization(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!config.repair.apiEnabled) {
    sendJson(res, 404, { error: "Not Found" });
    return false;
  }

  if (!config.server.authToken) {
    sendJson(res, 403, {
      error: "Repair API requires server.auth_token",
    });
    return false;
  }

  if (!isAuthorized(req.headers.authorization)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }

  return true;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new Error("Request body too large");
    }

    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBooleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }

  return value;
}

function readBvid(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const bvid = value.trim();
  if (!BVID_PATTERN.test(bvid)) {
    throw new Error(`${fieldName} must be a BV id`);
  }

  return bvid;
}

function readIntegerField(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }

  return value;
}

function readBvidArrayField(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`${key} cannot be empty`);
  }

  if (value.length > config.repair.maxBvids) {
    throw new Error(
      `${key} cannot contain more than ${config.repair.maxBvids} ids`,
    );
  }

  return value.map((item, index) => readBvid(item, `${key}[${index}]`));
}

function readArrayField(body: Record<string, unknown>, key: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`${key} cannot be empty`);
  }
  return value;
}

function isRepairColumn(column: string): column is RepairFilterColumnName {
  return REPAIR_FILTER_COLUMNS.has(column);
}

function readColumnFilterValue(
  value: unknown,
  fieldName: string,
): RepairColumnFilterValue {
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    Array.isArray(value)
  ) {
    return value;
  }

  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be a scalar, array, or object`);
  }

  const normalized: RepairColumnFilterOperators = {};
  const allowedOperators = new Set([
    "contains",
    "eq",
    "gt",
    "gte",
    "hasAll",
    "hasAny",
    "in",
    "isEmpty",
    "isNull",
    "lt",
    "lte",
    "max",
    "min",
  ]);

  for (const [operator, operatorValue] of Object.entries(value)) {
    if (!allowedOperators.has(operator)) {
      throw new Error(`${fieldName}.${operator} is not supported`);
    }

    if (
      (operator === "hasAll" || operator === "hasAny" || operator === "in") &&
      !Array.isArray(operatorValue)
    ) {
      throw new Error(`${fieldName}.${operator} must be an array`);
    }

    if (
      (operator === "isEmpty" || operator === "isNull") &&
      typeof operatorValue !== "boolean"
    ) {
      throw new Error(`${fieldName}.${operator} must be a boolean`);
    }

    switch (operator) {
      case "hasAll":
      case "hasAny":
      case "in":
        if (!Array.isArray(operatorValue)) {
          throw new Error(`${fieldName}.${operator} must be an array`);
        }
        if (operatorValue.length === 0) {
          throw new Error(`${fieldName}.${operator} cannot be empty`);
        }
        normalized[operator] = operatorValue;
        break;
      case "isEmpty":
      case "isNull":
        if (typeof operatorValue !== "boolean") {
          throw new Error(`${fieldName}.${operator} must be a boolean`);
        }
        normalized[operator] = operatorValue;
        break;
      case "contains":
        normalized.contains = operatorValue;
        break;
      case "eq":
        normalized.eq = operatorValue;
        break;
      case "gt":
        normalized.gt = operatorValue;
        break;
      case "gte":
        normalized.gte = operatorValue;
        break;
      case "lt":
        normalized.lt = operatorValue;
        break;
      case "lte":
        normalized.lte = operatorValue;
        break;
      case "max":
        normalized.max = operatorValue;
        break;
      case "min":
        normalized.min = operatorValue;
        break;
      default:
        break;
    }
  }

  return normalized;
}

function normalizeRepairFilter(value: unknown): RepairVideoFilter | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("filter must be a JSON object");
  }

  const limit = readIntegerField(value, "limit");
  const columns: Partial<
    Record<RepairFilterColumnName, RepairColumnFilterValue>
  > = {};

  if (value.columns !== undefined) {
    if (!isRecord(value.columns)) {
      throw new Error("filter.columns must be a JSON object");
    }

    for (const [column, columnValue] of Object.entries(value.columns)) {
      if (!isRepairColumn(column)) {
        throw new Error(`filter.columns.${column} is not supported`);
      }

      columns[column] = readColumnFilterValue(
        columnValue,
        `filter.columns.${column}`,
      );
    }
  }

  for (const [column, columnValue] of Object.entries(value)) {
    if (column === "columns" || column === "limit") continue;
    if (!isRepairColumn(column)) continue;
    columns[column] = readColumnFilterValue(columnValue, `filter.${column}`);
  }

  if (value.bvids !== undefined) {
    columns.bvid = {
      in: [...new Set(readBvidArrayField(value, "bvids") ?? [])],
    };
  }
  if (value.userIds !== undefined) {
    columns.user_id = { in: readArrayField(value, "userIds") };
  }
  if (value.typeIds !== undefined) {
    columns.type_id = { in: readArrayField(value, "typeIds") };
  }
  if (value.isFiltered !== undefined) {
    columns.is_filtered = readBooleanField(value, "isFiltered");
  }
  if (value.isDeleted !== undefined) {
    columns.is_deleted = readBooleanField(value, "isDeleted");
  }
  if (value.createdAfter !== undefined) {
    columns.created_at = { gte: value.createdAfter };
  }
  if (value.createdBefore !== undefined) {
    columns.created_at = {
      ...(isRecord(columns.created_at) ? columns.created_at : {}),
      lte: value.createdBefore,
    };
  }
  if (value.updatedAfter !== undefined) {
    columns.updated_at = { gte: value.updatedAfter };
  }
  if (value.updatedBefore !== undefined) {
    columns.updated_at = {
      ...(isRecord(columns.updated_at) ? columns.updated_at : {}),
      lte: value.updatedBefore,
    };
  }
  if (value.pubdateAfter !== undefined) {
    columns.pubdate = { gte: value.pubdateAfter };
  }
  if (value.pubdateBefore !== undefined) {
    columns.pubdate = {
      ...(isRecord(columns.pubdate) ? columns.pubdate : {}),
      lte: value.pubdateBefore,
    };
  }

  const filter: RepairVideoFilter = {};
  if (Object.keys(columns).length > 0) {
    filter.columns = columns;
  }

  if (limit !== undefined) {
    if (limit < 1) {
      throw new Error("filter.limit must be a positive integer");
    }
    filter.limit = limit;
  }

  return filter.columns || filter.limit !== undefined ? filter : undefined;
}

function normalizeRepairRequest(body: unknown): NormalizedRepairRequest {
  if (!isRecord(body)) {
    throw new Error("Request body must be a JSON object");
  }

  const all = readBooleanField(body, "all");
  const fixAids = readBooleanField(body, "fixAids");
  const filter = normalizeRepairFilter(body.filter);
  const bvids: string[] = [];

  if (body.bvid !== undefined) {
    bvids.push(readBvid(body.bvid, "bvid"));
  }

  if (body.bvids !== undefined) {
    bvids.push(...(readBvidArrayField(body, "bvids") ?? []));
  }

  const uniqueBvids = [...new Set(bvids)];

  if (all && uniqueBvids.length > 0) {
    throw new Error("all cannot be combined with bvid or bvids");
  }

  if (all && filter) {
    throw new Error("all cannot be combined with filter");
  }

  if (uniqueBvids.length > 0 && filter) {
    throw new Error("bvid or bvids cannot be combined with filter");
  }

  if (!all && uniqueBvids.length === 0 && !filter && !fixAids) {
    throw new Error("Specify all=true, bvid, bvids, filter, or fixAids=true");
  }

  return {
    all,
    bvids: uniqueBvids.length > 0 ? uniqueBvids : undefined,
    filter,
    fixAids,
  };
}

async function handleMetricsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    sendText(res, 405, "Method Not Allowed\n");
    return;
  }

  if (!ensureMetricsAuthorization(req, res)) return;

  try {
    res.statusCode = 200;
    res.setHeader("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (error) {
    logger.error("Failed to render Prometheus metrics:", error);
    sendText(res, 500, "Internal Server Error\n");
  }
}

function runRepairJob(
  job: RepairJobView,
  request: NormalizedRepairRequest,
): void {
  void (async () => {
    try {
      const db = Database.getInstance();
      job.result = await runRepairVideosWithDatabase(db, undefined, {
        bvids:
          request.all || request.filter ? undefined : (request.bvids ?? []),
        filter: request.filter,
        fixAids: request.fixAids,
      });
      job.status = "succeeded";
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      job.error = message || "Unknown repair error";
      job.status = "failed";
      logger.error("Repair API job failed:", error);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();
}

async function handleRepairRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = req.url?.split("?", 1)[0] ?? "/";

  if (!ensureRepairAuthorization(req, res)) return;

  if (path === config.repair.statusPath) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }

    sendJson(res, 200, repairJob ?? { status: "idle" });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  if (repairJob?.status === "running") {
    sendJson(res, 409, {
      error: "A repair job is already running",
      job: repairJob,
    });
    return;
  }

  let repairRequest: NormalizedRepairRequest;
  try {
    repairRequest = normalizeRepairRequest(await readJsonBody(req));
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "Invalid request",
    });
    return;
  }

  const now = new Date().toISOString();
  repairJob = {
    id: randomUUID(),
    request: {
      all: repairRequest.all,
      bvidCount: repairRequest.all ? 0 : (repairRequest.bvids?.length ?? 0),
      filter: repairRequest.filter,
      fixAids: repairRequest.fixAids,
    },
    startedAt: now,
    status: "running",
  };

  runRepairJob(repairJob, repairRequest);
  sendJson(res, 202, repairJob);
}

async function closeAfterFailedListen(
  activeServer: Server | null,
): Promise<void> {
  if (!activeServer) return;

  await new Promise<void>((resolve) => {
    try {
      activeServer.close(() => {
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

export async function startMetricsServer(): Promise<void> {
  if (!config.server.enabled || server) return;

  server = createServer(async (req, res) => {
    const path = req.url?.split("?", 1)[0] ?? "/";

    if (path === config.metrics.path) {
      await handleMetricsRequest(req, res);
      return;
    }

    if (path === config.repair.path || path === config.repair.statusPath) {
      await handleRepairRequest(req, res);
      return;
    }

    sendText(res, 404, "Not Found\n");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const activeServer = server;
      if (!activeServer) return reject(new Error("Metrics server missing"));
      activeServer.once("error", reject);
      activeServer.listen(config.server.port, config.server.host, () => {
        activeServer.off("error", reject);
        activeServer.unref();
        resolve();
      });
    });
  } catch (error) {
    const activeServer = server;
    server = null;
    await closeAfterFailedListen(activeServer);
    throw error;
  }

  logger.info(
    `HTTP control server listening on http://${config.server.host}:${config.server.port}`,
  );
}

export async function stopMetricsServer(): Promise<void> {
  if (!server) return;
  const activeServer = server;
  server = null;
  await new Promise<void>((resolve, reject) => {
    activeServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
