import { spawn } from "node:child_process";

if (process.platform !== "win32") {
  console.error("此脚本仅用于 Windows Chrome Profile 2。");
  process.exit(1);
}

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const child = spawn(
  chromePath,
  ["--profile-directory=Profile 2", "chrome://inspect/#remote-debugging"],
  {
    detached: true,
    stdio: "ignore"
  }
);
child.unref();

console.log("已在 Chrome Profile 2 打开远程调试设置页。");
console.log("请启用“允许对此浏览器实例进行远程调试”。");
console.log("随后运行：npm run e2e:profile2:attach");
console.log("Chrome 弹出连接授权时，请点击“允许”。");
