#!/usr/bin/env node
// 从 Herdr 自带的 main 版面生成 layouts/specs.json：在最右加一栏 Specs 面板。
//
//   node scripts/layout.mjs           # 生成 / 重新生成
//   node scripts/layout.mjs --check   # 是否和当前 Herdr 版本同步
//
// 为什么生成而不是手改：Herdr 每次启动会把官方版面整份重写，复制出来的副本是
// 「你的文件」，它不会合并、只会原样保留。所以 Herdr 升级后重跑一次这条命令，
// 就能把新 main 里的新节点带进来，而不是永远停在下手那天的结构。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const LAYOUTS = join(HOME, "layouts");
const SOURCE = join(LAYOUTS, "main.json");
const TARGET = join(LAYOUTS, "specs.json");
const STACK = "panel-body";
const PANEL = "panel";
const BLOCK = "specs";
const MOD = "herdr-spec";
const TABS = "tabs-specs"; // scripts/mod-tabs.mjs 生成的那个副本
const WIDTH = 400;
const MIN = 300;
const MAX = 900;

const version = (() => {
  try {
    return execFileSync("herdr-app", ["--version"], { encoding: "utf8" }).trim().replace(/^herdr-app\s+/, "");
  } catch {
    return "unknown";
  }
})();

const check = process.argv.includes("--check");

if (!existsSync(SOURCE)) {
  console.error(`找不到 ${SOURCE}：Herdr 还没在这台机器上运行过？`);
  process.exit(1);
}

if (check) {
  if (!existsSync(TARGET)) {
    console.log(`还没有 specs 版面 —— 跑一次 node ${process.argv[1]}`);
    process.exit(2);
  }
  const stamped = JSON.parse(readFileSync(TARGET, "utf8")).cloned_from?.version ?? "unknown";
  if (stamped === version) {
    console.log(`specs 版面是最新的（herdr ${version}）`);
    process.exit(0);
  }
  console.log(`specs 版面来自 herdr ${stamped}，当前 ${version} —— 需要重新生成`);
  process.exit(2);
}

const main = JSON.parse(readFileSync(SOURCE, "utf8"));

// 保留上一次手调过的栏宽。
let width = WIDTH;
if (existsSync(TARGET)) {
  try {
    const old = find(JSON.parse(readFileSync(TARGET, "utf8")), PANEL);
    if (old?.size?.px) width = Math.min(MAX, Math.max(MIN, old.size.px));
  } catch {
    /* 坏掉的副本直接覆盖 */
  }
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

const tree = structuredClone(main);
const stack = find(tree, STACK);
const panel = find(tree, PANEL);
if (!stack || !panel) {
  console.error("main.json 里没有 panel / panel-body，Herdr 的版面结构变了，这个脚本要跟着改");
  process.exit(1);
}

// 顶栏换成带 Specs 按钮的 tabs 副本。官方 tabs 只画 files / changes 两颗。
const tabsBlock = (function walk(node) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === "tabs") return node;
  for (const child of node.children ?? []) {
    const hit = walk(child);
    if (hit) return hit;
  }
  return null;
})(tree);
if (!tabsBlock) {
  console.error("main.json 里找不到画顶栏的 tabs 区块");
  process.exit(1);
}
tabsBlock.content = { ...tabsBlock.content, mod: TABS };

// Specs 作为面板栈的第三个孩子：和 Files / Changes 平级，共用同一栏和同一组按钮。
stack.children = (stack.children ?? []).filter((child) => child.id !== BLOCK);
stack.children.push({ id: BLOCK, type: "block", content: { mod: MOD } });
stack.active = BLOCK; // 第一次进来就停在 Specs；之后 tabs 会按 space 记住选择
panel.hidden = false;
panel.size = { px: width };
panel.min = MIN;
panel.max = MAX;

const { id: rootId, ...rest } = tree;
writeFileSync(TARGET, `${JSON.stringify({ id: rootId, cloned_from: { name: "main", version }, ...rest }, null, 2)}\n`);
console.log(`已生成 ${TARGET}（来自 main ${version}，栏宽 ${width}px，面板含 Files / Changes / Specs）`);
