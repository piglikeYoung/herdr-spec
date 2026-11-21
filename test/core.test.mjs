// core.mjs 的单元测试：不依赖 Herdr，`node --test` 就能跑。
import assert from "node:assert/strict";
import { test } from "node:test";
import { VERSION, agentsOf, artifactCount, attachCounts, busyElsewhere, canApply, canArchive, canExplore, canVerify, countSpec, countTasks, parseBlocks, parseMeta, promptFor, splitDated, statusOf, summaryOf, tabNameFor, tagAgents, verdictPathFor, verdictWriteCmd, ARTIFACTS, STATUSES } from "../mods/herdr-spec/core.mjs";

test("任务勾选只数清单行，且跳过代码块", () => {
  const md = ["## 1. 后端", "", "- [x] 1.1 序列化", "- [X] 1.2 端点", "- [ ] 1.3 测试", "", "```", "- [x] 示例，不算", "```"].join("\n");
  assert.deepEqual(countTasks(md), { done: 2, total: 3 });
});

test("没有任务时是 0/0", () => {
  assert.deepEqual(countTasks(""), { done: 0, total: 0 });
});

test("状态与 openspec list --json 一致", () => {
  assert.equal(statusOf({ done: 0, total: 0 }), "no-tasks");
  assert.equal(statusOf({ done: 1, total: 4 }), "in-progress");
  // openspec 把 0/6 也算 in-progress，不是「提案中」。
  assert.equal(statusOf({ done: 0, total: 6 }), "in-progress");
  assert.equal(statusOf({ done: 4, total: 4 }), "complete");
});

test("状态集合与顺序", () => {
  assert.deepEqual(STATUSES, ["in-progress", "no-tasks", "complete"]);
});

test("产物固定四个，顺序与 openspec status 一致", () => {
  assert.deepEqual(ARTIFACTS.map((a) => a.id), ["proposal", "specs", "design", "tasks"]);
});

test("产物计数按是否存在", () => {
  assert.equal(artifactCount({ proposal: true, design: false, tasks: true, specs: ["specs/auth/spec.md"] }), 3);
  assert.equal(artifactCount({ proposal: true, design: true, tasks: true, specs: [] }), 3);
  assert.equal(artifactCount({ proposal: false, design: false, tasks: false, specs: [] }), 0);
  assert.equal(artifactCount(null), 0);
});

test("meta 只认顶层 key，缩进的列表不误判", () => {
  const yaml = ["schema: spec-driven", "created: 2026-11-21", "context:", "  - 这两行是缩进", "    schema: 假的"].join("\n");
  const meta = parseMeta(yaml);
  assert.equal(meta.schema, "spec-driven");
  assert.equal(meta.created, "2026-11-21");
});

test("摘要取 Why 下的正文，不取标题", () => {
  const proposal = ["# 提案", "", "## Why", "", "目前只能线上读报表，离线分析要手动复制。", "", "## What Changes", "", "- 加导出按钮"].join("\n");
  assert.match(summaryOf(proposal), /^目前只能线上读报表/);
});

test("没有 Why 时退回第一段正文", () => {
  const proposal = ["# 标题", "", "第一段说明。", "", "第二段。"].join("\n");
  assert.equal(summaryOf(proposal), "第一段说明。");
});

test("归档目录名拆成日期与名称", () => {
  assert.deepEqual(splitDated("2026-11-10-old-export"), { date: "2026-11-10", name: "old-export" });
  assert.deepEqual(splitDated("no-date"), { date: "", name: "no-date" });
});

test("规格正文数出需求与场景", () => {
  const spec = [
    "## ADDED Requirements",
    "",
    "### Requirement: 导出 CSV",
    "报表页 SHALL 提供导出。",
    "",
    "#### Scenario: 点按钮导出",
    "- **WHEN** 用户点「导出 CSV」",
    "- **THEN** 下载一份 csv",
    "",
    "### Requirement: 邮件订阅",
    "设置页 SHALL 允许订阅。",
    "",
    "#### Scenario: 打开开关",
    "- **WHEN** 用户打开开关",
    "- **THEN** 保存偏好",
  ].join("\n");
  assert.deepEqual(countSpec(spec), { requirements: 2, scenarios: 2 });
});

test("引用在正文里的 Requirement 字样不算数", () => {
  assert.deepEqual(countSpec("需求写在 ### Requirement: 里，这不是标题。"), { requirements: 0, scenarios: 0 });
  assert.deepEqual(countSpec(""), { requirements: 0, scenarios: 0 });
});

test("切块：标题、段落、列表、表格、引用、代码、横线各成一块", () => {
  const md = [
    "# 标题",
    "",
    "一段正文。",
    "",
    "## 列表",
    "",
    "- 一",
    "- 二",
    "  续行",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "> 引用",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "---",
  ].join("\n");
  assert.deepEqual(parseBlocks(md).map((b) => b.kind), ["heading", "paragraph", "heading", "list", "table", "quote", "code", "hr"]);
});

test("切块：代码块里的 # 不算标题，围栏里的空行不切开", () => {
  const md = ["```md", "# 这是示例", "", "正文", "```", "真正的段落"].join("\n");
  const blocks = parseBlocks(md);
  assert.deepEqual(blocks.map((b) => b.kind), ["code", "paragraph"]);
  assert.equal(blocks[0].raw.split("\n").length, 5);
});

test("切块：需求与场景按名字切出来", () => {
  const md = ["### Requirement: 导出报表", "", "系统 SHALL 导出。", "", "#### Scenario: 有数据", "", "- **WHEN** 点了", "- **THEN** 下载"].join("\n");
  const blocks = parseBlocks(md);
  assert.deepEqual(blocks.map((b) => b.kind), ["requirement", "paragraph", "scenario", "list"]);
  assert.equal(blocks[0].name, "导出报表");
  assert.equal(blocks[2].name, "有数据");
});

test("切块：横线不会被当成列表项", () => {
  assert.deepEqual(parseBlocks("---").map((b) => b.kind), ["hr"]);
});

test("小节计数：数到下一个二级标题为止", () => {
  const md = [
    "## ADDED Requirements",
    "### Requirement: 甲",
    "#### Scenario: 一",
    "#### Scenario: 二",
    "## 别的",
    "### Requirement: 乙",
  ].join("\n");
  const blocks = attachCounts(parseBlocks(md));
  assert.deepEqual(blocks[0].counts, { requirements: 1, scenarios: 2 });
  assert.deepEqual(blocks[4].counts, { requirements: 1, scenarios: 0 });
});

// ── 交给 agent 去做 ──────────────────────────────────────────────────────────

test("只让还有没勾完任务的变更可以被执行", () => {
  assert.equal(canApply({ kind: "change", done: 1, total: 6 }), true);
  assert.equal(canApply({ kind: "change", done: 0, total: 0 }), false, "没有任务，apply 没东西可做");
  assert.equal(canApply({ kind: "change", done: 6, total: 6 }), false, "已经做完，不该再跑一遍");
  assert.equal(canApply({ kind: "archived", done: 1, total: 6 }), false);
  assert.equal(canApply({ kind: "spec", done: 0, total: 0 }), false);
  assert.equal(canApply(null), false);
});

test("tab 名压平到 a-z0-9-_ 且不超过 32 字", () => {
  assert.equal(tabNameFor("add-csv-export"), "add-csv-export");
  assert.equal(tabNameFor("Add CSV Export"), "add-csv-export", "空格与大写不该留在 tab 名里");
  assert.equal(tabNameFor("重构/导表"), "openspec", "全中文压空了要有个兜底名");
  assert.equal(tabNameFor(""), "openspec");
  assert.equal(tabNameFor("a".repeat(50)).length, 32);
});

test("tab 名被占了就往后退，而不是让 hc 报错", () => {
  assert.equal(tabNameFor("add-csv-export", ["add-csv-export"]), "add-csv-export-2");
  assert.equal(tabNameFor("add-csv-export", ["add-csv-export", "add-csv-export-2"]), "add-csv-export-3");
  const long = "b".repeat(32);
  assert.equal(tabNameFor(long, [long]).length <= 32, true);
  assert.equal(tabNameFor(long, [long]).endsWith("-2"), true);
});

test("探索只说不要改文件，执行/归档各自照官方 instructions 走", () => {
  const explore = promptFor("explore", "add-csv-export");
  assert.match(explore, /openspec instructions apply --change add-csv-export/);
  assert.match(explore, /不要修改任何文件/);
  const apply = promptFor("apply", "add-csv-export");
  assert.match(apply, /openspec instructions apply --change add-csv-export/);
  assert.doesNotMatch(apply, /不要修改任何文件/);
  const archive = promptFor("archive", "add-csv-export");
  assert.match(archive, /openspec instructions archive --change add-csv-export/, "归档交给 LLM 收尾");
});

test("标签按 address 贴到 agent 上，没有标签的归 null", () => {
  const agents = [
    { address: "t17", tab_name: "1", status: "working" },
    { address: "t14", tab_name: "1", status: "idle" },
  ];
  const terminals = [
    { address: "t17", labels: { "openspec.change": "add-csv-export" } },
    { address: "t14", labels: { "herdr.space": "s1" } },
  ];
  assert.deepEqual(tagAgents(agents, terminals).map((a) => a.change), ["add-csv-export", null]);
  assert.equal(agents[0].change, undefined, "不该改到传进来的原对象");
  assert.deepEqual(tagAgents(agents, []).map((a) => a.change), [null, null]);
});

test("tab 名还是 1 也能认出是哪条变更", () => {
  const tagged = tagAgents(
    [{ address: "t17", tab_name: "1", status: "idle" }, { address: "t18", tab_name: "2", status: "working" }],
    [{ address: "t17", labels: { "openspec.change": "add-csv-export" } },
     { address: "t18", labels: { "openspec.change": "add-csv-export" } }],
  );
  const { all, live } = agentsOf("add-csv-export", tagged);
  assert.equal(all.length, 2);
  assert.equal(live.status, "working", "同时开着两个时，显示还在动的那个");
  assert.equal(agentsOf("auth-refactor", tagged).live, null);
});

test("同仓库互斥：别的变更在跑就挡住，自己那条不算", () => {
  const tagged = [
    { address: "t17", change: "auth-refactor", status: "working" },
    { address: "t18", change: "add-csv-export", status: "idle" },
    { address: "t19", change: null, status: "working" },
  ];
  assert.equal(busyElsewhere({ name: "add-csv-export" }, tagged).change, "auth-refactor");
  assert.equal(busyElsewhere({ name: "auth-refactor" }, tagged), null, "自己那条不该挡自己");
  assert.equal(busyElsewhere({ name: "add-csv-export" }, [{ address: "t20", change: "auth-refactor", status: "idle" }]), null);
  assert.equal(busyElsewhere({ name: "add-csv-export" }, [{ address: "t21", change: null, status: "working" }]), null, "别人的终端不管");
});

test("版本号从 0.1.0 开始，右下角显示的就是它", () => {
  assert.match(VERSION, /^0\.\d+\.\d+$/, "semver 形状");
  assert.equal(VERSION, "0.1.0");
});

test("探索未归档的变更一直在，归档只在全部勾完后出现", () => {
  assert.equal(canExplore({ kind: "change", done: 1, total: 6 }), true, "进行中能探索");
  assert.equal(canExplore({ kind: "change", done: 6, total: 6 }), true, "全部勾完还能探索——规格会继续完善");
  assert.equal(canExplore({ kind: "change", done: 0, total: 0 }), true, "还没有任务也能探索");
  assert.equal(canExplore({ kind: "archived" }), false, "归档的没有探索");
  assert.equal(canExplore(null), false);
  assert.equal(canArchive({ kind: "change", done: 6, total: 6 }), true);
  assert.equal(canArchive({ kind: "change", done: 5, total: 6 }), false, "还剩任务就轮不到归档");
  assert.equal(canArchive({ kind: "change", done: 0, total: 0 }), false, "没有任务谈不上归档");
  assert.equal(canApply({ kind: "change", done: 6, total: 6 }), false, "执行与归档互斥出现");

  // verify 与归档同一条线：全部勾完才出现；它是可选动作，不是归档的门槛。
  assert.equal(canVerify({ kind: "change", done: 6, total: 6 }), true);
  assert.equal(canVerify({ kind: "change", done: 5, total: 6 }), false, "还剩任务不验证");
  assert.equal(canVerify({ kind: "archived" }), false);
});

test("验证：prompt 是只读三维度检查；结论写在变更目录里，validate 不报错", () => {
  const p = promptFor("verify", "demo-verify-me");
  assert.match(p, /instructions apply --change demo-verify-me/, "上下文仍由 OpenSpec 的 instructions 给");
  assert.match(p, /完整性/);
  assert.match(p, /正确性/);
  assert.match(p, /一致性/);
  assert.match(p, /CRITICAL/);
  assert.match(p, /不要修改任何文件/, "验证只读");
  // 结论跟着变更走：watchFolder 会为它触发刷新，远端也生效，归档时一并进 archive。
  const path = verdictPathFor("/Users/pix/Downloads/herdr-spec-demo", "demo-verify-me");
  assert.equal(path, "/Users/pix/Downloads/herdr-spec-demo/openspec/changes/demo-verify-me/.verify.json");
  // 写入命令：带引号 heredoc 原样落 JSON，agent 执行它才算完成验证闭环。
  const cmd = verdictWriteCmd("/Users/pix/Downloads/herdr-spec-demo", "demo-verify-me");
  assert.match(cmd, /<<'SPEC_VERIFY_EOF'/);
  assert.match(cmd, /"verdict":"pass 或 fail"/);
  assert.match(cmd, /date \+%Y-%m-%dT%H:%M:%S%z/);
});
