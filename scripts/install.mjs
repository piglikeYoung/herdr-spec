#!/usr/bin/env node
// 把 mods/herdr-spec 装进 Herdr，并生成一个带 Specs 侧栏的版面。
//
//   node scripts/install.mjs              安装 / 更新（含版面）
//   node scripts/install.mjs --check      只看是否需要更新
//   node scripts/install.mjs --uninstall  删掉 mod、版面和快捷键
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "mods", "herdr-spec");
const APP = join(homedir(), ".config", "herdr-app");
const DEST = join(APP, "mods", "herdr-spec");
const KEYS = join(APP, "keys.json");
const LAYOUT = join(APP, "layouts", "specs.json");
const STATE = join(APP, "layouts", ".state", "specs.json");
const KEY = "cmd-shift-s";
const LAYOUT_NAME = "specs";
const PANEL = "panel";

const args = new Set(process.argv.slice(2));

if (!existsSync(APP)) {
  console.error(`找不到 ${APP}：Herdr 还没在这台机器上运行过？`);
  process.exit(1);
}

// herdr-app check 会在 mod 目录里生成 gpui-kit.d.ts / jsconfig.json，不算源码。
const digest = (dir) => {
  const hash = createHash("sha256");
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      if (name === "gpui-kit.d.ts" || name === "jsconfig.json") continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(relative(dir, path)).update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 12);
};

if (args.has("--uninstall")) {
  rmSync(DEST, { recursive: true, force: true });
  rmSync(LAYOUT, { force: true });
  rmSync(STATE, { force: true });
  if (existsSync(KEYS)) {
    const keys = JSON.parse(readFileSync(KEYS, "utf8"));
    writeFileSync(`${KEYS}.bak-${Date.now()}`, readFileSync(KEYS));
    delete keys.global?.[KEY];
    delete keys[`layout:${LAYOUT_NAME}`];
    writeFileSync(KEYS, `${JSON.stringify(keys, null, 2)}\n`);
  }
  console.log("已移除：mod、layouts/specs.json、keys.json 里的两行");
  process.exit(0);
}

const same = existsSync(DEST) && digest(SRC) === digest(DEST);

if (args.has("--check")) {
  console.log(same ? `mod 已是最新：${DEST}` : `需要安装：${SRC} → ${DEST}`);
  let layoutOk = false;
  if (existsSync(LAYOUT)) {
    try {
      execFileSync("node", [join(HERE, "mod-tabs.mjs"), "--check"], { stdio: "inherit" });
      execFileSync("node", [join(HERE, "layout.mjs"), "--check"], { stdio: "inherit" });
      layoutOk = true;
    } catch {
      layoutOk = false;
    }
  } else {
    console.log("还没有 specs 版面");
  }
  process.exit(same && layoutOk ? 0 : 1);
}

if (!same) {
  rmSync(DEST, { recursive: true, force: true });
  cpSync(SRC, DEST, { recursive: true });
  console.log(`已复制 mod：${DEST}`);
} else {
  console.log(`mod 已是最新：${DEST}`);
}

const keys = JSON.parse(readFileSync(KEYS, "utf8"));
keys.global ??= {};
// 之前可能绑成「开 tab」，这里换成「切到带侧栏的版面」。
const want = `layout.switch:${LAYOUT_NAME}`;
const wantToggle = `layout.toggle:${PANEL}`;
let changed = false;
if (keys.global[KEY] !== want) {
  keys.global[KEY] = want;
  changed = true;
}
keys[`layout:${LAYOUT_NAME}`] ??= {};
if (keys[`layout:${LAYOUT_NAME}`][KEY] !== wantToggle) {
  keys[`layout:${LAYOUT_NAME}`][KEY] = wantToggle;
  changed = true;
}
if (changed) {
  writeFileSync(`${KEYS}.bak-${Date.now()}`, readFileSync(KEYS));
  writeFileSync(KEYS, `${JSON.stringify(keys, null, 2)}\n`);
  console.log(`已绑定 ${KEY}：在别的版面切到 specs，在 specs 里收起/展开右侧面板`);
}

if (!args.has("--no-layout")) {
  try {
    // 先造出带 Specs 按钮的顶栏副本，再生成引用它的版面。
    execFileSync("node", [join(HERE, "mod-tabs.mjs")], { stdio: "inherit" });
    execFileSync("node", [join(HERE, "layout.mjs")], { stdio: "inherit" });
  } catch {
    console.error("版面生成失败：mod 已装好，但侧栏还没出现");
  }
}

console.log(`
现在按 ⌘⇧S 切到 specs 版面。右上角 Files / Changes / Specs 三个按钮平级：点 Specs 显示规格，再点一次收起面板。
用 ⌘⇧L 切回原来的 main 版面。
项目跟着「当前 space 的文件夹」，切 space 就换项目。`);
