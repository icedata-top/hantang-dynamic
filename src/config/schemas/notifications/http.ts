import { z } from "zod";

// HTTP methods enum
export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

// HTTP request configuration for a single endpoint
export const httpRequestSchema = z.object({
  url: z.string(),
  method: httpMethodSchema,
  headers: z.record(z.string()).optional(),
  timeout: z.number().optional().default(5000),
  retries: z.number().optional().default(3),
  // Body template for POST/PUT requests (supports placeholders)
  body: z.string().optional(),
  // Query parameters template (supports placeholders)
  params: z.record(z.string()).optional(),
});

// HTTP notification configuration (supports multiple endpoints)
export const httpSchema = z.object({
  enabled: z.boolean().optional().default(false),
  endpoints: z.array(httpRequestSchema).optional().default([]),
  // Global defaults
  timeout: z.number().optional().default(5000),
  retries: z.number().optional().default(3),
  headers: z.record(z.string()).optional(),
});

export type HttpMethod = z.infer<typeof httpMethodSchema>;
export type HttpRequestConfig = z.infer<typeof httpRequestSchema>;
export type HttpConfig = z.infer<typeof httpSchema>;

// Factory function to create HTTP config from TOML/env
export function createHttpConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): HttpConfig {
  // Get endpoints from config
  const endpoints = getConfigValue(
    ["notifications", "http", "endpoints"],
    "HTTP_ENDPOINTS",
    [],
  );

  // If HTTP_ENDPOINTS is a JSON string, parse it
  let parsedEndpoints = endpoints;
  if (typeof endpoints === "string") {
    try {
      parsedEndpoints = JSON.parse(endpoints);
    } catch {
      parsedEndpoints = [];
    }
  }

  return {
    enabled: getConfigValue(
      ["notifications", "http", "enabled"],
      "HTTP_ENABLED",
      false,
    ),
    endpoints: parsedEndpoints,
    timeout: getConfigValue(
      ["notifications", "http", "timeout"],
      "HTTP_TIMEOUT",
      5000,
    ),
    retries: getConfigValue(
      ["notifications", "http", "retries"],
      "HTTP_RETRIES",
      3,
    ),
    headers: getConfigValue(
      ["notifications", "http", "headers"],
      "HTTP_HEADERS",
      {},
    ),
  };
}
