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
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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

  // ① tgz：交给 npm pack（它写的是标准 tar，路径天然是 POSIX）
  //
  // ⚠️ 定位 npm：`process.env.npm_execpath` 只有在"由 npm 脚本调用"时才存在，
  // 直接 `node tools/pack-release.mjs` 时是空的。所以要按几个候选依次找。
  const npmCandidates = [
    process.env.npm_execpath,
    // Windows 上 npm-cli.js 的常见位置（本机实测路径）
    "F:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    // 与当前 node 同级的 npm
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);

  let packed = false;
  let lastErr = "";
  for (const npmCli of npmCandidates) {
    if (!existsSync(npmCli)) continue;
    try {
      execFileSync(process.execPath, [npmCli, "pack", ROOT, "--pack-destination", RELEASES], { stdio: "pipe" });
      packed = true;
      break;
    } catch (e) {
      lastErr = String(e.stderr ?? e.message).slice(0, 200);
    }
  }
  if (!packed) {
    console.log("  ✗ npm pack 失败，无法生成 tgz");
    if (lastErr) console.log("    " + lastErr.split("\n")[0]);
    console.log("    候选路径都试过了：" + npmCandidates.join(" | "));
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

  // 包内文档不得再**声称** macOS 不可用。
  //
  // ⚠️ 断言必须能区分"主张"与"引用错误主张并纠正" —— 否则更正段落会把自己判失败。
  // 这里只查**表格行**（`| … | … |`）：真正的平台结论必然写在表格里，
  // 而"早先写过 macOS ❌，那是错的"这种内联引述不会以 `|` 开头。
  for (const f of ["README.md", "INSTALL.md", "QUICKSTART.md"]) {
    const p = existsSync(join(P, f)) ? join(P, f) : join(ROOT, f);
    if (!existsSync(p)) continue;
    const rows = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim().startsWith("|"));
    const bad = rows.filter((l) => /macOS/i.test(l) && /❌/.test(l));
    const onlyWin = rows.filter((l) => /只有这一个官方构建/.test(l));
    ck(bad.length === 0 && onlyWin.length === 0, `tgz 内 ${f} 的平台表不再声称 macOS 不可用`,
      bad.length ? bad[0].trim().slice(0, 70) : "");
  }
  execFileSync(process.execPath, ["-e", `require('node:fs').rmSync(${JSON.stringify(tmp)},{recursive:true,force:true})`]);
}

if (existsSync(zipPath)) {
  // 不依赖外部库，直接读 zip 的中央目录里的条目名
  const buf = readFileSync(zipPath);
  const names = [];
  for (let i = 0; i + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const nlen = buf.readUInt16LE(i + 28);
      names.push(buf.subarray(i + 46, i + 46 + nlen).toString("utf8"));
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
}

console.log("");
console.log("  " + "-".repeat(56));
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
