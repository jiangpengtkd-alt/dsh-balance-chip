#!/usr/bin/env node
/**
 * 打包发布产物：`releases/*.tgz`（由 npm pack 产出，标准 tar，路径天然 POSIX）。
 *
 * ⚠️ **只发 tgz 一种产物。** 曾经还生成过一个含全部文档的 zip，但
 *   `dsh plugin add xxx.zip` 会直接报 `ERR_PNPM_NOT_PACKAGE_DIRECTORY`（不是目录），
 *   而下载页上并排摆两个文件、其中一个不能直接装 —— 必然有人点错。
 *   少一个文件，比多一段说明可靠。
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
import { scanDoc } from "./doc-rules.mjs";

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
// 产物名一律从 package.json 的 name 派生 —— 曾经写死过一次，改包名时漏改这里会很隐蔽。
const TGZ_NAME = `${pkg.name}-${VERSION}.tgz`;
const RELEASES = join(ROOT, "releases");

let pass = 0;
let fail = 0;

const ck = (ok, label, extra) => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? "\u2713" : "\u2717"}  ${label}${extra ? "   " + extra : ""}`);
};


if (!CHECK_ONLY) {
  mkdirSync(RELEASES, { recursive: true });
  console.log(`  打包 ${VERSION} …`);

  // ⚠️ 先清掉 releases/ 里**其它版本**的产物。
  // 不清的话，releases/ 会同时躺着 0.10.4 和 0.10.5 两份，
  // 而"包内 README 引用的 tgz 版本号"这类断言是按**当前版本**比的 ——
  // 旧产物不会让它失败，只会静静留在仓库里误导人（这个坑踩过两次）。
  if (existsSync(RELEASES)) {
    for (const f of readdirSync(RELEASES)) {
      // 同时认旧包名前缀：改名后若只按新名前缀清，旧 tgz/zip 会一直躺在 releases/ 里，
      // 而产物断言只按**当前版本**比对，根本发现不了它们 —— 这类"改名残留"最容易漏。
      const staleNamePrefixes = [pkg.name + "-", "dsh-balance-mini-"];
      if (staleNamePrefixes.some((p) => f.startsWith(p)) && f !== TGZ_NAME) {
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

  console.log("");
}

// ── 校验（--check 时只做这一步）──
console.log(`  校验 v${VERSION} 的发布产物`);

const tgzPath = join(RELEASES, TGZ_NAME);
ck(existsSync(tgzPath), `${TGZ_NAME} 存在`);

if (existsSync(tgzPath)) {
  const tmp = join(process.env.TEMP ?? "/tmp", `pkgchk-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  execFileSync("tar", ["-xzf", tgzPath, "-C", tmp]);
  const P = join(tmp, "package");

  const inPkg = JSON.parse(readFileSync(join(P, "package.json"), "utf8"));
  ck(inPkg.version === VERSION, "tgz 内 package.json 版本与仓库一致", inPkg.version);

  // ⚠️ **package.json 里出现 `scripts` = 在用户机器上执行代码。**
  //
  // package.json 是 npm 强制打包的文件，**不受 `files` 白名单控制** —— 所以上面那条
  // "tgz 每个条目都受版本控制"也拦不住它。而 `install` / `postinstall` / `prepare` /
  // `prepack` 这些生命周期脚本是在**安装时**执行的：有人通过 PR 加一行
  // `"postinstall": "curl … | sh"`，测试照跑全绿、files 也没变，但每个用户装插件都会被执行。
  //
  // 本插件不需要任何生命周期脚本，出现即异常 —— 根目录与包内**两边都断言为零**。
  {
    const scriptsOf = (obj) => (obj.scripts && typeof obj.scripts === "object" ? Object.keys(obj.scripts) : []);
    const rootScripts = scriptsOf(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")));
    const pkgScripts = scriptsOf(inPkg);
    const all = [...rootScripts, ...pkgScripts];
    ck(all.length === 0,
      "package.json 不含 scripts（生命周期脚本会在用户机器上执行）",
      all.length ? "发现: " + all.join(", ") : "无");
  }

  for (const f of ["lib/client.js", "lib/index.js", "lib/holidays.js", "README.md", "CHANGELOG.md", "INSTALL.md"]) {
    const a = createHash("sha256").update(readFileSync(join(P, f))).digest("hex");
    const b = createHash("sha256").update(readFileSync(join(ROOT, f))).digest("hex");
    ck(a === b, `tgz 内 ${f} 与仓库逐字节一致`);
  }

  // ⚠️ files 清单必须覆盖 tools/ 下的**每一个**脚本。
  //    踩过：0.10.4 新增了 pack-release.mjs 但忘了加进 files，
  //    于是它没进 tgz —— 而当时的断言只查了固定几个文件，没核对清单本身，
  //    所以两份产物不一致了好几个版本都没被发现。
  {
    const declared = new Set((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files) || []);
    // ⚠️ 跳过 `_` 前缀的临时脚本：.gitignore 允许它们存在（本地一次性探索用），
    //    但它们是个人草稿、不该进 files 清单 —— 不跳过的话本地 --check 会莫名变红，
    //    而 CI 上没有这类文件所以是绿的，两边结论不一致。
    const scripts = readdirSync(join(ROOT, "tools")).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));
    const missing = scripts.filter((f) => !declared.has("tools/" + f));
    ck(missing.length === 0, "package.json 的 files 覆盖 tools/ 下所有脚本",
      missing.length ? "缺: " + missing.join(", ") : scripts.length + " 个脚本");
    const inTgz = new Set(readdirSync(join(P, "tools")));
    const notPacked = scripts.filter((f) => !inTgz.has(f));
    ck(notPacked.length === 0, "tgz 内实际包含 tools/ 下所有脚本",
      notPacked.length ? "缺: " + notPacked.join(", ") : "");
  }

  // ⚠️ **tgz 里的每个文件都必须来自版本控制。**
  //
  // `files` 里只要出现目录通配（`"docs/"`、`"lib/"`），`npm pack` 就会把该目录下
  // **工作区里的一切**都收进去 —— 包括没提交的笔记、日志、临时脚本。
  // 这与之前 zip 扫目录是同一个病；删掉 zip 并没有解决 tgz 这一半。
  // 断言"每个条目都是 git 跟踪的文件"，以后谁再放宽 files 都会立刻变红。
  {
    let tracked = null;
    try {
      tracked = new Set(
        execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
          .split("\n").map((s) => s.trim()).filter(Boolean),
      );
    } catch (error) {
      ck(false, "能用 git 枚举受控文件（tgz 每个条目都要核对来源）", String(error && error.message));
    }
    if (tracked) {
      const listed = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" })
        .split("\n").map((s) => s.trim()).filter(Boolean)
        .map((e) => e.replace(/^package\//, ""))
        .filter((e) => e !== "" && !e.endsWith("/"));
      const untracked = listed.filter((e) => !tracked.has(e));
      ck(untracked.length === 0,
        "tgz 内每个文件都来自版本控制（files 不得把工作区未提交文件打进去）",
        untracked.length ? "越界: " + untracked.slice(0, 5).join(", ") : listed.length + " 个条目");
    }
  }

  // ⚠️ 这条就是问题 6：包内 README 曾落后一个版本，照它操作会找不到文件
  //
  // ⚠️ 正则必须用**当前包名**。曾写死 `dsh-balance-mini-`，改名后它永远匹配 0 次，
  // 于是 `refs.length === 0` 恒真 —— 守卫还在，却已经什么都不拦了。
  // 判据"存在"不等于"有效"，这正是这个项目反复踩过的那一类。
  const pkgReadme = readFileSync(join(P, "README.md"), "utf8");
  const tgzRefPattern = new RegExp(`${pkg.name}-(\\d+\\.\\d+\\.\\d+)\\.tgz`, "g");
  const refs = [...new Set([...pkgReadme.matchAll(tgzRefPattern)].map((m) => m[1]))];
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
  // ── 文档判据 ──
  //
  // ⚠️ 判据本体在 `tools/doc-rules.mjs`，**只有那一份**。
  //     曾经同时存在于本文件与 CI workflow 的内联 grep 里，分叉后 CI 误报 ——
  //     "判据存在两处，就会有两套行为"。CI 那份已删，本文件也只调用不重写。
  //     判据的回归测试见 `tools/doc-rule-fixtures.mjs`。
  //
  // ⚠️ 扫描范围要分层，否则会把"记录错误"本身判成"主张错误"：
  //
  //   · 面向用户的文档（README / INSTALL / QUICKSTART）
  //       → 表格 + 正文都查。这些文档必须**只讲对的**。
  //   · 变更记录与审计档案（CHANGELOG / docs/audits）
  //       → **只查表格、且表格也不查** —— 见下方说明。
  //         这两份文件的天职就是复述曾经写错的话：正文里有
  //         "### H… 仍在说 macOS「待…」" 这种标题（描述问题），
  //         表格里有 `| 把 README 的 macOS 行改成 ❌ | 抓 |` 这种**测试用例**。
  //         任何形式的扫描都只能靠"恰好没写那个符号"来躲 —— 而我们每轮都在归档。
  //         所以这两份**整体跳过**，它们不是发布给用户的说明文档。
  const USER_FACING = ["README.md", "INSTALL.md", "QUICKSTART.md"];
  for (const f of USER_FACING) {
    const p = existsSync(join(P, f)) ? join(P, f) : join(ROOT, f);
    if (!existsSync(p)) continue;
    const offenders = scanDoc(readFileSync(p, "utf8"), { checkProse: true });
    ck(offenders.length === 0,
      `${f} 不再声称 macOS/Linux 装不了（语义判据 + 引用块/代码块豁免）`,
      offenders.length ? offenders[0].trim().slice(0, 70) : "");
  }
  execFileSync(process.execPath, ["-e", `require('node:fs').rmSync(${JSON.stringify(tmp)},{recursive:true,force:true})`]);
}


console.log("");
console.log("  " + "-".repeat(56));
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
