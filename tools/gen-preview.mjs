/**
 * 生成 docs/preview.html —— 样式预览页。
 *
 * 为什么要有这个脚本：预览页的样式必须与实机一致，而**手抄 CSS 必然会脱节**。
 * 本项目就吃过一次亏 —— 预览里的分隔点间距（`margin:0 1px`）、胶囊 `gap:6px`、
 * hover 态全都与实现不符，而 README 却声称"与实机一致"。
 *
 * 所以预览页的 CSS **从 lib/client.js 的 CSS 数组直接求值**得到，不可能脱节。
 * 示例 HTML（标签、行文案）同样在此维护 —— 组件改了这里也要跟着改。
 *
 * 用法：
 *   node tools/gen-preview.mjs                # 写到 <包根>/docs/preview.html
 *   node tools/gen-preview.mjs <输出路径>      # 写到指定位置
 *
 * 改完 lib/client.js 的样式后重新跑一次即可。
 * 想同时得到位图：用浏览器打开生成的 HTML 截图，或：
 *   msedge --headless=new --force-device-scale-factor=2 \
 *          --window-size=780,900 --screenshot=preview.png file:///<路径>/docs/preview.html
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const outPath = process.argv[2] ?? join(pkgRoot, "docs", "preview.html");

// ── 从源码求值出真实 CSS ────────────────────────────────────────────────
const src = readFileSync(join(pkgRoot, "lib", "client.js"), "utf8");
const start = src.indexOf("const CSS = [") + "const CSS = ".length;
const end = src.indexOf('].join("")', start);
if (start < "const CSS = ".length || end < 0) {
  console.error("  找不到 lib/client.js 里的 CSS 数组 —— 源码结构可能变了");
  process.exit(1);
}
const arrayLiteral = src.slice(start, end + 1);

// 数组字面量引用的常量。
//
// ⚠️ **必须从 client.js 源码里读真实值，不能在这里另抄一份** ——
// 抄一份的后果实测过：把 client.js 的 FONT_SIZE 改掉，render-test 会报错，
// 而本文件 19 条自检**全绿**，预览页就这样静默与实机脱钩
// （偏偏本文件开头声称的就是"预览与实机不可能脱节"）。
const readConst = (name) => {
  const m = new RegExp(`const ${name} = "([^"]+)"`).exec(src);
  if (!m) {
    console.error(`  找不到 lib/client.js 里的常量 ${name} —— 源码结构可能变了`);
    process.exit(1);
  }
  return m[1];
};
const CHIP_CLASS = readConst("CHIP_CLASS");
const PANEL_CLASS = readConst("PANEL_CLASS");
const FONT_SIZE = readConst("FONT_SIZE");
const LINE_HEIGHT = readConst("LINE_HEIGHT");
// eslint-disable-next-line no-eval
const chipCss = eval(`(${arrayLiteral})`).join("");

// ── 原厂 StatsPills 的真实 CSS（.iq1doa_*，前缀改 np_ 以避冲突） ─────────
const nativeCss = `.np_root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;display:flex}
.np_anchor{min-width:0;display:inline-flex}
.np_pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.np_pill svg{flex:none;width:14px;height:14px}
button.np_pill{cursor:pointer}
button.np_pill:hover,button.np_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.np_label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.np_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}`;

// ── 示例 HTML 的构造（与 lib/client.js 的渲染结构保持一致） ──────────────
/**
 * 段间留白 —— 对应实现的 `gap()`：**不渲染任何字符**，只留约一个字符的宽度。
 *
 * 曾是字面量分隔点 `·`（照抄原厂的 `.iq1doa_sep`）。但后两段各自带上绿点后，
 * 那个 `·` 与绿点挨在一起显得多余（被反馈"绿点前面的小白点多余"），故改为纯宽度。
 */
const SEP = `<span class="dsh-balance-mini-gap"></span>`;
/**
 * 余额图标（钱包）—— 与 lib/client.js 的 walletIcon() 同一份路径数据。
 *
 * 官方 lexicon 里没有金额类图标（91 个图标中无 wallet/coin/money），所以自绘；
 * 格式对齐 `IconClockOutlineRegular`：viewBox 0 0 16 16、fill:none、
 * stroke:currentColor、1px 描边。
 */
const WALLET_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex:none;display:block"><rect x="1.5" y="3.5" width="13" height="9" rx="2" stroke="currentColor" stroke-width="1"/><circle cx="11" cy="8" r="1.2" stroke="currentColor" stroke-width="1" fill="none"/></svg>`;
/**
 * 一组「标签 + 数值」，对应组件的 cell()。
 * `dotClass` 为小方点的颜色类（dot-bal / dot-sess / dot-turn）—— 三段各一色。
 */
const cell = (caption, text, dotClass) =>
  (dotClass ? `<span class="dsh-balance-mini-minidot ${dotClass}"></span>` : "")
  + `<span class="dsh-balance-mini-cap">${caption}</span><span>${text}</span>`;
const chip = (level, inner, attrs = "") =>
  `<button class="${CHIP_CLASS} ready lv-${level}" type="button"${attrs}>` +
  `<span class="dsh-balance-mini-dot"></span>${inner}</button>`;
/**
 * 时段结论（④）：空闲 / 高峰 / 假日。对应组件的 tierText + 状态点。
 * 点与字同色（绿=空闲、橙=高峰），形状沿用同一个 `.dsh-balance-mini-minidot` 基类。
 */
const TIER = (text, kind) =>
  `<span class="dsh-balance-mini-minidot dot-tier-${kind}"></span>` +
  `<span class="dsh-balance-mini-tier ${kind}">${text}</span>`;
/**
 * 完整胶囊，顺序与组件一致：总余额 · 会话累计 · 本轮消耗 · 时段。
 * 前三个数字按「变化速度」由慢到快排列 —— 余额 60 秒刷新，会话每步递增，
 * 本轮每步重置累加（跳动最明显），最活跃的数字落在最右边；时段是状态标签，放最后。
 */
const chipFull = (balance, session, turn, level = "green", attrs = "", tier = "空闲", tierKind = "idle") =>
  chip(level, cell("总余额", balance) + SEP + cell("会话累计", session, "dot-sess") + SEP + cell("本轮消耗", turn, "dot-turn") + SEP + TIER(tier, tierKind), attrs);
/**
 * 每一段都始终占位：数字算不出来时显示 "—"，时段拿不到时同样显示 "—"，**都不省略**。
 * 省略会让宽度在时段边界上周期性变化，右边元素跟着横移，看起来像坏了。
 */
const chipFullDash = (balance, session, turn, level = "green", attrs = "", tier = "空闲", tierKind = "idle") =>
  chip(level, cell("总余额", balance) + SEP + cell("会话累计", session, "dot-sess") + SEP + cell("本轮消耗", turn, "dot-turn") + SEP + TIER(tier, tierKind), attrs);

const ctxMeter = `<span class="ctx"><span class="ring"></span><span>42%</span></span>`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-balance-chip — 样式预览</title>
<style>
  /* ══════════════════════════════════════════════════════════════════
     本文件的 CSS 由 tools/gen-preview.mjs 从 lib/client.js 的 CSS 数组
     自动求值生成 —— 请勿手改，改了下次生成会被覆盖。
     手抄 CSS 会与实现脱节（本项目曾因此让预览的分隔点间距、gap、
     hover 态全部与实机不符）。
     ══════════════════════════════════════════════════════════════════ */

  /* ── 实机 design token（深色主题实测值） ── */
  :root {
    --dsh-content-font-size-secondary: 13px;
    --dsh-content-font-delta-secondary: 0px;
    --dsw-alias-label-primary: #e6e6e6;
    --dsw-alias-label-secondary: #8a8f98;
    --dsw-alias-label-tertiary: #6b7078;
    --dsw-alias-label-quaternary: rgba(128,128,128,.7);
    --dsw-alias-separator-primary: rgba(128,128,128,.5);
    /* 头部与正文之间的分割线。官方 .Xt1eiG_titleRule 用的是 border-l2，
       深色主题真实值 #ffffff1f（12% 白），取自官方主题包而非估的。 */
    --dsw-alias-border-l2: #ffffff1f;
    /* 状态点与小方点用到的语义色（值取自官方主题包，非手调）：
       success = static-green-500 = #22c55e
       warn    = static-amber-500 = #f59e0b
       deepseek-400（品牌蓝）      = #7aaaff
       缺了这些变量，var() 会解析失败 → 圆点变透明（预览里曾因此看不到绿点和蓝点） */
    --dsw-alias-state-success-primary: #22c55e;
    --dsw-alias-state-warn-primary: #f59e0b;
    --dsw-alias-state-error-primary: #e5534b;
    --dsw-static-deepseek-400: #7aaaff;
    --dsw-alias-interactive-bg-hover: rgba(128,128,128,.14);
    --dsw-specific-menu: #1b1e26;
    --dsw-radius-lg: 10px;
    --dsw-menu-backdrop-filter: none;
    --dsw-elevation-prominent: 0 6px 24px rgba(0,0,0,.45);
  }
  body {
    margin: 0; padding: 22px 26px 34px; background: #14161b;
    color: var(--dsw-alias-label-secondary);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; color: var(--dsw-alias-label-primary); }
  .sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin: 0 0 22px; line-height: 1.7; }
  h2 { font-size: 13px; font-weight: 600; margin: 24px 0 8px; color: var(--dsw-alias-label-primary); }
  .note { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin: 8px 0 0; line-height: 1.7; }
  .cap-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-top: 6px; }
  code { color: #a8b1c0; font-size: 12px; }
  .frame { background: #191c22; border: 1px solid rgba(128,128,128,.16); border-radius: 8px; padding: 2px 12px 6px; }

  /* ── 原厂「输入框下方那一排」容器 ── */
  .dock {
    box-sizing: border-box; min-width: 0; max-width: 100%;
    display: flex; justify-content: center; align-items: center; gap: 12px;
    font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
    line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
    padding: 6px 0;
  }
  /* 上下文圆圈示意（原厂 ContextMeter） */
  .ctx { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); }
  .ctx .ring { width: 14px; height: 14px; border-radius: 50%; flex: none;
    background: conic-gradient(#4c8dff 0 68%, rgba(128,128,128,.28) 68% 100%);
    -webkit-mask: radial-gradient(circle, transparent 0 4.5px, #000 4.5px 100%);
            mask: radial-gradient(circle, transparent 0 4.5px, #000 4.5px 100%); }

  /* ══ 原厂 StatsPills 真实 CSS（供并排对照） ══ */
${nativeCss.split("\n").map((l) => "  " + l).join("\n")}

  /* ══ 本插件真实 CSS —— 从 lib/client.js 求值得到 ══ */
${chipCss.split("}").filter((r) => r.trim()).map((r) => "  " + r.trim() + "}").join("\n")}
</style>
</head>
<body>

<h1>dsh-balance-chip — 样式预览</h1>
<p class="sub">
  本页 CSS 由 <code>tools/gen-preview.mjs</code> 从 <code>lib/client.js</code> 求值生成，与实机同一份定义。<br>
  原厂 <code>StatsPills</code> 的真实 CSS（<code>.iq1doa_*</code>）也内置其中，用于并排对照。
</p>

<h2>① 实机排布：上下文圆圈 + 余额胶囊</h2>
<div class="frame">
  <div class="dock">
    ${ctxMeter}
    ${chipFull("¥566.47", "¥13.265", "¥0.095")}
  </div>
</div>
<p class="note">
  三段各带标签，避免混淆，按变化速度由慢到快排列：<b>总余额</b>（充值余额 + 赠金余额，快照）· <b>会话累计</b>（本会话建立至今的累计）· <b>本轮消耗</b>（这一句话从发问到此刻的合计，跳动最明显）。<br>
  三个圆点同色，按<b>总余额分档</b>：≥100 绿 · 20–99 黄 · 1–19 红 · 其他灰。<br>号码段前是 5px 状态块，后两段标签前是 5px 小方点（对齐原生胶囊"每段都有图标"的节奏）。<br>数值用等宽数字，且<b>不预留最小宽度</b> —— 预留会让标签与数字之间出现空白。
  三段<b>始终占位</b>：本轮还算不出来时显示 <code>—</code>，不整段省略 —— 避免数字左右横移（见下方 ④）。
</p>

<h2>② 与原厂胶囊并排（分隔点 / 字号 / 间距一致性）</h2>
<div class="frame">
  <div class="dock">
    <span class="np_anchor"><button class="np_pill" type="button">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 12 L15.5 8.5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>
      <span class="np_label">337M tok<span class="np_sep">·</span>缓存命中 99%</span>
    </button></span>
    ${chipFull("¥566.47", "¥13.265", "¥0.095")}
  </div>
</div>
<p class="note">两边的分隔点应<b>大小、亮度、间距一致</b> —— 都用 <code>var(--dsw-alias-separator-primary)</code> 且 <code>margin:0 6px</code>，字号都用同一个 calc 表达式。</p>

<h2>③ 点击展开的浮层</h2>
<div class="frame">
  <div class="dock">
    ${ctxMeter}
    ${chipFull("¥566.47", "¥13.265", "¥0.095", "green",
      ' aria-expanded="true" style="background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)"')}
  </div>
  <div style="display:flex;justify-content:center;padding:4px 0 8px">
    <div class="${PANEL_CLASS}" style="position:static">
      <div class="bm-head">
        <span class="bm-head-main">${WALLET_SVG}总余额</span>
        <span class="bm-head-value">¥566.47</span>
        <span class="bm-head-day">本日消耗 ¥1.842</span>
      </div>
      <div class="bm-head-rule"></div>
      <dl class="bm-details">
        <dt>充值余额</dt><dd>¥554.13</dd>
        <dt>赠金余额（优先消耗）</dt><dd>¥12.34</dd>
        <dt>每轮平均消耗</dt><dd>¥0.158 · 84 轮</dd>
        <dt>会话累计 token</dt><dd>4.33亿</dd>
        <dt>会话命中缓存</dt><dd>4.31亿（99.4%）</dd>
        <dt>本日 token</dt><dd>12.9万</dd>
        <dt>单价（元/百万 token）</dt><dd>命中 0.02 · 未命中 1 · 输出 4</dd>
      </dl>
      <div class="bm-rule"></div>
      <div class="bm-foot">
        <button type="button" style="font:inherit;color:inherit;background:0 0;border:none;padding:0;cursor:pointer">↻ 立即刷新</button>
        <span class="bm-foot-time">当前时段：<span class="bm-slot bm-slot-idle">空闲</span></span>
      </div>
    </div>
  </div>
</div>
<p class="note">
  金额单位统一是「元/百万 token」，金额本身是元。<br>
  <b>不重复官方内容</b>：token 明细（缓存命中 / 未缓存输入 / 缓存读取 / 缓存写入 / 输出）在官方「Token 用量」浮层里已有，
  这里只给<b>成本视角</b>的三个数 —— 总量、缓存读取占比、本轮总量。<br>
  「会话命中缓存」解释了<b>为什么成本这么低</b>：命中那部分单价 0.02，未命中的是 1，<b>差 50 倍</b>。<br>
  单价行显示的是<b>当前时段</b>的费率（高峰翻倍），不是历史成交均价。
</p>

<h2>④ 三段始终占位（无值显示 "—"）、余额分档、异常状态</h2>
<div class="frame">
  <div class="dock">
    ${chipFull("¥566.47", "¥13.265", "¥0.095")}
    ${chipFull("¥42.10", "¥1.084", "¥0.021", "yellow")}
    ${chipFull("¥8.44", "¥0.124", "¥0.008", "red")}
  </div>
</div>
<p class="note">正常三态：圆点颜色按余额分档（≥100 绿 · 20–99 黄 · 1–19 红 · 其他灰）。末尾是时段结论。</p>

<h2>④b 时段结论：空闲 / 高峰 / 假日</h2>
<p class="note">
  时段决定单价是 1 倍还是 2 倍，所以常驻在胶囊上，不必点开浮层。<br>
  <b>空闲</b>用成功绿（便宜）、<b>高峰</b>用警告橙（贵一倍，是提醒不是错误）——与浮层底排同一组语义 token。<br>
  <b>假日</b>按空闲计价（官方规则：法定节假日全天算空闲），但仍单独显示，否则用户会以为节假日被算错了。
</p>
<div class="frame">
  <div class="dock" style="flex-direction:column;gap:2px;align-items:center">
    <div class="cap-note">空闲时段（非工作日 / 工作日非高峰）</div>
    ${chipFull("¥566.47", "¥13.265", "¥0.095", "green", "", "空闲", "idle")}
    <div class="cap-note">高峰时段（工作日 9–12 / 14–18）</div>
    ${chipFull("¥566.47", "¥13.265", "¥0.095", "green", "", "高峰", "peak")}
    <div class="cap-note">法定节假日（按空闲计价）</div>
    ${chipFull("¥566.47", "¥13.265", "¥0.095", "green", "", "假日", "idle")}
    <div class="cap-note">拿不到时段信息（仍占位，不省略）</div>
    ${chipFull("¥566.47", "¥13.265", "¥0.095", "green", "", "—", "idle")}
  </div>
</div>

<p class="note" style="margin-top:16px">
  <b>关键：位置必须稳定。</b>下面是同一个会话从「刚打开」到「本轮跑起来」的连续状态 ——
  三段<b>始终存在</b>，只是无值时显示 <code>—</code>。数字不会因某段出现/消失而左右横移。
</p>
<div class="frame">
  <div class="dock" style="flex-direction:column;gap:2px;align-items:center">
    <div class="cap-note">刚打开 DSH（本轮还没开始）</div>
    ${chipFullDash("¥553.51", "¥13.265", "—")}
    <div class="cap-note">本轮刚开始，基准已建立</div>
    ${chipFullDash("¥553.51", "¥13.265", "—")}
    <div class="cap-note">本轮累积中</div>
    ${chipFullDash("¥553.51", "¥13.270", "¥0.021")}
    <div class="cap-note">余额查询失败（三段仍占位）</div>
    ${chipFullDash("余额查询失败", "—", "—", "gray")}
  </div>
</div>
<p class="note">
  用 <code>—</code> 而不是 <code>¥0</code>：<code>¥0</code> 会被读成"本轮没花钱"，
  而实际可能是"还算不出来"。<code>—</code> 表达"暂无数据"更准确。
</p>

<h2>⑤ 字号跟随设置：与原厂胶囊同步变化</h2>
<p class="note">下面依次把 <code>--dsh-content-font-size-secondary</code> 设为 13 / 14 / 15px。两者都用同一个 calc 表达式且<b>不带兜底值</b>，因此始终同步。</p>
<div class="frame">
${[13, 14, 15]
  .map(
    (px) => `  <div class="dock" style="--dsh-content-font-size-secondary:${px}px">
    <span class="np_anchor"><button class="np_pill" type="button"><span class="np_label">原厂 ${px}px<span class="np_sep">·</span>对照</span></button></span>
    ${chipFull("¥566.47", "¥13.265", "¥0.095")}
  </div>`,
  )
  .join("\n")}
</div>

</body>
</html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, { encoding: "utf8" });

// ── 自检：关键规则必须真的注入进去了 ────────────────────────────────────
const checks = [
  ["chip gap:0（间距交给外部留白）", /align-items:center;gap:0;padding:1px 8px/.test(chipCss)],
  ["gap = 纯宽度留白（已弃用字符分隔点）", /dsh-balance-mini-gap\{flex:none;width:6px\}/.test(chipCss)],
  ["状态块 margin-right:5px", /dsh-balance-mini-dot\{[^}]*margin-right:5px/.test(chipCss)],
  ["三个块尺寸一致 5px（曾 6/5 混用被看出不一样大）", /dsh-balance-mini-minidot\{[^}]*width:5px[^}]*height:5px/.test(chipCss)
    && /dsh-balance-mini-dot\{[^}]*width:5px[^}]*height:5px/.test(chipCss)],
  ["状态点为圆角方块（对齐官方 swatch）", /dsh-balance-mini-dot\{[^}]*border-radius:2px/.test(chipCss)],
  ["标签样式 .dsh-balance-mini-cap", /dsh-balance-mini-cap\{[^}]*margin-right:4px/.test(chipCss)],
  ["hover 文字变亮", /aria-expanded=true\]\{[^}]*color:var\(--dsw-alias-label-secondary\)/.test(chipCss)],
  ["颜色 token 无兜底", !/--dsw-alias-(separator-primary|label-tertiary|label-secondary|label-primary|interactive-bg-hover)\s*,/.test(chipCss)],
  ["示例含三段标签", html.includes('balance-mini-cap">总余额') && html.includes('balance-mini-cap">会话累计') && html.includes('balance-mini-cap">本轮消耗')],
  ["无值段显示占位 —", /balance-mini-cap">本轮消耗<\/span><span>—<\/span>/.test(html)],
  ["三段顺序 总余额→会话累计→本轮消耗", html.indexOf('balance-mini-cap">总余额') < html.indexOf('balance-mini-cap">会话累计') && html.indexOf('balance-mini-cap">会话累计') < html.indexOf('balance-mini-cap">本轮消耗')],
  // 小方点三色必须都能渲染：缺 token 会让 var() 失败、圆点变透明（踩过）
  ["后两段小方点分别为蓝/淡紫（余额段用 5px 状态块）", /dot-sess\{background:var\(--dsw-static-deepseek-400\)\}/.test(chipCss)
    && /dot-turn\{background:#a78bfa\}/.test(chipCss)],
  ["预览页已定义圆点所需 token（缺了圆点会变透明）", /--dsw-alias-state-success-primary: #22c55e/.test(html)
    && /--dsw-static-deepseek-400: #7aaaff/.test(html)],
  // ── 浮层头部（对齐官方弹窗：图标 + 名称 + 主数值 + 分割线）──
  ["浮层头部为「图标 + 总余额 + 金额」", /class="bm-head"/.test(html) && /class="bm-head-main"/.test(html) && /class="bm-head-value"/.test(html)],
  ["头部含图标（svg）", /<svg[^>]*viewBox="0 0 16 16"/.test(html)],
  ["头部下有一条分割线", /class="bm-head-rule"/.test(html)],
  // 分割线必须用主题真实值 —— 之前填的是估的 rgba(128,128,128,.24)，预览与实机不一致
  ["分割线 token 为真实值 #ffffff1f（官方用 border-l2）", /--dsw-alias-border-l2: #ffffff1f/.test(html)],
  // 头部已放「余额」与「本日」，正文不该再重复
  ["浮层正文不含余额行", !/<dt>余额<\/dt>/.test(html)],
  // 正文必须含账号的第二个钱包（赠金）。它与头部的「余额」（充值余额）是两个数，
  // 官方账号设置页也是并列展示的 —— 这条断言防的是"又把赠金漏掉"。
  ["浮层第一排为「充值余额」（标题是总余额，正文是构成）", /<dt>充值余额<\/dt>/.test(html)],
  ["浮层含「赠金余额（优先消耗）」行（账号的第二个钱包）", /<dt>赠金余额（优先消耗）<\/dt>/.test(html)],
  // 节假日数据只在**缺数据**时出现（警示），数据齐全时不显示；示例是齐全状态，故应缺席
  ["浮层不含「节假日数据」行（数据齐全时不显示）", !/<dt>节假日数据<\/dt>/.test(html)],
  ["浮层不含「数据来源」行（已移除）", !/<dt>数据来源<\/dt>/.test(html)],
  ["时段行不在正文（已移到底部与刷新同一排）", !/<dt>当前时段<\/dt>/.test(html)],
  ["底排含「当前时段：空闲」（值加粗、带状态色）", /class="bm-foot-time">当前时段：<span class="bm-slot bm-slot-idle">空闲<\/span>/.test(html)],
  ["底排含「↻ 立即刷新」且与时段同一排", /class="bm-foot"[\s\S]*?↻ 立即刷新[\s\S]*?bm-foot-time/.test(html)],
  ["时段结论加粗、空闲绿、高峰橙", /bm-slot\{font-weight:600\}/.test(chipCss)
    && /bm-slot-idle\{color:var\(--dsw-alias-state-success-primary\)\}/.test(chipCss)
    && /bm-slot-peak\{color:var\(--dsw-alias-state-warn-primary\)\}/.test(chipCss)],
  ["底排两端对齐、时段与刷新同一套字体", /bm-foot\{[^}]*justify-content:space-between/.test(chipCss)
    && /bm-foot-time\{font:inherit;font-weight:400;color:var\(--dsw-alias-label-secondary\)\}/.test(chipCss)],
  ["浮层正文不含本日消耗行（已在头部）", !/<dt>本日消耗<\/dt>/.test(html)],
];
console.log(`  已生成 ${outPath}`);
console.log(`  注入的本插件 CSS ${chipCss.length} 字符`);
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`    ${ok ? "✓" : "✗"} ${label}`);
}
if (bad > 0) {
  console.error("  ⚠ 有检查未通过 —— 源码结构可能已变化，请核对 client.js 的 CSS 数组与渲染结构");
  process.exit(1);
}
