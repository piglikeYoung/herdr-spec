#!/usr/bin/env node
// 复制内置 tabs 面板，加一个 Specs 按钮。
//
// Herdr 的 tabs 只给 files 和 changes 硬编码了两个按钮（mods/tabs/main.js 末尾），
// 没有扩展点。要让 Specs 和它们平级，只能拿一份副本改两行——代价是这份副本不再
// 跟着 Herdr 更新，所以这个脚本每次都从**当前**官方文件重新生成，补丁打不上就报错
// 停下，而不是悄悄用旧代码。
//
//   node scripts/mod-tabs.mjs          # 生成 / 重新生成 mods/tabs-specs
//   node scripts/mod-tabs.mjs --check  # 检查副本是否与当前官方 tabs 同步
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const SRC = join(HOME, "mods", "tabs");
const DEST = join(HOME, "mods", "tabs-specs");
const NAME = "tabs-specs";

const ENABLED_OLD = `const enabled = shared("workspace.panels") ?? ["files", "changes"];`;
const ENABLED_NEW = `const enabled = [...new Set([...(shared("workspace.panels") ?? ["files", "changes"]), "specs"])];`;

const BUTTON_OLD = `.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))`;
const BUTTON_NEW = `${BUTTON_OLD}
      .when(enabled.includes("specs"), el => el.child(panelButton("specs", "Specs", "mods/herdr-spec/specs.svg")))`;

const args = new Set(process.argv.slice(2));

if (!existsSync(join(SRC, "main.js"))) {
  console.error(`找不到 ${SRC}/main.js：Herdr 还没在这台机器上运行过？`);
  process.exit(1);
}

const source = readFileSync(join(SRC, "main.js"), "utf8");

if (!source.includes(ENABLED_OLD) || !source.includes(BUTTON_OLD)) {
  console.error(
    [
      "官方 tabs 的代码变了，这个补丁对不上：",
      `  找不到：${!source.includes(ENABLED_OLD) ? ENABLED_OLD : BUTTON_OLD}`,
      "Herdr 升级后按钮的写法可能改了，需要先看一眼 mods/tabs/main.js 末尾再改本脚本。",
    ].join("\n"),
  );
  process.exit(3);
}

const patched = source.replace(ENABLED_OLD, ENABLED_NEW).replace(BUTTON_OLD, BUTTON_NEW);
const stamp = createHash("sha256").update(source).digest("hex").slice(0, 12);

if (args.has("--check")) {
  const target = join(DEST, "main.js");
  if (!existsSync(target)) {
    console.log(`还没有 ${DEST} —— 跑一次 node ${process.argv[1]}`);
    process.exit(2);
  }
  const current = readFileSync(target, "utf8");
  const built = current.includes(`// tabs-source ${stamp}`);
  console.log(built ? `tabs-specs 与当前 tabs 同步（${stamp}）` : "tabs-specs 是旧版 tabs 生成的 —— 重新生成");
  process.exit(built ? 0 : 2);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
for (const name of readdirSync(SRC)) {
  // 类型文件由 herdr-app check 生成，不需要带过去。
  if (name === "gpui-kit.d.ts" || name === "jsconfig.json") continue;
  const from = join(SRC, name);
  if (!statSync(from).isFile()) continue;
  if (name === "main.js") continue;
  copyFileSync(from, join(DEST, name));
}

const modJson = JSON.parse(readFileSync(join(SRC, "mod.json"), "utf8"));
modJson.title = "Tabs (Specs)";
writeFileSync(join(DEST, "mod.json"), `${JSON.stringify(modJson, null, 2)}\n`);
writeFileSync(join(DEST, "main.js"), `// tabs-source ${stamp}\n${patched}`);

console.log(`已生成 ${DEST}（基于 tabs ${stamp}，多加一个 Specs 按钮）`);
