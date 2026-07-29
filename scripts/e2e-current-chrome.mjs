import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

if (process.platform !== "win32") {
  console.error("真实 Chrome 附加脚本当前仅支持 Windows。");
  process.exit(1);
}

const mode = process.argv[2] || "prepare";
const userDataDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Google",
  "Chrome",
  "User Data"
);
const activePortPath = path.join(userDataDir, "DevToolsActivePort");

function readEndpoint() {
  if (!fs.existsSync(activePortPath)) {
    throw new Error("未找到 DevToolsActivePort。请先运行 npm run e2e:chrome:prepare，并在 Chrome 中允许远程调试。");
  }
  const [port, browserPath] = fs.readFileSync(activePortPath, "utf8").trim().split(/\r?\n/);
  if (!port || !browserPath) throw new Error("DevToolsActivePort 内容不完整。");
  return `ws://127.0.0.1:${port}${browserPath}`;
}

function openRemoteDebuggingPage() {
  const script = String.raw`
$chrome = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $chrome) { throw '未找到正在运行的 Chrome 窗口' }
Set-Clipboard -Value 'chrome://inspect/#remote-debugging'
$ws = New-Object -ComObject WScript.Shell
if (-not $ws.AppActivate($chrome.Id)) { throw '无法激活 Chrome 窗口' }
Start-Sleep -Milliseconds 350
$ws.SendKeys('^l')
Start-Sleep -Milliseconds 200
$ws.SendKeys('^v')
$ws.SendKeys('{ENTER}')
`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "无法打开 Chrome 远程调试设置页");
  console.log("已在当前 Chrome 打开 Remote debugging 页面。");
  console.log("请启用“允许对此浏览器实例进行远程调试”，连接请求出现时点击“允许”。");
  console.log("随后运行：npm run e2e:chrome:probe");
}

async function probeCurrentChrome() {
  const endpoint = readEndpoint();
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 60_000 });
  try {
    const pages = browser.contexts().flatMap((context) => context.pages()).map((page) => ({ title: "", url: page.url() }));
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      const item = pages.find((candidate) => candidate.url === page.url() && !candidate.title);
      if (item) item.title = await page.title().catch(() => "");
    }
    console.log(JSON.stringify({ endpoint, pages }, null, 2));
  } finally {
    await browser.close();
  }
}

try {
  if (mode === "prepare") openRemoteDebuggingPage();
  else if (mode === "endpoint") console.log(readEndpoint());
  else if (mode === "probe") await probeCurrentChrome();
  else throw new Error(`未知模式：${mode}`);
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
