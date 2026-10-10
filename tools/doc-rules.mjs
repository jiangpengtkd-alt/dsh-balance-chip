/**
 * 文档判据 —— **单一来源**。
 *
 * 这个模块的存在本身就是一条教训的产物。
 *
 * ## 为什么单独抽出来
 *
 * "文档不得声称 macOS/Linux 装不了"这条判据，前后迭代了**四版、误报三次**：
 *
 * | 版本 | 判据 | 被谁抓到 |
 * |---|---|---|
 * | ① | 全文件 grep | CI —— 把"更正引述"判失败 |
 * | ② | 只扫表格行 | 审计 —— 漏掉散文里的结论 |
 * | ③ | 表格 + 散文措辞白名单 | 审计变异测试 —— 同义改写全部绕过 |
 * | ④ | 表格 + 散文语义判据 | 审计 fixture —— "正话"被误判为违规 |
 *
 * 每一次都是靠"人肉变异测试 + 事后补枚举"往前挪。判据也是代码，就该像代码一样
 * 被单独测试 —— 于是把它从 `pack-release.mjs` 里抽出来，配一张
 * `doc-rule-fixtures.mjs` 的回归表。
 *
 * 另有一个直接原因：判据曾**同时存在于两处**（`pack-release.mjs` 与 CI 的内联 grep），
 * 分叉后 CI 开始误报。**判据存在两处，就会有两套行为。** 现在只有这一个模块。
 *
 * ## 判据本身
 *
 * - `PLATFORM` —— 一行里是否在讲平台
 * - `NEGATION` —— 是否在说"不可用"
 * - 两者**共现**即视为在主张"装不了"
 *
 * ## 迭代中踩过的两个具体坑（都写在对应位置）
 *
 * 1. 否定写成枚举 `无法安装` → `无法使用` 漏检。改成 `无法\S{0,4}`。
 * 2. `无` 这个字太松 → `无需`/`无论` 全中，把"macOS 上**无需**另装 Node"
 *    这种夸平台能用的正话判成违规。加否定前瞻排除，但**排除表里不能有 `法`**
 *    （`无 macOS 构建` 与 `无法安装` 都可能以 `无` 开头，排掉 `法` 会让
 *    「Mac 用户无法安装」整条漏检 —— 加前瞻时 fixture 当场抓到）。
 */

/** 一行里是否在讲平台。 */
export const PLATFORM = /macOS|Linux|darwin|Mac 用户|Mac 上/;

/**
 * 是否在说"不可用）。
 *
 * ⚠️ 这条模式**只应写在这一处**。曾在 `pack-release.mjs` 与 CI workflow 里各有一份，
 * 分叉后 CI 误报。CI 那份已删。
 */
export const NEGATION = new RegExp(
  [
    "装不了",
    "不能装",
    // `无法` + 任意短动词。写成 `无法安装` 会漏掉 `无法使用`（fixture 抓到过）。
    // 代价：「无法联网」这类**条件从句**会被误判 —— 见 fixture 的"两难句"。
    "无法\\S{0,4}",
    "不可用",
    "不支持",
    "尚未",
    "未发布",
    "没有可安装",
    // ⚠️ 兜底那支**不能以 `无` 收尾** —— 平台词在前时它会匹配到 "macOS 上无需…" 里的 `无`，
    //    把"夸平台能用"的正话判成违规（fixture 抓到 5 处误报）。
    //
    //    而"平台词在前 + 无官方构建"这类句子又必须抓到，所以用 `无` 的**固定搭配**做判据：
    //    `无官方X` / `无X构建` / `无X版本`。这几个搭配只出现在"说没有"的语境里，
    //    不会碰到 `无需` / `无论` / `无关` / `无障碍`。
    //    （试过 `无(?=差)` 与 `官方无…` 两种锚，前者误报 5 处、后者漏检 3 处 —— fixture 抓到的。）
    "无(?=法|官方|构建|版本|可用|发布)",
    "无\\s?(?!需|论|关|误|效|限|条件|线)(?:macOS|Mac|Linux)",
    "(?:macOS|Mac|Linux)[^。\\n]{0,14}(?:没有|不存在)",
    "待[^。\\n]{0,8}后可用",
    "尚未提供",
    "暂不可",
  ].join("|"),
);

/** 这一行是否构成"声称平台不可用"的违规。 */
export function isPlatformClaimViolation(line) {
  return PLATFORM.test(line) && NEGATION.test(line);
}

/** 表格行里出现 macOS ❌ 也算违规（表格里不会放更正说明）。 */
export function isTableViolation(line) {
  return line.trim().startsWith("|") && /macOS/i.test(line) && /❌/.test(line);
}

/**
 * 扫描一份文档内容，返回违规行。
 *
 * 豁免规则：
 *   · 代码块（``` … ```）—— 示例命令与 fixture 字符串必然出现这些词
 *   · 引用块（以 `>` 开头）—— 本仓库的约定：更正说明一律写在引用块里
 *   · `checkProse=false` 时只查表格 —— 给 CHANGELOG / docs/audits 用，
 *     它们的天职就是复述曾经写错的话
 */
export function scanDoc(text, { checkProse = true } = {}) {
  const offenders = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.trim().startsWith(">")) continue;
    if (isTableViolation(line)) { offenders.push(line); continue; }
    if (checkProse && isPlatformClaimViolation(line)) offenders.push(line);
  }
  return offenders;
}
