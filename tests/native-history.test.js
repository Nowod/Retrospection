import test from "node:test";
import assert from "node:assert/strict";
import { readNativeHistory, setNativeHistory, releaseNativeHistory } from "../extension/native-history.js";

function fixture({ granted = true, enabled = true, level = "controllable_by_this_extension" } = {}) {
  const writes = [];
  const original = enabled;
  const api = {
    permissions: { contains: async () => granted },
    privacy: { services: { autofillAddressEnabled: {
      get: async () => ({ value: enabled, levelOfControl: level }),
      set: async options => { writes.push(options); enabled = options.value; level = "controlled_by_this_extension"; },
      clear: async options => { writes.push({ clear: options }); enabled = original; level = "controllable_by_this_extension"; }
    } } }
  };
  return { api, writes };
}

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
    await releaseNativeHistory(api);
    assert.deepEqual(writes, []);
  }
});

test("恢复原设置撤销扩展控制，尊重用户原先关闭的设置", async () => {
  const { api, writes } = fixture({ enabled: false });
  await setNativeHistory(true, api);
  assert.equal((await releaseNativeHistory(api)).enabled, false);
  assert.deepEqual(writes.at(-1), { clear: { scope: "regular" } });
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

test("设置 API 读取、写入和恢复失败时不报告成功", async () => {
  for (const method of ["get", "set", "clear"]) {
    const { api } = fixture({ level: "controlled_by_this_extension" });
    api.privacy.services.autofillAddressEnabled[method] = async () => { throw new Error("API_FAILURE"); };
    const action = method === "get" ? readNativeHistory(api)
      : method === "set" ? setNativeHistory(false, api) : releaseNativeHistory(api);
    await assert.rejects(action, /API_FAILURE/);
  }
});
