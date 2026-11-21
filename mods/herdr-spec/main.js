// Specs：常驻在版面右侧一栏的只读看板。
//
// 项目跟着「当前 space 的文件夹」走：从那里向上找 openspec/，
// 所以同一个面板切 space 就换项目，不用手动选目录。
// 一栏只有 400px 左右，所以列表与详情共用同一块区域：点一行进详情，Esc 返回。
// 没有 WebView，全部是 GPUI 原生绘制。
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView } from "gpui-base";
import { spaces, panes, focused, props, exec, readTextFile, watchFolder, layout, theme, checking, appHome, notify, nextCommand, run, agents, hc, terminals } from "herdr";
import { STATUSES, STATUS_LABEL, ARTIFACTS, VERSION, statusOf, artifactCount, countTasks, countSpec, parseMeta, summaryOf, splitDated, parseBlocks, attachCounts, canApply, canArchive, canVerify, canExplore, tabNameFor, promptFor, verdictPathFor, verdictWriteCmd, tagAgents, agentsOf, busyElsewhere } from "./core.mjs";
import { scan, readChange, readDoc } from "./read.mjs";

const MOD = "herdr-spec";

/** 元素 id 只用字母数字下划线：路径里的 / 和 . 会让不同文档的 id 看起来像同一个。 */
function idKey(text) {
  return String(text).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** 路径太长会把 400px 的栏撑破，只留最后两段。 */
function shortPath(path) {
  const parts = String(path).split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : String(path);
}

// 在版面树里找我们这个 mod 的节点链（根 → 自己），用来判断是否真的显示中。
function pathTo(node, mod, chain = []) {
  if (!node || typeof node !== "object") return null;
  const next = [...chain, node];
  if (node.content?.mod === mod) return next;
  for (const child of node.children ?? []) {
    const hit = pathTo(child, mod, next);
    if (hit) return hit;
  }
  for (const float of node.floating ?? []) {
    const hit = pathTo(float, mod, next);
    if (hit) return hit;
  }
  return null;
}

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "in-progress", label: "进行中" },
  { id: "no-tasks", label: "无任务" },
  { id: "complete", label: "已完成" },
];

/**
 * 分组/行的配色：用 ansi 调色板，不用 accent / done。
 *
 * 这两颗语义色在浅色主题里都是蓝的（accent #1f62d0、done #2f6fe4），四个分组摆在一起
 * 就只能靠深浅猜。ansi 那一组明摆着有六种色相，分组之间一眼分得开；
 * 分组配色取提案 ansi3、进行中 ansi4、就绪 ansi2，正是这个路子。
 */
const TONES = {
  "in-progress": "ansi4", // 蓝
  "no-tasks": "ansi3",    // 琥珀
  complete: "ansi2",      // 绿
  archived: "ansi8",      // 灰
  spec: "ansi5",          // 紫
};

/** 某个分组/状态的色；主题不给这个 ansi 时退回 dim。 */
function toneOf(id, t) {
  return t[TONES[id] ?? "dim"] ?? t.dim;
}

/** 文件名和命令行用等宽：路径靠形状就能扫，跟正文一眼分得开。系统没这个字体时退回默认。 */
const MONO = "Menlo";

/** 分组标题上的图标：路径相对 app 根目录（跟 tabs 里引用 specs.svg 的写法一致），颜色继承文字色。 */
const ICONS = "mods/herdr-spec/icons";
const ICON_OF = {
  "in-progress": "bolt",
  "no-tasks": "circle",
  complete: "check",
  archived: "archive",
  spec: "doc",
};
const icon = (name, size, color) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);

// 把一段文字贴进终端的输入框、不按回车：括号粘贴（ESC[200~…ESC[201~）只会把文本
// 插进输入框，claude 的对话框就收到原样指令，留给用户补充上下文后自己回车。
// 贴完发一个 ctrl+\（0x1C）让 hc attach 退出。script 的用法是 macOS 的，
// 别的系统这条会失败，调用方退回剪贴板。
// 反斜杠要双写：模板字符串里 \033 是八进制转义（规范禁止），双写后 shell 里的
// printf 自己把 \033 解释成 ESC。
const PASTE = `{ sleep 0.2; printf '\\033[200~%s\\033[201~' "$4"; sleep 0.15; printf '\\034'; } | perl -e 'alarm 3; exec @ARGV' script -q /dev/null sh -c 'stty rows "$2" cols "$3"; exec hc attach "$1"' sh "$1" "$2" "$3" >/dev/null 2>&1`;

export default class SpecsPanel extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.context = null;
    this.root = null;
    this.kind = "";
    this.note = "";
    this.changes = [];
    this.archived = [];
    this.specs = [];
    this.at = null; // 列表里高亮的那一行
    this.sel = null; // 正在看详情的那一行；null = 显示列表
    this.docs = null;
    this.doc = null;
    this.docText = "";
    this.filter = "all";
    this.loading = true;
    this.stamp = 0;
    this.watchRoot = null;
    this.watching = null;
    this.on = null; // 远端 space 的机器名；null = 本机
    this.stale = false;
    this.schema = "";  // openspec/config.yaml 里的 schema
    this.where = null; // 扫不到项目时，那个被扫过的目录
    this.alt = null;   // space 自己指向的项目，作为空状态里的出口
    this.pin = null;   // 用户点「打开 space 项目」时临时钉住的路径
    this.pinCwd = null;
    this.folds = {};   // 分组 id → 是否收起
    this.foldsFor = null;
    this.copied = null; // 刚复制过的条目 dir，用来闪一下对勾
    this.copiedDoc = false; // 刚复制过整份原文
    this.raw = false; // 详情里看原文（整篇代码块）还是按块排版
    this.query = "";   // 名字搜索：变更、归档、规格共用一个子串
    this.typing = false; // 键盘是否在喂给搜索框
    // 交给 agent：pending 是「刚点过、等 tab 起来」的那条，15 秒内不让再点。
    this.pending = null;
    this.hasClaude = null; // null 还没探过；探到 false 就只给复制指令
    if (checking()) return;
    this.checkLayout(cx);
    this.refresh(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        // nextCommand() 返回的是命令名字符串（herdr.d.ts：Promise<string>），不是对象——
        // 曾经写成 cmd.command 比较，分支永远不匹配，命令悄悄失踪。
        const name = await nextCommand();
        if (!name) continue;
        if (name === "focus") this.handle.focus();
        else if (name === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
    // cd 不改文件、也不触发 watchFolder：每 4 秒比一次上下文（只读内存，不读盘），
    // 变了才真的重扫。
    cx.timer.every(4000, (cx) => {
      if (!this.visible()) return;
      if (this.contextKey() !== this.context) this.refresh(cx);
    });
    // 面板收起时不会重画，所以要有一份计时兜底；本地正常情况下靠 watchFolder。
    cx.timer.every(20000, (cx) => {
      // 说明书：副本隐藏后计时器照跑，所以要轻。藏起来时不读盘，只记一笔。
      if (!this.visible()) {
        this.stale = true;
        return;
      }
      if (!this.watching) this.refresh(cx);
    });
  }

  // 版面是生成物：Herdr 升级后 main 会变，副本不会跟着变。版本对不上时提醒一次，
  // 而不是让人对着旧结构猜为什么新面板没出现。
  checkLayout(cx) {
    cx.spawn(async () => {
      try {
        const [text, version] = await Promise.all([
          readTextFile(`${appHome()}/layouts/specs.json`),
          exec("herdr-app", ["--version"]),
        ]);
        const stamped = JSON.parse(text)?.cloned_from?.version;
        const running = version.stdout.trim().replace(/^herdr-app\s+/, "");
        if (!stamped || !running || stamped === running) return;
        const pair = `${stamped}->${running}`;
        if (localStorage.getItem("specs.layoutNotice") === pair) return;
        localStorage.setItem("specs.layoutNotice", pair);
        notify({
          title: "Specs 版面是旧版 Herdr 生成的",
          body: `版面来自 ${stamped}，当前运行 ${running}；跑一次 node scripts/layout.mjs 同步。`,
          level: "warning",
        });
      } catch {
        /* 还没生成版面，或 herdr-app 不在 PATH：没什么可提醒的 */
      }
    });
  }

  /** 终端此刻的真实目录。焦点在终端上时直接用它；面板自己有焦点时，取当前 tab 里那个终端。 */
  liveCwd() {
    const f = focused();
    if (f?.cwd) return f.cwd;
    const alive = panes().filter((p) => p.terminal && p.cwd);
    const sameTab = f?.tab ? alive.filter((p) => p.tab === f.tab) : [];
    const pick = sameTab.find((p) => p.focused) ?? sameTab[0] ?? alive.find((p) => p.focused) ?? alive[0];
    return pick?.cwd ?? null;
  }

  /**
   * 决定这次显示哪个项目。优先顺序：显式 props / 用户点选（pin）→ 终端实时目录 → space 文件夹。
   *
   * 关键：终端所在目录扫不到项目时**不再回退**到 space 文件夹。以前那样做，cd 到别的目录后
   * 面板仍显示旧项目，看起来像「没更新」。现在如实返回 tried，由界面说明这里没有规格。
   */
  async resolve() {
    const space = spaces().find((s) => s.active);
    const cwd = this.liveCwd();
    const explicit = props()?.root;
    if (explicit) {
      const found = await scan(explicit, { on: this.on }).catch(() => null);
      return found ? { found, from: "props" } : { found: null, tried: explicit };
    }
    // 用户点过「打开 space 项目」，但终端目录又变了：回到跟随终端。
    if (this.pin) {
      if (this.pinCwd === cwd) {
        const found = await scan(this.pin, { on: this.on }).catch(() => null);
        if (found) return { found, from: "pin" };
      }
      this.pin = null;
      this.pinCwd = null;
    }
    if (cwd) {
      const found = await scan(cwd, { on: this.on }).catch(() => null);
      if (found) return { found, from: "cwd" };
      // 这里确实没有规格项目。顺手看看 space 的项目在不在，好给一个出口。
      const alt = space?.folder && space.folder !== cwd
        ? await scan(space.folder, { on: this.on }).catch(() => null)
        : null;
      return { found: null, tried: cwd, alt };
    }
    if (space?.folder) {
      const found = await scan(space.folder, { on: this.on }).catch(() => null);
      return found ? { found, from: "space" } : { found: null, tried: space.folder };
    }
    return { found: null, tried: null };
  }

  /** 这个 space 在哪台机器上：null = 本机，否则 exec / readTextFile 都要带上它。 */
  machine() {
    return spaces().find((s) => s.active)?.machine ?? null;
  }

  /** 此刻是否真的看得见：收起的面板、栈里没选中的那一页都算看不见。 */
  visible() {
    const chain = pathTo(layout(), MOD);
    if (!chain) return true; // 作为独立 tab 打开时不在版面树里
    return chain.every((node, index) => {
      if (node.hidden) return false;
      const parent = chain[index - 1];
      if (parent?.type === "stack" && parent.active !== node.id) return false;
      return true;
    });
  }

  contextKey() {
    const space = spaces().find((s) => s.active);
    return `${space?.id ?? "-"}|${space?.machine ?? "-"}|${this.liveCwd() ?? "-"}|${props()?.root ?? "-"}`;
  }

  refresh(cx) {
    this.context = this.contextKey();
    cx.spawn(async (cx) => this.load(cx));
  }

  /**
   * 把验证结论挂到 ready 阶段的变更上（item.verified）。
   *
   * 结论文件是变更目录里的 `.verify.json`（agent 按任务里的命令落盘，见 core.mjs），
   * 跟着工程走：远端 space 用 on 读、on 跑 find，一样生效。陈旧判定：变更目录里
   * 任何文件比结论文件新 → 标记过期（验证之后又改了任务或代码，「已验证」就不成立）。
   */
  async attachVerdicts() {
    if (!this.root) return;
    const items = this.changes.filter((c) => canVerify(c));
    if (!items.length) return;
    await Promise.all(items.map(async (item) => {
      const path = verdictPathFor(this.root, item.name);
      const text = await readTextFile(path, { on: this.on }).catch(() => null);
      if (!text) return;
      let v;
      try {
        v = JSON.parse(text);
      } catch {
        return; // 写坏了当没有：宁可不亮徽章，不亮假的
      }
      if (v.verdict !== "pass") return; // fail 不亮徽章，报告在 claude 那边
      // find 找到比结论文件新的文件 = 验证之后目录又动过 = 过期。
      // 结论文件本身也在目录里，但它不可能比自己的 mtime 新，不干扰判定。
      const stale = await exec("sh", ["-c", 'find "$2" -type f -newer "$1" -print -quit', "stale", path, item.dir], { on: this.on })
        .then((r) => (r.code === 0 ? Boolean(r.stdout.trim()) : true))
        .catch(() => true); // 判不了就当过期：宁可让人重验，不给假标记
      item.verified = {
        at: String(v.at ?? ""),
        critical: Number(v.critical ?? 0),
        warning: Number(v.warning ?? 0),
        suggestion: Number(v.suggestion ?? 0),
        stale,
      };
    }));
  }

  async load(cx) {
    // 远端 space 的目录在另一台机器上：后面每个读文件/跑命令的调用都要带 on。
    this.on = this.machine();
    if (!this.changes.length) this.loading = true;
    const { found, from, tried, alt } = await this.resolve();
    this.loading = false;
    this.source = from ?? null;
    this.alt = alt ?? null;
    if (!found) {
      this.root = null;
      this.kind = "";
      this.changes = [];
      this.archived = [];
      this.specs = [];
      this.sel = null;
      this.at = null;
      this.docs = null;
      this.docText = "";
      this.schema = "";
      this.where = tried ?? null;
      this.note = tried ? "这个目录不是规格项目" : "这个 space 还没有文件夹";
      cx.notify();
      return;
    }
    this.where = null;
    this.alt = null;
    this.note = "";
    this.root = found.root;
    this.kind = found.kind;
    this.schema = found.schema || "";

    this.changes = await Promise.all(
      found.changes.map(async (entry) => {
        const files = await readChange(entry.dir, { on: this.on });
        const meta = parseMeta(files.meta);
        const counts = countTasks(files.tasks);
        return {
          kind: "change",
          name: entry.name,
          dir: entry.dir,
          status: statusOf(counts),          // no-tasks / in-progress / complete
          artifacts: entry.artifacts,        // proposal / design / tasks / specs[]
          arts: artifactCount(entry.artifacts),
          done: counts.done,
          total: counts.total,
          created: meta.created ?? "",
          summary: summaryOf(files.proposal),
        };
      }),
    );
    await this.attachVerdicts();

    this.archived = await Promise.all(
      found.archived.slice(-12).reverse().map(async (entry) => {
        const files = await readChange(entry.dir, { on: this.on });
        const counts = countTasks(files.tasks);
        const parts = splitDated(entry.name);
        return {
          kind: "archived",
          name: parts.name || entry.name,
          dir: entry.dir,
          date: parts.date,
          done: counts.done,
          total: counts.total,
          status: "archived",
          artifacts: entry.artifacts,
          arts: artifactCount(entry.artifacts),
        };
      }),
    );

    this.specs = found.specs.map((cap) => ({
      kind: "spec",
      name: cap,
      dir: `${found.root}/${found.kind}/specs/${cap}/spec.md`,
      status: "spec",
    }));

    if (this.foldsFor !== found.root) {
      this.foldsFor = found.root;
      // 换项目才回到默认：摊开「进行中」和「已完成」（用户要求），进行中一条都没有
      // 时摊开第一条有人的；归档和规格是备查，收起来。
      // 用户自己折过的分组在这个项目里一直记着，重扫不会重置。
      const counts = {};
      for (const status of STATUSES) counts[status] = this.changes.filter((c) => c.status === status).length;
      counts.archived = this.archived.length;
      counts.spec = this.specs.length;
      const groups = [...STATUSES, "archived", "spec"];
      const fallback = groups.find((id) => counts[id] > 0) ?? "in-progress";
      const open = new Set(["in-progress", "complete", fallback]);
      this.folds = {};
      for (const id of groups) {
        if (!open.has(id)) this.folds[id] = true;
      }
    }

    this.stamp = Date.now();
    this.watch(found, cx);

    const flat = this.flat();
    // 高亮跟着目录走，刷新后不错位。
    this.at = this.at ? flat.find((row) => row.dir === this.at.dir) ?? flat[0] ?? null : flat[0] ?? null;
    // 详情开着时，文件变动后要把当前这份重读一遍；那一行没了就退回列表。
    if (this.sel) {
      const again = flat.find((row) => row.kind === this.sel.kind && row.dir === this.sel.dir);
      if (again) this.open(again, cx, true);
      else this.sel = null;
    }
    cx.notify();
  }

  watch(found, cx) {
    const target = `${found.root}/${found.kind}`;
    // watchFolder 只看本机；远端 space 交给上面的计时兜底。
    if (this.on) return;
    // 已经在看这个目录：循环还活着，不要重复起一个。
    if (this.watchRoot === target) return;
    this.watching?.cancel();
    this.watching = null;
    this.watchRoot = target;
    cx.spawn(async (cx) => {
      while (this.watchRoot === target) {
        try {
          this.watching = watchFolder(target);
          await this.watching;
        } catch {
          this.watching = null;
          return;
        }
        if (this.watchRoot !== target) return;
        // 直接重新读，不经过 refresh：refresh 会重建监视，循环就断了。
        if (this.visible()) await this.load(cx);
        else this.stale = true;
      }
      this.watching = null;
    });
  }

  /** 一个条目属于哪个分组：状态本身就是 id；归档与规格单列。 */
  sectionId(item) {
    if (item.kind === "archived") return "archived";
    if (item.kind === "spec") return "spec";
    return item.status;
  }

  /**
   * 这个分组收着没有。
   *
   * 默认只有「进行中」是摊开的。但用 f 过滤到某一组时，那一组必须展开——否则按了过滤
   * 只看到一张合起来的标题栏，像把内容过滤没了。
   */
  folded(id) {
    if (this.filter !== "all" && this.filter === id) return false;
    // 搜索时也不折叠：命中项被藏在合起来的卡片里，等于没搜到。
    if (this.query) return false;
    return Boolean(this.folds[id]);
  }

  /** 一行是不是命中当前的搜索。空串就是全都算命中。 */
  matches(item) {
    if (!this.query) return true;
    return item.name.toLowerCase().includes(this.query.toLowerCase());
  }

  /** 改搜索词：高亮跟着挪到第一条命中，列表立刻重排。 */
  setQuery(text, cx) {
    this.query = text;
    this.at = this.flat()[0] ?? null;
    cx.notify();
  }

  toggleFold(id, cx) {
    this.folds = { ...this.folds, [id]: !this.folds[id] };
    // 收起后高亮行可能被藏起来了，挪到第一行还能看见的。
    const flat = this.flat();
    if (this.at && !flat.some((row) => row.dir === this.at.dir)) this.at = flat[0] ?? null;
    cx.notify();
  }

  toggleAll(cx) {
    const ids = [...STATUSES, "archived", "spec"];
    const anyOpen = ids.some((id) => id in this.folds && !this.folds[id]);
    const next = {};
    for (const status of STATUSES) next[status] = anyOpen;
    next.archived = anyOpen;
    next.spec = anyOpen;
    this.folds = next;
    const flat = this.flat();
    if (this.at && !flat.some((row) => row.dir === this.at.dir)) this.at = flat[0] ?? null;
    cx.notify();
  }

  /** 列表最终展示的行：过滤后的状态 + 归档 + 规格，收起的分组不出现。 */
  flat() {
    const rows = [];
    for (const status of STATUSES) {
      if (this.filter !== "all" && this.filter !== status) continue;
      if (this.folded(status)) continue;
      for (const change of this.changes.filter((c) => c.status === status && this.matches(c))) rows.push(change);
    }
    if (this.filter === "all") {
      if (!this.folded("archived")) rows.push(...this.archived.filter((x) => this.matches(x)));
      if (!this.folded("spec")) rows.push(...this.specs.filter((x) => this.matches(x)));
    }
    return rows;
  }

  /** 这条变更有没有某个产物。用于页签的明暗，以及正文的「还没生成」提示。 */
  hasArtifact(item, id) {
    if (!item) return false;
    if (item.kind === "spec") return id === "spec";
    if (!item.artifacts) return false;
    if (id === "specs") return item.artifacts.specs.length > 0;
    return Boolean(item.artifacts[id]);
  }

  open(item, cx, quiet = false) {
    // 打开一条就退出输入态（搜索词留着，回来还能接着看这批结果）。
    this.typing = false;
    this.sel = item;
    if (!quiet) this.docText = "";
    // 变更与归档固定列四个产物；单份主规格只有一份。
    const docs = item.kind === "spec" ? ["spec"] : ARTIFACTS.map((a) => a.id);
    this.docs = docs;
    // 刷新时保留正在看的那一份；换了条目就落到第一个已存在的产物。
    const keep = quiet && this.doc && docs.includes(this.doc) ? this.doc : docs.find((id) => this.hasArtifact(item, id)) ?? docs[0];
    this.doc = keep;
    cx.notify();
    if (keep) this.pickDoc(keep, cx);
  }

  /** 按产物 id 取正文；specs 是多份 delta，合成一份带能力小标题的文档。 */
  async loadArtifact(item, id) {
    if (item.kind === "spec") return readDoc(item.dir, { on: this.on });
    if (!this.hasArtifact(item, id)) return "";
    if (id === "specs") {
      const parts = await Promise.all(
        item.artifacts.specs.map(async (rel) => {
          const cap = rel.replace(/^specs\//, "").replace(/\/spec\.md$/, "");
          const text = await readDoc(`${item.dir}/${rel}`, { on: this.on });
          return { cap, text };
        }),
      );
      if (parts.length === 1) return parts[0].text;
      return parts.map((part) => `# ${part.cap}\n\n${part.text}`).join("\n\n---\n\n");
    }
    const file = { proposal: "proposal.md", design: "design.md", tasks: "tasks.md" }[id];
    return file ? readDoc(`${item.dir}/${file}`, { on: this.on }) : "";
  }

  back(cx) {
    this.sel = null;
    this.docs = null;
    this.doc = null;
    this.docText = "";
    cx.notify();
  }

  pickDoc(doc, cx) {
    const item = this.sel;
    if (!item) return;
    this.doc = doc;
    this.docText = "";
    cx.notify(); // 先把页签点亮、正文清空；读盘回来再填，点了马上有反馈
    cx.spawn(async (cx) => {
      const text = await this.loadArtifact(item, doc);
      // 只校验「还是这条变更、还是这份产物」；不再比对 context 快照。
      if (this.sel?.dir !== item.dir || this.doc !== doc) return;
      this.docText = text;
      cx.notify();
    });
  }

  move(delta, cx) {
    const flat = this.flat();
    if (!flat.length) return;
    const at = this.at ? flat.findIndex((row) => row.dir === this.at.dir) : -1;
    const next = flat[Math.min(flat.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))];
    if (next && next.dir !== this.at?.dir) {
      this.at = next;
      cx.notify();
    }
  }

  stepDoc(delta, cx) {
    if (!this.docs?.length || !this.sel) return;
    const at = this.docs.indexOf(this.doc);
    const next = this.docs[Math.min(this.docs.length - 1, Math.max(0, at + delta))];
    if (next && next !== this.doc) this.pickDoc(next, cx);
  }

  cycleFilter(cx) {
    const at = FILTERS.findIndex((f) => f.id === this.filter);
    this.filter = FILTERS[(at + 1) % FILTERS.length].id;
    this.at = this.flat()[0] ?? null;
    cx.notify();
  }

  render(cx) {
    if (checking()) {
      return v_flex().size_full().items_center().justify_center().child(div().text_color(theme().muted).child("Checking…"));
    }
    if (this.context !== this.contextKey()) this.refresh(cx);
    else if (this.stale && this.visible()) {
      this.stale = false;
      this.refresh(cx);
    }
    const t = theme();
    const done = this.changes.reduce((n, c) => n + c.done, 0);
    const total = this.changes.reduce((n, c) => n + c.total, 0);

    // 底色用侧栏那一层的颜色，卡片才浮得出来；主题没给 chrome 时退回 background。
    return v_flex().id("specs").size_full().min_h(0).bg(t.chrome ?? t.background).text_color(t.foreground).text_size(15)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const key = e.key;
        // 输入态：先把字吃进来，方向键和回车照常用，别的键一律不冒泡。
        if (this.typing) {
          cx.stop_propagation();
          if (key === "escape") {
            this.typing = false;
            this.setQuery("", cx);
            return;
          }
          if (key === "enter") {
            this.typing = false;
            if (this.at) this.open(this.at, cx);
            else cx.notify();
            return;
          }
          if (key === "backspace") {
            this.setQuery(this.query.slice(0, -1), cx);
            return;
          }
          if (key === "down" || key === "up") {
            this.move(key === "down" ? 1 : -1, cx);
            return;
          }
          // key_char 才是「这一下会打出来的字」，带 shift 也正确；组合键留给宿主。
          const ch = e.key_char;
          const mod = e.modifiers ?? {};
          if (ch && ch.length === 1 && !mod.platform && !mod.control && !mod.alt) {
            this.setQuery(this.query + ch, cx);
          }
          return;
        }
        if (this.sel) {
          if (key === "escape") {
            cx.stop_propagation();
            this.back(cx);
          } else if (key === "right" || key === "l") {
            cx.stop_propagation();
            this.stepDoc(1, cx);
          } else if (key === "left" || key === "h") {
            cx.stop_propagation();
            this.stepDoc(-1, cx);
          } else if (key === "r") {
            cx.stop_propagation();
            this.refresh(cx);
          } else if (key === "m") {
            cx.stop_propagation();
            this.raw = !this.raw;
            cx.notify();
          }
          return;
        }
        if (key === "down" || key === "j") {
          cx.stop_propagation();
          this.move(1, cx);
        } else if (key === "up" || key === "k") {
          cx.stop_propagation();
          this.move(-1, cx);
        } else if (key === "enter") {
          cx.stop_propagation();
          if (this.at) this.open(this.at, cx);
        } else if (key === "left" || key === "h") {
          cx.stop_propagation();
          if (this.at) this.toggleFold(this.sectionId(this.at), cx);
        } else if (key === "right" || key === "l") {
          cx.stop_propagation();
          if (this.at && this.folded(this.sectionId(this.at))) this.toggleFold(this.sectionId(this.at), cx);
        } else if (key === "z") {
          cx.stop_propagation();
          this.toggleAll(cx);
        } else if (key === "/") {
          cx.stop_propagation();
          this.typing = true;
          cx.notify();
        } else if (key === "tab" || key === "f") {
          cx.stop_propagation();
          this.cycleFilter(cx);
        } else if (key === "r") {
          cx.stop_propagation();
          this.refresh(cx);
        } else if (key === "escape") {
          cx.stop_propagation();
          if (this.query) {
            this.setQuery("", cx);
          } else if (this.filter !== "all") {
            this.filter = "all";
            this.at = this.flat()[0] ?? null;
            cx.notify();
          } else {
            run("pane.go", { direction: "left" });
          }
        }
      })
      .child(this.header(t, done, total, cx))
      .child(this.sel ? this.detail(t, cx) : this.list(t, cx))
      .child(this.footer(t));
  }

  header(t, done, total, cx) {
    if (this.typing || this.query) return this.searchBar(t, cx);
    const filter = FILTERS.find((f) => f.id === this.filter);
    return h_flex().h(46).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      // 两行：上面是哪一栏，下面是看的哪个项目——切 space 时一眼就知道换没换。
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().font_semibold().child("Specs"))
          .when(Boolean(this.schema || this.kind), (e) => e.child(this.badge(this.schema || this.kind, t, `${t.accent}1f`, t.accent)))
          .when(this.source === "pin", (e) => e.child(this.badge("space", t))))
        .child(div().min_w(0).truncate().text_size(12).text_color(t.muted)
          .child(this.root ? shortPath(this.root) : this.where ? shortPath(this.where) : "没有项目")))
      .when(total > 0, (e) => e.child(div().flex_none().text_size(13).text_color(t.muted).child(`${done}/${total}`)))
      .when(this.filter !== "all", (e) => e.child(div().flex_none().text_size(12).text_color(t.accent).child(filter.label)))
      .child(h_flex().id("specs-search").h(24).w(22).flex_none().rounded(5).items_center()
        .justify_center().cursor_pointer().text_size(14).text_color(t.muted)
        .tooltip("按名字搜索（/）")
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.handle.focus();
          this.typing = true;
          cx.notify();
        })
        .child(icon("search", 13, t.muted)))
      .child(div().id("specs-refresh").px(6).py(2).rounded(5).flex_none().cursor_pointer().text_size(13).text_color(t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.refresh(cx))
        .child("刷新"));
  }

  /** 顶栏换成搜索行：放大镜、输入中的词、命中条数，右边一颗清除。不在输入态时点一下就进。 */
  searchBar(t, cx) {
    const active = this.typing;
    const hits = this.flat().length;
    return h_flex().h(46).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .when(!active, (e) => e.cursor_pointer().on_click((_e, cx) => {
        this.handle.focus();
        this.typing = true;
        cx.notify();
      }))
      .child(icon("search", 14, active ? t.accent : t.dim))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().items_center().gap(1).min_w(0)
          .child(div().min_w(0).truncate().text_color(this.query ? t.foreground : t.dim)
            .child(this.query || "按名字搜索"))
          // 自绘的插入符：输入态才闪，省得去抢真输入框的焦点。
          .when(active, (e) => e.child(div().flex_none().text_color(t.accent).child("▏"))))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(`${hits} 条 · ${active ? "esc 清空，enter 打开" : "点这里继续输入"}`)))
      .when(Boolean(this.query), (e) => e.child(h_flex().id("specs-search-clear").h(22).px(6).flex_none()
        .rounded(5).items_center().cursor_pointer().text_size(12).text_color(t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.typing = false;
          this.setQuery("", cx);
        })
        .child("✕")))
      .when(!Boolean(this.query), (e) => e.child(div().flex_none().text_size(12).text_color(t.dim).child("esc 退出")));
  }

  badge(text, t, bg = null, fg = null) {
    return div().px(6).py(1).rounded(5).flex_none().bg(bg ?? t.raised).text_size(12).text_color(fg ?? t.muted).child(text);
  }

  list(t, cx) {
    const sections = [];
    for (const status of STATUSES) {
      if (this.filter !== "all" && this.filter !== status) continue;
      const rows = this.changes.filter((c) => c.status === status && this.matches(c));
      if (!rows.length) continue;
      sections.push(this.section(t, cx, status, STATUS_LABEL[status], rows));
    }
    const archived = this.archived.filter((x) => this.matches(x));
    const specs = this.specs.filter((x) => this.matches(x));
    if (this.filter === "all" && archived.length) {
      sections.push(this.section(t, cx, "archived", "归档", archived));
    }
    if (this.filter === "all" && specs.length) {
      sections.push(this.section(t, cx, "spec", "规格", specs));
    }
    return v_flex().flex_1().min_h(0).relative()
      .child(v_flex().id("specs-list").absolute().inset_0().overflow_y_scroll().px(8).pt(8).pb(10).gap(8)
        .when(!sections.length, (e) => e.child(this.empty(t, cx)))
        .children(sections))
      .child(Scrollbar.vertical("specs-list").absolute().inset_0());
  }

  /** 一个分组：一张浮在底色上的卡片，标题栏可点折起来；行贴着卡片边，最后一行的圆角自己收。 */
  section(t, cx, id, label, rows) {
    const folded = this.folded(id);
    const tone = toneOf(id, t);
    const head = h_flex().id(`specs-sec-${id}`).h(32).flex_none().px(10).gap(7).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .when(!folded && rows.length > 0, (e) => e.border_b(1).border_color(t.border))
      .on_click((_e, cx) => {
        this.handle.focus();
        this.toggleFold(id, cx);
      })
      // 图标始终带色，收起来也看得出这一组是什么；文字收起来时变淡。
      .child(icon(ICON_OF[id] ?? "circle", 14, tone))
      .child(div().font_semibold().text_size(13).text_color(folded ? t.muted : t.foreground).child(label))
      .child(h_flex().flex_none().px(6).py(1).rounded_full().items_center().bg(`${tone}1f`)
        .child(div().text_size(12).text_color(tone).child(String(rows.length))))
      .child(div().flex_1())
      .child(div().flex_none().text_size(12).text_color(t.dim).child(folded ? "▸" : "▾"));
    // 浅色主题的 border 只有 7% 黑，白卡在白底上等于没有边：这里用 input（15%）并把卡片抬一点。
    return v_flex().flex_none().rounded(10).border_1().border_color(t.input).bg(t.surface).overflow_hidden().shadow_2xs()
      .child(head)
      .when(!folded, (e) => e.children(rows.map((row, i) => this.row(row, t, cx, i + 1, i === 0, i === rows.length - 1))));
  }

  /** 列表为空时说明原因：是「这里真没有变更」，还是「这个目录根本不是项目」。 */
  empty(t, cx) {
    const card = (children) => v_flex().flex_none().px(12).py(11).gap(6).rounded(10)
      .border_1().border_color(t.input).bg(t.surface).shadow_2xs()
      .children(children);
    if (this.loading) return card([div().text_color(t.dim).child("读取中…")]);
    if (this.query) {
      return card([
        div().font_semibold().text_color(t.foreground).child(`没有匹配「${this.query}」的变更或规格`),
        div().text_size(13).text_color(t.dim).child("esc 清空后回到全部；换个更短的词也行。"),
      ]);
    }
    if (!this.where) {
      if (this.root && !this.changes.length) {
        return card([
          div().font_semibold().text_color(t.foreground).child("还没有变更"),
          div().text_size(13).text_color(t.dim).child("在终端里跑 openspec new change <名字>，建好后这里会自动出现。"),
        ]);
      }
      return card([div().text_color(t.dim).child(this.note || "这里没有变更")]);
    }
    return card([
      div().min_w(0).truncate().font_semibold().child(shortPath(this.where)),
      div().text_size(13).text_color(t.dim).child("不是规格项目：这里没有 openspec/。"),
      div().text_size(13).text_color(t.dim).child("面板跟随终端所在目录，cd 到项目里就会切过去。"),
      ...(this.alt
        ? [h_flex().id("specs-alt").mt(3).px(9).py(5).rounded(6).flex_none().cursor_pointer()
          .border_1().border_color(t.input).text_size(13).text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.pin = this.alt.root;
            this.pinCwd = this.liveCwd();
            this.refresh(cx);
          })
          .child(`打开 space 项目：${shortPath(this.alt.root)}`)]
        : []),
    ]);
  }

  /**
   * 一行变更/归档/规格。
   *
   * 版式：序号 + 标题一行，进度条横贯整行（不缩进）、摘要缩在名字下面。
   * 进度条如果在正文列里，右侧会留一截空白，看着像断掉；横贯之后它才像这条变更自己的刻度。
   *
   * 序号代替原来的状态圆点：状态已经由分组标题的图标和进度条颜色说明了，行里再用同色的点
   * 是重复；编号反而能跟详情页的「2 / 5」对上，说「第三条」时有个准。
   */
  row(item, t, cx, index, first = false, last = false) {
    const on = this.at && this.at.dir === item.dir;
    const color = toneOf(item.status, t);
    const count = item.total ? `${item.done}/${item.total}` : "";
    // 产物不全时给个数，比一排小字母好读；四个都在就不占地方。
    const arts = item.kind === "change" && item.arts < 4 ? `产物 ${item.arts}/4` : "";
    // 进度条：一条 4px 的槽，颜色沿用这一组的状态色。
    // 槽用 input（15% 黑）：raised 在白卡上几乎看不见，0/6 那种一行就完全没痕迹了。
    const percent = item.total > 0 ? Math.round((item.done / item.total) * 100) : 0;
    const copied = this.copied === item.dir;
    return v_flex().id(`specs-row-${item.dir}`).flex_none().py(9).gap(5).cursor_pointer()
      // 选中行左侧一条色带 + 淡底；色带占 2px，左边距补回来，文字不会跟着跳。
      .pl(on ? 8 : 10).pr(8)
      // 行与行之间一条发丝线：一组里有三四条时，眼睛才知道从哪一行开始。
      .when(!first, (e) => e.border_t(1).border_color(t.border))
      .when(on, (e) => e.bg(`${t.accent}14`).border_l(2).border_color(t.accent))
      // 卡片的 overflow_hidden 只裁矩形，最后一行要自己收圆角，底色才不会从圆角里露出来。
      .when(last && !on, (e) => e.rounded_b(9))
      .hover((s) => s.when(!on, (e) => e.bg(t.hover)))
      .on_click((_e, cx) => {
        this.handle.focus();
        this.at = item;
        this.open(item, cx);
      })
      .child(h_flex().gap(7).items_center().min_w(0)
        .child(div().w(13).flex_none().text_size(12).text_color(on ? t.accent : t.dim).child(String(index)))
        .child(div().min_w(0).truncate().child(item.name))
        .child(div().flex_1())
        .when(Boolean(arts), (e) => e.child(div().flex_none().text_size(12).text_color(t.dim).child(arts)))
        // 验证通过：任务数徽章左侧一颗绿钩（过期不亮——内容又改过，验证不再成立）。
        .when(item.verified && !item.verified.stale, (e) => e.child(h_flex().flex_none().items_center()
          .tooltip(`已验证${item.verified.at ? ` · ${this.fmtWhen(item.verified.at)}` : ""}；内容变更后需重新验证`)
          .child(icon("check", 13, t.done ?? t.ansi2 ?? t.accent))))
        .when(Boolean(count), (e) => e.child(h_flex().flex_none().px(5).py(1).rounded(4).items_center()
          .bg(`${color}1f`)
          .child(div().text_size(12).text_color(color).child(count))))
        // 复制这一条的目录路径。点它不能把行也打开，所以按下就把事件截住。
        .child(h_flex().id(`specs-copy-${item.dir}`).w(20).h(18).flex_none().rounded(4)
          .items_center().justify_center().cursor_pointer()
          .tooltip(copied ? "已复制" : "复制目录路径")
          .hover((s) => s.bg(t.raised))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.copyPath(item, cx);
          })
          .child(icon(copied ? "check" : "copy", 12, copied ? (t.ansi2 ?? t.done) : t.dim))))
      .when(item.total > 0, (e) => e.child(div().h(4).flex_none().mt(1).rounded(2).bg(t.input).overflow_hidden()
        .child(div().h_full().rounded(2).w(`${percent}%`).bg(color))))
      .when(Boolean(item.summary), (e) => e.child(div().pl(20).min_w(0).truncate().text_size(13).text_color(t.muted).child(item.summary)))
      // 行底的快捷动作（每行只放建议的下一步）：探索未归档的变更
      // 一直在；执行（还有任务）与归档（全部勾完）互斥出现，都是承诺动作。
      .when(canExplore(item), (e) => e.child(this.rowActions(item, t)));
  }

  /** 列表行底的快捷动作行：`探索` + 当前该做的事（执行 / 验证+归档）。 */
  rowActions(item, t) {
    // h 要显式给：不给的容器在这一行里塌成 0 高，按钮明明渲染了却看不见。
    const wrap = h_flex().mt(1).ml(20).h(22).gap(4)
      // v_flex 的子元素默认拉伸填满整行——不按内容收缩的话，按钮会一直顶到右边缘。
      .self_start();
    wrap.child(this.rowChip(item, "explore", "sparkle", "探索", false,
      (c) => this.startAgent("explore", item, c), t,
      "开一个新 tab，指令贴进输入框、不回车——补充上下文后自己发送（不改文件）"));
    if (canApply(item)) {
      wrap.child(this.rowChip(item, "run", "play", `执行 ${item.total - item.done}`, true,
        (c) => this.startAgent("apply", item, c), t,
        "开一个新 tab，apply 指令贴进输入框——确认后回车开工（会改文件）"));
    } else if (canVerify(item)) {
      // 验证通过（未过期）不再给「验证」按钮——状态由任务数徽章左侧的绿钩说明；
      // 没验证过或验证后内容又有改动（过期），按钮重新出现，实心给建议的下一步。
      const stale = Boolean(item.verified?.stale);
      if (!item.verified) {
        wrap.child(this.rowChip(item, "verify", "check", "验证", true,
          (c) => this.startAgent("verify", item, c), t,
          "开一个新 tab，检查指令贴进输入框——确认后发送（只读，出分级报告）"));
      } else if (stale) {
        wrap.child(this.rowChip(item, "verify", "check", "验证", true,
          (c) => this.startAgent("verify", item, c), t,
          "上次验证已过期（变更内容又有改动）——建议重新验证；也可直接归档"));
      }
      wrap.child(this.rowChip(item, "archive", "archive", "归档", Boolean(item.verified) && !stale,
        (c) => this.startAgent("archive", item, c), t,
        "开一个新 tab，归档指令贴进输入框——确认后发送"));
    }
    return wrap;
  }

  /** ISO 时间转成「时:分」，解析不了就原样给（agent 写的时间格式以它为准）。 */
  fmtWhen(s) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /**
   * 列表行上的小按钮。solid = 承诺动作（accent 实心），否则只读建议（描边淡底）。
   * 点它不进详情、也不选中这一行——快速开始就只管开始。守卫与详情卡同一套。
   */
  rowChip(item, id, iconName, label, solid, onClick, t, tip) {
    return h_flex().id(`specs-row-${id}-${item.dir}`).h(22).px(7).gap(4).flex_none()
      .items_center().rounded(5).cursor_pointer().text_size(12)
      .when(solid, (e) => e.bg(t.accent).text_color(t.accent_foreground ?? t.background))
      .when(!solid, (e) => e.border_1().border_color(t.accent).bg(`${t.accent}14`).text_color(t.accent))
      .tooltip(tip)
      .when(solid, (e) => e.hover((s) => s.opacity(0.88)))
      .when(!solid, (e) => e.hover((s) => s.bg(`${t.accent}26`)))
      .on_mouse_down("left", (_e, c) => c.stop_propagation())
      .on_click((_e, c) => {
        c.stop_propagation();
        onClick(c);
      })
      .child(icon(iconName, 11, solid ? (t.accent_foreground ?? t.background) : t.accent))
      .child(label);
  }

  /** 复制这一条的目录：规格条目存的是 spec.md，复制它所在的目录。反馈用图标变对勾，1.4 秒后复原。 */
  copyPath(item, cx) {
    const dir = item.kind === "spec" ? item.dir.replace(/\/spec\.md$/, "") : item.dir;
    cx.write_to_clipboard(dir);
    this.copied = item.dir;
    cx.notify();
    cx.timer.after(1400, (cx) => {
      if (this.copied !== item.dir) return; // 又复制了别的，别把新的对勾擦掉
      this.copied = null;
      cx.notify();
    });
  }

  detail(t, cx) {
    const item = this.sel;
    const docs = this.docs ?? [];
    const label = (id) => (id === "spec" ? "Spec" : ARTIFACTS.find((a) => a.id === id)?.label ?? id);
    const tone = toneOf(item.status, t);
    // 「第几条」按列表里现在这一批算（过滤与折叠之后），跟返回后看到的一致。
    const rows = this.flat();
    const pos = rows.findIndex((row) => row.dir === item.dir);

    // 页签上带数：Tasks 2/5、Specs 2——不点进去也知道哪份值得先看。
    const chipCount = (id) => {
      if (id === "tasks" && item.total) return `${item.done}/${item.total}`;
      if (id === "specs") {
        const n = item.artifacts?.specs?.length ?? 0;
        return n > 1 ? String(n) : "";
      }
      return "";
    };

    const chips = docs.map((id) => {
      const on = this.doc === id;
      const exists = this.hasArtifact(item, id);
      const count = chipCount(id);
      return h_flex().id(`specs-doc-${id}`).h(26).px(9).gap(4).flex_none().items_center().rounded(6)
        .cursor_pointer().text_size(13)
        .when(on, (e) => e.bg(`${t.accent}1f`))
        .text_color(on ? t.accent : exists ? t.muted : t.dim)
        .hover((s) => s.when(!on, (e) => e.bg(t.hover)))
        .on_click((_e, cx) => {
          this.handle.focus();
          this.pickDoc(id, cx);
        })
        .child(label(id))
        // 验证通过：Tasks 页签的计数左侧一颗绿钩（过期不亮），与列表行的徽章同款。
        .when(id === "tasks" && item.verified && !item.verified.stale,
          (e) => e.child(h_flex().flex_none().items_center()
            .tooltip(`已验证${item.verified.at ? ` · ${this.fmtWhen(item.verified.at)}` : ""}；内容变更后需重新验证`)
            .child(icon("check", 12, t.done ?? t.ansi2 ?? t.accent))))
        .when(Boolean(count), (e) => e.child(div().flex_none().text_size(11)
          .text_color(on ? t.accent : t.dim).child(count)));
    });

    // 数字块。规格页放需求/场景数（2 Requirements / 2 Scenarios 的写法），
    // 其余放任务与产物——同一块位置，回答的问题随文档变。
    const specCount = this.doc === "spec" || this.doc === "specs" ? countSpec(this.docText) : null;
    const tiles = [];
    if (specCount && specCount.requirements > 0) {
      tiles.push(this.tile(String(specCount.requirements), "需求", t));
      if (specCount.scenarios > 0) tiles.push(this.tile(String(specCount.scenarios), "场景", t));
    } else {
      if (item.total) tiles.push(this.tile(`${item.done}/${item.total}`, "任务", t));
      if (item.kind !== "spec") tiles.push(this.tile(`${item.arts}/4`, "产物", t));
    }

    const when = item.date || item.created || "";
    const status = this.statusLabel(item);
    const file = this.docFile(item);
    const missing = !this.hasArtifact(item, this.doc);

    // 上一份 / 下一份：键盘的 ←→ 没人看得见，页面上得有一个能点的。
    const atDoc = docs.indexOf(this.doc);
    const nav = (dir, glyph, to) => h_flex().id(`specs-nav-${dir}`).h(22).w(20).flex_none()
      .items_center().justify_center().rounded(5).text_size(15)
      .when(!to, (e) => e.text_color(t.dim))
      .when(Boolean(to), (e) => e.cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.handle.focus();
          this.stepDoc(dir === "prev" ? -1 : 1, cx);
        }))
      .child(glyph);

    // 卡片的头：这份是什么（提案/设计/任务）、那条变更现在什么状态、看的到底是哪个文件。
    const head = v_flex().flex_none().px(12).pt(11).pb(10).gap(5)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().min_w(0).truncate().font_semibold().text_size(16).child(label(this.doc)))
        .child(div().flex_1())
        .when(Boolean(status), (e) => e.child(h_flex().flex_none().px(6).py(1).rounded_full().items_center()
          .bg(`${tone}1f`).child(div().text_size(11).text_color(tone).child(status))))
        // 「原文」是个开关，不是说明文字：常显在卡头、按下有底色，才不会被当成标题的一部分忽略。
        .when(!missing, (e) => e.child(h_flex().id("specs-raw").h(22).px(7).gap(4).flex_none().items_center()
          .rounded(6).border_1().cursor_pointer().text_size(12)
          .border_color(this.raw ? t.accent : t.input)
          .text_color(this.raw ? t.accent : t.muted)
          .when(this.raw, (e) => e.bg(`${t.accent}1f`))
          .tooltip(this.raw ? "回到按块排版（m）" : "看原始 markdown（m）")
          .hover((s) => s.bg(this.raw ? `${t.accent}26` : t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.handle.focus();
            this.raw = !this.raw;
            cx.notify();
          })
          .child(icon("doc", 12, this.raw ? t.accent : t.muted))
          .child("原文")))
        // 复制整份原文：块渲染之后跨块选不中，整份拿走得有个按钮。
        .when(Boolean(this.docText), (e) => e.child(h_flex().id("specs-copy-doc").h(22).w(20).flex_none().rounded(5)
          .items_center().justify_center().cursor_pointer()
          .tooltip(this.copiedDoc ? "已复制" : "复制这一份原文")
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.copyDoc(cx);
          })
          .child(icon(this.copiedDoc ? "check" : "copy", 12, this.copiedDoc ? (t.ansi2 ?? t.done) : t.dim))))
        // 只有一份产物（比如单份规格）时不摆翻页键，省下的地方留给标题。
        .when(docs.length > 1, (e) => e
          .child(nav("prev", "‹", atDoc > 0))
          .child(nav("next", "›", atDoc >= 0 && atDoc < docs.length - 1))))
      .when(Boolean(file || when), (e) => e.child(div().min_w(0).truncate().font_family(MONO).text_size(12)
        .text_color(t.dim).child([file, when].filter(Boolean).join("  ·  "))))
      .when(tiles.length > 0, (e) => e.child(h_flex().flex_none().w_full().gap(8).mt(3).children(tiles)));

    const body = missing
      ? this.missing(t, item, label(this.doc))
      : this.raw ? this.rawBody(t, item) : this.docBody(t, item);
    const actions = this.actions(t, cx);

    return v_flex().flex_1().relative().w_full().min_h(0)
      .child(h_flex().flex_none().w_full().px(8).pt(8).pb(6).gap(6).items_center()
        .child(h_flex().id("specs-back").h(26).px(7).gap(3).flex_none().items_center().rounded(6).cursor_pointer()
          .text_size(13).text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.handle.focus();
            this.back(cx);
          })
          .child("‹ 返回"))
        .child(div().min_w(0).truncate().font_semibold().child(item.name))
        .child(div().flex_1())
        // 在这批里的第几条：与详情页右上角的「2 / 3」呼应。
        .when(pos >= 0, (e) => e.child(div().flex_none().text_size(12).text_color(t.dim)
          .child(`${pos + 1} / ${rows.length}`))))
      // 页签与正文合成一张卡：头是这份的标题与数字，页签是卡片的分栏，正文只滚自己。
      .child(v_flex().flex_1().min_h(0).mx(8).mb(8).rounded(10).border_1().border_color(t.input)
        .bg(t.surface).overflow_hidden().shadow_2xs()
        .child(head)
        .child(h_flex().id("specs-docs").h(38).flex_none().w_full().px(6).items_center()
          .border_t(1).border_b(1).border_color(t.border)
          // 栏窄的时候页签放不下：让它横向滚，别把最后一个页签裁成半个字。
          .child(h_flex().flex_1().min_w(0).h_full().gap(2).items_center().overflow_x_scroll()
            .children(chips)))
        .child(body)
        // 操作栏钉在卡片底部：放进正文就会跟着滚走，滚到底才看得见等于没有。
        .when(Boolean(actions), (e) => e.child(actions)));
  }

  /**
   * 详情卡底部那条「让 agent 上手」的栏。
   *
   * 只对还做得动的变更出现：已经完成的、归档的、纯规格的都没有动作可做，
   * 与其摆一排灰按钮，不如整条不画。远端 space 也先不画——`hc run --on` 的语义和
   * 那边的 cwd 还没验过，宁可不给。
   *
   * 版式约定（以后加动作照这个来）：
   * - 左边一组是「开工」类，用视觉重量区分用途：**实心（accent 填充）＝当前状态唯一
   *   该做的事**——还剩任务是「执行 N 项」，全部勾完就流转成「归档」；安全的只读动作
   *   （探索）用 accent 描边淡底。颜色同为 accent，只靠重量区分。
   * - 探索未归档的变更一直在：规格会持续完善、任务也可能补充，跟阶段无关。
   * - 右边一组是「管理」类（复制指令、已在跑 ›）：中性样式。
   */
  actions(t, cx) {
    const item = this.sel;
    if (!item || this.on) return null;
    if (item.kind !== "change") return null;
    const open = canApply(item);
    const done = canArchive(item);
    const tagged = tagAgents(agents(), terminals());
    const mine = agentsOf(item.name, tagged).live;

    const busy = this.busy(item);
    const other = busy ? null : busyElsewhere(item, tagged);
    // 探索只读，同仓库互斥管不到它；执行会改文件才要被那个守卫挡住。
    const blocked = Boolean(busy || other);

    // 副按钮：accent 描边 + 淡底。它是只读的安全动作，但灰字里看不见，
    // 所以跟主按钮同色、只低一档视觉重量——实心是承诺，描边只是建议。
    const ghost = (id, label, iconName, onClick, tip) => h_flex().id(id).h(26).px(8).gap(4).flex_none()
      .items_center().rounded(6).border_1().border_color(t.accent).bg(`${t.accent}14`)
      .cursor_pointer().text_size(12).text_color(t.accent)
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .hover((s) => s.bg(`${t.accent}26`))
      .on_mouse_down("left", (_e, c) => c.stop_propagation())
      .on_click((_e, c) => {
        c.stop_propagation();
        this.handle.focus();
        onClick(c);
      })
      .child(icon(iconName, 12, t.accent))
      .child(label);

    // 主按钮随状态流转：还剩任务 → 执行；全部勾完 → 验证；验证通过 → 归档。
    // 实心 = 当前状态建议的下一步。验证是可选动作（用户确认可跳过），没验证时
    // 归档以描边 ghost 出现；验证通过后归档升实心。陈旧标记让验证重新成为主按钮。
    const v = item.verified ?? null;
    const verified = Boolean(v && !v.stale);
    const whenRun = open;
    const whenVerify = done && !verified;
    const whenArchive = done && verified;
    const disabled = whenRun && blocked;
    const primary = h_flex().id("specs-run").h(26).px(9).gap(4).flex_none().items_center().rounded(6)
      .text_size(12).cursor_pointer()
      .when(disabled, (e) => e.bg(t.raised).text_color(t.dim))
      .when(!disabled, (e) => e.bg(t.accent).text_color(t.accent_foreground ?? t.background))
      .when(!disabled, (e) => e.hover((s) => s.opacity(0.88)))
      .tooltip(whenRun
        ? (blocked
          ? (busy ? "刚启动，等它出现" : `${other.tab_name} 正在跑：同一个仓库同时只跑一个`)
          : "开一个新 tab，apply 指令贴进输入框——确认后回车开工（会改文件）")
        : (whenVerify
          ? "开一个新 tab，检查指令贴进输入框——确认后发送（只读，出分级报告）；不想验证可直接点旁边的归档"
          : "开一个新 tab，归档指令贴进输入框——确认后发送，claude 按归档指令收尾"))
      .on_mouse_down("left", (_e, c) => c.stop_propagation())
      .on_click((_e, c) => {
        c.stop_propagation();
        if (whenRun) {
          if (blocked) return;
          this.startAgent("apply", item, c);
        } else if (whenVerify) {
          this.startAgent("verify", item, c);
        } else if (whenArchive) {
          this.startAgent("archive", item, c);
        }
      })
      .child(icon(whenRun ? "play" : whenVerify ? "check" : "archive", 11, disabled ? t.dim : (t.accent_foreground ?? t.background)))
      .child(whenRun ? `执行 ${item.total - item.done} 项` : whenVerify ? "验证" : "归档");

    return h_flex().flex_none().w_full().h(44).px(10).gap(6).items_center()
      .border_t(1).border_color(t.border).bg(t.raised)
      .child(ghost("specs-explore", "探索", "sparkle", (c) => this.startAgent("explore", item, c),
        "开一个新 tab，指令贴进输入框、不回车——补充上下文后自己发送（不改文件）"))
      // 这条已经有人在跑：不再给「执行」，免得点出第二个 agent 抢同一个 tasks.md。
      // 归档/验证不受同仓库互斥限制（完成后的 agent 是 idle，不算在跑）。
      .when((open && !mine) || done, (e) => e.child(primary))
      // 验证是可选动作：没验证（或标记过期）时归档以描边出现，随时可跳过。
      .when(done && !verified, (e) => e.child(ghost("specs-archive", "归档", "archive", (c) => this.startAgent("archive", item, c),
        "跳过验证直接归档：归档指令贴进输入框，确认后发送")))
      .child(div().flex_1())
      // 复制指令是退路：没有 claude、或想换别的 agent，粘一句就能走。
      .child(h_flex().id("specs-copy-prompt").h(24).w(22).flex_none().rounded(5).items_center()
        .justify_center().cursor_pointer().tooltip("复制这句指令，粘给任意 agent")
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, c) => c.stop_propagation())
        .on_click((_e, c) => {
          c.stop_propagation();
          this.copyPrompt(item, c);
        })
        .child(icon("copy", 12, t.dim)))
      .when(Boolean(mine), (e) => e.child(h_flex().id("specs-focus-agent").h(24).px(8).gap(4).flex_none()
        .items_center().rounded(6).cursor_pointer().text_size(12)
        .bg(`${mine.status === "blocked" ? (t.blocked ?? t.dim) : t.accent}1f`)
        .text_color(mine.status === "blocked" ? (t.blocked ?? t.dim) : t.accent)
        .tooltip(`${mine.app ?? "agent"} · ${mine.tab_name}`)
        .hover((s) => s.opacity(0.85))
        .on_mouse_down("left", (_e, c) => c.stop_propagation())
        .on_click((_e, c) => {
          c.stop_propagation();
          this.focusAgent(mine, c);
        })
        .child(mine.status === "blocked" ? "等你回答 ›" : "已在跑 ›")));
  }

  /** 把这一句指令放进剪贴板：没有 claude、或贴入失败、或想换 agent 时用。 */
  copyPrompt(item, cx, prompt) {
    this.handle.focus();
    cx.write_to_clipboard(prompt ?? promptFor("apply", item.name));
    this.note = "指令已复制，粘给任意 agent 就行";
    cx.notify();
  }

  /** 刚点过、还在等 tab 出现：agent 起来并回报状态要几秒，这期间不让再点。 */
  busy(item) {
    return Boolean(this.pending && this.pending.dir === item.dir && Date.now() < this.pending.until);
  }

  /**
   * 开一个新 tab，让 agent 上手。
   *
   * 设计原则：spec 上的一切操作（探索/执行/归档）都经过 LLM——面板只开 tab、送指令、
   * 看状态，判断活全部交给 agent 按 OpenSpec 的 instructions 执行。
   *
   * 走 `run("tab.new")`：Herdr 自己开 tab、自己起终端，点击后立刻可见——试过 `hc run --bg`
   * 自己起终端再补 `herdr.space` 标签，Herdr 只收它认识的标签，差一点终端就上不了屏，
   * 看起来像点了没反应。`tab.new` 的 name 直接就是 tab 名（`hc run --name` 只给终端起名、
   * tab 名还是数字）。
   *
   * 统一的开工方式（用户要求）：四种动作都不带 task——claude 就绪（第一次回报状态）
   * 后，用括号粘贴把指令放进它的输入框、**不回车**，由用户确认/补充后自己发送。
   * 会不会改文件交给指令内容与用户把关，面板只负责把话送到。见 pasteWhenReady。
   *
   * 终端地址要等新 tab 真出现才有，归属标签随后贴（labelNew）：贴上 `openspec.change`
   * 之后，「已在跑 ›」和同仓库互斥才认得它。
   */
  async startAgent(kind, item, cx) {
    if (this.busy(item)) return;
    const other = busyElsewhere(item, tagAgents(agents(), terminals()));
    if (other) {
      this.note = `${other.tab_name} 正在跑，同一个仓库同时只跑一个`;
      notify({
        title: "已经有变更在执行",
        body: `${other.tab_name}（${other.status === "blocked" ? "在等你回答" : "进行中"}）`,
      });
      cx.notify();
      return;
    }
    const word = kind === "explore" ? "探索" : kind === "archive" ? "归档" : kind === "verify" ? "验证" : "执行";
    // 指令先行算好：贴进输入框、退回剪贴板，用的都是同一份。
    // 验证的结论也要经过 LLM 落盘：任务里附上写 .verify.json 的命令，面板靠它亮「已验证」。
    const prompt = kind === "verify"
      ? `${promptFor("verify", item.name)}\n\n全部检查完成后，执行下面这条命令把结论写进变更目录（面板靠它显示「已验证」标记，不写等于验证没发生；verdict 填 pass 或 fail——还有 CRITICAL 或 WARNING 就是 fail，SUGGESTION 不算）：\n\n${verdictWriteCmd(this.root, item.name)}`
      : promptFor(kind, item.name);
    // 探一次 claude 在不在：不在就别开一个空 tab 给人看，直接把指令放剪贴板。
    if (this.hasClaude === null) {
      const probe = await exec("claude", ["--version"], { cwd: this.root, timeout: 8000 }).catch(() => null);
      this.hasClaude = Boolean(probe && probe.code === 0);
    }
    if (!this.hasClaude) {
      this.note = "没找到 claude，已把指令复制到剪贴板";
      this.copyPrompt(item, cx, prompt);
      return;
    }
    const space = focused()?.space ?? spaces().find((s) => s.active)?.id ?? null;
    if (!space) {
      this.note = "没找到当前 space，先切到一个 space 再启动";
      cx.notify();
      return;
    }

    const taken = spaces().flatMap((s) => s.tabs.map((tab) => tab.name));
    const name = tabNameFor(item.name, taken);
    this.pending = { dir: item.dir, until: Date.now() + 15000 };
    const before = new Set(terminals().map((t) => t.address));
    // 四种动作一律不带 task：指令贴进输入框、不回车——由用户确认后自己发送。
    // 会不会改文件由指令内容与用户把关，面板只负责把话送到。
    run("tab.new", { name, space, folder: this.root, argv: ["claude"] });
    this.note = `${word}已开新 tab：${name}，指令贴进输入框，确认后回车`;
    notify({ title: `${word}已开新 tab`, body: `${item.name} · 指令在输入框里，补充/确认后回车` });
    this.pasteWhenReady(before, item, cx, prompt, word);
    this.labelNew(before, item.name, kind, cx);
    cx.notify();
  }

  /**
   * 等新终端出现、claude 第一次回报状态（=界面就绪）后，把指令括号粘贴进
   * 它的输入框，不按回车——用户要先看过/补充过，自己发送。20 秒内等不到
   * （或贴不进去）就退回剪贴板，不让人干等。
   */
  pasteWhenReady(before, item, cx, prompt, word, tries = 50) {
    cx.timer.after(400, (c) => {
      const pane = panes().find((p) => p.terminal && !before.has(p.terminal));
      const agent = pane && agents().find((a) => a.address === pane.terminal);
      if (pane && agent && agent.status) {
        // 界面刚画完，给它稳一稳再贴，不然括号粘贴可能撞上重绘。
        c.timer.after(600, () => {
          this.pastePrompt(pane.terminal, prompt)
            .then((ok) => {
              if (ok) {
                this.note = "指令已贴进输入框：确认/补充后自己回车";
                notify({ title: `${word}指令就绪`, body: "指令在 claude 输入框里，确认后回车发送" });
              } else {
                this.note = "贴不进输入框，指令已复制，粘给 claude";
                c.write_to_clipboard(prompt);
              }
              c.notify();
            })
            // 贴入链路的任何异常都不能静默：剪贴板是最后的退路。
            .catch(() => {
              this.note = "贴入出了错，指令已复制，粘给 claude";
              c.write_to_clipboard(prompt);
              c.notify();
            });
        });
      } else if (tries > 1) {
        this.pasteWhenReady(before, item, c, prompt, word, tries - 1);
      } else {
        this.note = "claude 没就绪，指令已复制，粘给它";
        c.write_to_clipboard(prompt);
        c.notify();
      }
    });
  }

  /** 按目标终端的行列数贴入（尺寸对上，claude 才不会跳一下重绘）。失败返回 false。 */
  async pastePrompt(address, text) {
    try {
      const got = await hc(["get", address, "--json"]);
      const size = JSON.parse(got.stdout || "{}");
      const r = await exec("sh", ["-c", PASTE, "sh", address, String(size.rows), String(size.cols), text]);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  /**
   * `tab.new` 不打自定义标签：等新终端出现（panes 里多出来的那个）再把归属贴上。
   * 「已在跑 ›」、同仓库互斥都靠 `openspec.change` 这个标签认人，贴上之前有
   * 15 秒的 pending 兜底，不怕连点。
   */
  labelNew(before, change, kind, cx, tries = 20) {
    cx.timer.after(300, (cx) => {
      const pane = panes().find((p) => p.terminal && !before.has(p.terminal));
      if (pane) {
        hc(["label", pane.terminal, `openspec.change=${change}`, `openspec.kind=${kind}`]);
      } else if (tries > 1) {
        this.labelNew(before, change, kind, cx, tries - 1);
      }
    });
  }

  /** 切到已经在跑的那个 tab。 */
  focusAgent(agent, cx) {
    this.handle.focus();
    run("pane.focus", agent.pane ? { pane: agent.pane } : { terminal: agent.address });
    this.note = `已切到 ${agent.tab_name}`;
    cx.notify();
  }

  /** 状态胶囊上的字：规格与归档不是 change 的三个状态之一，单独给。 */
  statusLabel(item) {
    if (item.kind === "spec") return "规格";
    if (item.kind === "archived") return "归档";
    return STATUS_LABEL[item.status] ?? "";
  }

  /** 这一份产物在项目里的路径，显示在标题下面，切页签时跟着变。 */
  docFile(item) {
    const id = this.doc;
    if (!id) return "";
    if (item.kind === "spec") return `specs/${item.name}/spec.md`;
    if (id === "specs") return item.artifacts?.specs?.[0] ?? "specs/";
    return { proposal: "proposal.md", design: "design.md", tasks: "tasks.md" }[id] ?? "";
  }

  /** 详情页顶上的数字块：上面一个大数，下面一行说明。 */
  tile(value, label, t) {
    return v_flex().flex_1().min_w(0).px(10).py(6).gap(1).rounded(8).border_1().border_color(t.input)
      .child(div().font_semibold().text_size(16).text_color(t.foreground).child(value))
      .child(div().text_size(11).text_color(t.muted).child(label));
  }

  /**
   * 正文：按块排。
   *
   * 块的外壳（标题行、需求行、场景条、横线、引用缩进）由我们画，块里的原文照旧交给
   * TextView.markdown 去排——粗体、行内代码、表格、任务列表都还是它原生的样子，我们只是
   * 把一张大文本拆成一段段可控的块。滚动也因此提到外层，整篇只有一条滚动条。
   */
  docBody(t, item) {
    const blocks = attachCounts(parseBlocks(this.docText));
    const key = `${idKey(item.dir)}-${idKey(this.doc)}`;
    if (!blocks.length) {
      return v_flex().flex_1().p(12).child(div().text_size(13).text_color(t.dim).child("这份文档是空的。"));
    }
    return v_flex().flex_1().min_h(0).relative()
      .child(v_flex().id(`specs-doc-${key}`).absolute().inset_0().overflow_y_scroll()
        .px(12).pt(10).pb(18).gap(8)
        .children(blocks.map((block, i) => this.block(block, t, `specs-blk-${key}-${i}`, blocks[i - 1]))))
      .child(Scrollbar.vertical(`specs-doc-${key}`).absolute().inset_0());
  }

  /** 一块。`prev` 用来判断块之间要不要贴紧（场景下面的 WHEN/THEN 就该缩进着贴上去）。 */
  block(b, t, id, prev) {
    const underScenario = prev?.kind === "scenario";
    if (b.kind === "requirement") {
      return h_flex().flex_none().w_full().gap(7).items_center().pt(8)
        .child(this.chip(t, "需求", t.ansi5 ?? t.accent))
        .child(div().min_w(0).truncate().font_semibold().text_size(14).text_color(t.foreground).child(b.name));
    }
    if (b.kind === "scenario") {
      // 场景是需求的下一层：一条淡底的小横条，比用标题更省地方，也一眼看出是 WHEN/THEN。
      return h_flex().flex_none().w_full().mt(1).px(8).py(5).rounded(6).gap(6).items_center()
        .bg(t.raised).border_l(2).border_color(t.dim)
        .child(div().flex_none().text_size(11).text_color(t.dim).child("场景"))
        .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(b.name));
    }
    if (b.kind === "heading") {
      if (b.level === 1) return div().flex_none().pt(2).font_semibold().text_size(18).child(b.text);
      if (b.level === 2) {
        // 二级标题右侧挂这一节的数：3 个需求 / 2 个场景，扫一眼知道多重。
        const counts = b.counts;
        const hasReq = (counts?.requirements ?? 0) > 0;
        const hasSce = (counts?.scenarios ?? 0) > 0;
        return h_flex().flex_none().w_full().items_center().gap(6).pt(12).pb(5)
          .border_b(1).border_color(t.border)
          .child(div().min_w(0).truncate().font_semibold().text_size(16).text_color(t.foreground).child(b.text))
          .child(div().flex_1())
          .when(hasReq, (e) => e.child(this.chip(t, `${counts.requirements} 需求`, t.ansi5 ?? t.accent)))
          .when(hasSce, (e) => e.child(this.chip(t, `${counts.scenarios} 场景`, t.ansi4 ?? t.accent)));
      }
      return div().flex_none().font_semibold().text_size(15).text_color(t.foreground).child(b.text);
    }
    if (b.kind === "hr") return div().h(1).flex_none().mt(2).bg(t.border);
    // 其余块交给 TextView 排原文；字号在这里定一次，免得段落和列表各排各的。
    const text = TextView.markdown(id, b.raw).selectable(true).scrollable(false).flex_none().text_size(14);
    if (b.kind === "quote") {
      return div().flex_none().pl(9).border_l(2).border_color(t.border).child(text);
    }
    // 场景下的 WHEN/THEN、需求下的 SHALL 句子都缩进一级：它们是上一条的正文，不是新的一节。
    if (b.kind === "list" && underScenario) return div().flex_none().pl(12).child(text);
    if (b.kind === "paragraph" && prev?.kind === "requirement") return div().flex_none().pl(12).child(text);
    return text;
  }

  /** 整份原文进剪贴板。块渲染把文本拆成了很多个元素，跨块选不中，整份拿走得有条捷径。 */
  copyDoc(cx) {
    cx.write_to_clipboard(this.docText);
    this.copiedDoc = true;
    cx.notify();
    cx.timer.after(1400, (cx) => {
      if (!this.copiedDoc) return;
      this.copiedDoc = false;
      cx.notify();
    });
  }

  /**
   * 原文模式：整篇当成一个 markdown 代码块交给 TextView。
   *
   * 这样既有等宽字体、又保留缩进，还能整篇选中复制；围栏长度按正文里最长的反引号串算，
   * 免得正文自带 ``` 把围栏提前关掉。
   */
  rawBody(t, item) {
    const key = `${idKey(item.dir)}-${idKey(this.doc)}`;
    const longest = Math.max(2, ...(this.docText.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    return v_flex().flex_1().min_h(0).child(div().size_full().pt(8).px(8).pb(8)
      .child(TextView.markdown(`specs-raw-${key}`, `${fence}md\n${this.docText}\n${fence}`)
        .selectable(true).scrollable(true)));
  }

  /** 小标签：需求、计数都用它，淡底同色字。 */
  chip(t, text, color) {
    return div().flex_none().px(5).py(1).rounded(4).bg(`${color}1f`)
      .text_size(11).text_color(color).child(text);
  }

  /** 这份产物还没生成时，正文位置放什么。
   *
   * Tip 块：淡底 + 左边一条实色、上面一行小标签、里面放能直接抄的
   * 命令。比原来把提示写成 markdown 斜体强——斜体和正文一个字号，看不出该拿它怎么办。
   */
  missing(t, item, name) {
    if (item.kind === "archived") {
      return v_flex().flex_1().p(14).child(div().text_size(13).text_color(t.dim).child(`这份已经归档，没有 ${name}。`));
    }
    return v_flex().flex_1().min_h(0).p(12).items_start()
      .child(v_flex().w_full().px(11).py(9).gap(6).rounded(8)
        .bg(`${t.accent}0f`).border_l(3).border_color(t.accent)
        .child(div().font_semibold().text_size(12).text_color(t.accent).child("还没生成"))
        .child(div().text_size(13).text_color(t.muted).child(`这份变更还没有 ${name}。在终端里跑下面这一行，agent 会按 schema 写出来。`))
        .child(v_flex().w_full().mt(1).px(8).py(6).rounded(6).border_1().border_color(t.input).bg(t.surface)
          .child(div().font_family(MONO).text_size(12).text_color(t.foreground).whitespace_normal()
            .child(`openspec instructions ${this.doc} --change ${item.name}`))));
  }

  /** 键帽：按键和动词分开，扫一眼就知道按什么，不用在一串文字里找。 */
  key(t, text) {
    return div().flex_none().px(4).py(1).rounded(4).border_1().border_color(t.input)
      .bg(t.surface).text_size(11).text_color(t.muted).child(text);
  }

  footer(t) {
    const hints = this.typing
      ? [["esc", "清空"], ["↑↓", "选择"], ["enter", "打开"]]
      : this.query
        ? [["/", "继续输入"], ["esc", "清空"]]
        : this.sel
          ? [["esc", "返回"], ["←→", "产物"], ["m", "原文"]]
          : [["↑↓", "选择"], ["/", "搜索"], ["f", "过滤"], ["z", "折叠"]];
    const keys = this.note
      ? [div().min_w(0).truncate().child(this.note)]
      : hints.flatMap(([k, verb]) => [this.key(t, k), div().flex_none().child(verb)]);
    return h_flex().h(26).flex_none().px(10).gap(6).items_center().border_t(1).border_color(t.border).text_size(12).text_color(t.dim)
      .children(keys)
      .child(div().flex_1())
      .child(div().flex_none().child(`v${VERSION}`));
  }
}
