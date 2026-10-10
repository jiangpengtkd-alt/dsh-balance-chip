#!/usr/bin/env node
/**
 * 文档判据的回归测试（fixture 表）。
 *
 * ## 为什么要有这个文件
 *
 * `tools/doc-rules.mjs` 里那条"文档不得声称 macOS/Linux 装不了"的判据，
 * 前后迭代了**四版、误报三次**，每一次都靠"人肉变异测试 + 事后补枚举"往前挪：
 *
 * | 版本 | 判据 | 被谁抓到 |
 * |---|---|---|
 * | ① | 全文件 grep | CI —— 把"更正引述"判失败 |
 * | ② | 只扫表格行 | 审计 —— 漏掉散文里的结论 |
 * | ③ | 表格 + 散文措辞白名单 | 审计变异测试 —— 同义改写全部绕过 |
 * | ④ | 表格 + 散文语义判据 | 审计 fixture —— "正话"被误判为违规 |
 *
 * 判据也是代码，就该有回归测试。改 `NEGATION` 之后跑一下这个文件，
 * 立刻知道有没有踩坏旧 case。
 *
 * ## 三类 fixture
 *
 *   FLAG    —— 应当判违规（真阳性）：换着法子说"装不了"
 *   ALLOW   —— 应当放行（真阴性）：更正说明、条件从句、夸平台能用的话
 *   TRICKY  —— 语义上确实两难，**记录取舍**而不算失败
 *
 * 用法：`node tools/doc-rule-fixtures.mjs`
 */
import { isPlatformClaimViolation, isTableViolation, scanDoc } from "./doc-rules.mjs";

/** 真阳性：都是在主张"装不了"，必须抓。 */
const FLAG = [
  "macOS / Linux（bash / zsh）—— 待官方发布宿主后可用",
  "官方无 macOS 构建，因此 Mac 用户无法安装。",
  "Mac 用户暂时无法使用本插件。",
  "Linux 上不支持安装本插件。",
  "结论：macOS / Linux 上没有可安装的 DSH 宿主。",
  "macOS 版本尚未发布。",
  "该插件在 Linux 上不可用。",
  "macOS 上装不了这个插件。",
  "在 macOS 上不能装。",
  "macOS 的构建尚未提供。",
];

/** 真阴性：不是在主张"装不了"，必须放行。 */
const ALLOW = [
  "在 macOS 上运行需要 Node 22.15+。",
  "macOS 版已实测可用，见平台表。",
  "Windows 与 macOS 均已实机验证。",
  "判断平台：读 desktop-runtime.json 的 platform 字段。",
  "这条命令已在 macOS（darwin-arm64）上实测通过。",
  "支持 Windows / macOS / Linux，同一份代码。",
  "macOS 上安装与 Windows 完全相同，只是路径写法不同。",
  // ⚠️ 下面这几条是审计方喂出来的**假阳性**：都是"夸平台能用"的正话，
  //    但 `无` 这个字太松，`无需`/`无论` 全中。改 NEGATION 后必须放行。
  "在 macOS 上无需另行安装 Node（DSH 已内置）。",
  "macOS 用户无论用哪个 shell 都能安装。",
  "macOS 上与平台无关的行为一致。",
  "无需为 macOS 单独打包。",
];

/**
 * 两难句：语义上确实分不开，**记录取舍**而不算失败。
 *
 * 「无法联网」是**条件从句**，「无法安装」是**主张** —— 正则层面同形。
 * 目前策略：宁可偶尔误报，也不放过真阳性。
 * 理由：误报会在文档里立刻被看见并改写句子；漏检则会静默发出错误的承诺。
 */
const TRICKY = [
  "macOS 用户无法联网时也能离线安装。",
  "在 macOS 上无法访问外网的环境里也能用。",
];

let pass = 0;
let fail = 0;

console.log("\n  ── 真阳性：必须抓 ──");
for (const t of FLAG) {
  const hit = isPlatformClaimViolation(t);
  if (hit) pass += 1; else fail += 1;
  console.log(`  ${hit ? "\u2713" : "\u2717"}  ${hit ? "违规" : "★ 漏检"}  ${t.slice(0, 48)}`);
}

console.log("\n  ── 真阴性：必须放行 ──");
for (const t of ALLOW) {
  const hit = isPlatformClaimViolation(t);
  if (!hit) pass += 1; else fail += 1;
  console.log(`  ${!hit ? "\u2713" : "\u2717"}  ${!hit ? "放行" : "★ 误报"}  ${t.slice(0, 48)}`);
}

// ── 豁免规则：代码块 / 引用块 / 表格 ──
console.log("\n  ── 豁免与表格判据 ──");
const SCAN_CASES = [
  {
    name: "引用块里的更正说明 → 放行",
    text: "> 早先写过「macOS 上无法安装」，那是错的。",
    want: 0,
  },
  {
    name: "代码块里的示例 → 放行",
    text: "```bash\necho 'macOS 上不支持'\n```",
    want: 0,
  },
  {
    name: "正文里的主张 → 违规",
    text: "macOS 上无法安装本插件。",
    want: 1,
  },
  {
    name: "表格里 macOS + ❌ → 违规",
    text: "| macOS | ❌ | 无构建 |",
    want: 1,
  },
  {
    name: "表格里 macOS + ✅ → 放行",
    text: "| macOS arm64 | ✅ 实机验证 | darwin-arm64 |",
    want: 0,
  },
  {
    name: "（记录类文档）只查表格：正文复述不算",
    text: "### H 某处仍在说 macOS「待官方发布宿主后可用」",
    want: 0,
    opts: { checkProse: false },
  },
];
for (const c of SCAN_CASES) {
  const n = scanDoc(c.text, c.opts).length;
  const ok = n === c.want;
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? "\u2713" : "\u2717"}  ${c.name}${ok ? "" : `   期望 ${c.want} 处、实际 ${n} 处`}`);
}
void isTableViolation;

console.log("\n  ── 两难句：记录取舍，不计失败 ──");
for (const t of TRICKY) {
  const hit = isPlatformClaimViolation(t);
  console.log(`  ·  ${hit ? "判违规（可接受的误报）" : "判放行"}  ${t.slice(0, 48)}`);
}

console.log("\n  " + "-".repeat(58));
console.log(`  ${pass} 通过 / ${fail} 失败   （另有 ${TRICKY.length} 条两难句记录在案）`);
process.exit(fail === 0 ? 0 : 1);
