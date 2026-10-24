import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchExtension, startFixtureServer, poll, contentScript } from "./helpers/browser.mjs";

const { server, base } = await startFixtureServer();
const profile = await mkdtemp(join(tmpdir(), "retrospection-lifecycle-"));
const failures = [];
let context;
let passed = 0;

try {
  context = await launchExtension(profile);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = context.pages()[0];
  page.setDefaultTimeout(5000);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const send = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const evaluate = (fn, argument) => contentScript(page, extensionId, `(${fn})(${JSON.stringify(argument) ?? "undefined"})`);
  const host = () => page.locator('[data-retrospection-root]');
  const records = async () => Object.entries(await worker.evaluate(() => chrome.storage.local.get(null)))
    .filter(([key]) => key.startsWith("history:")).flatMap(([, history]) => history.records);
  const record = async value => (await records()).find(item => item.value === value);
  const saved = (value, count = 1) => poll(() => record(value), item => item?.events.length === count, `${value}: ${count}`);
  const settle = async () => { await send({ type: "STATUS" }); await page.waitForTimeout(100); };
  const save = async (value, selector = '#first') => {
    await page.locator(selector).fill(value);
    await page.locator(selector).press("Enter");
    await saved(value);
    await page.locator('#outside').click();
  };
  const open = async (selector = '#first') => {
    await page.locator(selector).fill("");
    await page.locator(selector).click();
    await poll(() => host().isVisible(), Boolean, "history visible");
  };
  const check = async (name, run) => {
    await page.goto("about:blank");
    await send({ type: "STATUS" });
    await worker.evaluate(() => chrome.storage.local.clear());
    assert.equal((await send({ type: "SET_SITE_ENABLED", origin: base, enabled: true })).ok, true);
    await page.goto(`${base}/fixture.html`);
    await evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.lastHistoryEnabled = null;
      chrome.runtime.sendMessage = async (...args) => {
        const response = await original(...args);
        if (args[0].type === "GET_HISTORY") globalThis.lastHistoryEnabled = response.enabled;
        return response;
      };
    });
    try {
      await run();
      console.log(`PASS ${++passed}: ${name}`);
    } catch (error) {
      failures.push({ name, message: error.message });
      console.error(`FAIL: ${name}\n${error.stack}`);
    }
  };

  await check("带修饰键的 Delete 不会误删历史，单独 Delete 仍可删除", async () => {
    await save("快捷键记录");
    await open();
    await page.locator('#first').press("ArrowDown");
    for (const key of ["Control+Delete", "Shift+Delete", "Alt+Delete", "Meta+Delete"]) {
      await page.locator('#first').press(key);
      await settle();
      assert.ok(await record("快捷键记录"), key);
    }
    await page.locator('#first').press("Delete");
    await poll(() => record("快捷键记录"), item => !item, "plain Delete removes record");
  });

  await check("带修饰键的 Enter 不会擅自回填，单独 Enter 正常回填", async () => {
    await save("组合确认键记录");
    await open();
    for (const key of ["Control+Enter", "Shift+Enter", "Alt+Enter", "Meta+Enter"]) {
      await page.locator('#first').press("ArrowDown");
      await page.locator('#first').press(key);
      assert.equal(await page.locator('#first').inputValue(), "", key);
    }
    await page.locator('#first').press("ArrowDown");
    await page.locator('#first').press("Enter");
    await saved("组合确认键记录", 2);
  });

  await check("保持焦点暂停并恢复网站，不补记暂停期间的输入", async () => {
    await page.locator('#first').click();
    await poll(() => evaluate(() => lastHistoryEnabled), value => value === true, "initial enabled");
    await send({ type: "SET_SITE_ENABLED", origin: base, enabled: false });
    await poll(() => evaluate(() => lastHistoryEnabled), value => value === false, "paused");
    await page.locator('#first').fill("暂停期间输入");
    await send({ type: "SET_SITE_ENABLED", origin: base, enabled: true });
    await poll(() => evaluate(() => lastHistoryEnabled), value => value === true, "resumed");
    await page.locator('#outside').click();
    await settle();
    assert.equal(await record("暂停期间输入"), undefined);
    await save("恢复后编辑");
  });

  await check("清空后迟到的保存失败不会让旧草稿在失焦时复活", async () => {
    await page.locator('#first').fill("应被清空的草稿");
    await evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let held = false;
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message.type === "RECORD" && !held) {
          held = true;
          return new Promise(resolve => { globalThis.failPendingSave = () => resolve({ ok: false, error: "STORAGE_ERROR" }); });
        }
        return original(message, ...args);
      };
    });
    await page.locator('#first').press("Enter");
    await send({ type: "CLEAR", target: "all" });
    await settle();
    await evaluate(() => failPendingSave());
    await page.waitForTimeout(50);
    await page.locator('#outside').click();
    await settle();
    assert.equal(await record("应被清空的草稿"), undefined);
  });

  await check("删除等待期间重新输入同一内容，新的输入仍可正常保存", async () => {
    await save("删除后重新输入");
    await open();
    await evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message, ...args) => {
        const response = await original(message, ...args);
        if (message.type === "DELETE") await new Promise(resolve => { globalThis.finishDelete = resolve; });
        return response;
      };
    });
    await host().locator('.row').hover();
    await host().locator('.delete').click();
    await poll(() => record("删除后重新输入"), item => !item, "delete persisted");
    await page.locator('#first').fill("删除后重新输入");
    await evaluate(() => finishDelete());
    await page.waitForTimeout(50);
    await page.locator('#outside').click();
    await saved("删除后重新输入");
  });

  await check("原生模态 dialog 内的历史可以用鼠标回填和删除", async () => {
    await page.evaluate(() => {
      const dialog = document.createElement("dialog");
      dialog.setAttribute("aria-label", "新增条目");
      dialog.innerHTML = '<input id="native-dialog-field"><button id="dialog-outside">其他</button>';
      document.body.append(dialog);
      dialog.showModal();
    });
    await page.locator('#native-dialog-field').fill("原生弹窗历史");
    await page.locator('#native-dialog-field').press("Enter");
    await saved("原生弹窗历史");
    await open('#native-dialog-field');
    await host().locator('.fill').click();
    assert.equal(await page.locator('#native-dialog-field').inputValue(), "原生弹窗历史");
    await saved("原生弹窗历史", 2);
    await open('#native-dialog-field');
    await host().locator('.row').hover();
    await host().locator('.delete').click();
    await poll(() => record("原生弹窗历史"), item => !item, "dialog delete");
    await page.locator('dialog').evaluate(element => element.remove());
    await save("普通输入框仍可用");
    await open();
    await host().locator('.fill').click();
    await saved("普通输入框仍可用", 2);
  });

  await check("纯文本可编辑区域回填保留连续空格和制表符", async () => {
    await page.locator('#editable').fill("首段  两个空格\t尾段");
    const text = await page.locator('#editable').innerText();
    await page.locator('#outside').click();
    await saved(text);
    await open('#editable');
    await host().locator('.fill').click();
    assert.equal(await page.locator('#editable').innerText(), text);
    await saved(text, 2);
  });

  await check("表单原生重置后不保存被取消的草稿，空框重新显示历史", async () => {
    await save("重置前历史");
    await page.locator('#first').fill("已取消的草稿");
    await page.locator('#first-form').evaluate(element => element.reset());
    assert.equal(await page.locator('#first').inputValue(), "");
    await poll(() => host().isVisible(), Boolean, "reset reopens history");
    await page.locator('#outside').click();
    await settle();
    assert.equal(await record("已取消的草稿"), undefined);
  });

  await check("记录和删除失败可恢复，未成功删除的记录保留", async () => {
    await save("删除失败应保留");
    await open();
    await evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let failed = false;
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message.type === "DELETE" && !failed) { failed = true; return Promise.resolve({ ok: false, error: "STORAGE_ERROR" }); }
        return original(message, ...args);
      };
    });
    await host().locator('.row').hover();
    await host().locator('.delete').click();
    await poll(() => host().locator('.notice').textContent(), text => text.includes("删除失败"), "delete failure visible");
    assert.ok(await record("删除失败应保留"));
    await host().locator('.delete').click();
    await poll(() => record("删除失败应保留"), item => !item, "retry removes record");
  });

  await check("取消原生重置会保留输入，真正重置按钮会刷新空框列表", async () => {
    await save("原生重置历史");
    await page.locator('#first').fill("取消重置保留草稿");
    await page.locator('#first-form').evaluate(element => {
      element.addEventListener("reset", event => event.preventDefault(), { once: true });
      element.reset();
    });
    assert.equal(await page.locator('#first').inputValue(), "取消重置保留草稿");
    await page.locator('#outside').click();
    await saved("取消重置保留草稿");
    await page.locator('#first-form').evaluate(element => {
      const button = document.createElement("button");
      button.id = "reset-button";
      button.type = "reset";
      button.textContent = "重置";
      button.addEventListener("mousedown", event => event.preventDefault());
      element.append(button);
    });
    await page.locator('#first').fill("按钮重置取消草稿");
    await page.locator('#reset-button').click();
    assert.equal(await page.locator('#first').inputValue(), "");
    await poll(() => host().isVisible(), Boolean, "native reset button refreshes history");
    await page.locator('#outside').click();
    await settle();
    assert.equal(await record("按钮重置取消草稿"), undefined);
  });

  await check("暂停状态读取失败也不恢复记录，重新启用后只记录新编辑", async () => {
    await page.locator('#first').click();
    await send({ type: "SET_SITE_ENABLED", origin: base, enabled: false });
    await poll(() => evaluate(() => lastHistoryEnabled), value => value === false, "paused");
    await evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let failed = false;
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message.type === "GET_HISTORY" && !failed) { failed = true; return Promise.resolve({ ok: false, error: "STORAGE_ERROR" }); }
        return original(message, ...args);
      };
    });
    await page.locator('#first').click();
    await page.locator('#first').fill("失败读取期间的暂停输入");
    await send({ type: "SET_SITE_ENABLED", origin: base, enabled: true });
    await poll(() => evaluate(() => lastHistoryEnabled), value => value === true, "resumed");
    await page.locator('#outside').click();
    await settle();
    assert.equal(await record("失败读取期间的暂停输入"), undefined);
    await save("读取恢复后的输入");
  });

  await check("保存失败后可以按 Enter 重试，重试加失焦只计一次", async () => {
    await page.locator('#first').fill("保存重试内容");
    await evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.saveRequestsFail = true;
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message.type === "RECORD" && saveRequestsFail) return Promise.resolve({ ok: false, error: "STORAGE_ERROR" });
        return original(message, ...args);
      };
    });
    await page.locator('#first').press("Enter");
    await settle();
    assert.equal(await record("保存重试内容"), undefined);
    await evaluate(() => { globalThis.saveRequestsFail = false; });
    await page.locator('#first').press("Enter");
    await page.locator('#outside').click();
    await saved("保存重试内容");
  });

  await check("重置后立即切换焦点不会保存旧草稿；取消重置时仍可保存", async () => {
    for (const cancelled of [false, true]) {
      const text = cancelled ? "取消重置并切换焦点" : "立即重置并切换焦点";
      await page.locator('#first').fill(text);
      await page.evaluate(cancelled => {
        const form = document.querySelector('#first-form');
        if (cancelled) form.addEventListener("reset", event => event.preventDefault(), { once: true });
        form.reset();
        document.querySelector('#second').focus();
      }, cancelled);
      await settle();
      if (cancelled) await saved(text);
      else assert.equal(await record(text), undefined);
    }
  });

  await check("长时间停留后再次点击当前输入框，会重新计算七天次数", async () => {
    await save("七天窗口刷新");
    await open();
    assert.equal(await host().locator('.count').innerText(), "1");
    await worker.evaluate(() => {
      globalThis.originalReviewClock = Date.now;
      const now = Date.now();
      Date.now = () => now + 8 * 86400000;
    });
    try {
      await page.locator('#first').click();
      await poll(() => host().locator('.count').innerText(), text => text === "0", "rolling count refreshed");
    } finally {
      await worker.evaluate(() => { Date.now = globalThis.originalReviewClock; delete globalThis.originalReviewClock; });
    }
  });

  await check("页面往返后历史仍可回填，过期缓存不会带回已删除记录", async () => {
    await save("页面往返历史");
    await open();
    await page.goto(`${base}/other.html`);
    await open();
    await host().locator('.row').hover();
    await host().locator('.delete').click();
    await poll(() => record("页面往返历史"), item => !item, "deleted on other page");
    await page.goBack();
    await page.locator('#first').click();
    await settle();
    assert.equal(await host().isVisible(), false);
    await save("往返后的新记录");
    await open();
    await host().locator('.fill').click();
    await saved("往返后的新记录", 2);
  });

  assert.deepEqual(failures, [], "All lifecycle scenarios pass");
  console.log(`\n${passed} lifecycle scenarios passed with the actual unpacked extension.`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
