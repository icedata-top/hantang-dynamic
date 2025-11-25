import axios, { type AxiosRequestConfig } from "axios";
import { config } from "../../config";
import type { HttpRequestConfig } from "../../config/schemas/notifications/http";
import { logger } from "../logger";
import type { VideoTemplateData } from "./notifier";

/**
 * Replace template variables in a string
 * Supports placeholders like {{message}}, {{aid}}, {{bvid}}, etc.
 */
function replaceTemplateVariables(
  template: string,
  variables: Record<string, any>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Process template variables in HTTP request configuration
 */
function processRequestTemplate(
  requestConfig: HttpRequestConfig,
  variables: VideoTemplateData,
): HttpRequestConfig {
  const processed: HttpRequestConfig = {
    ...requestConfig,
    url: replaceTemplateVariables(requestConfig.url, variables),
  };

  // Process body if present
  if (requestConfig.body) {
    processed.body = replaceTemplateVariables(requestConfig.body, variables);
  }

  // Process query parameters
  if (requestConfig.params) {
    processed.params = {};
    for (const [key, value] of Object.entries(requestConfig.params)) {
      processed.params[key] = replaceTemplateVariables(value, variables);
    }
  }

  // Process headers
  if (requestConfig.headers) {
    processed.headers = {};
    for (const [key, value] of Object.entries(requestConfig.headers)) {
      processed.headers[key] = replaceTemplateVariables(value, variables);
    }
  }

  return processed;
}

/**
 * Send HTTP request with retry logic
 */
async function sendHttpRequest(
  requestConfig: HttpRequestConfig,
  variables: VideoTemplateData,
): Promise<void> {
  const processed = processRequestTemplate(requestConfig, variables);
  const maxRetries = requestConfig.retries ?? config.notifications.http.retries;
  const timeout = requestConfig.timeout ?? config.notifications.http.timeout;

  // Prepare axios config
  const axiosConfig: AxiosRequestConfig = {
    method: processed.method,
    url: processed.url,
    timeout,
    headers: {
      ...config.notifications.http.headers,
      ...processed.headers,
    },
    params: processed.params,
  };

  // Add body for methods that support it
  if (processed.body && ["POST", "PUT", "PATCH"].includes(processed.method)) {
    // Try to parse as JSON, otherwise send as string
    try {
      axiosConfig.data = JSON.parse(processed.body);
      if (!axiosConfig.headers?.["Content-Type"]) {
        axiosConfig.headers = {
          ...axiosConfig.headers,
          "Content-Type": "application/json",
        };
      }
    } catch {
      axiosConfig.data = processed.body;
      if (!axiosConfig.headers?.["Content-Type"]) {
        axiosConfig.headers = {
          ...axiosConfig.headers,
          "Content-Type": "text/plain",
        };
      }
    }
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios(axiosConfig);
      logger.debug(`HTTP notification sent successfully:`, {
        method: processed.method,
        url: processed.url,
        status: response.status,
        statusText: response.statusText,
        params: processed.params,
        headers: processed.headers,
        body: processed.body,
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10000); // Exponential backoff, max 10s
        logger.warn(
          `HTTP notification failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${lastError.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  logger.error(
    `HTTP notification failed after ${maxRetries} attempts to ${processed.url}: ${lastError?.message}`,
  );
  throw lastError;
}

/**
 * Send HTTP notifications to all configured endpoints
 */
export async function sendHttpNotification(
  message: string,
  templateData?: Partial<VideoTemplateData>,
): Promise<void> {
  if (
    !config.notifications.http.enabled ||
    !config.notifications.http.endpoints.length
  ) {
    return;
  }

  const variables: VideoTemplateData = {
    message,
    timestamp: new Date().toISOString(),
    ...templateData,
  };

  const delay = config.notifications.http.delay ?? 100;

  // Process endpoints sequentially with delay
  for (let i = 0; i < config.notifications.http.endpoints.length; i++) {
    const endpoint = config.notifications.http.endpoints[i];

    try {
      await sendHttpRequest(endpoint, variables);
    } catch (error) {
      logger.error(
        `Failed to send HTTP notification to ${endpoint.url}:`,
        error,
      );
    }

    // Add delay between requests (except for the last one)
    if (i < config.notifications.http.endpoints.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
