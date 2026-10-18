import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import type { BiliDynamicItem } from "../types/bilibili/dynamic";
import { DynamicsService } from "./dynamics.service";

function item(id: string, type: string, timestamp = 200): BiliDynamicItem {
  return {
    id_str: id,
    type,
    modules: {
      module_author: { mid: 7, name: "author", pub_ts: String(timestamp) },
    },
  };
}

test("mixed feed follows opaque cursors and applies one frontier across content types", async () => {
  const requests: Array<{ url?: string; params: Record<string, unknown> }> = [];
  const pages = [
    {
      items: [
        item("900", "DYNAMIC_TYPE_AV"),
        item("899", "DYNAMIC_TYPE_COMMON_SQUARE"),
      ],
      offset: "opaque:next",
      has_more: true,
    },
    {
      items: [
        item("800", "DYNAMIC_TYPE_WORD"),
        item("700", "DYNAMIC_TYPE_FORWARD"),
      ],
      offset: "opaque:last",
      has_more: true,
    },
    {
      items: [
        item("600", "DYNAMIC_TYPE_FORWARD"),
        item("500", "DYNAMIC_TYPE_DRAW", 10),
      ],
      offset: "",
      has_more: false,
    },
  ];
  const client = axios.create({
    adapter: async (request) => {
      requests.push({ url: request.url, params: request.params });
      return {
        data: { code: 0, data: pages[requests.length - 1] },
        status: 200,
        statusText: "OK",
        headers: {},
        config: request,
      };
    },
  });
  const account = { uid: "7", dynamicClient: client } as AccountContext;
  const originalWait = config.application.apiWaitTime;
  config.application.apiWaitTime = 0;
  try {
    const result = [];
    for await (const page of new DynamicsService(account).fetchDynamicsStream({
      minTimestamp: 100,
      minDynamicId: 650n,
    }))
      result.push({
        maxId: page.maxDynamicId,
        ids: page.cards.map((card) => card.desc.dynamic_id_str),
      });
    assert.deepEqual(result, [
      { maxId: 900n, ids: ["900"] },
      { maxId: 800n, ids: ["800", "700"] },
      { maxId: 650n, ids: [] },
    ]);
    assert.deepEqual(
      requests.map((request) => request.params.offset),
      [undefined, "opaque:next", "opaque:last"],
    );
    assert.ok(
      requests.every(
        (request) =>
          request.url === "/feed/all" && request.params.type === "all",
      ),
    );
  } finally {
    config.application.apiWaitTime = originalWait;
  }
});

test("a repeated feed cursor fails the traversal", async () => {
  const client = axios.create({
    adapter: async (request) => {
      return {
        data: {
          code: 0,
          data: {
            items: [item("900", "DYNAMIC_TYPE_AV")],
            offset: "same",
            has_more: true,
          },
        },
        status: 200,
        statusText: "OK",
        headers: {},
        config: request,
      };
    },
  });
  const originalWait = config.application.apiWaitTime;
  config.application.apiWaitTime = 0;
  try {
    await assert.rejects(async () => {
      for await (const _page of new DynamicsService({
        uid: "7",
        dynamicClient: client,
      } as AccountContext).fetchDynamicsStream({
        minTimestamp: 100,
        minDynamicId: 0n,
      })) {
        /* consume stream */
      }
    }, /missing or repeated cursor/);
  } finally {
    config.application.apiWaitTime = originalWait;
  }
});

function feedClient(
  handler: (request: {
    params: Record<string, unknown>;
  }) => { code: number; message?: string; data?: unknown } | undefined,
) {
  return axios.create({
    adapter: async (request) => {
      const body = handler({ params: request.params ?? {} }) ?? {
        code: 0,
        data: { items: [], offset: "", has_more: false },
      };
      return {
        data: body,
        status: 200,
        statusText: "OK",
        headers: {},
        config: request,
      };
    },
  });
}

test("a twice-repeated 4101133 ends the traversal without failing", async () => {
  const offsets: unknown[] = [];
  const client = feedClient(({ params }) => {
    offsets.push(params.offset);
    if (params.offset === undefined) {
      return {
        code: 0,
        data: {
          items: [item("900", "DYNAMIC_TYPE_AV")],
          offset: "end-ish",
          has_more: true,
        },
      };
    }
    return { code: 4101133, message: "请求数据发生错误，请刷新或稍后重试" };
  });
  // Mirror the shared client: business codes reject instead of returning.
  client.interceptors.response.use((response) => {
    if (response.data.code !== 0) {
      return Promise.reject({
        message: `API Error: code ${response.data.code}`,
        status: response.status,
        code: response.data.code,
        data: response.data,
      });
    }
    return response;
  });

  const originalWait = config.application.apiWaitTime;
  config.application.apiWaitTime = 0;
  try {
    const pages = [];
    for await (const page of new DynamicsService({
      uid: "7",
      dynamicClient: client,
    } as AccountContext).fetchDynamicsStream({
      minTimestamp: 100,
      minDynamicId: 0n,
    })) {
      pages.push(page.maxDynamicId);
    }
    assert.deepEqual(pages, [900n]);
    assert.deepEqual(offsets, [undefined, "end-ish", "end-ish"]);
  } finally {
    config.application.apiWaitTime = originalWait;
  }
});

test("a transient 4101133 is retried once and pagination continues", async () => {
  const offsets: unknown[] = [];
  const client = feedClient(({ params }) => {
    offsets.push(params.offset);
    if (params.offset === undefined) {
      return {
        code: 0,
        data: {
          items: [item("900", "DYNAMIC_TYPE_AV")],
          offset: "next",
          has_more: true,
        },
      };
    }
    if (offsets.length === 2) {
      return { code: 4101133, message: "请求数据发生错误，请刷新或稍后重试" };
    }
    return {
      code: 0,
      data: {
        items: [item("800", "DYNAMIC_TYPE_AV")],
        offset: "",
        has_more: false,
      },
    };
  });

  const originalWait = config.application.apiWaitTime;
  config.application.apiWaitTime = 0;
  try {
    const pages = [];
    for await (const page of new DynamicsService({
      uid: "7",
      dynamicClient: client,
    } as AccountContext).fetchDynamicsStream({
      minTimestamp: 100,
      minDynamicId: 0n,
    })) {
      pages.push(page.maxDynamicId);
    }
    assert.deepEqual(pages, [900n, 800n]);
    assert.deepEqual(offsets, [undefined, "next", "next"]);
  } finally {
    config.application.apiWaitTime = originalWait;
  }
});
