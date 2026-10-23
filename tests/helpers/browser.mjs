import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.RETROSPECTION_PLAYWRIGHT_MODULE || "playwright");
export const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const output = join(root, "test-results");

export async function launchExtension(profile, extension = join(root, "extension"), options = {}) {
  return chromium.launchPersistentContext(profile, {
    headless: true, channel: "chromium",
    executablePath: process.env.RETROSPECTION_CHROMIUM_EXECUTABLE,
    viewport: { width: 1360, height: 1040 }, locale: "zh-CN",
    ...options,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
}

export async function poll(read, predicate, label) {
  const end = Date.now() + 8000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}; last value: ${JSON.stringify(value)}`);
}

// Evaluate in the actual extension's isolated content-script world. Test-only
// fault injection stays in a disposable browser profile and never ships.
export async function contentScript(page, extensionId, expression) {
  const session = await page.context().newCDPSession(page);
  const contexts = [];
  session.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
  try {
    await session.send("Runtime.enable");
    const context = contexts.find(item => item.name.includes(extensionId) || item.origin.includes(extensionId));
    assert.ok(context, "Extension content-script context exists");
    const response = await session.send("Runtime.evaluate", {
      contextId: context.id, expression, awaitPromise: true, returnByValue: true
    });
    assert.equal(response.exceptionDetails, undefined, response.exceptionDetails?.exception?.description);
    return response.result.value;
  } finally {
    await session.detach();
  }
}

export async function startFixtureServer() {
  const fixture = await readFile(join(root, "tests/fixtures/inputs.html"), "utf8");
  let port;
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (/^\/dictionary\/[AB]$/.test(path)) {
      const suffix = `${path.at(-1)}-${Date.now()}`;
      response.setHeader("content-type", mime[".html"]);
      response.end(`<!doctype html><meta charset="UTF-8"><title>字典 ${path.at(-1)}</title>
        <style>input{display:block;margin:12px;padding:10px}#outside{position:fixed;right:20px;top:20px}</style>
        <div role="dialog" aria-labelledby="title-${suffix}"><h2 id="title-${suffix}">添加条目</h2>
        <form id="form-${suffix}"><label for="el-id-name-${suffix}">* 条目名称：</label><input data-testid="item-name" id="el-id-name-${suffix}" name="generated-name-${suffix}">
        <label for="el-id-value-${suffix}">条目值</label><input data-testid="item-value" id="el-id-value-${suffix}">
        <label for="el-id-other-${suffix}">条目名称</label><input data-testid="other-name" id="el-id-other-${suffix}"></form></div>
        <div class="el-dialog"><span class="el-dialog__title">添加字典</span><div class="el-form-item"><label class="el-form-item__label">条目名称</label><input data-testid="other-dialog" id="el-id-unrelated-${suffix}"></div></div>
        <button id="outside">离开</button><script>document.querySelector('form').addEventListener('submit',e=>e.preventDefault())</script>`);
      return;
    }
    if (["/fixture.html", "/other.html", "/frame.html"].includes(path)) {
      response.setHeader("content-type", mime[".html"]);
      response.end(fixture);
      return;
    }
    if (path === "/frames.html") {
      response.setHeader("content-type", mime[".html"]);
      response.end(`<!doctype html><title>Frames</title><iframe id="left" src="http://localhost:${port}/frame.html" width="600" height="600"></iframe><iframe id="right" src="http://localhost:${port}/frame.html" width="600" height="600"></iframe>`);
      return;
    }
    if (path === "/csp.html") {
      response.setHeader("content-type", mime[".html"]);
      response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'none'; script-src 'none'; require-trusted-types-for 'script'");
      response.end('<!doctype html><meta charset="UTF-8"><title>Strict CSP</title><input id="csp"><button id="outside">离开</button>');
      return;
    }
    try {
      const file = resolve(root, `.${path.endsWith("/") ? `${path}index.html` : path}`);
      if (!file.startsWith(`${root}/`)) throw new Error("Invalid path");
      response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
      response.end(await readFile(file));
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}`, port };
}
