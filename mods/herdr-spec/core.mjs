// 纯逻辑：把 markdown 文本变成看板需要的事实。这里不碰文件系统，也不碰界面。
//
// 调用方（mod 的 read.mjs）负责读文件，本文件只做解析，
// 这样规则只有一份，测试可以脱离 Herdr 跑。
//
// 名词以 OpenSpec 自己的说法为准：
//   - 状态（`openspec list --json` 的 status）：no-tasks / in-progress / complete
//   - 产物（`openspec status --change X --json` 的 artifacts）：proposal / specs / design / tasks

/**
 * 面板自己的版本，右下角显示。从 0.1.0 开始：
 * 小改动（按钮、文案、修 bug）末位 +1；重构页面或内容结构，中位 +1。
 */
export const VERSION = "0.1.1";

export const STATUSES = ["in-progress", "no-tasks", "complete"];

export const STATUS_LABEL = {
  "in-progress": "进行中",
  "no-tasks": "无任务",
  complete: "已完成",
};

/** 一个变更的四个产物，顺序与 `openspec status` 一致。 */
export const ARTIFACTS = [
  { id: "proposal", label: "Proposal" },
  { id: "specs", label: "Specs" },
  { id: "design", label: "Design" },
  { id: "tasks", label: "Tasks" },
];

/**
 * 状态判定，与 `openspec list --json` 一致：
 * 没有任务 = no-tasks，全部勾完 = complete，其余 = in-progress。
 */
export function statusOf({ done, total }) {
  if (!total) return "no-tasks";
  return done >= total ? "complete" : "in-progress";
}

/** 四个产物里有几个已经存在（0–4）。 */
export function artifactCount(artifacts) {
  if (!artifacts) return 0;
  let n = 0;
  if (artifacts.proposal) n += 1;
  if (artifacts.design) n += 1;
  if (artifacts.tasks) n += 1;
  if (artifacts.specs?.length) n += 1;
  return n;
}

/** `.openspec.yaml` 里我们关心的几个键。只认 `key: value`，够用且不会误判正文。 */
export function parseMeta(text) {
  const meta = {};
  if (!text) return meta;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line || /^\s/.test(line)) continue; // 缩进行属于上一个键
    const m = /^([a-z_][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

/** 任务勾选：`- [x]` 与 `- [ ]`。忽略代码块里的行（提案里常贴示例清单）。 */
export function countTasks(text) {
  let done = 0;
  let total = 0;
  if (!text) return { done, total };
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^[-*]\s*\[([ xX])\]/.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1].toLowerCase() === "x") done += 1;
  }
  return { done, total };
}

/** 摘要：优先取 `## Why` 下的第一段正文；没有就取第一个非标题、非清单的行。 */
export function summaryOf(proposal) {
  if (!proposal) return "";
  const lines = proposal.split("\n");
  let inWhy = false;
  let fallback = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      inWhy = /^why\b/i.test(heading[2].trim());
      continue;
    }
    if (/^```/.test(line)) continue;
    if (/^[-*|>]/.test(line)) {
      if (inWhy && !fallback) fallback = line.replace(/^[-*|>]\s*/, "");
      continue;
    }
    const text = line.replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (!text) continue;
    if (inWhy) return clamp(text, 190);
    if (!fallback) fallback = text;
  }
  return clamp(fallback, 190);
}

function clamp(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 规格正文里的需求与场景数。
 *
 * OpenSpec 的 spec.md 与变更里的 delta 用同一套标记：`### Requirement: 名字` 一条需求，
 * `#### Scenario: 名字` 一个场景（缩进在需求下面）。数字块上放这两个数，一眼看出这份规格
 * 有多重，不用滚到底数标题。
 */
export function countSpec(text) {
  const src = String(text ?? "");
  return {
    requirements: (src.match(/^#{2,4}\s+Requirement:/gm) ?? []).length,
    scenarios: (src.match(/^#{2,5}\s+Scenario:/gm) ?? []).length,
  };
}

// —— 块级切分 ——
//
// 只认块边界，不碰行内语法：块里的原文照样交给 TextView.markdown 去排，粗体、行内代码、
// 表格、任务列表都是它原生的活。我们拿到的只是「这是第几块、是标题/段落/列表/代码/引用/
// 表格/需求/场景/横线」，好给不同的块套不同的外壳。

const RE_HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_FENCE = /^\s{0,3}(```+|~~~+)(.*)$/;
const RE_UL = /^\s{0,3}[-*+]\s+\S/;
const RE_OL = /^\s{0,3}\d{1,9}[.)]\s+\S/;
const RE_QUOTE = /^\s{0,3}>\s?/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 列表的续行：缩进两个空格以上的正文，或者空行之后的下一项。 */
function continuesList(lines, at) {
  const line = lines[at] ?? "";
  if (!line.trim()) {
    const after = lines[at + 1] ?? "";
    return RE_UL.test(after) || RE_OL.test(after) || /^\s{2,}\S/.test(after);
  }
  return RE_UL.test(line) || RE_OL.test(line) || /^\s{2,}\S/.test(line);
}

/**
 * 把一篇 markdown 切成顶层块。返回的每块带 `kind` 与原文 `raw`；
 * 需求/场景块额外有 `name`（冒号后面那截），标题块有 `level` 与 `text`。
 */
export function parseBlocks(text) {
  const lines = String(text ?? "").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body = [line];
      i += 1;
      while (i < lines.length) {
        body.push(lines[i]);
        if (lines[i].trim().startsWith(mark)) {
          i += 1;
          break;
        }
        i += 1;
      }
      blocks.push({ kind: "code", lang: fence[2].trim(), raw: body.join("\n") });
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].replace(/\s*#+\s*$/, "");
      const req = /^requirement:\s*(.+)$/i.exec(title);
      const sce = /^scenario:\s*(.+)$/i.exec(title);
      if (req) blocks.push({ kind: "requirement", level, name: req[1].trim(), raw: line });
      else if (sce) blocks.push({ kind: "scenario", level, name: sce[1].trim(), raw: line });
      else blocks.push({ kind: "heading", level, text: title, raw: line });
      i += 1;
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push({ kind: "hr", raw: line });
      i += 1;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "quote", raw: body.join("\n") });
      continue;
    }

    if (RE_UL.test(line) || RE_OL.test(line)) {
      const body = [line];
      i += 1;
      while (i < lines.length && continuesList(lines, i)) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "list", raw: body.join("\n") });
      continue;
    }

    if (line.includes("|") && RE_TABLE_SEP.test(lines[i + 1] ?? "")) {
      const body = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "table", raw: body.join("\n") });
      continue;
    }

    const body = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) break;
      if (RE_HEADING.test(next) || RE_HR.test(next) || RE_FENCE.test(next) || RE_QUOTE.test(next)) break;
      if (RE_UL.test(next) || RE_OL.test(next)) break;
      body.push(next);
      i += 1;
    }
    blocks.push({ kind: "paragraph", raw: body.join("\n") });
  }
  return blocks;
}

/**
 * 给二级标题数一下它这一节里有几条需求、几个场景，挂在 `counts` 上。
 *
 * 数到下一个二级（或更高级）标题为止。`## ADDED Requirements` 这类小节也算——它下面通常
 * 全是 `### Requirement:`，正好显示 3 这种数。
 */
export function attachCounts(blocks) {
  const out = blocks.map((block) => ({ ...block }));
  let current = null;
  for (const block of out) {
    if (block.kind === "heading" && block.level <= 2) {
      current = { requirements: 0, scenarios: 0 };
      block.counts = current;
      continue;
    }
    if (!current) continue;
    if (block.kind === "requirement") current.requirements += 1;
    if (block.kind === "scenario") current.scenarios += 1;
  }
  return out;
}

/** 归档目录名 `2026-11-10-old-export` → 日期与名称。 */
export function splitDated(name) {
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name);
  return m ? { date: m[1], name: m[2] } : { date: "", name };
}

// ── 交给 agent 去做 ────────────────────────────────────────────────────────────
//
// 这一段只做判断和拼字符串，不碰宿主：能不能跑、tab 叫什么、给 agent 说什么、
// 谁已经在跑。放这里是为了能 node --test 单测，mod 运行时的那点调用都在 main.js。

/**
 * 这条变更还没做完、值得让 agent 上手吗。
 *
 * 只有「有任务且没勾完」才算——`no-tasks` 的变更 tasks.md 还没有，apply 指令没东西可执行；
 * 已完成的再跑一遍只会让 agent 去改已经做完的事。
 */
export function canApply(item) {
  return Boolean(item) && item.kind === "change" && item.total > 0 && item.done < item.total;
}

/**
 * 探索按钮的出现条件：变更没归档就一直能探索——规格会持续完善、任务也可能补充，
 * 跟进行到哪个阶段无关（进行中、全部勾完、还没有任务，都一样）。
 */
export function canExplore(item) {
  return Boolean(item) && item.kind === "change";
}

/**
 * 归档按钮的出现条件：任务全部勾完。`openspec archive` 会把变更挪进 archive/
 * 并把规格并进主 specs，是这条生命周期的终点动作。
 */
export function canArchive(item) {
  return Boolean(item) && item.kind === "change" && item.total > 0 && item.done >= item.total;
}

/**
 * 验证按钮的出现条件：与归档同一条线（任务全部勾完）。
 *
 * 验证是可选动作：不通过它也能归档（用户明确要求可跳过），所以这里只管
 * 「什么时候值得建议验证」，不做归档的门槛。准入用简单口径——不区分手动
 * 任务（tasks.md 里标 [M] 的条目），以后真用到再分。
 */
export function canVerify(item) {
  return Boolean(item) && item.kind === "change" && item.total > 0 && item.done >= item.total;
}

/**
 * 验证结论的存放路径：当前工程里、这份变更自己的目录下。
 *
 * 放在变更目录（`.verify.json`，OpenSpec 不认识它、validate 实测不报错）有三个好处：
 * watchFolder 会为它触发面板自动刷新；远端 space 也能读到（跟着工程走）；
 * 归档时验证记录跟着变更一起进 archive/，历史得以保留。换工程自然各归各的，
 * 删了工程就没了——验证跟着工程才有意义。
 */
export function verdictPathFor(root, change) {
  return `${root}/openspec/changes/${change}/.verify.json`;
}

/**
 * 让 agent 把验证结论写进状态文件的命令。
 *
 * 面板上的一切操作都经过 LLM，验证标记也不例外：由验证 agent 在检查结束后
 * 执行这条命令落盘，面板重扫时读到它才亮「已验证」。用带引号的 heredoc，
 * JSON 原样落盘、不吃 shell 展开；不写的话面板永远不知道验证结果。
 */
export function verdictWriteCmd(root, change) {
  const path = verdictPathFor(root, change);
  return `cat > '${path}' <<'SPEC_VERIFY_EOF'\n{"change":"${change}","verdict":"pass 或 fail","critical":0,"warning":0,"suggestion":0,"at":"$(date +%Y-%m-%dT%H:%M:%S%z)"}\nSPEC_VERIFY_EOF`;
}

/**
 * agent 收到的第一句话。
 *
 * 探索明确「不要改文件」，执行照 OpenSpec 自己的 apply 指令走，
 * 验证是只读的三维度检查（完整性/正确性/一致性），分级出报告。
 * 不在这里复述上下文——instructions 本身就是上下文，重复一遍只会让
 * agent 先读我们猜的东西。
 */
export function promptFor(kind, name) {
  if (kind === "explore") {
    return `运行 openspec instructions apply --change ${name} 读这份变更的上下文，然后给出实现计划、影响面与风险。先不要修改任何文件，也不要勾选任务。`;
  }
  if (kind === "archive") {
    return `运行 openspec instructions archive --change ${name} 并按它执行。`;
  }
  if (kind === "verify") {
    return `运行 openspec instructions apply --change ${name} 读这份变更的完整上下文，然后对照实际实现做三维度只读检查：\n1. 完整性——tasks.md 的每一项是否真的完成（不是只勾了框）；\n2. 正确性——实现是否符合 proposal.md 的承诺与 design.md 的决策；\n3. 一致性——specs delta 的每个 Requirement/Scenario 是否与代码实际行为一致（没有 delta spec 的部分按行为检查替代）。\n输出分级报告：CRITICAL（必须修复才能归档）/ WARNING（建议修复）/ SUGGESTION（可选优化），每个发现给出文件、行号与具体建议；没有阻塞问题就明确说「可以归档」。只读检查，不要修改任何文件，也不要勾选任务。`;
  }
  return `运行 openspec instructions apply --change ${name} 并按它执行，做完的项在 tasks.md 里勾上。`;
}

/**
 * 新 tab 的名字。
 *
 * `hc run --name` 只收 1–32 个 `a-z 0-9 - _`，重名会直接报错，所以先压平再让位：
 * 变更名本来就是 kebab-case，多数情况原样可用；被占了就往后加 `-2`、`-3`。
 */
export function tabNameFor(name, taken = []) {
  const used = new Set(taken.filter(Boolean));
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32) || "openspec";
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const suffix = `-${i}`;
    const next = base.slice(0, 32 - suffix.length).replace(/[-_]+$/, "") + suffix;
    if (!used.has(next)) return next;
  }
  return `${base.slice(0, 29)}-x${Date.now() % 100}`;
}

/**
 * 把 terminal 上的 `openspec.change` 标签贴到 agent 上。
 *
 * 为什么不用 tab 名：`hc run --name` 起的是终端名，tab 名还是 `1`、`2`（实测 `tab_name`
 * 就是这个）。标签是开 tab 时我们自己写进去的，改不了也不会被 agent 改掉，比名字可靠得多。
 * 两个数组按 `address` 对齐——agent 和 terminal 指的是同一个终端。
 */
export function tagAgents(agents = [], terminals = []) {
  const byAddress = new Map();
  for (const term of terminals) {
    const change = term?.labels?.["openspec.change"];
    if (change) byAddress.set(term.address, change);
  }
  return agents.map((agent) => ({ ...agent, change: byAddress.get(agent.address) ?? null }));
}

/**
 * 这条变更自己的 agent。
 *
 * `working`/`blocked` 的排前面：同一条被开过两次时，我们关心的是还在动的那个。
 */
export function agentsOf(name, tagged = []) {
  const mine = tagged.filter((agent) => agent.change === name);
  const live = mine.filter((agent) => agent.status === "working" || agent.status === "blocked");
  return { all: mine, live: live[0] ?? null };
}

/**
 * 同一个仓库里有没有别的变更正在被 agent 做。
 *
 * OpenSpec 的所有变更都在一个 repo 里，两个 agent 并行必然互相踩文件（同一个 tasks.md、
 * 同一片源码）。这条规矩只认一个并发：一次只放一个过去。
 * `idle`/`done` 不算，那是开过但已经停手的 tab；没有标签的（别人的终端）也不算。
 */
export function busyElsewhere(item, tagged = []) {
  return tagged.find((agent) => agent.change && agent.change !== item?.name
    && (agent.status === "working" || agent.status === "blocked")) ?? null;
}
