const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RUNTIME_FILES, buildExtension } = require("../scripts/build-extension");
const Queue = require("../queue-core");
const root = path.resolve(__dirname, "..");
test("production manifest is local and contains one page controller", () => {
  const m = require("../manifest.json");
  assert.equal(m.version, require("../package.json").version);
  assert.deepEqual(m.permissions, ["notifications", "storage", "webRequest", "declarativeNetRequest"]);
  const hosts = values => [...new Set(values.map(value => new URL(value.replace(/\*$/, "")).hostname))].sort();
  assert.deepEqual(hosts(m.host_permissions), [...Queue.HOSTS].sort());
  assert.deepEqual(hosts(m.content_scripts[0].matches), [...Queue.HOSTS].sort());
  const scripts = m.content_scripts.flatMap(group => group.js);
  const files = [m.background.service_worker, ...scripts, "popup.js"];
  let bytes = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    new Function(source);
    bytes += Buffer.byteLength(source);
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|history\.(pushState|replaceState)\s*=/);
  }
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.doesNotMatch(content, /MutationObserver/);
  assert.match(content, /const hidden = document\.hidden;/);
  assert.match(content, /response: hidden \|\| outcome !== "completed" \? "" : D\.readText\(p\.assistant\)/);
  assert.doesNotMatch(content, /transportDone/);
  assert.match(content, /observedOutcome\(p, rt\.turn\)/);
  // Includes durable notification retry and the localized queue/popup surfaces.
  // Keep a readable dependency-free runtime, not whitespace-minified source.
  assert.ok(bytes < 145000, `runtime should remain thin: ${bytes}`);
  assert.equal(scripts.filter(f => f === "content.js").length, 1);
  assert.equal(m.content_scripts[0].run_at, "document_start");
  const sidebar = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  assert.doesNotMatch(sidebar, /MutationObserver|setInterval|setTimeout|fetch\(/);
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(background, /updateDynamicRules\(\{ removeRuleIds:\[HISTORY_GUARD_RULE_ID\] \}\)/);
  assert.doesNotMatch(background, /addRules\s*:/);
  assert.doesNotMatch(content, /location\.reload|historyTimer|allow-once/);
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
  assert.ok(bytes < 180 * 1024, `dist should stay tiny: ${bytes}`);
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
