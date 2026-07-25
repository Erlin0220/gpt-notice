console.error("已停用 Playwright Chromium 独立登录：OpenAI 真人验证可能循环触发。");
console.error("请改用已登录的 Chrome Profile 2：npm run e2e:profile2:prepare");
process.exit(1);
