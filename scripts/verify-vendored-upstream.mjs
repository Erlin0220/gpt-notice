import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = "tylevnovik/chatgpt-web-accelerator";
const commit = "bbb755160f4eb7c31f9fcb54a8a6776a903cb99d";
const files = new Map([
  ["content.js", "f12488c7fa06592b5c23f365e3e6f5fd56ab7b214f6a5b97b6f1da08b4eea513"],
  ["content.css", "d831c51731e9e68c128cadd2893dfd03aa00e89a7d9ba7947913f68d39ce0abd"],
  ["LICENSE", "a3c34b284e7064373410e6605eb1c68f06ffb3fe4ad6fe1e1d743177c6c0a544"]
]);
const vendorDir = path.join(root, "vendor", "chatgpt-web-accelerator");
const normalize = value => String(value).replace(/\r\n/g, "\n");
const digest = value => crypto.createHash("sha256").update(normalize(value)).digest("hex");

async function sync() {
  fs.mkdirSync(vendorDir, { recursive: true });
  for (const [name, expected] of files) {
    const url = `https://raw.githubusercontent.com/${upstream}/${commit}/${name}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`upstream fetch failed: ${name} (${response.status})`);
    const source = normalize(await response.text());
    const actual = digest(source);
    if (actual !== expected) throw new Error(`upstream hash changed unexpectedly: ${name} ${actual}`);
    fs.writeFileSync(path.join(vendorDir, name), source, "utf8");
  }
}

function check() {
  for (const [name, expected] of files) {
    const file = path.join(vendorDir, name);
    if (!fs.existsSync(file)) throw new Error(`missing vendored upstream file: ${name}`);
    const actual = digest(fs.readFileSync(file, "utf8"));
    if (actual !== expected) throw new Error(`vendored upstream was modified: ${name} ${actual}`);
  }
}

if (process.argv.includes("--sync")) await sync();
check();
console.log(`Verified unchanged upstream ${upstream}@${commit} (${files.size} files)`);
