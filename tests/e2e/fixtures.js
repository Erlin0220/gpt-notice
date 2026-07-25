const fs = require("node:fs");
const path = require("node:path");
const { test: base, chromium, expect } = require("@playwright/test");

const projectRoot = path.resolve(__dirname, "../..");
const extensionPath = projectRoot;

function resolveProfilePath() {
  const configured = process.env.GPT_NOTICE_E2E_PROFILE;
  if (!configured) return path.join(projectRoot, ".test-profile", "automation");
  return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
}

async function getExtensionServiceWorker(context) {
  const existing = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) return existing;

  return context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith("chrome-extension://"),
    timeout: 15_000
  });
}

const test = base.extend({
  persistentContext: async ({}, use, testInfo) => {
    const profilePath = resolveProfilePath();
    fs.mkdirSync(profilePath, { recursive: true });
    fs.mkdirSync(testInfo.outputDir, { recursive: true });

    const logLines = [];
    const appendLog = (scope, type, text) => {
      logLines.push(`${new Date().toISOString()} [${scope}] [${type}] ${text}`);
    };

    const context = await chromium.launchPersistentContext(profilePath, {
      channel: "chromium",
      headless: process.env.PW_HEADLESS !== "0",
      viewport: { width: 1440, height: 1000 },
      recordVideo: {
        dir: path.join(testInfo.outputDir, "video"),
        size: { width: 1280, height: 720 }
      },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check"
      ]
    });

    const attachPageLogging = (page) => {
      page.on("console", (message) => appendLog("page", message.type(), message.text()));
      page.on("pageerror", (error) => appendLog("page", "error", error.stack || error.message));
    };

    context.pages().forEach(attachPageLogging);
    context.on("page", attachPageLogging);
    context.on("serviceworker", (worker) => {
      worker.on("console", (message) => appendLog("service-worker", message.type(), message.text()));
    });

    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    try {
      await use(context);
    } finally {
      try {
        await context.tracing.stop({ path: testInfo.outputPath("playwright-trace.zip") });
      } catch (error) {
        appendLog("trace", "error", error.message);
      }
      fs.writeFileSync(testInfo.outputPath("browser-console.log"), `${logLines.join("\n")}\n`, "utf8");
      await context.close();
    }
  },

  extensionServiceWorker: async ({ persistentContext }, use) => {
    const worker = await getExtensionServiceWorker(persistentContext);
    await use(worker);
  },

  extensionId: async ({ extensionServiceWorker }, use) => {
    const extensionId = new URL(extensionServiceWorker.url()).host;
    await use(extensionId);
  },

  page: async ({ persistentContext }, use) => {
    const existingPage = persistentContext.pages().find((candidate) => candidate.url() === "about:blank");
    const page = existingPage || (await persistentContext.newPage());
    await use(page);
  }
});

module.exports = {
  test,
  expect,
  projectRoot,
  extensionPath,
  getExtensionServiceWorker
};
