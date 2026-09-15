const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test: base, chromium, expect } = require("@playwright/test");

const projectRoot = path.resolve(__dirname, "../..");
const extensionPath = path.join(projectRoot, "dist");

function resolveProfilePath(testInfo) {
  const configured = process.env.GPT_NOTICE_E2E_PROFILE;
  if (configured && !(testInfo.file.endsWith("real-chatgpt.spec.js") && process.env.GPT_NOTICE_REAL_CHATGPT === "1")) {
    throw new Error("Controlled sending tests must use a fresh temporary profile; configured profiles are only allowed for the explicit read-only live smoke.");
  }
  if (configured) return { path: path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured), cleanup: false };
  const root = path.join(os.tmpdir(), "gpt-notice-e2e");
  fs.mkdirSync(root, { recursive: true });
  return { path: fs.mkdtempSync(path.join(root, `${process.pid}-${testInfo.workerIndex}-`)), cleanup: true };
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
    const profile = resolveProfilePath(testInfo);
    const profilePath = profile.path;
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

    const live = testInfo.file.endsWith("real-chatgpt.spec.js") && process.env.GPT_NOTICE_REAL_CHATGPT === "1";
    // The fallback is a hard outbound deny, not just an assumed model choice.
    // Controlled fixtures registered later must fulfill locally; unknown URLs
    // (including a future generation endpoint) can never reach ChatGPT.
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.protocol === "chrome-extension:") return route.continue();
      const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method());
      return live && !(mutation && ["chatgpt.com", "chat.openai.com"].includes(url.hostname)) ? route.continue() : route.abort("blockedbyclient");
    });
    if (!live) await context.routeWebSocket("**/*", socket => socket.close());

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
      const keepArtifacts = testInfo.status !== testInfo.expectedStatus || process.env.GPT_NOTICE_KEEP_ARTIFACTS === "1";
      try {
        await context.tracing.stop(keepArtifacts ? { path: testInfo.outputPath("playwright-trace.zip") } : {});
      } catch (error) {
        appendLog("trace", "error", error.message);
      }
      fs.writeFileSync(testInfo.outputPath("browser-console.log"), `${logLines.join("\n")}\n`, "utf8");
      await context.close();
      if (!keepArtifacts) fs.rmSync(path.join(testInfo.outputDir, "video"), { recursive: true, force: true });
      if (profile.cleanup) fs.rmSync(profilePath, { recursive: true, force: true });
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
