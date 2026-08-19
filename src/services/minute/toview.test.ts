import assert from "node:assert/strict";
import test from "node:test";
import {
  sampleWatchLaterToViewAccounts,
  selectWatchLaterToViewAccounts,
  type ToViewClient,
} from "./toview";

test("To View selects only explicitly configured account IDs", () => {
  const selected = selectWatchLaterToViewAccounts(
    [{ uid: "100" }, { uid: "200" }],
    [{ accountId: 200n }],
  );

  assert.deepEqual(selected, [{ uid: "200" }]);
});

test("To View fetches once per configured account", async () => {
  let requestCount = 0;
  const client: ToViewClient = {
    async get() {
      requestCount += 1;
      return { data: { code: 0, data: { count: 0, list: [] } } };
    },
  };
  const accounts = [
    { uid: "100", toViewClient: client },
    { uid: "200", toViewClient: client },
  ];

  const samples = await sampleWatchLaterToViewAccounts(
    accounts,
    [{ accountId: 100n }, { accountId: 200n }],
    new Date(),
  );

  assert.deepEqual(samples, []);
  assert.equal(requestCount, 2);
});

test("To View de-duplicates configured account IDs within a pass", async () => {
  let requestCount = 0;
  const client: ToViewClient = {
    async get() {
      requestCount += 1;
      return { data: { code: 0, data: { count: 0, list: [] } } };
    },
  };

  await sampleWatchLaterToViewAccounts(
    [{ uid: "100", toViewClient: client }],
    [{ accountId: 100n }, { accountId: 100n }],
    new Date(),
  );

  assert.equal(requestCount, 1);
});

test("To View rejects an incomplete response before sampling", async () => {
  const client: ToViewClient = {
    async get() {
      return { data: { code: 0, data: { count: 1, list: [] } } };
    },
  };

  const samples = await sampleWatchLaterToViewAccounts(
    [{ uid: "100", toViewClient: client }],
    [{ accountId: 100n }],
    new Date(),
  );

  assert.deepEqual(samples, []);
});
