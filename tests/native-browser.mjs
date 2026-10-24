import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, launchExtension } from "./helpers/browser.mjs";
const temporary = await mkdtemp(join(tmpdir(), "retrospection-native-"));
let context;
try {
  for (const granted of [false, true]) {
    const extension = join(temporary, granted ? "granted" : "optional");
    await cp(join(root, "extension"), extension, { recursive: true });
    if (granted) {
      // Grant only in this disposable test copy: no prompt and no user's profile.
      const manifestPath = join(extension, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.permissions.push("privacy");
      delete manifest.optional_permissions;
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    context = await launchExtension(join(temporary, granted ? "profile-granted" : "profile-optional"), extension, {
      viewport: { width: 500, height: 1000 }
    });
    let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    let page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await page.waitForFunction(() => !document.querySelector("#native-status").textContent.includes("正在读取"));
    assert.equal(await page.locator('label[for="native-enabled"] strong').textContent(), "浏览器自动填充");
    assert.match(await page.locator("#native-note").textContent(), /全局生效.*地址填充/);
    assert.equal(await page.locator(".native-controls button").count(), 0);
    if (!granted) {
      assert.equal(await page.locator("#native-enabled").isDisabled(), false);
      assert.equal(await page.locator("#native-enabled").evaluate(element => element.indeterminate), true);
      await page.evaluate(() => {
        globalThis.permissionRequests = [];
        chrome.permissions.request = options => {
          permissionRequests.push({ options, active: navigator.userActivation.isActive });
          return new Promise(resolve => { globalThis.resolvePermission = resolve; });
        };
      });
      await page.locator("#native-enabled").click();
      assert.equal(await page.locator("#native-enabled").isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => permissionRequests), [
        { options: { permissions: ["privacy"] }, active: true }
      ]);
      await page.evaluate(() => resolvePermission(false));
      await page.waitForFunction(() => document.querySelector("#message").textContent.includes("未授予权限"));
      await page.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal(await page.locator("#native-enabled").evaluate(element => element.indeterminate), true);
      assert.equal(await worker.evaluate(() => chrome.permissions.contains({ permissions: ["privacy"] })), false);
      assert.equal(await worker.evaluate(async () =>
        (await chrome.storage.local.get("nativeAutofillConfigured")).nativeAutofillConfigured), undefined);
      console.log("PASS: 点击开关直接请求权限，等待期间防止重复点击，拒绝后恢复未授权状态");
      await page.evaluate(() => {
        chrome.permissions.request = async () => { throw new Error("PERMISSION_FAILURE"); };
      });
      await page.locator("#native-enabled").press("Space");
      await page.waitForFunction(() => document.querySelector("#message").textContent.includes("无法修改"));
      await page.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal(await page.locator("#native-enabled").evaluate(element => element.indeterminate), true);
      console.log("PASS: 键盘切换也能请求权限，权限申请异常后开关仍可重试");
    } else {
      const read = () => worker.evaluate(() => chrome.privacy.services.autofillAddressEnabled.get({}));
      await page.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal((await read()).value, false);
      assert.equal((await read()).levelOfControl, "controlled_by_this_extension");
      assert.equal(await worker.evaluate(async () =>
        (await chrome.storage.local.get("nativeAutofillConfigured")).nativeAutofillConfigured), true);
      console.log("PASS: 授权后真实 Chrome 自动填充默认关闭");
      // Permission is pregranted only in this temporary copy. Simulate the UI's
      // initial unknown state, then request the real permission in a click gesture.
      const authorization = await context.newPage();
      await authorization.addInitScript(() => {
        let pending = true;
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        const request = chrome.permissions.request.bind(chrome.permissions);
        globalThis.permissionRequests = [];
        chrome.runtime.sendMessage = async (message, ...args) => {
          const response = await send(message, ...args);
          return message.type === "GET_NATIVE_HISTORY" && pending
            ? { ...response, granted: false, enabled: null, canChange: false, level: null } : response;
        };
        chrome.permissions.request = async options => {
          permissionRequests.push({ options, active: navigator.userActivation.isActive });
          const allowed = await request(options);
          if (allowed) pending = false;
          return allowed;
        };
      });
      await authorization.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
      await authorization.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal(await authorization.locator("#native-enabled").evaluate(element => element.indeterminate), true);
      await authorization.locator("#native-enabled").click();
      await authorization.waitForFunction(() => document.querySelector("#native-enabled").checked && !document.querySelector("#native-enabled").disabled);
      assert.deepEqual(await authorization.evaluate(() => permissionRequests), [
        { options: { permissions: ["privacy"] }, active: true }
      ]);
      assert.equal((await read()).value, true);
      await authorization.close();
      console.log("PASS: 开关内授权成功后应用本次选择，真实 Chrome 设置同步开启");
      await page.reload();
      await page.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal(await page.locator("#native-enabled").isChecked(), true);

      // Restart the browser and worker, retaining only this disposable profile.
      await context.close();
      context = null;
      context = await launchExtension(join(temporary, "profile-granted"), extension);
      worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(8000);
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
      await page.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal(await page.locator("#native-enabled").isChecked(), true);
      assert.equal((await read()).value, true);
      console.log("PASS: 手动开启后，重开设置和重启浏览器均不覆盖选择");

      await page.locator("#native-enabled").uncheck();
      await page.waitForFunction(() => !document.querySelector("#native-enabled").checked && !document.querySelector("#native-enabled").disabled);
      assert.equal((await read()).value, false);
      await page.reload();
      await page.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal((await read()).value, false);
      assert.equal(await page.locator("#native-enabled").isChecked(), false);
      assert.equal(await page.locator("#native-status").isVisible(), false);
      console.log("PASS: 手动关闭后重开设置保留状态，授权后仅显示开关");
      await worker.evaluate(() => chrome.privacy.services.autofillAddressEnabled.set({ value: true }));
      await page.waitForFunction(() => document.querySelector("#native-enabled").checked);
      await page.locator("#native-enabled").uncheck();
      await page.waitForFunction(() => !document.querySelector("#native-enabled").checked && !document.querySelector("#native-enabled").disabled);
      assert.equal((await read()).value, false);
      await mkdir(join(root, "test-results"), { recursive: true });
      await page.locator("body").screenshot({ path: join(root, "test-results/native-popup.png") });
      console.log("PASS: 外部设置变更实时反映到开关");
    }
    await context.close();
    context = null;
  }
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
