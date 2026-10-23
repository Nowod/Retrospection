import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
let checked = 0;

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(file);
    else if (/\.(?:m?js|json|html|css)$/.test(entry.name)) {
      const source = await readFile(file, "utf8");
      assert.ok(!/[\t ]+$/m.test(source), `Trailing whitespace: ${relative(root, file)}`);
      if (/\.m?js$/.test(file)) {
        const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        assert.equal(result.status, 0, result.error?.message || result.stderr);
      } else if (file.endsWith(".json")) JSON.parse(source);
      checked++;
    }
  }
}

for (const directory of ["extension", "tests", "scripts", "demo"]) await checkDirectory(join(root, directory));
const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
const assets = [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(script => [...script.js, ...(script.css || [])])];
for (const asset of new Set(assets)) {
  assert.ok((await stat(join(root, "extension", asset))).isFile(), `Missing manifest asset: ${asset}`);
}
console.log(`PASS: ${checked} source files checked; manifest assets exist.`);
