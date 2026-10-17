import assert from "node:assert/strict";
import test from "node:test";
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
