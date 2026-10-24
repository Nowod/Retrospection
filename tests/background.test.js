import test from "node:test";
import assert from "node:assert/strict";

test("真实 worker 消息处理：隔离、并发写入、权限、暂停与清空", async t => {
  const store = {};
  let listener;
  let accessLevel;
  let failNextWrite = false;
  let failNextRemove = false;
  globalThis.chrome = {
    runtime: {
      id: "test-extension", getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: fn => { listener = fn; } }
    },
    tabs: { query: async () => [], sendMessage: async () => {} },
    permissions: { contains: async () => false, onAdded: { addListener: () => {} } },
    storage: { local: {
      setAccessLevel: async options => { accessLevel = options.accessLevel; },
      get: async key => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return structuredClone(key === null ? store : (store[key] ? { [key]: store[key] } : {}));
      },
      set: async values => {
        if (failNextWrite) { failNextWrite = false; throw new Error("QUOTA_BYTES"); }
        await new Promise(resolve => setTimeout(resolve, 1));
        Object.assign(store, structuredClone(values));
      },
      remove: async keys => {
        if (failNextRemove) { failNextRemove = false; throw new Error("INTERRUPTED"); }
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      },
      getBytesInUse: async () => JSON.stringify(store).length
    } }
  };
  t.after(() => { delete globalThis.chrome; });
  await import(`../extension/background.js?test=${Date.now()}`);
  const content = { id: "test-extension", url: "https://a.test/form", tab: { id: 1, incognito: false } };
  const popup = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };
  const send = (message, sender = content) => new Promise(resolve => listener(message, sender, resolve));

  await t.test("storage 仅对可信扩展上下文开放", async () => {
    await send({ type: "GET_HISTORY", scope: "A" });
    assert.equal(accessLevel, "TRUSTED_CONTEXTS");
  });
  await t.test("网站默认关闭，读取、保存和删除均不读写历史", async () => {
    for (const type of ["GET_HISTORY", "RECORD", "DELETE"]) {
      const result = await send({ type, scope: "A", value: "尚未开启" });
      assert.equal(result.ok, true);
      assert.equal(result.enabled, false);
      assert.deepEqual(result.records, []);
      assert.deepEqual(store, {});
    }
  });
  await t.test("旧版默认开启不会自动启用网站；手动开启只作用于指定网站", async () => {
    store.settings = { enabled: true, disabledOrigins: [] };
    assert.equal((await send({ type: "GET_HISTORY", scope: "A" })).enabled, false);
    for (let i = 0; i < 2; i++) {
      const status = await send({ type: "SET_SITE_ENABLED", origin: "https://a.test/form", enabled: true }, popup);
      assert.deepEqual(status.settings.enabledOrigins, ["https://a.test"]);
    }
    assert.equal((await send({ type: "GET_HISTORY", scope: "A" })).enabled, true);
    assert.equal((await send({ type: "RECORD", scope: "A", value: "未开启的网站" },
      { ...content, url: "https://b.test/form" })).enabled, false);
  });
  await t.test("旧总开关关闭不妨碍已启用网站，旧开关消息不再接受", async () => {
    store.settings.enabled = false;
    assert.equal((await send({ type: "GET_HISTORY", scope: "A" })).enabled, true);
    assert.deepEqual((await send({ type: "STATUS" }, popup)).settings, { enabledOrigins: ["https://a.test"] });
    const before = structuredClone(store);
    assert.equal((await send({ type: "SET_ENABLED", enabled: false }, popup)).error, "UNKNOWN_MESSAGE");
    assert.deepEqual(store, before);
    await send({ type: "SET_SITE_ENABLED", origin: "https://a.test", enabled: true }, popup);
    assert.equal(Object.hasOwn(store.settings, "enabled"), false);
  });
  await t.test("两个字段、两个网站，即使内容相同也互不混用", async () => {
    await send({ type: "RECORD", scope: "A", value: "内容" });
    assert.equal((await send({ type: "GET_HISTORY", scope: "B" })).records.length, 0);
    const other = { ...content, url: "https://b.test/form" };
    assert.equal((await send({ type: "GET_HISTORY", scope: "A" }, other)).records.length, 0);
    await send({ type: "RECORD", scope: "B", value: "内容" });
    await send({ type: "DELETE", scope: "A", value: "内容" });
    assert.equal((await send({ type: "GET_HISTORY", scope: "B" })).records[0].count, 1);
  });
  await t.test("20 个并发输入不会相互覆盖导致少计", async () => {
    await Promise.all(Array.from({ length: 20 }, () => send({ type: "RECORD", scope: "parallel", value: "并发" })));
    assert.equal((await send({ type: "GET_HISTORY", scope: "parallel" })).records[0].count, 20);
  });
  await t.test("网页上下文无法读取全站数据或清空其他网站；无痕不记录", async () => {
    assert.equal((await send({ type: "STATUS" })).error, "FORBIDDEN");
    assert.equal((await send({ type: "CLEAR", target: "all" })).error, "FORBIDDEN");
    for (const type of ["GET_NATIVE_HISTORY", "SET_NATIVE_HISTORY"]) {
      assert.equal((await send({ type, enabled: false })).error, "FORBIDDEN");
    }
    assert.equal((await send({ type: "RECORD", scope: "private", value: "隐私" }, { ...content, tab: { id: 1, incognito: true } })).error, "UNSUPPORTED_PAGE");
  });
  await t.test("暂停本站后不再读取或记录，恢复后原记录仍在", async () => {
    await send({ type: "SET_SITE_ENABLED", origin: "https://a.test", enabled: false }, popup);
    const blocked = await send({ type: "RECORD", scope: "B", value: "不应保存" });
    assert.equal(blocked.enabled, false);
    assert.deepEqual(blocked.records, []);
    await send({ type: "SET_SITE_ENABLED", origin: "https://a.test", enabled: true }, popup);
    assert.deepEqual((await send({ type: "GET_HISTORY", scope: "B" })).records.map(item => item.value), ["内容"]);
  });
  await t.test("写入失败后队列仍可工作，错误不包含用户输入", async () => {
    failNextWrite = true;
    assert.equal((await send({ type: "RECORD", scope: "quota", value: "失败内容" })).error, "STORAGE_ERROR");
    assert.equal((await send({ type: "RECORD", scope: "quota", value: "重试" })).ok, true);
  });
  await t.test("清空本站不影响其他网站，全局清空保留启用设置", async () => {
    await send({ type: "SET_SITE_ENABLED", origin: "https://b.test", enabled: true }, popup);
    await send({ type: "RECORD", scope: "other", value: "其他站点" }, { ...content, url: "https://b.test/form" });
    let result = await send({ type: "CLEAR", target: "site", origin: "https://a.test" }, popup);
    assert.equal(result.stats.records, 1);
    assert.equal(result.stats.siteRecords, 0);
    result = await send({ type: "CLEAR", target: "all" }, popup);
    assert.equal(result.stats.records, 0);
    assert.equal(Object.hasOwn(store.settings, "enabled"), false);
    assert.deepEqual(store.settings.enabledOrigins.sort(), ["https://a.test", "https://b.test"]);
  });
  await t.test("停用网站保留旧记录且不可删除或迁移，重新开启后恢复原历史", async () => {
    await send({ type: "RECORD", scope: "kept-old", value: "保留历史" });
    await send({ type: "SET_SITE_ENABLED", origin: "https://a.test", enabled: false }, popup);
    const before = structuredClone(store);
    for (const type of ["GET_HISTORY", "RECORD", "DELETE"]) {
      const result = await send({ type, scope: "kept-new", legacyScope: "kept-old", value: "保留历史" });
      assert.equal(result.enabled, false);
      assert.deepEqual(result.records, []);
      assert.deepEqual(store, before);
    }
    await send({ type: "SET_SITE_ENABLED", origin: "https://a.test", enabled: true }, popup);
    assert.equal((await send({ type: "GET_HISTORY", scope: "kept-old" })).records[0].value, "保留历史");
  });
  await t.test("同类弹窗导入旧字段历史，累计次数只合并一次且保留隔离", async () => {
    await send({ type: "RECORD", scope: "dict-A-old", value: "共享条目" });
    await send({ type: "RECORD", scope: "dict-B-old", value: "共享条目" });
    const a = await send({ type: "GET_HISTORY", scope: "shared-item-name", legacyScope: "dict-A-old" });
    assert.equal(a.records[0].count, 1);
    const b = await send({ type: "GET_HISTORY", scope: "shared-item-name", legacyScope: "dict-B-old" });
    assert.equal(b.records[0].count, 2);
    assert.equal((await send({ type: "GET_HISTORY", scope: "dict-A-old" })).records.length, 0);
    // Simulate worker termination after storing the merge but before removing the source.
    await send({ type: "RECORD", scope: "dict-A-old", value: "共享条目" });
    assert.equal((await send({ type: "GET_HISTORY", scope: "shared-item-name", legacyScope: "dict-A-old" })).records[0].count, 2);
    assert.equal((await send({ type: "GET_HISTORY", scope: "other-field" })).records.length, 0);
  });
  await t.test("无效请求在迁移和写入之前被拒绝，不改变已有记录", async () => {
    await send({ type: "RECORD", scope: "invalid-old", value: "待迁移" });
    const before = structuredClone(store);
    for (const value of [null, "", " ", "x".repeat(4001)]) {
      const result = await send({ type: "RECORD", scope: "invalid-new", legacyScope: "invalid-old", value });
      assert.equal(result.error, "INVALID_VALUE");
      assert.deepEqual(store, before);
    }
    for (const scope of [null, "", 42, "x".repeat(12001)]) {
      assert.equal((await send({ type: "GET_HISTORY", scope })).error, "INVALID_SCOPE");
    }
    assert.equal((await send({ type: "SET_SITE_ENABLED", origin: "https://a.test", enabled: "false" }, popup)).error, "INVALID_SETTING");
    assert.equal((await send({ type: "CLEAR", target: "invalid" }, popup)).error, "INVALID_TARGET");
    assert.deepEqual(store, before);
  });
  await t.test("迁移写入后删除旧键失败，重试不会重复计数", async () => {
    await send({ type: "RECORD", scope: "retry-old", value: "迁移重试" });
    failNextRemove = true;
    assert.equal((await send({ type: "GET_HISTORY", scope: "retry-new", legacyScope: "retry-old" })).error, "STORAGE_ERROR");
    const retried = await send({ type: "GET_HISTORY", scope: "retry-new", legacyScope: "retry-old" });
    assert.equal(retried.ok, true);
    assert.equal(retried.records[0].count, 1);
    assert.deepEqual((await send({ type: "GET_HISTORY", scope: "retry-old" })).records, []);
  });
  await t.test("损坏的历史分组不会阻止设置读取、本站清空或全局清空", async () => {
    store["history:damaged-null"] = null;
    store["history:damaged-records"] = { origin: "https://a.test", records: [null, { value: 42 }] };
    const status = await send({ type: "STATUS", origin: "https://a.test" }, popup);
    assert.equal(status.ok, true);
    assert.ok(status.stats.records > 0);
    assert.equal((await send({ type: "CLEAR", target: "site", origin: "https://a.test" }, popup)).ok, true);
    const cleared = await send({ type: "CLEAR", target: "all" }, popup);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.stats.records, 0);
    assert.deepEqual(Object.keys(store), ["settings"]);
  });
});
