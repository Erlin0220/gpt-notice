const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
test("production manifest is local and contains one page controller", () => {
  const m = require("../manifest.json");
  assert.equal(m.version, require("../package.json").version);
  assert.deepEqual(m.permissions, ["notifications", "storage", "tabs"]);
  const files = [m.background.service_worker, ...m.content_scripts[0].js, "popup.js"];
  let bytes = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    new Function(source);
    bytes += Buffer.byteLength(source);
    assert.doesNotMatch(source, /new MutationObserver|fetch\(|XMLHttpRequest|history\.(pushState|replaceState)\s*=/);
  }
  assert.ok(bytes < 100000, `runtime should remain thin: ${bytes}`);
  assert.equal(m.content_scripts[0].js.filter(f => f === "content.js").length, 1);
  for (const obsolete of ["queue-v060.js", "queue-lease-guard.js", "diagnostics.js"]) assert.equal(fs.existsSync(path.join(root, obsolete)), false);
});
