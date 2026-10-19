import assert from "node:assert/strict";
import test from "node:test";
import { dynamicDetailClient } from "../api/client";
import { StateManager } from "../core/state";
import { Database } from "../database";
import type { BiliDynamicItem } from "../types/bilibili/dynamic";
import type { DynamicData } from "../types/models/database";
import { DetailsService } from "./details.service";
import { toDynamicCard } from "./dynamicCard";

function item(id: string, type: string): BiliDynamicItem {
  return {
    id_str: id,
    type,
    modules: {
      module_author: {
        mid: "7",
        name: "forwarder",
        face: "avatar",
        pub_ts: "123",
      },
    },
  };
}

test("embedded original video survives forward processing and storage", async () => {
  const source = item("90071992547409931", "DYNAMIC_TYPE_AV");
  source.modules.module_dynamic = {
    desc: { text: "video caption" },
    major: { archive: { bvid: "BV1original" } },
  };
  const nested = {
    ...item("90071992547409932", "DYNAMIC_TYPE_FORWARD"),
    orig: source,
  };
  const forward = {
    ...item("90071992547409933", "DYNAMIC_TYPE_FORWARD"),
    orig: nested,
  };
  forward.modules.module_dynamic = {
    desc: { text: "forward caption" },
    major: null,
  };
  const card = toDynamicCard(forward);
  assert.ok(card);
  const db = Database.getInstance();
  const originalSave = db.saveDynamic;
  const originalUser = db.addDiscoveredUser;
  const originalCache = db.getCachedForwardBvid;
  const stored: DynamicData[] = [];
  db.saveDynamic = async (data) => {
    stored.push(data);
  };
  db.addDiscoveredUser = async () => {};
  db.getCachedForwardBvid = async () => null;
  const service = new DetailsService();
  const ids: (string | number)[] = [];
  service.processVideoById = async (id) => {
    ids.push(id);
    return { video: null, relatedVideos: [] };
  };
  try {
    await service.processVideo(card);
    assert.deepEqual(ids, ["BV1original"]);
    assert.equal(stored[0].dynamicId, 90071992547409933n);
    assert.equal(stored[0].origDynamicId, 90071992547409932n);
    assert.equal(stored[0].origType, 1);
    assert.equal(stored[0].forwardText, "forward caption");
    assert.equal(stored[0].bvid, "BV1original");
  } finally {
    db.saveDynamic = originalSave;
    db.addDiscoveredUser = originalUser;
    db.getCachedForwardBvid = originalCache;
  }
});

test("missing forward original is recovered from Polymer detail and persisted", async (t) => {
  t.mock.method(StateManager.prototype, "isTicketValid", () => true);
  t.mock.method(StateManager.prototype, "isWbiKeysValid", () => true);
  t.mock.getter(StateManager.prototype, "imgKey", () => "0".repeat(32));
  t.mock.getter(StateManager.prototype, "subKey", () => "1".repeat(32));
  const forward = item("90071992547409933", "DYNAMIC_TYPE_FORWARD");
  forward.orig = item("90071992547409932", "DYNAMIC_TYPE_AV");
  forward.modules.module_dynamic = { desc: { text: "forward caption" } };
  const card = toDynamicCard(forward);
  assert.ok(card);
  const original = item("90071992547409932", "DYNAMIC_TYPE_AV");
  original.modules.module_dynamic = {
    major: { archive: { bvid: "BV1recovered" } },
  };
  const originalAdapter = dynamicDetailClient.defaults.adapter;
  let requests = 0;
  dynamicDetailClient.defaults.adapter = async (request) => {
    requests++;
    assert.equal(request.url, "/detail");
    assert.deepEqual(request.params, { id: "90071992547409932" });
    return {
      config: request,
      data: { code: 0, data: { item: original } },
      headers: {},
      status: 200,
      statusText: "OK",
    };
  };
  const db = Database.getInstance();
  const stored: DynamicData[] = [];
  t.mock.method(db, "getCachedForwardBvid", async () => null);
  t.mock.method(db, "addDiscoveredUser", async () => {});
  t.mock.method(db, "saveDynamic", async (data: DynamicData) => {
    stored.push(data);
  });
  const service = new DetailsService();
  const ids: (string | number)[] = [];
  t.mock.method(service, "processVideoById", async (id: string | number) => {
    ids.push(id);
    return { video: null, relatedVideos: [] };
  });
  try {
    await service.processVideo(card);
    assert.equal(requests, 1);
    assert.deepEqual(ids, ["BV1recovered"]);
    assert.equal(stored[0].dynamicId, 90071992547409933n);
    assert.equal(stored[0].origDynamicId, 90071992547409932n);
    assert.equal(stored[0].origType, 8);
    assert.equal(stored[0].forwardText, "forward caption");
    assert.equal(stored[0].bvid, "BV1recovered");
  } finally {
    dynamicDetailClient.defaults.adapter = originalAdapter;
  }
});

test("opus images and article content retain the existing storage fields", async () => {
  const draw = item("100", "DYNAMIC_TYPE_DRAW");
  draw.modules.module_dynamic = {
    major: {
      opus: {
        summary: { text: "image text" },
        pics: [{ url: "image", width: 640, height: 480 }],
      },
    },
  };
  const article = item("101", "DYNAMIC_TYPE_ARTICLE");
  article.modules.module_dynamic = {
    major: { article: { title: "title", desc: "summary", covers: ["cover"] } },
  };
  const db = Database.getInstance();
  const originalSave = db.saveDynamic;
  const stored: DynamicData[] = [];
  db.saveDynamic = async (data) => {
    stored.push(data);
  };
  try {
    for (const source of [draw, article]) {
      const card = toDynamicCard(source);
      assert.ok(card);
      await new DetailsService().saveDynamic(card);
    }
    assert.equal(stored[0].textContent, "image text");
    assert.deepEqual(stored[0].images, [
      { img_src: "image", img_width: 640, img_height: 480 },
    ]);
    assert.equal(stored[1].title, "title");
    assert.equal(stored[1].textContent, "summary");
    assert.deepEqual(stored[1].images, [{ img_src: "cover" }]);
  } finally {
    db.saveDynamic = originalSave;
  }
});

test("forward pointing at deleted content is not re-requested", async (t) => {
  t.mock.method(StateManager.prototype, "isTicketValid", () => true);
  t.mock.method(StateManager.prototype, "isWbiKeysValid", () => true);
  t.mock.getter(StateManager.prototype, "imgKey", () => "0".repeat(32));
  t.mock.getter(StateManager.prototype, "subKey", () => "1".repeat(32));
  const forward = item("90071992547409941", "DYNAMIC_TYPE_FORWARD");
  forward.orig = item("90071992547409942", "DYNAMIC_TYPE_AV");
  forward.modules.module_dynamic = { desc: { text: "forward caption" } };
  const card = toDynamicCard(forward);
  assert.ok(card);

  const originalAdapter = dynamicDetailClient.defaults.adapter;
  let requests = 0;
  dynamicDetailClient.defaults.adapter = async (request) => {
    requests++;
    // Same shape as axios rejecting the HTTP 500 MISS_MEDIALIST_DATA answer.
    throw {
      message: "Request failed with status code 500",
      config: request,
      response: {
        status: 500,
        data: {
          code: 500,
          message:
            "MISS_MEDIALIST_DATA: dyn_id = 90071992547409942, rid = 3931291464",
        },
      },
    };
  };
  const db = Database.getInstance();
  t.mock.method(db, "getCachedForwardBvid", async () => null);
  t.mock.method(db, "addDiscoveredUser", async () => {});
  t.mock.method(db, "saveDynamic", async () => {});
  const service = new DetailsService();
  t.mock.method(service, "processVideoById", async () => ({
    video: null,
    relatedVideos: [],
  }));
  try {
    const first = await service.processVideo(card);
    const second = await service.processVideo(card);
    assert.deepEqual(first, { video: null, relatedVideos: [] });
    assert.deepEqual(second, { video: null, relatedVideos: [] });
    assert.equal(requests, 1);
  } finally {
    dynamicDetailClient.defaults.adapter = originalAdapter;
  }
});

test("deleted forward answered as a business code is not re-requested", async (t) => {
  t.mock.method(StateManager.prototype, "isTicketValid", () => true);
  t.mock.method(StateManager.prototype, "isWbiKeysValid", () => true);
  t.mock.getter(StateManager.prototype, "imgKey", () => "0".repeat(32));
  t.mock.getter(StateManager.prototype, "subKey", () => "1".repeat(32));
  const forward = item("90071992547409951", "DYNAMIC_TYPE_FORWARD");
  forward.orig = item("90071992547409952", "DYNAMIC_TYPE_AV");
  forward.modules.module_dynamic = { desc: { text: "forward caption" } };
  const card = toDynamicCard(forward);
  assert.ok(card);

  const originalAdapter = dynamicDetailClient.defaults.adapter;
  let requests = 0;
  dynamicDetailClient.defaults.adapter = async (request) => {
    requests++;
    // The shape bilibili actually returns: HTTP 200 with a business code 500.
    return {
      config: request,
      data: {
        code: 500,
        message:
          "MISS_MEDIALIST_DATA: dyn_id = 90071992547409952, rid = 3931291464",
      },
      headers: {},
      status: 200,
      statusText: "OK",
    };
  };
  const db = Database.getInstance();
  t.mock.method(db, "getCachedForwardBvid", async () => null);
  t.mock.method(db, "addDiscoveredUser", async () => {});
  t.mock.method(db, "saveDynamic", async () => {});
  const service = new DetailsService();
  t.mock.method(service, "processVideoById", async () => ({
    video: null,
    relatedVideos: [],
  }));
  try {
    const first = await service.processVideo(card);
    const second = await service.processVideo(card);
    // Not `failed`, so the tracker does not queue the aid for another retry.
    assert.deepEqual(first, { video: null, relatedVideos: [] });
    assert.deepEqual(second, { video: null, relatedVideos: [] });
    assert.equal(requests, 1);
  } finally {
    dynamicDetailClient.defaults.adapter = originalAdapter;
  }
});
