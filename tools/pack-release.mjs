#!/usr/bin/env node
/**
 * 打包发布产物：releases/*.tgz + releases/*.zip
 *
 * ⚠️ 为什么不用 PowerShell 的 `Compress-Archive` 生成 zip：
 * 它把条目名写成 **Windows 反斜杠**（`plugin\lib\client.js`），
 * macOS / Linux 解压后拿到的不是目录树，而是 19 个文件名里带 `\` 的平铺文件。
 * 这个缺陷藏了很久（0.1.1 的 zip 也有），直到有人在 Mac 上实测才暴露。
 * 现在统一用 Node 手写 zip 条目，**条目名一律 POSIX 正斜杠**。
 *
 * 用法：
 *   node tools/pack-release.mjs            # 打包当前版本
 *   node tools/pack-release.mjs --check    # 只校验已有产物，不重新打包（CI 用）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";

/** 跨 Node 版本安全的删除（rmSync 在 Node 14.14+ 才有，这里只是给个名字好读）。 */
const rmSyncCompat = (p) => rmSync(p, { force: true });

// ⚠️ 必须用 fileURLToPath，不能手写 `.pathname`：
// pathname **不做百分号解码**，路径里只要有空格就会变成 `%20`，
// 后面所有 readFileSync 全部 ENOENT。实测仓库放到 "/tmp/pkg space" 就直接挂。
// 这条尤其要紧 —— DSH 自己就装在 `/Applications/DeepSeek Harness.app` 这种带空格的路径里。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHECK_ONLY = process.argv.includes("--check");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const TGZ_NAME = `dsh-balance-mini-${VERSION}.tgz`;
const ZIP_NAME = `dsh-balance-mini-${VERSION}.zip`;
const RELEASES = join(ROOT, "releases");

let pass = 0;
let fail = 0;
const ck = (ok, label, extra) => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? "\u2713" : "\u2717"}  ${label}${extra ? "   " + extra : ""}`);
};

/** 递归列出文件，返回 POSIX 相对路径（**始终正斜杠**）。 */
function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

// ── 最小 ZIP 写入器（store + deflate，条目名 POSIX 正斜杠）──
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(entries, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0; // 用固定时间戳，保证可重复构建
  const dosDate = (1 << 5) | 1; // 1980-01-01

  for (const { name, data } of entries) {
    // ⚠️ 这里就是修复点：name 必须是 POSIX 路径，绝不能出现反斜杠
    if (name.includes("\\")) throw new Error(`条目名含反斜杠，会在 macOS/Linux 上丢失目录结构: ${name}`);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名的 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 36); // 外部属性
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, end]));
}

// ── 组装 zip 内容：plugin/ + tgz + 三份中文文档 ──
const ZIP_INCLUDE = listFiles(ROOT).filter(
  (f) =>
    !f.startsWith("releases/") &&
    !f.startsWith(".git/") &&
    !f.startsWith(".github/") &&
    f !== ".gitignore" &&
    f !== "QUICKSTART.md",
);

if (!CHECK_ONLY) {
  mkdirSync(RELEASES, { recursive: true });
  console.log(`  打包 ${VERSION} …`);

  // ⚠️ 先清掉 releases/ 里**其它版本**的产物。
  // 不清的话，releases/ 会同时躺着 0.10.4 和 0.10.5 两份，
  // 而"包内 README 引用的 tgz 版本号"这类断言是按**当前版本**比的 ——
  // 旧产物不会让它失败，只会静静留在仓库里误导人（这个坑踩过两次）。
  if (existsSync(RELEASES)) {
    for (const f of readdirSync(RELEASES)) {
      if (f.startsWith("dsh-balance-mini-") && f !== TGZ_NAME && f !== ZIP_NAME) {
        rmSyncCompat(join(RELEASES, f));
        console.log(`    （清掉旧产物 ${f}）`);
      }
    }
  }

  // ① tgz：交给 npm pack（它写的是标准 tar，路径天然是 POSIX）
  //
  // ⚠️ 定位 npm：三条路都要覆盖，否则这个"修跨平台问题"的工具自己只能在 Windows 上跑。
  //   · npm_execpath        只有"由 npm 脚本调用"时才有，直接 node tools/… 时是空的
  //   · Windows             全局安装是 <prefix>\node_modules\npm\bin\npm-cli.js
  //   · macOS / Linux       全局安装是 <prefix>/lib/node_modules/npm/bin/npm-cli.js
  //     ⚠️ POSIX 上多一层 `lib` —— 之前只试了不带 lib 的路径，导致 Mac 上直接报
  //        "npm pack 失败"，而 --check 不依赖 npm 所以 CI 一直是绿的，掩盖了这个缺口。
  const nodeDir = dirname(process.execPath);
  const npmCandidates = [
    process.env.npm_execpath,
    // 与本机 node 同级（Windows 布局）
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    // POSIX 布局：<prefix>/lib/node_modules/npm/bin/npm-cli.js
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // 再往上一层（某些发行版把 npm 放在 <prefix>/lib 而 node 在 <prefix>/bin）
    join(nodeDir, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // 本机实测的 Windows 路径
    "F:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  ].filter(Boolean);

  let packed = false;
  let lastErr = "";
  for (const npmCli of npmCandidates) {
    if (!existsSync(npmCli)) continue;
    try {
      execFileSync(process.execPath, [npmCli, "pack", ROOT, "--pack-destination", RELEASES], { stdio: "pipe" });
      packed = true;
      console.log(`    （用 ${npmCli}）`);
      break;
    } catch (e) {
      lastErr = String(e.stderr ?? e.message).slice(0, 200);
    }
  }

  // 候选路径都不行时，最后试一次 PATH 里的 npm（npm_execpath 为空、且装在非标准位置时）
  if (!packed) {
    try {
      execFileSync("npm", ["pack", ROOT, "--pack-destination", RELEASES], { stdio: "pipe", shell: process.platform === "win32" });
      packed = true;
      console.log("    （用 PATH 里的 npm）");
    } catch (e) {
      lastErr = String(e.stderr ?? e.message).slice(0, 200);
    }
  }

  if (!packed) {
    console.log("  ✗ npm pack 失败，无法生成 tgz");
    if (lastErr) console.log("    " + lastErr.split("\n")[0]);
    console.log("    候选路径都试过了：" + npmCandidates.join(" | ") + " | PATH 里的 npm");
    process.exit(1);
  }
  const tgzPath = join(RELEASES, TGZ_NAME);
  if (existsSync(tgzPath)) console.log(`  ✓ ${TGZ_NAME}`);
  else { console.log(`  ✗ ${TGZ_NAME} 未生成`); process.exit(1); }

  // ② zip：手写，条目名正斜杠
  const prefix = `dsh-balance-mini-${VERSION}`;
  const entries = [];
  for (const f of ZIP_INCLUDE) {
    entries.push({ name: `${prefix}/${f}`, data: readFileSync(join(ROOT, f)) });
  }
  // 三份中文文档（放在 zip 顶层，方便直接看）
  const docs = [
    ["QUICKSTART.md", "快速上手.md"],
    ["CHANGELOG.md", "更新记录.md"],
    ["INSTALL.md", "安装说明.md"],
  ];
  for (const [src, dst] of docs) {
    if (existsSync(join(ROOT, src))) {
      entries.push({ name: `${prefix}/${dst}`, data: readFileSync(join(ROOT, src)) });
    }
  }
  entries.push({ name: `${prefix}/${TGZ_NAME}`, data: readFileSync(tgzPath) });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

  writeZip(entries, join(RELEASES, ZIP_NAME));
  console.log(`  ✓ ${ZIP_NAME}（${entries.length} 个条目）`);
  console.log("");
}

// ── 校验（--check 时只做这一步）──
console.log(`  校验 v${VERSION} 的发布产物`);

const tgzPath = join(RELEASES, TGZ_NAME);
const zipPath = join(RELEASES, ZIP_NAME);
ck(existsSync(tgzPath), `${TGZ_NAME} 存在`);
ck(existsSync(zipPath), `${ZIP_NAME} 存在`);

if (existsSync(tgzPath)) {
  const tmp = join(process.env.TEMP ?? "/tmp", `pkgchk-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  execFileSync("tar", ["-xzf", tgzPath, "-C", tmp]);
  const P = join(tmp, "package");

  const inPkg = JSON.parse(readFileSync(join(P, "package.json"), "utf8"));
  ck(inPkg.version === VERSION, "tgz 内 package.json 版本与仓库一致", inPkg.version);

  for (const f of ["lib/client.js", "lib/index.js", "lib/holidays.js", "README.md", "CHANGELOG.md", "INSTALL.md"]) {
    const a = createHash("sha256").update(readFileSync(join(P, f))).digest("hex");
    const b = createHash("sha256").update(readFileSync(join(ROOT, f))).digest("hex");
    ck(a === b, `tgz 内 ${f} 与仓库逐字节一致`);
  }

  // ⚠️ 这条就是问题 6：包内 README 曾落后一个版本，照它操作会找不到文件
  const pkgReadme = readFileSync(join(P, "README.md"), "utf8");
  const refs = [...new Set([...pkgReadme.matchAll(/dsh-balance-mini-(\d+\.\d+\.\d+)\.tgz/g)].map((m) => m[1]))];
  ck(refs.length === 0 || refs.every((v) => v === VERSION),
    "tgz 内 README 引用的 tgz 版本号正确", refs.join(",") || "（未写死版本号）");

  // 包内文档不得再**声称** macOS / Linux 装不了。
  //
  // 判据演进（每一版都是被实际漏检逼出来的，留在这里避免退回）：
  //   ① 全文件 grep            → 把"更正引述"判失败（CI 抓到）
  //   ② 只扫表格行             → 漏掉散文里的结论（审计抓到）
  //   ③ 表格 + 散文**措辞白名单** → 同义改写全部绕过（审计用变异测试证明：
  //                              "待官方发布宿主后可用"、"官方无 macOS 构建" 都能过，
  //                              而前者当时**就写在仓库里**）
  //   ④ 现在：表格用语义、散文也用语义，两者强度对等
  //
  // ⚠️ 教训：**白名单式判据等于没有判据** —— 它只能防止"把原句改回去"，
  //    防不住任何换个说法的等价结论。判据要盯**语义**（平台名 + 否定词共现），
  //    而不是盯**我当初碰巧写的那几个字**。
  //
  // 例外：`>` 引用块豁免 —— 更正说明一律写在引用块里（本仓库既有写法），
  //      正文主张不会。这样"引用旧结论并纠正"不会被误判。
  // ⚠️ 否定模式也要写成"语义"而不是"枚举动词"。
  //    第一版写了 `无法安装`，结果 `无法使用` 就漏了（变异测试当场抓到）——
  //    同一个坑换个位置又踩了一次。所以这里用 `无法\S{0,4}` 覆盖任意动词，
  //    而不是逐个列 "安装/使用/运行/…"。
  const NEGATION = new RegExp(
    [
      "装不了",
      "不能装",
      "无法\\S{0,4}", // 无法安装 / 无法使用 / 无法运行 …
      "不可用",
      "不支持",
      "尚未",
      "未发布",
      "没有可安装",
      "无\\s?(?:macOS|Mac|Linux)",
      "(?:macOS|Mac|Linux)[^。\\n]{0,12}(?:没有|无|不存在)",
      "待[^。\\n]{0,8}后可用",
      "尚未提供",
      "暂不可",
      "不支持安装",
    ].join("|"),
  );
  const PLATFORM = /macOS|Linux|darwin|Mac 用户|Mac 上/;
  // 判据的**单一来源**就在这里。CI 不再内联一份重复实现 ——
  // 曾经两处并存，分叉后 CI 把 CHANGELOG / docs/audits 里"变异测试用例表格"
  // 中列出的**示例字符串**当成了违规（`| 散文加「官方无 macOS 构建…」 | ✓ 漏掉 |`）。
  // 教训与本节修的那条同源：**判据存在两处，就会有两套行为。**
  //
  // ⚠️ 扫描范围要分层，否则会把"记录错误"本身判成"主张错误"：
  //
  //   · 面向用户的文档（README / INSTALL / QUICKSTART）
  //       → 表格 + 正文都查。这些文档必须**只讲对的**。
  //   · 变更记录与审计档案（CHANGELOG / docs/audits）
  //       → **只查表格**。它们的天职就是复述曾经写错的话
  //         （"### H… INSTALL.md 仍在说 macOS「待…」" 这种标题必然命中否定词，
  //          但那是在**描述**问题，不是**主张**它）。
  //         文件级豁免太粗（会放过真问题），表格级判据够用且无歧义。
  const USER_FACING = ["README.md", "INSTALL.md", "QUICKSTART.md"];
  const RECORDS = ["CHANGELOG.md", "docs/audits/README.md"];
  for (const f of [...USER_FACING, ...RECORDS]) {
    const p = existsSync(join(P, f)) ? join(P, f) : join(ROOT, f);
    if (!existsSync(p)) continue;
    const proseChecked = USER_FACING.includes(f);
    const lines = readFileSync(p, "utf8").split("\n");

    let inFence = false;
    const offenders = [];
    for (const l of lines) {
      if (l.trim().startsWith("```")) { inFence = !inFence; continue; }
      if (inFence) continue;                        // 代码块里出现的示例不算
      if (l.trim().startsWith(">")) continue;        // 引用块 = 更正说明
      const isRow = l.trim().startsWith("|");
      if (isRow && /macOS/i.test(l) && /❌/.test(l)) { offenders.push(l); continue; }
      if (proseChecked && PLATFORM.test(l) && NEGATION.test(l)) offenders.push(l);
    }
    ck(offenders.length === 0,
      `${f} 的${proseChecked ? "表格与正文" : "表格"}不再声称 macOS/Linux 装不了`,
      offenders.length ? offenders[0].trim().slice(0, 70) : "");
  }
  execFileSync(process.execPath, ["-e", `require('node:fs').rmSync(${JSON.stringify(tmp)},{recursive:true,force:true})`]);
}

if (existsSync(zipPath)) {
  // 不依赖外部库，直接读 zip 的中央目录里的条目名
  const buf = readFileSync(zipPath);
  const names = [];
  const entryOffsets = [];
  for (let i = 0; i + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const nlen = buf.readUInt16LE(i + 28);
      names.push(buf.subarray(i + 46, i + 46 + nlen).toString("utf8"));
      // 本地头偏移在中央目录项的第 42 字节
      entryOffsets.push({ name: names[names.length - 1], localAt: buf.readUInt32LE(i + 42) });
    }
  }
  ck(names.length > 0, "zip 中央目录可解析", `${names.length} 个条目`);

  // ⚠️ 问题 1 的核心断言：非 Windows 解压后必须能得到目录树
  const backslash = names.filter((n) => n.includes("\\"));
  ck(backslash.length === 0, "zip 条目名不含反斜杠（macOS/Linux 才能解出目录树）",
    backslash.length ? `例如 ${backslash[0]}` : "");
  // ⚠️ zip 的结构是 `<prefix>/lib/index.js`（没有 plugin/ 这一层 —— 那层在 0.10.3 之前的旧包里）。
  // 断言要按实际结构写，别照抄旧包的样子。
  ck(names.some((n) => n.endsWith("/lib/index.js")), "zip 内存在 lib/index.js 层级路径（解压后是目录树）");
  ck(names.some((n) => n.endsWith("/tools/pack-release.mjs")), "zip 内含打包脚本（便于用户自己重打）");
  ck(names.some((n) => n.endsWith(".tgz")), "zip 内包含 tgz 安装包");
  ck(names.some((n) => n.endsWith("快速上手.md")), "zip 内含 快速上手.md");

  // ── zip 的**内容**也要比对，不能只查条目名 ──
  //
  // ⚠️ 否则"只重打了 tgz、忘了重打 zip"这种情况 --check 依然全绿，
  // 而 zip 里躺着旧代码和旧 tgz。上面几条只验证了结构，验证不了内容。
  const readEntry = (entry) => {
    // 本地文件头：30 字节固定 + 文件名长度 + 扩展区长度
    const nlen = buf.readUInt16LE(entry.localAt + 26);
    const elen = buf.readUInt16LE(entry.localAt + 28);
    const method = buf.readUInt16LE(entry.localAt + 8);
    const csize = buf.readUInt32LE(entry.localAt + 18);
    const dataAt = entry.localAt + 30 + nlen + elen;
    const raw = buf.subarray(dataAt, dataAt + csize);
    return method === 8 ? zlib.inflateRawSync(raw) : raw;
  };
  // 打包脚本自己写入的：deflate
  for (const f of ["lib/client.js", "lib/index.js", "lib/holidays.js", "package.json", "README.md", "INSTALL.md"]) {
    const entry = entryOffsets.find((e) => e.name.endsWith("/" + f));
    if (!entry) { ck(false, `zip 内含 ${f}`); continue; }
    const a = createHash("sha256").update(readEntry(entry)).digest("hex");
    const b = createHash("sha256").update(readFileSync(join(ROOT, f))).digest("hex");
    ck(a === b, `zip 内 ${f} 与仓库逐字节一致`);
  }
  // 内嵌的 tgz 必须与 releases/ 里那一份相同，否则用户从 zip 拿到的安装包是旧的
  const tgzEntry = entryOffsets.find((e) => e.name.endsWith(".tgz"));
  if (tgzEntry && existsSync(join(RELEASES, TGZ_NAME))) {
    const a = createHash("sha256").update(readEntry(tgzEntry)).digest("hex");
    const b = createHash("sha256").update(readFileSync(join(RELEASES, TGZ_NAME))).digest("hex");
    ck(a === b, "zip 内嵌的 tgz 与 releases/ 中的逐字节一致（防止只重打了一半）");
  }
  // zip 里的中文文档是打包时从仓库根复制的，也要比对
  for (const [src, dst] of [["QUICKSTART.md", "快速上手.md"], ["CHANGELOG.md", "更新记录.md"], ["INSTALL.md", "安装说明.md"]]) {
    const entry = entryOffsets.find((e) => e.name.endsWith("/" + dst));
    if (!entry) { ck(false, `zip 内含 ${dst}`); continue; }
    const a = createHash("sha256").update(readEntry(entry)).digest("hex");
    const b = createHash("sha256").update(readFileSync(join(ROOT, src))).digest("hex");
    ck(a === b, `zip 内 ${dst} == 仓库的 ${src}`);
  }
}

console.log("");
console.log("  " + "-".repeat(56));
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
