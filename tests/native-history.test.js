import test from "node:test";
import assert from "node:assert/strict";
import { readNativeHistory, setNativeHistory, initializeNativeHistory } from "../extension/native-history.js";

function fixture({ granted = true, enabled = true, level = "controllable_by_this_extension" } = {}) {
  const writes = [];
  const store = {};
  const api = {
    permissions: { contains: async () => granted },
    storage: { local: {
      get: async key => ({ [key]: store[key] }),
      set: async values => Object.assign(store, values)
    } },
    privacy: { services: { autofillAddressEnabled: {
      get: async () => ({ value: enabled, levelOfControl: level }),
      set: async options => { writes.push(options); enabled = options.value; level = "controlled_by_this_extension"; }
    } } }
  };
  return { api, writes, store };
}

test("首次授权后默认关闭，重复初始化和手动开启后均不覆盖选择", async () => {
  const { api, writes, store } = fixture({ granted: false });
  assert.equal((await initializeNativeHistory(api)).granted, false);
  assert.deepEqual(store, {});
  assert.deepEqual(writes, []);
  api.permissions.contains = async () => true;
  assert.equal((await initializeNativeHistory(api)).enabled, false);
  assert.equal((await initializeNativeHistory(api)).enabled, false);
  assert.deepEqual(writes, [{ value: false, scope: "regular" }]);
  assert.equal(store.nativeAutofillConfigured, true);
  await setNativeHistory(true, api);
  assert.equal((await initializeNativeHistory(api)).enabled, true);
  assert.equal(writes.length, 2);
});

test("默认关闭遇到策略锁定或写入失败时不标记完成，允许稍后重试", async () => {
  for (const level of ["not_controllable", "controlled_by_other_extensions"]) {
    const { api, writes, store } = fixture({ level });
    assert.equal((await initializeNativeHistory(api)).canChange, false);
    assert.deepEqual(writes, []);
    assert.deepEqual(store, {});
  }
  const { api, store } = fixture();
  const setting = api.privacy.services.autofillAddressEnabled;
  const original = setting.set;
  setting.set = async () => { throw new Error("API_FAILURE"); };
  await assert.rejects(initializeNativeHistory(api), /API_FAILURE/);
  assert.deepEqual(store, {});
  setting.set = original;
  assert.equal((await initializeNativeHistory(api)).enabled, false);
  assert.equal(store.nativeAutofillConfigured, true);
});

test("未授权时不猜测 Chrome 状态，不读取 privacy API，不改变偏好", async () => {
  const { api, writes } = fixture({ granted: false });
  delete api.privacy;
  assert.deepEqual(await readNativeHistory(api), { granted: false, enabled: null, canChange: false, level: null });
  await assert.rejects(setNativeHistory(false, api), /NATIVE_PERMISSION/);
  assert.deepEqual(writes, []);
});

test("开关写入真实 ChromeSetting，并重新读取验证结果", async () => {
  const { api, writes } = fixture();
  assert.equal((await setNativeHistory(false, api)).enabled, false);
  assert.equal((await setNativeHistory(true, api)).enabled, true);
  assert.deepEqual(writes, [{ value: false, scope: "regular" }, { value: true, scope: "regular" }]);
});

test("策略锁定或其他扩展控制时不强行写入", async () => {
  for (const level of ["not_controllable", "controlled_by_other_extensions"]) {
    const { api, writes } = fixture({ level });
    assert.equal((await readNativeHistory(api)).canChange, false);
    await assert.rejects(setNativeHistory(false, api), /NATIVE_LOCKED/);
    assert.deepEqual(writes, []);
  }
});

test("无效参数和被外部立即覆盖的设置均不会报告成功", async () => {
  const { api, writes } = fixture();
  await assert.rejects(setNativeHistory("false", api), /INVALID_SETTING/);
  assert.deepEqual(writes, []);
  api.privacy.services.autofillAddressEnabled.set = async () => {};
  await assert.rejects(setNativeHistory(false, api), /NATIVE_LOCKED/);
});

test("权限存在但 Chrome 设置 API 不可用时返回明确错误", async () => {
  const { api, writes } = fixture();
  delete api.privacy.services.autofillAddressEnabled;
  await assert.rejects(readNativeHistory(api), /NATIVE_UNAVAILABLE/);
  await assert.rejects(setNativeHistory(false, api), /NATIVE_UNAVAILABLE/);
  assert.deepEqual(writes, []);
});

test("设置 API 读取和写入失败时不报告成功", async () => {
  for (const method of ["get", "set"]) {
    const { api } = fixture({ level: "controlled_by_this_extension" });
    api.privacy.services.autofillAddressEnabled[method] = async () => { throw new Error("API_FAILURE"); };
    const action = method === "get" ? readNativeHistory(api) : setNativeHistory(false, api);
    await assert.rejects(action, /API_FAILURE/);
  }
});
