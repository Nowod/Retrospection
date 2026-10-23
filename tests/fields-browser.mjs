import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { output, launchExtension, startFixtureServer, contentScript } from "./helpers/browser.mjs";

const { server, base } = await startFixtureServer();
const profile = await mkdtemp(join(tmpdir(), "retrospection-fields-"));
const failures = [];
let context;
let passed = 0;

try {
  context = await launchExtension(profile);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = context.pages()[0];
  const evaluate = (fn, argument) => contentScript(page, extensionId, `(${fn})(${JSON.stringify(argument) ?? "undefined"})`);
  const markup = html => page.evaluate(html => { document.body.innerHTML = html; }, html);
  const check = async (name, run) => {
    await page.goto(`${base}/fixture.html`);
    try {
      await run();
      console.log(`PASS ${++passed}: ${name}`);
    } catch (error) {
      failures.push({ name, message: error.message });
      console.error(`FAIL: ${name}\n${error.stack}`);
    }
  };

  await check("现有稳定字段键和旧版迁移键保持兼容", async () => {
    const identity = await evaluate(() => RetrospectionFields.identityFor(document.querySelector("#first")));
    assert.equal(identity.scope, JSON.stringify({ v: 4, frame: [], shadow: "",
      field: ["input:text", "attributes", "first", "query", "", ""], index: 0 }));
    assert.equal(identity.legacyScope, JSON.stringify({ v: 1, path: "/fixture.html", route: "", frame: [],
      form: "form#first-form", field: ["input:text", "id", "first", ""] }));
  });

  await check("显式字段键在属性变化后保持共享，不同键或输入类型保持独立", async () => {
    const scopes = await evaluate(() => {
      const input = document.querySelector("#first");
      input.dataset.retrospectionKey = "dictionary-code";
      const read = () => RetrospectionFields.identityFor(input).scope;
      const before = read();
      input.id = "another-id";
      input.name = "another-name";
      input.placeholder = "编号";
      const changed = read();
      input.dataset.retrospectionKey = "dictionary-name";
      const anotherKey = read();
      input.dataset.retrospectionKey = "dictionary-code";
      input.type = "number";
      return [before, changed, anotherKey, read()];
    });
    assert.equal(scopes[0], scopes[1]);
    assert.notEqual(scopes[0], scopes[2]);
    assert.notEqual(scopes[0], scopes[3]);
  });

  await check("框架 ID、UUID 和时间戳变化不会拆分同一个有标签的字段", async () => {
    await markup('<form><label><span>* 条目名称：</span><input placeholder="请输入"></label></form>');
    const scopes = await evaluate(() => {
      const input = document.querySelector("input");
      return [":r3:", "_r_7_", "el-id-33-8", "rc-field-3", "radix-8", "headlessui-input-7",
        "react-select-9-input", "field123", "input-57", crypto.randomUUID(), "generated-name-17", "dict-1792700000000"]
        .map(id => {
          input.id = id;
          input.name = id;
          return RetrospectionFields.identityFor(input).scope;
        });
    });
    assert.equal(new Set(scopes).size, 1);
  });

  await check("标签的必填星号、冒号和空白变化不影响共享", async () => {
    await markup('<label for="dictNo">* 字典编号：</label><input id="dictNo" placeholder="请输入内容">');
    const scopes = await evaluate(() => ["* 字典编号：", "＊ 字典编号 :", "  字典编号  "].map(text => {
      document.querySelector("label").textContent = text;
      return RetrospectionFields.identityFor(document.querySelector("input")).scope;
    }));
    assert.equal(new Set(scopes).size, 1);
  });

  await check("可访问标签与组件标签等价，具体占位文本仍可区分字段", async () => {
    await markup('<div class="ant-form-item"><label>编号：</label><input id="code"></div>');
    const scopes = await evaluate(() => {
      const input = document.querySelector("input");
      const read = () => RetrospectionFields.identityFor(input).scope;
      const component = read();
      document.querySelector("label").remove();
      input.setAttribute("aria-label", "编号");
      const ariaLabel = read();
      input.removeAttribute("aria-label");
      const label = document.createElement("span");
      label.id = "label-reference";
      label.textContent = "编号";
      document.body.append(label);
      input.setAttribute("aria-labelledby", label.id);
      const labelledBy = read();
      input.placeholder = "请输入业务编号";
      return [component, ariaLabel, labelledBy, read()];
    });
    assert.equal(scopes[0], scopes[1]);
    assert.equal(scopes[1], scopes[2]);
    assert.notEqual(scopes[2], scopes[3]);
  });

  await check("同一表单的重复字段保持独立，外置 form 关联字段也按顺序区分", async () => {
    await markup('<form id="owner"><input name="elements"><input name="code"></form><input name="code" form="owner">');
    const scopes = await evaluate(() => [...document.querySelectorAll('input[name="code"]')].map(input => RetrospectionFields.identityFor(input).scope));
    assert.notEqual(scopes[0], scopes[1]);
  });

  await check("弹窗内 Shadow DOM 的重复字段不会错误共享", async () => {
    await markup('<div role="dialog"><div id="shadow-form"></div></div>');
    const scopes = await evaluate(() => {
      const root = document.querySelector("#shadow-form").attachShadow({ mode: "open" });
      root.innerHTML = '<input name="code"><input name="code">';
      return [...root.querySelectorAll("input")].map(input => RetrospectionFields.identityFor(input).scope);
    });
    assert.notEqual(scopes[0], scopes[1]);
  });

  await check("排除区域覆盖 Shadow DOM 后代，移除排除后恢复可用", async () => {
    await markup('<section data-retrospection="off"><div id="shadow"></div></section>');
    const results = await evaluate(() => {
      const root = document.querySelector("#shadow").attachShadow({ mode: "open" });
      root.innerHTML = '<input name="ordinary">';
      const input = root.querySelector("input");
      const excluded = RetrospectionFields.isEligible(input);
      document.querySelector("section").removeAttribute("data-retrospection");
      return [excluded, RetrospectionFields.isEligible(input)];
    });
    assert.deepEqual(results, [false, true]);
  });

  await check("禁用 fieldset 中的字段排除，首个 legend 中可输入字段正常识别", async () => {
    await markup('<fieldset disabled><legend><input name="allowed"></legend><input name="blocked"></fieldset>');
    const results = await evaluate(() => [...document.querySelectorAll("input")].map(input => RetrospectionFields.isEligible(input)));
    assert.deepEqual(results, [true, false]);
  });

  await check("敏感字段、只读字段和不支持的类型排除，普通字段可用", async () => {
    const results = await evaluate(() => {
      const cases = [
        { type: "password" }, { type: "checkbox" }, { type: "file" }, { type: "hidden" },
        { autocomplete: "one-time-code" }, { autocomplete: "cc-number" }, { name: "api_key" },
        { placeholder: "请输入验证码" }, { "aria-label": "银行卡" }, { readonly: "" }, { disabled: "" },
        { type: "text", name: "project" }, { type: "search" }, { type: "email" }, { type: "number" }
      ];
      return cases.map(attributes => {
        const input = document.createElement("input");
        for (const [name, value] of Object.entries(attributes)) input.setAttribute(name, value);
        document.body.append(input);
        return RetrospectionFields.isEligible(input);
      });
    });
    assert.deepEqual(results, [...Array(11).fill(false), ...Array(4).fill(true)]);
  });

  await check("无属性字段的路径兜底区分相邻输入框，重建动态 ID 后保持原身份", async () => {
    await markup('<form><input><input></form>');
    const scopes = await evaluate(() => {
      const inputs = [...document.querySelectorAll("input")];
      const before = inputs.map(input => RetrospectionFields.identityFor(input).scope);
      document.querySelector("form").id = "rc-" + crypto.randomUUID();
      inputs.forEach(input => { input.id = "el-id-" + crypto.randomUUID(); });
      return [before, inputs.map(input => RetrospectionFields.identityFor(input).scope)];
    });
    assert.notEqual(scopes[0][0], scopes[0][1]);
    assert.deepEqual(scopes[0], scopes[1]);
  });

  await check("Ant Design 和 Bootstrap 页签即使没有 ARIA 关联也可识别", async () => {
    for (const framework of ["ant", "bootstrap"]) {
      await markup(framework === "ant"
        ? '<div class="ant-tabs"><div class="ant-tabs-tab ant-tabs-tab-active"><span class="ant-tabs-tab-btn">数据字典<span class="ant-badge-count">8</span></span></div><div class="ant-tabs-tabpane"><input id="dictNo"></div></div>'
        : '<ul class="nav-tabs"><li><a class="nav-link active" href="#pane">数据字典</a></li></ul><div class="tab-pane" id="pane"><input id="dictNo"></div>');
      const first = await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")));
      assert.deepEqual(JSON.parse(first.scope).context.tabs, ["数据字典"]);
      assert.equal(first.legacyScope, null);
      await page.locator(framework === "ant" ? '.ant-tabs-tab-btn' : '.nav-link').evaluate(element => { element.textContent = "默认值字典"; });
      const second = await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")).scope);
      assert.notEqual(first.scope, second);
    }
  });

  await check("嵌套页签保留所属层级，旁边的独立页签组不会影响字段", async () => {
    await markup(`<nav aria-label="Breadcrumb"><ol><li>项目 A</li><li aria-current="page">字典管理</li></ol></nav>
      <button role="tab" aria-selected="true" id="outer">业务管理</button>
      <section role="tabpanel" aria-labelledby="outer">
        <button role="tab" aria-selected="true" id="inner">基础字典</button>
        <section role="tabpanel" aria-labelledby="inner"><input id="dictNo"></section>
      </section><button role="tab" aria-selected="true" id="unrelated">侧边工具</button>`);
    const before = await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")).scope);
    assert.deepEqual(JSON.parse(before).context, { tabs: ["业务管理", "基础字典"], breadcrumb: "字典管理" });
    await page.locator('#unrelated').evaluate(element => { element.textContent = "另一个工具"; });
    assert.equal(await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")).scope), before);
    await page.locator('#inner').evaluate(element => { element.textContent = "默认值字典"; });
    assert.notEqual(await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")).scope), before);
  });

  await check("面包屑使用当前末级名称，实体路径和徽标数字变化不拆分字段", async () => {
    for (const html of [
      '<nav aria-label="Breadcrumb"><ol><li id="entity">项目 A</li><li aria-current="page">字典管理<span class="badge">5</span></li></ol></nav>',
      '<div class="el-breadcrumb"><span class="el-breadcrumb__inner" id="entity">项目 A</span><span class="el-breadcrumb__separator">/</span><span class="el-breadcrumb__inner">字典管理<span class="el-badge__content">5</span></span></div>',
      '<div class="breadcrumb"><span id="entity">项目 A</span><span>字典管理</span></div>'
    ]) {
      await markup(html + '<input id="dictNo">');
      const before = await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")).scope);
      assert.equal(JSON.parse(before).context.breadcrumb, "字典管理");
      await page.locator('#entity').evaluate(element => { element.textContent = "项目 B"; });
      await page.locator('.badge, .el-badge__content').evaluateAll(elements => elements.forEach(element => { element.textContent = "99"; }));
      assert.equal(await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")).scope), before);
    }
  });

  await check("弹窗标题兼容 ARIA 与常见组件，动态引用 ID 不写入分组", async () => {
    for (const html of [
      '<section role="dialog" aria-labelledby="rc-title-1"><h2 id="rc-title-1">新增字典</h2><input id="dictNo"></section>',
      '<section role="dialog" aria-label="新增字典"><input id="dictNo"></section>',
      '<section class="ant-modal"><div class="ant-modal-title">新增字典</div><input id="dictNo"></section>',
      '<section class="el-dialog"><span class="el-dialog__title">新增字典</span><input id="dictNo"></section>',
      '<section class="modal-content"><h5 class="modal-title">新增字典</h5><input id="dictNo"></section>'
    ]) {
      await markup(html);
      const before = await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")).scope);
      assert.deepEqual(JSON.parse(before).context, { dialog: "新增字典" });
      assert.ok(!before.includes("rc-title-1"));
    }
  });

  await check("挂在 body 的复用弹窗保留打开来源，鼠标与键盘打开都可区分并列页签", async () => {
    await markup(`<button role="tab" id="left-tab" aria-selected="true">数据字典</button>
      <section role="tabpanel" aria-labelledby="left-tab"><button id="open-left">打开左侧</button></section>
      <button role="tab" id="right-tab" aria-selected="true">默认值字典</button>
      <section role="tabpanel" aria-labelledby="right-tab"><button id="open-right">打开右侧</button></section>
      <button id="outside">外部按钮</button>
      <section role="dialog" hidden><h2>新增</h2><input id="dictNo"><button id="close">关闭</button><button id="child">打开子弹窗</button></section>`);
    await page.evaluate(() => {
      for (const id of ["open-left", "open-right"]) document.getElementById(id).onclick = () => {
        document.querySelector('[role="dialog"]').hidden = false;
        document.querySelector('#dictNo').focus();
      };
      document.querySelector('#close').onclick = () => { document.querySelector('[role="dialog"]').hidden = true; };
      document.querySelector('#child').onclick = () => {
        const child = document.createElement("section");
        child.setAttribute("role", "dialog");
        child.setAttribute("aria-label", "选择条目");
        child.innerHTML = '<input id="childNo">';
        document.body.append(child);
        child.querySelector("input").focus();
      };
    });
    await page.locator('#open-left').click();
    const left = await evaluate(() => RetrospectionFields.identityFor(document.querySelector('#dictNo')).scope);
    assert.deepEqual(JSON.parse(left).context, { tabs: ["数据字典"], dialog: "新增" });
    await page.locator('#outside').click();
    await page.locator('#right-tab').evaluate(element => { element.textContent = "改变无关页签"; });
    await page.locator('#dictNo').click();
    assert.equal(await evaluate(() => RetrospectionFields.identityFor(document.querySelector('#dictNo')).scope), left);
    await page.locator('#child').click();
    const child = await evaluate(() => RetrospectionFields.identityFor(document.querySelector('#childNo')).scope);
    assert.deepEqual(JSON.parse(child).context, { tabs: ["数据字典"], dialog: "选择条目" });
    await page.locator('#childNo').evaluate(element => element.parentElement.remove());
    await page.locator('#close').click();
    await page.locator('#right-tab').evaluate(element => { element.textContent = "默认值字典"; });
    await page.locator('#open-right').focus();
    await page.locator('#open-right').press("Enter");
    const right = await evaluate(() => RetrospectionFields.identityFor(document.querySelector('#dictNo')).scope);
    assert.deepEqual(JSON.parse(right).context, { tabs: ["默认值字典"], dialog: "新增" });
    assert.notEqual(right, left);
  });

  await check("无所属关系且多个页签同时激活时不猜测；隐藏导航不参与识别", async () => {
    await markup('<button role="tab" aria-selected="true">左侧</button><button role="tab" aria-selected="true">右侧</button><div hidden><nav aria-label="Breadcrumb"><span aria-current="page">隐藏导航</span></nav></div><input id="dictNo">');
    const result = await evaluate(() => RetrospectionFields.identityFor(document.querySelector("input")));
    assert.equal(JSON.parse(result.scope).v, 4);
    assert.ok(result.legacyScope);
  });

  await check("异步复用弹窗未自动聚焦时，稍后首次输入仍保留各自打开页签", async () => {
    await markup(`<button role="tab" id="left-tab" aria-selected="true">数据字典</button>
      <section role="tabpanel" aria-labelledby="left-tab"><button id="open-left">打开</button></section>
      <button role="tab" id="right-tab" aria-selected="true">默认值字典</button>
      <section role="tabpanel" aria-labelledby="right-tab"><button id="open-right">打开</button></section>
      <div id="modal-shell" hidden><section role="dialog"><h2>新增</h2><input id="dictNo"></section></div>`);
    await page.evaluate(() => {
      for (const side of ["left", "right"]) document.querySelector(`#open-${side}`).onclick = () => {
        setTimeout(() => { document.querySelector('#modal-shell').hidden = false; }, 40);
      };
    });
    for (const [side, name] of [["left", "数据字典"], ["right", "默认值字典"]]) {
      await page.locator(`#open-${side}`).click();
      await page.locator('#dictNo').waitFor({ state: "visible" });
      // No field is touched until the opening-capture window has ended.
      await page.waitForTimeout(5200);
      const before = await evaluate(() => RetrospectionFields.identityFor(document.querySelector('#dictNo')).scope);
      assert.deepEqual(JSON.parse(before).context, { tabs: [name], dialog: "新增" });
      await page.locator('#dictNo').click();
      assert.equal(await evaluate(() => RetrospectionFields.identityFor(document.querySelector('#dictNo')).scope), before);
      await page.locator('#modal-shell').evaluate(element => { element.hidden = true; });
    }
  });

  await check("从弹窗内页签打开子弹窗时保留局部页签层级", async () => {
    await markup(`<button role="tab" aria-selected="true">业务管理</button>
      <section role="dialog"><h2>管理字典</h2>
        <button role="tab" id="inner-tab" aria-selected="true">基础字典</button>
        <section role="tabpanel" aria-labelledby="inner-tab"><button id="open-child">新增条目</button></section>
      </section>`);
    await page.evaluate(() => {
      document.querySelector('#open-child').onclick = () => {
        const child = document.createElement("section");
        child.setAttribute("role", "dialog");
        child.setAttribute("aria-label", "添加条目");
        child.innerHTML = '<input id="dictNo">';
        document.body.append(child);
        child.querySelector("input").focus();
      };
    });
    await page.locator('#open-child').click();
    const first = await evaluate(() => RetrospectionFields.identityFor(document.querySelector('#dictNo')).scope);
    assert.deepEqual(JSON.parse(first).context, { tabs: ["业务管理", "基础字典"], dialog: "添加条目" });
    await page.locator('#dictNo').evaluate(element => element.parentElement.remove());
    await page.locator('#inner-tab').evaluate(element => { element.textContent = "默认值字典"; });
    await page.locator('#open-child').click();
    const second = await evaluate(() => RetrospectionFields.identityFor(document.querySelector('#dictNo')).scope);
    assert.deepEqual(JSON.parse(second).context, { tabs: ["业务管理", "默认值字典"], dialog: "添加条目" });
    assert.notEqual(first, second);
  });

  await check("含页签和面包屑的 500 字段表单识别耗时采样", async () => {
    const timing = await evaluate(() => {
      const form = document.createElement("form");
      form.id = "large-form";
      form.innerHTML = Array.from({ length: 500 }, (_, i) => `<label for="business-${i}">字段 ${i}</label><input id="business-${i}" name="business-${i}">`).join("");
      const label = document.createElement("button");
      label.id = "performance-tab";
      label.setAttribute("role", "tab");
      label.setAttribute("aria-selected", "true");
      label.textContent = "数据字典";
      const pane = document.createElement("section");
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-labelledby", label.id);
      pane.append(form);
      const breadcrumb = document.createElement("nav");
      breadcrumb.setAttribute("aria-label", "Breadcrumb");
      breadcrumb.innerHTML = '<span aria-current="page">字典管理</span>';
      document.body.replaceChildren(breadcrumb, label, pane);
      const inputs = [...form.querySelectorAll("input")];
      const samples = [];
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        RetrospectionFields.identityFor(inputs[i % 2 ? 499 : 0]);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return { fields: inputs.length, samples: samples.length, medianMs: samples[20], p95Ms: samples[38],
        maxMs: samples.at(-1), userAgent: navigator.userAgent };
    });
    assert.equal(timing.fields, 500);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "field-performance.json"), JSON.stringify(timing, null, 2) + "\n");
    console.log(`TIMING: ${JSON.stringify(timing)}`);
  });

  assert.deepEqual(failures, [], "All field recognition scenarios pass");
  console.log(`\n${passed} field recognition scenarios passed with the actual unpacked extension.`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
