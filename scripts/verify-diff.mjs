import { spawnSync } from "node:child_process";

for (const staged of [false, true]) {
  const args = [
    "diff",
    ...(staged ? ["--cached"] : []),
    "--check",
    "--",
    ".",
    ":(exclude)vendor/chatgpt-web-accelerator/**"
  ];
  const result = spawnSync("git", args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
