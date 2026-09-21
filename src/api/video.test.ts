import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import axios, { type AxiosAdapter } from "axios";
import { apiErrorsByCodeTotal, apiRequestsTotal } from "../metrics/registry";
import type { BiliVideoFullDetailResponse } from "../types";
import { webInterfaceClient } from "./client";
import { fetchVideoFullDetail } from "./video";

function response(code: number): BiliVideoFullDetailResponse {
  return {
    code,
    message: code === 0 ? "" : "login required",
    ttl: 1,
    data: { source: code === 0 ? "direct" : "proxy" },
  } as unknown as BiliVideoFullDetailResponse;
}

async function metricValue(
  metric: typeof apiErrorsByCodeTotal | typeof apiRequestsTotal,
  labels: Record<string, string>,
): Promise<number> {
  const result = await metric.get();
  return result.values
    .filter((value) => {
      const metricLabels = value.labels as Record<string, string | number>;
      return Object.entries(labels).every(
        ([key, expected]) => metricLabels[key] === expected,
      );
    })
    .reduce((sum, value) => sum + value.value, 0);
}

function setTestWbiState(): () => void {
  const statePath = "state.json";
  const originalState = existsSync(statePath) ? readFileSync(statePath) : null;
  writeFileSync(
    statePath,
    JSON.stringify({
      lastDynamicIdByType: {},
      lastUpdate: Date.now(),
      lastUA: "test-user-agent",
      imgKey: "0123456789abcdef0123456789abcdef",
      subKey: "fedcba9876543210fedcba9876543210",
      wbiKeysExpiresAt: Math.floor(Date.now() / 1000) + 7200,
    }),
  );
  return () => {
    if (originalState) {
      writeFileSync(statePath, originalState);
    } else {
      rmSync(statePath, { force: true });
    }
  };
}

test("proxy login-required detail response hands off to the authenticated direct client", async () => {
  const originalAdapter = webInterfaceClient.defaults.adapter;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const errors: string[] = [];
  const warnings: string[] = [];
  const proxyErrorCount = await metricValue(apiErrorsByCodeTotal, {
    code: "-403",
  });
  const proxyRequestErrorCount = await metricValue(apiRequestsTotal, {
    host: "proxy.example.test",
    route: "/x/web-interface/view/detail",
    result: "error",
  });
  const restoreWbiState = setTestWbiState();
  const proxyAdapter: AxiosAdapter = async (request) => {
    assert.equal(request.headers.get("Cookie"), undefined);
    assert.equal(
      (request as { metadata?: { proxyDetailLoginFallback?: boolean } })
        .metadata?.proxyDetailLoginFallback,
      true,
    );
    return {
      config: request,
      data: response(-403),
      headers: {},
      status: 200,
      statusText: "OK",
    };
  };
  const directClient = axios.create({
    headers: { Cookie: "SESSDATA=test-session" },
  });
  directClient.defaults.adapter = async (request) => {
    assert.equal(request.headers.get("Cookie"), "SESSDATA=test-session");
    return {
      config: request,
      data: response(0),
      headers: {},
      status: 200,
      statusText: "OK",
    };
  };

  webInterfaceClient.defaults.adapter = proxyAdapter;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const detail = await fetchVideoFullDetail(
      { bvid: "BVhandoff" },
      directClient,
    );
    assert.equal(detail?.code, 0);
  } finally {
    webInterfaceClient.defaults.adapter = originalAdapter;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    restoreWbiState();
  }

  assert.equal(
    await metricValue(apiErrorsByCodeTotal, { code: "-403" }),
    proxyErrorCount,
  );
  assert.equal(
    await metricValue(apiRequestsTotal, {
      host: "proxy.example.test",
      route: "/x/web-interface/view/detail",
      result: "error",
    }),
    proxyRequestErrorCount,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("a direct login-required detail response after proxy handoff still fails", async () => {
  const originalAdapter = webInterfaceClient.defaults.adapter;
  const restoreWbiState = setTestWbiState();
  const proxyAdapter: AxiosAdapter = async (request) => ({
    config: request,
    data: response(-403),
    headers: {},
    status: 200,
    statusText: "OK",
  });
  const directClient = axios.create();
  directClient.defaults.adapter = async (request) => ({
    config: request,
    data: response(-403),
    headers: {},
    status: 200,
    statusText: "OK",
  });

  webInterfaceClient.defaults.adapter = proxyAdapter;
  try {
    await assert.rejects(
      fetchVideoFullDetail({ bvid: "BVdirect-failure" }, directClient),
      /Fetch video full detail failed/,
    );
  } finally {
    webInterfaceClient.defaults.adapter = originalAdapter;
    restoreWbiState();
  }
});
