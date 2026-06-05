import { createServer, type Server } from "node:http";
import { config } from "../config";
import { logger } from "../utils/logger";
import { metricsRegistry } from "./registry";

let server: Server | null = null;

export async function startMetricsServer(): Promise<void> {
  if (!config.metrics.enabled || server) return;

  server = createServer(async (req, res) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end("Method Not Allowed\n");
      return;
    }

    const path = req.url?.split("?", 1)[0] ?? "/";
    if (path !== config.metrics.path) {
      res.statusCode = 404;
      res.end("Not Found\n");
      return;
    }

    if (config.metrics.authToken) {
      const expected = `Bearer ${config.metrics.authToken}`;
      if (req.headers.authorization !== expected) {
        res.statusCode = 401;
        res.end("Unauthorized\n");
        return;
      }
    }

    try {
      res.statusCode = 200;
      res.setHeader("Content-Type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch (error) {
      logger.error("Failed to render Prometheus metrics:", error);
      res.statusCode = 500;
      res.end("Internal Server Error\n");
    }
  });

  await new Promise<void>((resolve, reject) => {
    const activeServer = server;
    if (!activeServer) return reject(new Error("Metrics server missing"));
    activeServer.once("error", reject);
    activeServer.listen(config.metrics.port, config.metrics.host, () => {
      activeServer.off("error", reject);
      activeServer.unref();
      resolve();
    });
  });

  logger.info(
    `Prometheus metrics listening on http://${config.metrics.host}:${config.metrics.port}${config.metrics.path}`,
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
