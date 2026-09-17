const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_FILES = [
  "manifest.json",
  "background.js",
  "queue-core.js",
  "usage-core.js",
  "projects-core.js",
  "sidebar.js",
  "chatgpt-dom.js",
  "queue-ui.js",
  "content.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons/chatgpt.png",
  "THIRD_PARTY_NOTICES.md"
];

function buildExtension(projectRoot = path.resolve(__dirname, "..")) {
  const outputDir = path.join(projectRoot, "dist");
  const stagingDir = path.join(projectRoot, `.dist-build-${process.pid}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  let bytes = 0;
  for (const relativePath of RUNTIME_FILES) {
    const source = path.join(projectRoot, relativePath);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`缺少扩展运行文件：${relativePath}`);
    const target = path.join(stagingDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    bytes += fs.statSync(source).size;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(stagingDir, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  if (manifest.version !== pkg.version) throw new Error(`manifest/package 版本不一致：${manifest.version} != ${pkg.version}`);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, outputDir);
  return { outputDir, bytes };
}

if (require.main === module) {
  const result = buildExtension();
  console.log(`Built ${result.outputDir} (${(result.bytes / 1024).toFixed(1)} KB)`);
}

module.exports = { RUNTIME_FILES, buildExtension };
