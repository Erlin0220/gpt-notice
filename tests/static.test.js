const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RUNTIME_FILES, buildExtension } = require("../scripts/build-extension");
const root = path.resolve(__dirname, "..");
test("production manifest is local and contains one page controller", () => {
  const m = require("../manifest.json");
  assert.equal(m.version, require("../package.json").version);
  assert.deepEqual(m.permissions, ["notifications", "storage", "tabs", "webRequest"]);
  const files = [m.background.service_worker, ...m.content_scripts[0].js, "popup.js"];
  let bytes = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    new Function(source);
    bytes += Buffer.byteLength(source);
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|history\.(pushState|replaceState)\s*=/);
  }
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.match(content, /new MutationObserver/);
  assert.doesNotMatch(content, /observer\.observe\((?:document|document\.body)/);
  assert.doesNotMatch(content, /characterData\s*:\s*true/);
  assert.doesNotMatch(content, /observer\.observe\([^;]*subtree\s*:\s*true/);
  assert.ok(bytes < 100000, `runtime should remain thin: ${bytes}`);
  assert.equal(m.content_scripts[0].js.filter(f => f === "content.js").length, 1);
  for (const obsolete of ["queue-v060.js", "queue-lease-guard.js", "diagnostics.js"]) assert.equal(fs.existsSync(path.join(root, obsolete)), false);
});
test("dist contains only the thin extension runtime", () => {
  const { outputDir, bytes } = buildExtension(root);
  const actual = [];
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else actual.push(relative);
    }
  };
  walk(outputDir);
  assert.deepEqual(actual.sort(), [...RUNTIME_FILES].sort());
  assert.ok(bytes < 150 * 1024, `dist should stay tiny: ${bytes}`);
  for (const forbidden of ["node_modules", ".test-profile", "test-results", ".git", ".codegraph", ".scratch"]) {
    assert.equal(fs.existsSync(path.join(outputDir, forbidden)), false, `${forbidden} must not be packaged`);
  }
});
test("CI and releases share the allowlist and include the required upstream license", () => {
  assert.ok(RUNTIME_FILES.includes("THIRD_PARTY_NOTICES.md"));
  for (const workflow of ["ci.yml", "auto-release.yml"]) {
    const source = fs.readFileSync(path.join(root,".github/workflows",workflow),"utf8");
    assert.match(source,/npm run build/);
    assert.match(source,/cp -a dist\/\./);
    assert.doesNotMatch(source,/rsync -a \.\//);
  }
  const release = fs.readFileSync(path.join(root,".github/workflows/auto-release.yml"),"utf8");
  assert.match(release,/paths:\s+- manifest\.json/);
  assert.ok(release.indexOf("refusing a mismatched release") < release.indexOf('if gh release view "$TAG"'));
});
