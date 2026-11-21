// 取数层：只负责把磁盘上的东西读成字符串，交给 core.mjs 解析。
//
// 用 shell 列目录而不是 fs：mod 里的 `fs/promises` 只有读写文件，
// 没有 readdir；`find` 走一次 shell 就能拿到整棵树，还能顺带向上找项目根。
import { exec, readTextFile } from "herdr";

// 从当前目录往上找 openspec/，一次列出变更、每个变更的产物、归档、能力。
// 用 tab 分隔，避免名字里有空格时切错列。
//
// 行格式：
//   A  <变更名>                       一个变更
//   F  <变更名> <proposal.md|design.md|tasks.md>
//   G  <变更名> <specs/能力/spec.md>   一份 delta 规格
//   Z / ZF / ZG                       同上，用于 changes/archive/<日期-名字>/
//   S  <能力>                         主规格
const SCAN = String.raw`
d=$1
while [ -n "$d" ] && [ "$d" != "/" ]; do
  if [ -d "$d/openspec/changes" ]; then k=openspec; break; fi
  d=$(dirname "$d")
done
[ -z "$k" ] && exit 3
printf 'ROOT\t%s\n' "$d"
printf 'KIND\t%s\n' "$k"
for p in "$d/$k/changes"/*/; do
  [ -d "$p" ] || continue
  n=$(basename "$p")
  [ "$n" = archive ] && continue
  printf 'A\t%s\n' "$n"
  for f in proposal.md design.md tasks.md; do
    [ -f "$p/$f" ] && printf 'F\t%s\t%s\n' "$n" "$f"
  done
  for s in "$p"/specs/*/spec.md; do
    [ -f "$s" ] || continue
    c=$(basename "$(dirname "$s")")
    printf 'G\t%s\tspecs/%s/spec.md\n' "$n" "$c"
  done
done
for p in "$d/$k/changes/archive"/*/; do
  [ -d "$p" ] || continue
  n=$(basename "$p")
  printf 'Z\t%s\n' "$n"
  for f in proposal.md design.md tasks.md; do
    [ -f "$p/$f" ] && printf 'ZF\t%s\t%s\n' "$n" "$f"
  done
  for s in "$p"/specs/*/spec.md; do
    [ -f "$s" ] || continue
    c=$(basename "$(dirname "$s")")
    printf 'ZG\t%s\tspecs/%s/spec.md\n' "$n" "$c"
  done
done
for p in "$d/$k/specs"/*/; do
  [ -d "$p" ] || continue
  printf 'S\t%s\n' "$(basename "$p")"
done
if [ -f "$d/$k/config.yaml" ]; then
  v=$(sed -n 's/^schema:[[:space:]]*//p' "$d/$k/config.yaml" | head -1)
  [ -n "$v" ] && printf 'SCHEMA\t%s\n' "$v"
fi
`;

function blankArtifacts() {
  return { proposal: false, design: false, tasks: false, specs: [] };
}

function markArtifact(target, file) {
  if (file === "proposal.md") target.proposal = true;
  else if (file === "design.md") target.design = true;
  else if (file === "tasks.md") target.tasks = true;
}

/** 扫一个目录上方的项目。返回 null 表示这一路都没有 openspec/。 */
export async function scan(start, options = {}) {
  const r = await exec("sh", ["-c", SCAN, "specs", start], options).catch(() => null);
  if (!r || r.code !== 0) return null;
  const out = { root: "", kind: "", schema: "", changes: [], archived: [], specs: [] };
  const byKey = new Map();
  for (const raw of r.stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const [tag, ...rest] = line.split("\t");
    const value = rest.join("\t");
    if (tag === "ROOT") out.root = value;
    else if (tag === "KIND") out.kind = value;
    else if (tag === "SCHEMA") out.schema = value;
    else if (tag === "S") out.specs.push(value);
    else if (tag === "A" || tag === "Z") {
      const archived = tag === "Z";
      const entry = {
        name: value,
        dir: `${out.root}/${out.kind}/changes/${archived ? "archive/" : ""}${value}`,
        artifacts: blankArtifacts(),
      };
      byKey.set(`${tag}:${value}`, entry);
      (archived ? out.archived : out.changes).push(entry);
    } else if (tag === "F" || tag === "ZF") {
      const target = byKey.get(`${tag === "ZF" ? "Z" : "A"}:${rest[0]}`);
      if (target) markArtifact(target.artifacts, rest[1]);
    } else if (tag === "G" || tag === "ZG") {
      const target = byKey.get(`${tag === "ZG" ? "Z" : "A"}:${rest[0]}`);
      if (target && rest[1]) target.artifacts.specs.push(rest[1]);
    }
  }
  return out.root ? out : null;
}

/** 读三个文件，缺的当空串；`on` 让 Herdr 把这些文件纳入变化订阅。 */
export async function readChange(dir, options = {}) {
  const on = options.on;
  const [tasks, proposal, meta] = await Promise.all([
    readTextFile(`${dir}/tasks.md`, { on }).catch(() => ""),
    readTextFile(`${dir}/proposal.md`, { on }).catch(() => ""),
    readTextFile(`${dir}/.openspec.yaml`, { on }).catch(() => ""),
  ]);
  return { tasks: tasks ?? "", proposal: proposal ?? "", meta: meta ?? "" };
}

export async function readDoc(path, options = {}) {
  return (await readTextFile(path, options).catch(() => "")) ?? "";
}
