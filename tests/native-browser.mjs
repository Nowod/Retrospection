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
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await page.waitForFunction(() => !document.querySelector("#native-status").textContent.includes("正在读取"));
    assert.match(await page.locator("#native-note").textContent(), /会同时影响地址自动填充/);
    if (!granted) {
      assert.equal(await page.locator("#native-enabled").isDisabled(), true);
      assert.equal(await page.locator("#native-grant").isVisible(), true);
      await page.evaluate(() => { chrome.permissions.request = async () => false; });
      await page.locator("#native-grant").click();
      await page.waitForFunction(() => document.querySelector("#message").textContent.includes("未授予权限"));
      assert.equal(await worker.evaluate(() => chrome.permissions.contains({ permissions: ["privacy"] })), false);
      console.log("PASS: 未授权显示未知状态，拒绝授权保持 Chrome 原设置");
    } else {
      const read = () => worker.evaluate(() => chrome.privacy.services.autofillAddressEnabled.get({}));
      const original = (await read()).value;
      await page.locator("#native-enabled").setChecked(!original);
      await page.waitForFunction(value => document.querySelector("#native-enabled").checked === value && !document.querySelector("#native-enabled").disabled, !original);
      assert.equal((await read()).value, !original);
      await page.reload();
      await page.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal(await page.locator("#native-enabled").isChecked(), !original);
      await page.locator("#native-enabled").setChecked(original);
      await page.waitForFunction(() => !document.querySelector("#native-enabled").disabled);
      assert.equal((await read()).value, original);
      await page.locator("#native-release").click();
      await page.locator("#native-release").waitFor({ state: "hidden" });
      assert.equal((await read()).value, original);
      console.log("PASS: 真实 Chrome 全局开关双向写入、重开持久化与恢复原设置");
      await worker.evaluate(value => chrome.privacy.services.autofillAddressEnabled.set({ value }), !original);
      await page.waitForFunction(value => document.querySelector("#native-enabled").checked === value, !original);
      await page.locator("#native-release").click();
      await page.locator("#native-release").waitFor({ state: "hidden" });
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
