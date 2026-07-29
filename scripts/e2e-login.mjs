console.error("已停用 Playwright Chromium 独立登录：OpenAI 真人验证可能循环触发。");
console.error("请改用当前已登录 Chrome：npm run e2e:chrome:prepare");
process.exit(1);
