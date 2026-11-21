# herdr-spec

[Herdr](https://herdr.dev) 右侧面板里的一个 item：和 **Files**、**Changes** 并排的 **Specs**。变更按阶段分组，点一行进详情看 proposal / design / tasks / delta spec。数据直接读项目里的 `openspec/`，**不需要 WebView、不需要跑本地服务、不需要装任何 CLI**。

全部界面是 GPUI 原生绘制，所以它就像内置面板一样：共用同一栏宽度、共用右上角那组按钮、每个 space 各自记住选了哪个 item。

## 安装

Herdr 要开着，然后：

```bash
node scripts/install.mjs
```

它做四件事：

1. 把 `mods/herdr-spec` 复制到 `~/.config/herdr-app/mods/`；
2. 从官方 `mods/tabs` 生成 `mods/tabs-specs`——**只多一个 Specs 按钮**，其余原样；
3. 从官方 `main` 版面生成 `layouts/specs.json`：右侧面板加 `specs` 这个孩子，顶栏换成 `tabs-specs`；
4. 往 `keys.json` 写两行快捷键。

`keys.json` 改之前会备份成 `.bak-<时间>`。

```bash
node scripts/install.mjs --check       # mod、tabs 副本、版面是否都和当前 Herdr 同步
node scripts/install.mjs               # 全部重新生成
node scripts/install.mjs --no-layout   # 只更新 mod
node scripts/install.mjs --uninstall   # 删 mod、tabs 副本、版面、快捷键
```

### 装到其他设备

1. 新机器上先装好 Herdr 并**启动一次**（它要生成 `~/.config/herdr-app/`，安装脚本靠它落点）；
2. 拿到本仓库：`git clone <你的仓库地址>`（或直接把整个目录拷过去，含 `node_modules` 与否皆可——依赖只有 Node 内置模块）；
3. `node scripts/install.mjs`（需要 Node ≥ 18，macOS 自带或 `brew install node`）；
4. 重启 Herdr（或等 mod 热重载），`Cmd+Shift+S` 呼出 Specs 面板；
5. 更新时把仓库拉到最新再跑一次 `node scripts/install.mjs`，`--check` 可先看是否需要。

面板读的是**各项目自己的** `openspec/` 目录，没有全局状态要迁移；在新设备上打开同一个项目目录即可看到同样的看板。

### 为什么要复制一份 tabs

官方 `mods/tabs/main.js` 末尾把面板按钮写死了，只有两行：

```js
.when(enabled.includes("files"), …)
.when(enabled.includes("changes"), …)
```

`shared("workspace.panels")` 只决定这两颗显不显示，不是通用列表；给 stack 加 `header: "tabs"` 也不会画出可点的条目（实测没有反应，而且 tabs 会按 space 把选中项改回去）。所以想让 Specs 和它们平级，只能拿一份副本补一行按钮。

代价是这份副本不跟 Herdr 升级：**升级后重跑 `node scripts/mod-tabs.mjs`**。它每次都从当前官方文件重新生成，找不到那两行锚点就报错停下（而不是悄悄用旧代码）：

```
官方 tabs 的代码变了，这个补丁对不上：
  找不到：.when(enabled.includes("changes"), …)
```

## 用法

- 右上角 **Files / Changes / Specs** 三颗按钮：点一下显示对应面板，再点一下收起。
- 别的版面按 `⌘⇧S` → 切到 `specs` 版面（默认停在 Specs）；在 `specs` 版面再按一次收起整栏。
- `⌘⇧L` → 在 `main` 和 `specs` 之间切换。
- 拖动栏的左边界改宽度，Files / Changes / Specs 共用这个宽度。

## 项目怎么定

面板自己不绑目录，按顺序**逐个尝试**：

1. 打开时传的 `props.root`
2. **终端的实时目录**（`cd` 之后跟着变；面板自己有焦点时取当前 tab 里那个终端）
3. 当前 space 的文件夹（只有在拿不到终端目录时才用）

拿到起点后**向上走**，第一个含 `openspec/changes` 的目录就是项目根。

终端所在目录不是项目时**不会偷偷回退**到 space 的项目——那样 `cd` 完面板还显示旧数据，看着像没反应。现在会明确写出「该目录不是规格项目」，并给一个「打开 space 项目」的入口。

因此：

- 在仓库子目录里也能找到项目；
- 在终端里 `cd` 到另一个项目，面板会跟过去（没有文件事件，靠每 4 秒一次的内存比对发现；点一下面板会立刻刷新）；
- `cd` 到没有规格的目录（如 `~/Downloads/RTLTextDemo`）时显示空状态，而不是留着你上一个项目；
- 切 space 就换项目，面板自动刷新；
- 只认 `openspec/`（含 `changes/` 子目录），其它格式一律当「不是规格项目」；
- **远端 space 也能读**：`spaces()[i].machine` 非空时，列目录和读文件都带 `on: <machine>` 走 herdr-core，不需要在本地挂载那台机器的磁盘。远端没有本地目录可监视，改用 20 秒计时刷新。

面板收起、或切到 Files / Changes 时，它知道自己是隐藏的，会停掉读盘和文件监视（只记一笔"回来要重读"），符合说明书里"隐藏的副本计时器照跑，所以要轻"的要求。

## 界面

面板通常 370–400px，所以列表和详情共用同一块区域：点一行进详情，`‹ 返回` 或 `Esc` 回到列表。

- **顶栏**：`Specs`、schema（`openspec/config.yaml` 里的那一行）、当前项目路径、任务总数、刷新。
- **列表**：一张张卡片，卡片标题是状态图标（进行中 ⚡ / 无任务 ○ / 已完成 ✓ / 归档 🗃 / 规格 📄）加计数。行里依次是组内序号、变更名、产物数（不满 4 个时显示 `产物 n/4`）、任务数与进度条、提案摘要，行尾一颗复制目录路径的按钮。
- **搜索**：`/` 或点顶栏的放大镜，敲几个字符按名字过滤（变更、归档、规格一起过），`↑↓` 选、`enter` 打开、`esc` 清空。输入态下 `f`/`z`/`m` 这些快捷键让位给文字。
- **折叠**：点卡片标题收起/展开；`z` 一键全收或全开；进项目时摊开「进行中」和「已完成」（它没有条目就摊开第一条有内容的），归档与规格收起。用 `f` 过滤到某一组时，那一组强制展开。
- **详情**：卡头是产物名、状态胶囊、`proposal.md` 这样的文件名与日期、两个数字块（任务/产物，看规格时换成需求/场景）、`‹ ›` 翻页；下面是带计数的页签和正文。还没有的产物页签是灰的，点开给一条能直接抄的 `openspec instructions` 命令。
- **正文**：先按块切分，再逐块排。块的外壳自己画——二级标题带分隔线与「3 需求 / 2 场景」计数、`### Requirement:` 变成「需求 标题」一行、`#### Scenario:` 变成淡底小横条、引用缩进一级；块里的原文仍交给 `TextView.markdown`，粗体、行内代码、表格、任务列表都还是原生的。滚动在外层，整篇只有一条滚动条。块内文字可以选中复制；要整篇复制或看原始 markdown，按 `m` 或点卡头那颗「原文」开关（按下有蓝底）。卡头还有一颗复制按钮，一次把整份放进剪贴板。
- **操作栏**：变更的详情卡底部有一条固定栏（不随正文滚动）。用视觉重量区分用途——**实心 = 当前状态建议的下一步**：还剩任务是 `执行 N 项`（accent 填充），全部勾完流转成 `验证`（对照文档做完整性/正确性/一致性三维度只读检查，出 CRITICAL/WARNING/SUGGESTION 分级报告）；**验证通过后「验证」按钮消失**，Tasks 页签的计数左侧亮一颗绿钩 ✓，实心流转成 `归档`（按 `openspec instructions archive` 做文档修正、合并与 spec 同步，最后执行 openspec archive），这类判断活不留给面板。**验证是可选动作**：没验证时归档以描边出现、随时可跳过；验证之后变更内容又改过的话，绿钩熄灭、「验证」按钮重新出现（陈旧判定按变更目录文件时间），但不拦归档。`探索`（accent 描边淡底）未归档的变更一直在——规格会持续完善、任务也可能补充。右边一组是**管理**类：复制图标把指令放进剪贴板（换别的 agent 也能用）；agent 在跑的变更显示 `已在跑 ›`（在等你回答时是琥珀色的 `等你回答 ›`），点一下切过去。
- **列表页快捷按钮**：变更的每一行底部放小按钮——`探索`（描边）+ 当前的承诺动作（`执行 N 项`，或全部勾完后的 `验证` / `归档`），实心永远给建议的下一步；**验证通过后「验证」按钮消失**，行内任务数徽章（如 `3/3`）左侧亮绿钩 ✓。每行只放建议的下一步：不进详情页就能启动项目。两页的动作、守卫（15 秒防重复、没装 claude 转复制、同仓库互斥）完全同一套。
- **验证标记的存放**：验证结论由验证 agent 写进**当前工程的变更目录**（`openspec/changes/<变更名>/.verify.json`，OpenSpec 不认识它、validate 实测不报错）。跟着工程走：watchFolder 为它触发自动刷新，远端 space 同样生效，归档时验证记录随变更一起进 archive/ 保留。
- **底栏**：键帽样式的操作提示与版本号（`v<VERSION>`，见下节）。

键位（点一下面板拿到焦点后）：

| 键 | 作用 |
|---|---|
| `↑` `↓` 或 `k` `j` | 列表里移一行 |
| `Enter` 或 `→` | 打开详情 |
| `Esc` | 详情里返回列表；列表里清除过滤；都没有时把焦点交给左边的终端 |
| `←` `→` 或 `h` `l` | 详情里换文档页签 |
| `m` | 详情里切换「按块排版 / 原文」 |
| `/` | 按名字搜索（`esc` 清空） |
| `f` 或 `Tab` | 循环切换阶段过滤 |
| `r` | 重新读盘 |

## 让 agent 上手

**面板上的一切操作（探索 / 执行 / 验证 / 归档）都经过 LLM**：面板只负责开 tab、送指令、看状态；写文档、改代码、归档前的合并与同步，这些判断活全部交给 agent 按 OpenSpec 的 instructions 执行，面板自己从不跑会改文件的命令。

**设计原则：spec 上的一切操作都经过 LLM。** 探索、执行、归档——面板只负责开 tab、送指令、看状态；写文档、改代码、归档前的文档修正与 spec 同步，这些判断活全部交给 agent 按 OpenSpec 的 instructions 执行。面板自己从不跑会改文件的命令。

操作栏只对「还做得动」的变更出现：已完成的（未归档）给探索与归档，归档后的整条不画；远端 space 这一版也不画（`hc run --on` 的 cwd 与标签语义还没验过）。

点下去就开一个新 tab，claude 在里面跑（`run("tab.new")`）：

- `tab.new { name, space, folder, argv: ["claude"] }`——Herdr 自己开 tab、自己起终端，**点击后立刻可见**。不自己起终端：试过 `hc run --bg` 再补 `herdr.space` 标签，Herdr 只收带它的标签的终端，差一点就上不了屏，看起来像点了没反应。不带 task：指令由括号粘贴送进输入框（见下）。
- `tab.new` 的 `name` 直接就是 tab 名（`hc run --name` 只给终端起名，tab 名还是数字）；给 claude 的话只有一句「运行 `openspec instructions ... --change X` 并按它执行」——上下文由 OpenSpec 自己给，面板不复述。
- **四种动作一律不自动发送**：探索 / 执行 / 验证 / 归档开的 tab 都不带 task——等 claude 就绪（第一次回报状态）后，用括号粘贴把指令放进它的输入框、**不按回车**，由用户确认/补充后自己发送；会不会改文件交给指令内容与用户把关。括号粘贴走 `hc attach`（依赖 macOS 的 `script`），贴不进去就退回剪贴板。
- **同仓库互斥**：已经有别的变更在跑（`working` / `blocked`）时不给执行。所有变更在一个 repo 里，两个 agent 并行必然互相踩文件。「探索」只读，不受这条限制。
- 归属按 `openspec.change` 标签认：`tab.new` 不打自定义标签，所以开完后轮询新终端、用 `hc label` 贴上，「已在跑 ›」和互斥靠它认人。贴上之前有 15 秒的防重复点击兜底。
- 本机没装 `claude` 时不开空 tab，直接把指令放进剪贴板。

## 版本号

右下角显示 `v<版本>`（`core.mjs` 的 `VERSION`）。从 **0.1.0** 开始：

- 小改动（按钮、文案、修 bug）：末位 +1（0.1.1、0.1.2…）
- 重构页面或内容结构：中位 +1（0.2.0、0.3.0…）

每次改动在提交时同步更新 `VERSION` 与这里的规则说明。

## Herdr 升级后

两个生成物都要重做：

```bash
node scripts/mod-tabs.mjs        # 顶栏副本（补丁对不上会报错，需要人工看一眼新版 tabs）
node scripts/layout.mjs          # specs 版面（把新 main 的结构带进来）
node scripts/install.mjs --check # 一次查三个
```

`layouts/specs.json` 是生成物，不是手改的副本。Herdr 每次启动会整份重写官方版面，而复制出来的副本归你、永远不会被合并——所以升级后重跑一次生成，把新 `main` 里的新节点带进来。

面板自己也会检查：`cloned_from.version` 与 `herdr-app --version` 不一致、且这个版本对还没提醒过时，会弹一次通知。

## 读哪些文件

| 文件 | 作用 | 面板怎么用 |
|---|---|---|
| `openspec/config.yaml` | **项目级**配置：`schema`、`context`、`rules`、`operations` | 只取 `schema` 显示在顶栏 |
| `openspec/changes/<名字>/.openspec.yaml` | **每个变更**自己的元数据：`schema`、`created`、`skip_specs` | 读 `created` 显示日期；四个页签恒定列出，文件在不在决定它是亮的还是灰的 |
| `openspec/changes/<名字>/{proposal,design,tasks}.md` | 变更正文 | proposal 首段做列表摘要，tasks 的 `- [x]` 算进度 |
| `openspec/changes/<名字>/specs/<能力>/spec.md` | delta 规格（可以有多份） | 都归在 `Specs` 页签下；多份时每份前面加一行 `# 能力名` |
| `openspec/specs/<能力>/spec.md` | 主规格（已归档的能力） | 列表底部的「规格」段 |

没有 `.meta.yaml` 这回事——OpenSpec 从不生成每变更元数据文件。`config.yaml` 也不是元数据：它不记录某个变更的状态，只规定这个项目用哪套 schema、agent 该遵守什么写作约束。

## 数据与兼容

- 状态判定与 `openspec list --json` 一致：`totalTasks = 0` → `no-tasks`；全勾 → `complete`；其余 → `in-progress`。注意 0/6 也算 `in-progress`（OpenSpec 就是这么算的），只有真的没有任务才算无任务。
- 产物固定四个，顺序与 `openspec status --change X` 相同：`proposal` → `specs` → `design` → `tasks`。
- 任务计数只认 `- [x]` / `- [ ]`，并跳过代码块里的示例清单。
- 摘要取 `## Why` 下第一段正文；没有就取第一段非标题文字。
- 每个变更的元数据只读 `openspec/changes/<名字>/.openspec.yaml`（`schema` / `created` / `skip_specs`），不读任何其它元数据文件。
- 项目级配置只取 `openspec/config.yaml` 的 `schema`；`context` / `rules` / `operations` 是给 agent 的写作约束，面板不展示。

## 不做

只读。勾任务、归档、`validate` 一律不做——会改文件。需要动手时，就在同 space 的终端里跑 `openspec` 命令或对应的技能。

## 目录

```
mods/herdr-spec/
  mod.json      声明（place: none，不自动停靠；focusable 让 pane.go 能把键盘给它）
  main.js       视图：列表 ⇄ 详情、键盘、刷新
  core.mjs      纯逻辑：阶段、计数、摘要、文档顺序（不碰 fs，可单测）
  read.mjs      取数：shell 列目录 + readTextFile 读内容
  specs.svg     顶栏按钮的图标
  icons/        分组标题的图标（闪电=进行中、圆圈=无任务、对勾=已完成、箱子=归档、文档=规格）
scripts/install.mjs   安装 / 校验 / 卸载
scripts/mod-tabs.mjs  生成 mods/tabs-specs（官方 tabs + 一个 Specs 按钮）
scripts/layout.mjs    生成 layouts/specs.json（面板加入 specs）
test/core.test.mjs    逻辑层测试
```

为什么列表用 shell 而不用 `fs/promises`：mod 里的 `fs` 只有读写文件，没有 `readdir`；一次 `sh -c` 就能把变更、归档、规格连同项目根一起拿到，还能顺带向上找根目录。

## 测试

```bash
npm test
```

只测 `core.mjs`（纯函数），不需要 Herdr。界面靠 `herdr-app check mods/herdr-spec` 做类型与加载检查。

## 来源

本仓库是独立实现：一个 Herdr mod（GPUI 原生绘制）+ 一个纯逻辑模块，直接读取 OpenSpec 项目的目录与 delta spec 约定（`changes/`、`specs/`、`tasks.md` 的勾选语法、`.openspec.yaml`）。

> 早期版本是一个 React + Vite 的 Web 应用，已移除：Herdr 的 mod 不支持 HTML/CSS/WebView，那套代码在这里没有落点。需要时见 git 历史。
