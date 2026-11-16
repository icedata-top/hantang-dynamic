import assert from "node:assert/strict";
import test from "node:test";
import type { VideoData } from "../types";

async function load() {
  process.env.SESSDATA ??= "test";
  process.env.BILIBILI_UID ??= "1";
  const { config } = await import("../config");
  const { filterVideo } = await import("./filter");
  return { config, filterVideo };
}

type Rules = {
  typeIds?: number[];
  tidV2?: number[];
  copyrightTypes?: number[];
  contentKeywords?: string[];
  contentBlacklist?: string[];
};

async function passes(rules: Rules, videoData: VideoData): Promise<boolean> {
  const { config, filterVideo } = await load();
  const video = config.whitelist.video as Record<string, unknown>;
  const filtering = config.processing.filtering as Record<string, unknown>;
  const saved = {
    typeIds: video.typeIds,
    tidV2: video.tidV2,
    copyrightTypes: video.copyrightTypes,
    contentKeywords: video.contentKeywords,
    contentBlacklist: filtering.contentBlacklist,
  };
  video.typeIds = rules.typeIds ?? [];
  video.tidV2 = rules.tidV2 ?? [];
  video.copyrightTypes = rules.copyrightTypes ?? [];
  video.contentKeywords = rules.contentKeywords ?? [];
  filtering.contentBlacklist = rules.contentBlacklist ?? [];
  try {
    return (await filterVideo(videoData)) !== null;
  } finally {
    video.typeIds = saved.typeIds;
    video.tidV2 = saved.tidV2;
    video.copyrightTypes = saved.copyrightTypes;
    video.contentKeywords = saved.contentKeywords;
    filtering.contentBlacklist = saved.contentBlacklist;
  }
}

function makeVideo(overrides: Partial<VideoData> = {}): VideoData {
  return {
    bvid: "BV1test",
    title: "title",
    description: "description",
    tag: "tag",
    type_id: 30,
    copyright: 1,
    ...overrides,
  } as VideoData;
}

test("type check: an empty type list admits every type", async () => {
  assert.equal(await passes({}, makeVideo({ type_id: 999 })), true);
});

test("type check: a listed type passes and an unlisted type is blocked", async () => {
  const rules = { typeIds: [30, 28] };
  assert.equal(await passes(rules, makeVideo({ type_id: 30 })), true);
  assert.equal(await passes(rules, makeVideo({ type_id: 999 })), false);
});

test("type check: a content keyword admits an unlisted type", async () => {
  const rules = { typeIds: [30], contentKeywords: ["Miku"] };
  assert.equal(
    await passes(rules, makeVideo({ type_id: 999, title: "初音MIKU曲" })),
    true,
  );
  assert.equal(
    await passes(rules, makeVideo({ type_id: 999, description: "miku" })),
    true,
  );
  assert.equal(
    await passes(rules, makeVideo({ type_id: 999, tag: "miku" })),
    true,
  );
  assert.equal(await passes(rules, makeVideo({ type_id: 999 })), false);
});

test("copyright check: an unlisted copyright is blocked unless a keyword matches", async () => {
  const rules = { copyrightTypes: [1], contentKeywords: ["miku"] };
  assert.equal(await passes(rules, makeVideo({ copyright: 1 })), true);
  assert.equal(await passes(rules, makeVideo({ copyright: 2 })), false);
  assert.equal(
    await passes(rules, makeVideo({ copyright: 2, title: "miku" })),
    true,
  );
  assert.equal(
    await passes(
      rules,
      makeVideo({ copyright: undefined as unknown as number }),
    ),
    true,
  );
});

test("blacklist: a matching keyword blocks even when every allowlist passes", async () => {
  const rules = {
    typeIds: [30],
    contentKeywords: ["miku"],
    contentBlacklist: ["Spam"],
  };
  assert.equal(await passes(rules, makeVideo()), true);
  assert.equal(await passes(rules, makeVideo({ title: "SPAM" })), false);
  assert.equal(
    await passes(rules, makeVideo({ type_id: 999, title: "miku spam" })),
    false,
  );
});

test("an empty tid_v2 list leaves the type check on type_ids for any tid_v2", async () => {
  const rules = { typeIds: [30], tidV2: [] };
  for (const tid_v2 of [undefined, 0, 2022, 2037]) {
    assert.equal(await passes(rules, makeVideo({ type_id: 30, tid_v2 })), true);
    assert.equal(
      await passes(rules, makeVideo({ type_id: 999, tid_v2 })),
      false,
    );
  }
});

test("tid_v2 list: a positive tid_v2 is judged by the list, not type_ids", async () => {
  const rules = { typeIds: [30], tidV2: [2022] };
  assert.equal(
    await passes(rules, makeVideo({ tid_v2: 2022, type_id: 999 })),
    true,
  );
  assert.equal(
    await passes(rules, makeVideo({ tid_v2: 2037, type_id: 30 })),
    false,
  );
});

test("tid_v2 list applies even when the type list is empty", async () => {
  const rules = { tidV2: [2022] };
  assert.equal(await passes(rules, makeVideo({ tid_v2: 2022 })), true);
  assert.equal(await passes(rules, makeVideo({ tid_v2: 2037 })), false);
});

test("tid_v2 list: a zero or missing tid_v2 falls back to type_ids", async () => {
  const rules = { typeIds: [30], tidV2: [2022] };
  for (const tid_v2 of [0, undefined]) {
    assert.equal(await passes(rules, makeVideo({ type_id: 30, tid_v2 })), true);
    assert.equal(
      await passes(rules, makeVideo({ type_id: 999, tid_v2 })),
      false,
    );
  }
});

test("tid_v2 list: a content keyword admits an unlisted tid_v2", async () => {
  const rules = { typeIds: [30], tidV2: [2022], contentKeywords: ["miku"] };
  assert.equal(
    await passes(rules, makeVideo({ tid_v2: 2037, title: "miku" })),
    true,
  );
  assert.equal(await passes(rules, makeVideo({ tid_v2: 2037 })), false);
});

test("tid_v2 list: copyright and blacklist still apply after the type check", async () => {
  const rules = {
    tidV2: [2022],
    copyrightTypes: [1],
    contentBlacklist: ["spam"],
  };
  assert.equal(await passes(rules, makeVideo({ tid_v2: 2022 })), true);
  assert.equal(
    await passes(rules, makeVideo({ tid_v2: 2022, copyright: 2 })),
    false,
  );
  assert.equal(
    await passes(rules, makeVideo({ tid_v2: 2022, title: "spam" })),
    false,
  );
});
