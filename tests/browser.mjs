import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { root, output, launchExtension, startFixtureServer, poll, contentScript } from "./helpers/browser.mjs";

await mkdir(output, { recursive: true });
const { server, base, port } = await startFixtureServer();
const profile = await mkdtemp(join(tmpdir(), "retrospection-browser-"));
const extension = join(root, "extension");
let context;
let passed = 0;

try {
  context = await launchExtension(profile, extension);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.text().includes("[Retrospection]")) console.log(message.text()); });
  const host = target => target.locator("[data-retrospection-root]");
  const values = target => host(target).locator(".row .value").allTextContents();
  const allStorage = () => worker.evaluate(() => chrome.storage.local.get(null));
  const record = async value => {
    const all = await allStorage();
    for (const [key, history] of Object.entries(all)) {
      if (!key.startsWith("history:")) continue;
      const item = history.records.find(item => item.value === value);
      if (item) return { key, ...item };
    }
    return null;
  };
  const waitCount = (value, count) => poll(() => record(value), item => item?.events.length === count, `${value} count ${count}`);
  const focus = async (target, selector) => {
    await target.locator(selector).fill("");
    await target.locator(selector).click();
    await poll(() => target.locator(selector).getAttribute("aria-expanded"), value => value === "true" || value === "false", "history loaded");
  };
  const save = async (target, selector, value) => {
    await target.locator(selector).fill(value);
    await target.locator(selector).press("Enter");
    await target.locator("#outside").click();
  };
  const check = async (name, run) => {
    await run();
    passed++;
    console.log(`PASS ${passed}: ${name}`);
  };

  await page.goto(`${base}/fixture.html`);
  await check("无历史时不显示列表；Enter + submit + blur 只计一次", async () => {
    await focus(page, "#first");
    assert.equal(await host(page).isVisible(), false);
    await save(page, "#first", "第一条内容");
    await waitCount("第一条内容", 1);
    await page.locator("#first").click();
    await poll(() => page.locator("#first").getAttribute("aria-expanded"), value => value === "false", "nonempty focus stays closed");
    assert.equal(await host(page).isVisible(), false);
    await focus(page, "#first");
    assert.deepEqual(await values(page), ["第一条内容"]);
    assert.equal(await host(page).locator(".count").innerText(), "1");
    await page.locator("#outside").click();
    assert.equal((await record("第一条内容")).events.length, 1);
  });

  await check("占位符或名称相同但稳定 ID 不同的字段仍独立", async () => {
    await focus(page, "#second");
    assert.deepEqual(await values(page), []);
    await save(page, "#second", "第二个框");
    await focus(page, "#third");
    assert.deepEqual(await values(page), []);
    await focus(page, "#first");
    assert.deepEqual(await values(page), ["第一条内容"]);
  });

  await check("仅空输入框显示排序历史，输入、点击及方向键不会唤起，清空后恢复", async () => {
    await save(page, "#first", "更常用的内容");
    await save(page, "#first", "更常用的内容");
    await waitCount("更常用的内容", 2);
    await focus(page, "#first");
    assert.deepEqual(await values(page), ["更常用的内容", "第一条内容"]);
    await page.locator("#first").fill("第一");
    assert.equal(await host(page).isVisible(), false);
    await page.locator("#first").click();
    await page.locator("#first").press("ArrowDown");
    await page.locator("#first").press("ArrowUp");
    assert.equal(await host(page).isVisible(), false);
    assert.equal(await page.locator("#first").inputValue(), "第一");
    await page.locator("#first").fill(" ");
    assert.equal(await host(page).isVisible(), false);
    await page.locator("#first").fill("");
    assert.equal(await host(page).isVisible(), true);
    assert.deepEqual(await values(page), ["更常用的内容", "第一条内容"]);
    await page.locator("#first").evaluate(element => { element.value = "预置内容"; element.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await host(page).isVisible(), false);
    await page.locator("#first").fill("");
    await page.locator("#first").press("Escape");
    assert.equal(await host(page).isVisible(), false);
    await page.locator("#first").fill("");
    await page.locator("#outside").click();
  });

  await check("悬浮选中，点击右侧次数也能回填，并触发 input/change", async () => {
    await focus(page, "#first");
    const row = host(page).locator(".row").first();
    await row.hover();
    assert.match(await row.getAttribute("class"), /selected/);
    assert.equal(await row.locator(".delete").isVisible(), true);
    await row.locator(".count").click();
    assert.equal(await page.locator("#first").inputValue(), "更常用的内容");
    assert.equal(await host(page).isVisible(), false);
    await waitCount("更常用的内容", 3);
    const events = await page.evaluate(() => window.changes.slice(-2));
    assert.deepEqual(events.map(item => item[0]), ["input", "change"]);
    await page.locator("#outside").click();
    assert.equal((await record("更常用的内容")).events.length, 3);
    await focus(page, "#first");
    const fullRow = host(page).locator(".row").first();
    const bounds = await fullRow.boundingBox();
    // The small gap beside the delete button is also part of the fill target.
    await fullRow.click({ position: { x: bounds.width - 2, y: bounds.height / 2 } });
    await waitCount("更常用的内容", 4);
  });

  await check("点击删除保持输入值及焦点，删除后不会在 blur 时复活", async () => {
    await focus(page, "#first");
    const before = await page.locator("#first").inputValue();
    const row = host(page).locator(".row").filter({ hasText: "第一条内容" });
    await row.hover();
    await row.locator(".delete").click();
    await poll(() => record("第一条内容"), item => item === null, "deleted record");
    assert.equal(await page.locator("#first").inputValue(), before);
    assert.equal(await page.locator("#first").evaluate(element => element === document.activeElement), true);
    await page.locator("#outside").click();
    assert.equal(await record("第一条内容"), null);
  });

  await check("方向键选择并回填；ArrowUp 首次选中最后一条", async () => {
    await save(page, "#first", "键盘的第二条");
    await focus(page, "#first");
    await page.locator("#first").press("ArrowUp");
    const chosen = await host(page).locator(".selected .value").textContent();
    assert.equal(chosen, "键盘的第二条");
    await page.locator("#first").press("Enter");
    assert.equal(await page.locator("#first").inputValue(), chosen);
    await waitCount(chosen, 2);
    await page.locator("#outside").click();
    await focus(page, "#first");
    await page.locator("#first").press("ArrowDown");
    await page.locator("#first").press("Delete");
    await poll(() => record("更常用的内容"), item => item === null, "keyboard delete");
  });

  await check("刷新持久化；同站不同路径中的相同输入框共享历史", async () => {
    await page.reload();
    await focus(page, "#first");
    assert.deepEqual(await values(page), ["键盘的第二条"]);
    await page.goto(`${base}/fixture.html?search=another`);
    await focus(page, "#first");
    assert.deepEqual(await values(page), ["键盘的第二条"]);
    await page.goto(`${base}/other.html`);
    await focus(page, "#first");
    assert.deepEqual(await values(page), ["键盘的第二条"]);
    await page.goto(`${base}/fixture.html`);
  });

  await check("七天之外的记录保留为零次，历史 HTML 当作纯文本呈现", async () => {
    const saved = await record("键盘的第二条");
    await worker.evaluate(async key => {
      const history = (await chrome.storage.local.get(key))[key];
      const now = Date.now();
      history.records.push({ value: "七天前的旧内容", lastUsed: now - 8 * 86400000, events: [now - 8 * 86400000] });
      history.records.push({ value: "<img src=x onerror=alert(1)>", lastUsed: now - 1, events: [now - 1] });
      await chrome.storage.local.set({ [key]: history });
    }, saved.key);
    await focus(page, "#first");
    assert.deepEqual(await values(page), ["键盘的第二条", "<img src=x onerror=alert(1)>", "七天前的旧内容"]);
    assert.equal(await host(page).locator(".row").last().locator(".count").innerText(), "0");
    assert.equal(await host(page).locator("img").count(), 0);
  });

  await check("密码、验证码、只读及主动排除字段不记录，脚本赋值不记录", async () => {
    for (const selector of ["#password", "#otp", "#readonly", "#ignored"]) {
      await page.locator(selector).click();
      assert.equal(await host(page).isVisible(), false);
    }
    await page.locator("#password").fill("password-must-not-save");
    await page.locator("#otp").fill("123456");
    await page.locator("#outside").click();
    assert.equal(await record("password-must-not-save"), null);
    assert.equal(await record("123456"), null);
    await focus(page, "#second");
    await page.locator("#second").evaluate(element => { element.value = "script-value"; element.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.locator("#outside").click();
    assert.equal(await record("script-value"), null);
  });

  await check("多行文本与普通 contenteditable 可记录和回填", async () => {
    await page.locator("#multi").fill("第一行\n第二行");
    await page.locator("#outside").click();
    await waitCount("第一行\n第二行", 1);
    await focus(page, "#multi");
    await host(page).locator(".fill").click();
    assert.equal(await page.locator("#multi").inputValue(), "第一行\n第二行");
    await page.locator("#editable").fill("可编辑区域");
    await page.locator("#outside").click();
    await waitCount("可编辑区域", 1);
    await focus(page, "#editable");
    await host(page).locator(".fill").click();
    assert.equal(await page.locator("#editable").innerText(), "可编辑区域");
  });

  await check("可编辑区域保留换行与空行，清空后显示历史，HTML 内容仍作为纯文本", async () => {
    for (const text of ["可编辑首行\n\n可编辑末行", "<b>普通文本</b>\n下一行\n"]) {
      await page.locator('#editable').fill(text);
      // Native editing can use block elements for blank lines. Compare with
      // Chrome's rendered text rather than assuming its generated markup.
      const original = await page.locator('#editable').innerText();
      await page.locator('#outside').click();
      await waitCount(original, 1);
      await focus(page, '#editable');
      assert.equal(await host(page).isVisible(), true);
      await host(page).locator('.fill').filter({ hasText: text.split("\n")[0] }).click();
      assert.equal(await page.locator('#editable').innerText(), original);
      assert.equal(await page.locator('#editable b').count(), 0);
      await waitCount(original, 2);
      await page.locator('#outside').click();
      assert.equal((await record(original)).events.length, 2);
    }
    await focus(page, '#editable');
    await page.locator('#editable').fill(" ");
    assert.equal(await host(page).isVisible(), false);
    await page.locator('#editable').fill("");
    await page.locator('#editable').press("Enter");
    assert.equal(await host(page).isVisible(), false);
    await page.locator('#editable').fill("");
    assert.equal(await host(page).isVisible(), true);
  });

  await check("同名同属性字段共享，Shadow DOM 与无名字段结构仍可区分", async () => {
    await page.evaluate(() => {
      for (const id of ["shadow-one", "shadow-two"]) {
        const host = document.createElement("div");
        host.id = id;
        host.attachShadow({ mode: "open" }).innerHTML = '<input id="same" style="padding:12px;width:380px;margin:12px">';
        document.body.append(host);
      }
    });
    await page.locator("#shadow-one #same").fill("Shadow 的历史");
    await page.locator("#outside").click();
    await waitCount("Shadow 的历史", 1);
    await focus(page, "#shadow-two #same");
    assert.deepEqual(await values(page), []);
    await page.evaluate(() => {
      const section = document.createElement("section");
      section.id = "dynamic";
      section.innerHTML = '<form id="named-a"><input name="same-name"></form><form id="named-b"><input name="same-name"></form><input><input>';
      document.body.append(section);
    });
    await page.locator("#named-a input").fill("两个表单共享的历史");
    await page.locator("#outside").click();
    await waitCount("两个表单共享的历史", 1);
    await focus(page, "#named-b input");
    assert.deepEqual(await values(page), ["两个表单共享的历史"]);
    await page.locator("#dynamic > input").first().fill("无名输入框的历史");
    await page.locator("#outside").click();
    await waitCount("无名输入框的历史", 1);
    await page.locator("#dynamic > input").last().click();
    await poll(() => values(page), items => items.length === 0, "anonymous fields isolated");
  });

  await check("相同 URL 的两个跨域 iframe 独立，刷新后身份仍稳定", async () => {
    await page.goto(`${base}/frames.html`);
    const left = page.frameLocator("#left");
    const right = page.frameLocator("#right");
    await focus(left, "#first");
    await left.locator("#first").fill("左侧跨域框");
    await left.locator("#outside").click();
    await waitCount("左侧跨域框", 1);
    await focus(right, "#first");
    assert.deepEqual(await values(right), []);
    await page.reload();
    await focus(page.frameLocator("#left"), "#first");
    assert.deepEqual(await values(page.frameLocator("#left")), ["左侧跨域框"]);
  });

  await check("两个标签页同时写入同一个字段不会少计", async () => {
    await page.goto(`${base}/fixture.html`);
    const secondPage = await context.newPage();
    await secondPage.goto(`${base}/fixture.html`);
    await Promise.all([save(page, "#first", "来自两个标签页"), save(secondPage, "#first", "来自两个标签页")]);
    await waitCount("来自两个标签页", 2);
    await secondPage.close();
    await page.bringToFront();
  });

  await check("中文输入法组合期间 Enter 不会误选历史或提前计数", async () => {
    await focus(page, "#first");
    await page.locator("#first").press("ArrowDown");
    assert.equal(await host(page).locator(".selected").count(), 1);
    await page.locator("#first").dispatchEvent("compositionstart", { data: "中文" });
    assert.equal(await host(page).isVisible(), false);
    await page.locator("#first").fill("组合输入的中文");
    await page.locator("#first").press("Enter");
    assert.equal(await page.locator("#first").inputValue(), "组合输入的中文");
    assert.equal(await record("组合输入的中文"), null);
    await page.locator("#first").dispatchEvent("compositionend", { data: "中文" });
    await page.locator("#outside").click();
    await waitCount("组合输入的中文", 1);
  });

  await check("真实输入法组词后点击其他输入框、按 Tab 或点击外部都只保存一次", async () => {
    const session = await context.newCDPSession(page);
    try {
      for (const action of ["点击另一输入框", "Tab 切换", "点击外部"]) {
        const text = `输入法${action}`;
        await focus(page, "#first");
        await session.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
        assert.equal(await record(text), null);
        if (action === "点击另一输入框") await page.locator('#second').click();
        else if (action === "Tab 切换") await page.locator('#first').press("Tab");
        else await page.locator('#outside').click();
        await waitCount(text, 1);
        await focus(page, "#first");
        assert.ok((await values(page)).includes(text));
        await page.locator('#outside').click();
        assert.equal((await record(text)).events.length, 1);
      }
    } finally {
      await session.detach();
    }
  });

  await check("网页阻止鼠标切换焦点时，不提前结束输入或重复计次", async () => {
    await page.locator('#first').fill("焦点保留时的草稿");
    await page.locator('#second').evaluate(element => {
      element.addEventListener("mousedown", event => event.preventDefault(), { once: true });
    });
    await page.locator('#second').click();
    assert.equal(await page.locator('#first').evaluate(element => element === document.activeElement), true);
    await page.waitForTimeout(100);
    assert.equal(await record("焦点保留时的草稿"), null);
    await page.locator('#first').press("Enter");
    await waitCount("焦点保留时的草稿", 1);
    await page.locator('#outside').click();
    assert.equal((await record("焦点保留时的草稿")).events.length, 1);
  });

  let popup;
  await check("真实插件弹窗：网站暂停、恢复、清空且不复活草稿", async () => {
    const popupEvent = context.waitForEvent("page");
    await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `chrome-extension://${extensionId}/popup.html`);
    popup = await popupEvent;
    popup.setDefaultTimeout(8000);
    await popup.waitForLoadState();
    await poll(() => popup.locator("#site-name").textContent(), name => name === `127.0.0.1:${port}`, "popup origin");
    await popup.locator("#site-enabled").uncheck();
    await poll(() => allStorage(), all => all.settings?.disabledOrigins.includes(base), "site paused");
    await page.locator("#first").fill("暂停时不记录");
    await page.locator("#outside").click();
    assert.equal(await record("暂停时不记录"), null);
    await popup.locator("#site-enabled").check();
    await poll(() => allStorage(), all => !all.settings?.disabledOrigins.includes(base), "site resumed");
    await focus(page, "#first");
    await page.locator("#first").fill("清空时的草稿");
    await popup.locator("#clear-site").click();
    await popup.locator("#confirm-clear").click();
    await poll(() => record("来自两个标签页"), item => item === null, "site cleared");
    await page.locator("#outside").click();
    assert.equal(await record("清空时的草稿"), null);
    assert.ok(await record("左侧跨域框")); // localhost is a different origin.
    await popup.locator("#enabled").uncheck();
    await poll(() => allStorage(), all => all.settings?.enabled === false, "global paused");
    await popup.locator("#enabled").check();
    await poll(() => allStorage(), all => all.settings?.enabled === true, "global resumed");
  });

  await check("严格 CSP 与 Trusted Types 页面中仍可显示样式和保存", async () => {
    await page.goto(`${base}/csp.html`);
    await focus(page, "#csp");
    assert.equal(await host(page).locator(".panel").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(255, 255, 255)");
    await page.locator("#csp").fill("受限页面的内容");
    await page.locator("#csp").press("Tab");
    await waitCount("受限页面的内容", 1);
    await focus(page, "#csp");
    assert.deepEqual(await values(page), ["受限页面的内容"]);
  });

  await check("同类字典的条目共享，不同弹窗标题隔离，动态 ID 刷新后保持稳定", async () => {
    await page.goto(`${base}/dictionary/A`);
    const oldScope = await page.locator('[data-testid="item-name"]').evaluate(element => JSON.stringify({
      v: 1, path: location.pathname, route: "", frame: [], form: `form#${element.form.id}`,
      field: ["input:text", "id", element.id, ""]
    }));
    const oldKey = await worker.evaluate(async ({ origin, scope }) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${origin}\n${scope}`));
      const key = "history:" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const now = Date.now();
      await chrome.storage.local.set({ [key]: { version: 1, origin, records: [
        { value: "字典原有条目", events: [now - 1, now], lastUsed: now }
      ] } });
      return key;
    }, { origin: base, scope: oldScope });
    await focus(page, '[data-testid="item-name"]');
    assert.deepEqual(await values(page), []);
    assert.equal((await record("字典原有条目")).events.length, 2);
    assert.equal((await allStorage())[oldKey].records[0].value, "字典原有条目");
    await save(page, '[data-testid="item-name"]', "字典共享条目");
    await waitCount("字典共享条目", 1);
    await focus(page, '[data-testid="item-value"]');
    assert.deepEqual(await values(page), []);
    await save(page, '[data-testid="item-value"]', "字典共享取值");
    await waitCount("字典共享取值", 1);
    await page.goto(`${base}/dictionary/B`);
    await focus(page, '[data-testid="item-name"]');
    assert.deepEqual(await values(page), ["字典共享条目"]);
    await host(page).locator('.row').filter({ hasText: "字典共享条目" }).locator('.fill').click();
    await waitCount("字典共享条目", 2);
    assert.equal(await page.locator('[data-testid="item-name"]').inputValue(), "字典共享条目");
    await focus(page, '[data-testid="item-value"]');
    assert.deepEqual(await values(page), ["字典共享取值"]);
    await focus(page, '[data-testid="other-name"]');
    assert.deepEqual(await values(page), []);
    await focus(page, '[data-testid="other-dialog"]');
    assert.deepEqual(await values(page), []);
    await page.reload();
    await focus(page, '[data-testid="item-name"]');
    assert.ok((await values(page)).includes("字典共享条目"));
    await page.goto(`${base.replace("127.0.0.1", "localhost")}/dictionary/B`);
    await focus(page, '[data-testid="item-name"]');
    assert.deepEqual(await values(page), []);
  });

  for (const mode of ["aria", "element", "breadcrumb"]) {
    await check(`${mode} 导航中的同名字段按页签或面包屑隔离，同类实体仍共享`, async () => {
      const modalField = '[data-testid="modal-field"]';
      const openModal = async (kind = "modal") => {
        await page.locator("#outside").click();
        await page.locator(`[data-testid="open-${kind}"]`).click();
      };
      const closeModal = async () => page.locator('[data-testid="close-modal"]').click();
      await page.goto(`${base}/tests/fixtures/page-context.html?mode=${mode}`);
      await save(page, '[data-testid="plain-field"]', `${mode} 普通字段甲`);
      await openModal();
      const firstTitleId = await page.locator('[role="dialog"]').getAttribute("aria-labelledby");
      await save(page, modalField, `${mode} 字典编号甲`);
      await waitCount(`${mode} 字典编号甲`, 1);
      await focus(page, '[data-testid="other-field"]');
      assert.deepEqual(await values(page), []);
      await closeModal();
      await page.locator('[data-testid="tab-1"]').click();
      await focus(page, '[data-testid="plain-field"]');
      assert.deepEqual(await values(page), []);
      await openModal();
      assert.notEqual(await page.locator('[role="dialog"]').getAttribute("aria-labelledby"), firstTitleId);
      await focus(page, modalField);
      assert.deepEqual(await values(page), []);
      await save(page, modalField, `${mode} 字典编号乙`);
      await closeModal();
      await page.locator('[data-testid="tab-0"]').click();
      await openModal();
      await focus(page, modalField);
      assert.deepEqual(await values(page), [`${mode} 字典编号甲`]);
      await host(page).locator(".fill").click();
      await waitCount(`${mode} 字典编号甲`, 2);
      await page.reload();
      await openModal();
      await focus(page, modalField);
      assert.deepEqual(await values(page), [`${mode} 字典编号甲`]);
      assert.equal(await host(page).locator(".count").innerText(), "2");
      await closeModal();

      await openModal("entry");
      await save(page, modalField, `${mode} 共享条目`);
      await closeModal();
      await page.locator('[data-testid="entity"]').click();
      await openModal("entry");
      await focus(page, modalField);
      assert.deepEqual(await values(page), [`${mode} 共享条目`]);
      await closeModal();
      await page.locator('[data-testid="tab-1"]').click();
      await openModal("entry");
      await focus(page, modalField);
      assert.deepEqual(await values(page), []);
    });
  }

  await check("只有动态 ID 的无名输入框按结构识别，重建后延续历史", async () => {
    await page.goto(`${base}/fixture.html`);
    const rebuild = async () => page.evaluate(() => {
      document.querySelector('[data-testid="anonymous-form"]')?.remove();
      const form = document.createElement("form");
      form.dataset.testid = "anonymous-form";
      form.id = "rc-" + crypto.randomUUID();
      const input = document.createElement("input");
      input.dataset.testid = "anonymous-field";
      input.id = "el-id-" + crypto.randomUUID();
      form.append(input);
      form.addEventListener("submit", event => event.preventDefault());
      document.body.append(form);
    });
    await rebuild();
    const selector = '[data-testid="anonymous-field"]';
    const previousId = await page.locator(selector).getAttribute("id");
    await save(page, selector, "无名字段稳定历史");
    await waitCount("无名字段稳定历史", 1);
    await rebuild();
    assert.notEqual(await page.locator(selector).getAttribute("id"), previousId);
    await focus(page, selector);
    assert.deepEqual(await values(page), ["无名字段稳定历史"]);
  });

  await check("连续键入复用本次字段身份，重新聚焦后才识别变化", async () => {
    await page.goto(`${base}/fixture.html`);
    await page.locator("#first").evaluate(element => { element.id = "session-start"; });
    await focus(page, "#session-start");
    await contentScript(page, extensionId, `(() => {
      const original = RetrospectionContext.forField;
      globalThis.contextRecognitionCalls = 0;
      globalThis.RetrospectionContext = { forField(element) {
        contextRecognitionCalls++;
        return original(element);
      } };
    })()`);
    await page.locator("#session-start").pressSequentially("session-");
    await page.locator("#session-start").evaluate(element => { element.id = "session-changed"; });
    await page.locator("#session-changed").pressSequentially("typing");
    assert.equal(await contentScript(page, extensionId, "contextRecognitionCalls"), 0);
    await page.locator("#session-changed").press("Enter");
    await page.locator("#outside").click();
    await waitCount("session-typing", 1);
    await page.locator("#session-changed").evaluate(element => { element.id = "session-start"; });
    await focus(page, "#session-start");
    assert.deepEqual(await values(page), ["session-typing"]);
    await page.locator("#outside").click();
    await page.locator("#session-start").evaluate(element => { element.id = "session-changed"; });
    await focus(page, "#session-changed");
    assert.deepEqual(await values(page), []);
  });

  await check("旧版及已混合的字段分组保留原数据，不导入新的页面分组", async () => {
    await page.goto(`${base}/tests/fixtures/page-context.html?mode=breadcrumb`);
    await page.locator('[data-testid="open-modal"]').click();
    const oldKeys = await worker.evaluate(async origin => {
      const scopes = [
        { v: 4, frame: [], shadow: "", field: ["input:text", "attributes", "dictNo", "", "字典编号", ""], index: 0 },
        { v: 2, dialog: "新增", frame: [], shadow: "", form: "", field: ["input:text", "label", "字典编号"], index: 0 },
        { v: 3, dialog: "新增", frame: [], shadow: "", form: "", field: ["input:text", "label", "字典编号"], index: 0, page: { breadcrumb: "客户资料" } }
      ];
      const keys = [];
      for (const scope of scopes) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${origin}\n${JSON.stringify(scope)}`));
        const key = "history:" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        const now = Date.now();
        await chrome.storage.local.set({ [key]: { version: 1, origin, records: [
          { value: "旧版上下文内容", events: [now], lastUsed: now }
        ] } });
        keys.push(key);
      }
      return keys;
    }, base);
    await focus(page, '[data-testid="modal-field"]');
    assert.deepEqual(await values(page), ["breadcrumb 字典编号甲"]);
    const all = await allStorage();
    for (const key of oldKeys) assert.equal(all[key].records[0].value, "旧版上下文内容");
  });

  await check("读取失败后可重新点击恢复，不残留错误提示", async () => {
    await page.goto(`${base}/fixture.html`);
    await save(page, "#first", "读取恢复内容");
    await waitCount("读取恢复内容", 1);
    await focus(page, "#first");
    await page.locator("#outside").click();
    await contentScript(page, extensionId, `(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.testReadFails = true;
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message.type === "GET_HISTORY" && testReadFails) {
          return Promise.resolve({ ok: false, error: "STORAGE_ERROR" });
        }
        return original(message, ...args);
      };
    })()`);
    await page.locator("#first").click();
    await poll(() => host(page).locator(".notice").textContent(), text => text.includes("暂时无法读取"), "read failure shown");
    await contentScript(page, extensionId, "testReadFails = false");
    await page.locator("#first").click();
    await poll(() => values(page), items => items.includes("读取恢复内容"), "read retry completed");
    assert.equal(await host(page).locator(".notice").textContent(), "");
  });

  await check("删除完成后，较早的读取响应不能让已删除内容重新出现", async () => {
    await page.goto(`${base}/fixture.html`);
    await save(page, "#first", "延迟读取待删除");
    await waitCount("延迟读取待删除", 1);
    await focus(page, "#first");
    await contentScript(page, extensionId, `(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let delay = true;
      chrome.runtime.sendMessage = async (message, ...args) => {
        const result = await original(message, ...args);
        if (message.type === "GET_HISTORY" && delay) {
          delay = false;
          await new Promise(resolve => { globalThis.releaseHistoryRead = resolve; });
        }
        return result;
      };
    })()`);
    await worker.evaluate(async () => {
      for (const tab of await chrome.tabs.query({})) {
        await chrome.tabs.sendMessage(tab.id, { type: "RETROSPECTION_CHANGED" }).catch(() => {});
      }
    });
    await poll(() => contentScript(page, extensionId, 'typeof releaseHistoryRead'), value => value === "function", "old response held");
    const row = host(page).locator(".row").filter({ hasText: "延迟读取待删除" });
    await row.hover();
    await row.locator(".delete").click();
    await poll(() => record("延迟读取待删除"), item => item === null, "delete saved");
    await contentScript(page, extensionId, `(async () => {
      releaseHistoryRead();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    assert.ok(!(await values(page)).includes("延迟读取待删除"));
  });

  await check("下拉只展示频次前 20 条，删除后补位，保留未展示记录并按最近使用淘汰超额内容", async () => {
    await page.goto(`${base}/fixture.html`);
    await save(page, "#first", "条数限制测试");
    const { key } = await waitCount("条数限制测试", 1);
    await worker.evaluate(async key => {
      const history = (await chrome.storage.local.get(key))[key];
      const now = Date.now();
      history.records = Array.from({ length: 100 }, (_, index) => {
        const lastUsed = now - (index + 1) * 60000;
        return { value: `上限记录${index + 1}`, lastUsed,
          events: Array.from({ length: index + 1 }, (_, usage) => lastUsed - usage * 1000) };
      });
      await chrome.storage.local.set({ [key]: history });
    }, key);
    await focus(page, "#first");
    const expected = Array.from({ length: 20 }, (_, index) => `上限记录${100 - index}`);
    assert.deepEqual(await values(page), expected);
    assert.equal((await allStorage())[key].records.length, 100);
    await page.locator("#first").press("ArrowUp");
    assert.equal(await host(page).locator(".selected .value").textContent(), "上限记录81");
    await page.locator("#first").press("ArrowDown");
    assert.equal(await host(page).locator(".selected .value").textContent(), "上限记录100");
    await page.locator("#first").press("Delete");
    await poll(() => values(page), items => items.at(-1) === "上限记录80", "next history fills deleted row");
    assert.deepEqual(await values(page), [...expected.slice(1), "上限记录80"]);
    assert.equal((await allStorage())[key].records.length, 99);

    await save(page, "#first", "上限记录79");
    await save(page, "#first", "上限记录79");
    await waitCount("上限记录79", 81);
    await focus(page, "#first");
    assert.deepEqual(await values(page), [...expected.slice(1, -1), "上限记录79", "上限记录81"]);
    assert.equal((await allStorage())[key].records.length, 99);

    await save(page, "#first", "容量新增甲");
    await save(page, "#first", "容量新增乙");
    await waitCount("容量新增乙", 1);
    const stored = (await allStorage())[key].records;
    assert.equal(stored.length, 100);
    assert.ok(!stored.some(item => item.value === "上限记录99"));
    assert.ok(stored.some(item => item.value === "容量新增甲"));
    assert.ok(stored.some(item => item.value === "容量新增乙"));
    await page.reload();
    await focus(page, "#first");
    assert.equal((await values(page)).length, 20);
    assert.ok((await values(page)).includes("上限记录79"));
  });

  await check("实际插件在体验页中的视觉截图、定位和弹窗展示", async () => {
    await page.goto(`${base}/demo/`);
    await page.locator("#project").fill("十月产品设计复盘");
    await page.locator("#project").press("Enter");
    await page.locator("#owner").click();
    await waitCount("十月产品设计复盘", 1);
    const saved = await record("十月产品设计复盘");
    await worker.evaluate(async key => {
      const now = Date.now();
      const history = (await chrome.storage.local.get(key))[key];
      history.records = [
        { value: "十月产品设计复盘", events: Array.from({ length: 18 }, (_, index) => now - index * 60000), lastUsed: now },
        { value: "用户体验优化计划", events: Array.from({ length: 12 }, (_, index) => now - index * 60000), lastUsed: now - 1 },
        { value: "新版本需求评审", events: Array.from({ length: 7 }, (_, index) => now - index * 60000), lastUsed: now - 2 },
        { value: "团队周会纪要", events: Array.from({ length: 3 }, (_, index) => now - index * 60000), lastUsed: now - 3 }
      ];
      await chrome.storage.local.set({ [key]: history });
    }, saved.key);
    await focus(page, "#project");
    await host(page).locator(".row").first().hover();
    const inputBox = await page.locator("#project").boundingBox();
    const listBox = await host(page).boundingBox();
    assert.ok(Math.abs(listBox.y - inputBox.y - inputBox.height - 8) < 2);
    await page.screenshot({ path: join(output, "extension-demo.png"), fullPage: true });
    await popup.reload();
    await popup.locator("#enabled").waitFor({ state: "visible" });
    await popup.waitForFunction(() => !document.querySelector("#enabled").disabled);
    await popup.locator("body").screenshot({ path: join(output, "popup.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#project").click();
    await poll(() => host(page).boundingBox(), box => box && box.x >= 0 && box.x + box.width <= 391, "narrow viewport dropdown fits");
    await page.screenshot({ path: join(output, "narrow.png"), fullPage: true });
  });

  assert.deepEqual(errors, [], "No uncaught page errors");
  console.log(`\n${passed} browser scenarios passed with the actual unpacked extension.`);
} catch (error) {
  if (context) for (const [index, page] of context.pages().entries()) {
    for (const frame of page.frames()) console.log("Frame state:", frame.url(), await frame.evaluate(() => ({
      active: document.activeElement?.id, focused: document.hasFocus(),
      visible: document.querySelector("[data-retrospection-root]")?.style.display,
      rows: document.querySelector("[data-retrospection-root]")?.shadowRoot?.querySelectorAll(".row").length
    })).catch(() => null));
    await page.screenshot({ path: join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
