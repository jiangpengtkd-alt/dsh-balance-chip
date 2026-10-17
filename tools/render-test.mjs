/**
 * 用真实数据渲染组件 —— 这是之前**漏掉致命 bug** 的地方。
 *
 * 背景：组件把快照存在 useState 里，初始为 null。旧测试只调用组件一次、从不推数据，
 * 于是 `balanceYuan` 恒为 null，永远走「余额未就绪」分支，**执行不到 fmtMoney**。
 * 而 fmtMoney 当时定义在使用之后（const 的暂时性死区），只在真正有数据时才抛错
 * → React 卸载子树 → 胶囊显示十几秒后消失。测试全过，线上却挂。
 *
 * 现在：直接把心跳快照预置好，再渲染组件，断言**所有金额分支都被执行且不抛错**。
 */
import { readFileSync } from "node:fs";

const src = readFileSync(process.argv[2] + "/lib/client.js", "utf8");

// ── hook 运行时 ──
let hooks = [];
let cursor = 0;
const rt = {
  begin() { cursor = 0; },
  useState(init) {
    const i = cursor++;
    if (!hooks[i]) hooks[i] = { v: typeof init === "function" ? init() : init };
    const set = (nv) => { hooks[i].v = typeof nv === "function" ? nv(hooks[i].v) : nv; };
    if (hooks[i].v === false) rt._boolSetter = set; // open 的初值是 false
    return [hooks[i].v, set];
  },
  useRef(init) { const i = cursor++; if (!hooks[i]) hooks[i] = { v: { current: init } }; rt._ref = hooks[i].v; return hooks[i].v; },
  useEffect(fn, deps) { const i = cursor++; const p = hooks[i]; const same = p && p.deps && deps && p.deps.length === deps.length && p.deps.every((d, k) => Object.is(d, deps[k])); if (!same) { if (p && p.cleanup) p.cleanup(); hooks[i] = { deps, cleanup: fn() }; } },
  useLayoutEffect() {},
  useMemo(f) { return f(); },
  useCallback(f) { return f; },
};
const reactStub = {
  Fragment: Symbol("Fragment"),
  createElement: (t, p, ...k) => ({ t, p, k: k.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) }),
  useState: (i) => rt.useState(i),
  useRef: (i) => rt.useRef(i),
  useEffect: (f, d) => rt.useEffect(f, d),
  useLayoutEffect: () => {},
  useMemo: (f) => rt.useMemo(f),
  useCallback: (f) => rt.useCallback(f),
};

// ── 加载工厂，并把内部 beat 暴露出来 ──
// 做法：模块源码以 `return module.exports;` 结束，我们在其前面插一句导出生效。
const patched = src.replace(
  "exports.apply = apply;",
  "exports.__beat = beat;\n\t\texports.apply = apply;",
);
if (patched === src) {
  console.error("  ✗ 无法注入 __beat（源结构变了？）");
  process.exit(1);
}

let captured = null;
const win = { __ModuleLoader__: { load: (d) => { captured = d; } } };
new Function("window", "console", patched)(win, console);

const ex = captured.factory((n) => {
  if (n === "react") return reactStub;
  if (n === "react-dom") return { createPortal: (x) => x };
  throw new Error("unknown " + n);
});

let Comp = null;
ex.apply({ inject: (d, f) => f({ connection: { rpc: { call: async () => ({}) } }, slots: { inject: (n, f2) => f2(), register: (a, b) => { Comp = b; return () => {}; } } }) }, {});
if (!Comp) throw new Error("没拿到组件");
const beat = ex.__beat;
if (!beat) throw new Error("没拿到 beat");

let pass = 0;
let total = 0;
const ck = (ok, label, extra = "") => { total += 1; if (ok) pass += 1; console.log(`  ${ok ? "✓" : "✗"}  ${label}${extra ? "   " + extra : ""}`); };

/**
 * 预置心跳快照并渲染。
 *
 * ⚠️ 必须**渲染两次**：React 里 `setSnapshot`（在 effect 中调用）会触发一次重渲染，
 * 数据要到那一次才出现在界面上。只渲染一次的话 `snapshot` 仍是初始值，
 * 会误判成"没数据"—— 这正是本测试第一版犯的错。
 */
const renderWith = (snapshot) => {
  beat.snapshot = snapshot;
  hooks = []; // 全新实例，模拟首次挂载
  cursor = 0;
  let error = null;
  const created = [];
  const origCreate = reactStub.createElement;
  reactStub.createElement = (t, p, ...k) => { const el = { t, p, k: k.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) }; created.push(el); return el; };
  const props = { sessionId: "s1", refreshMs: 60000, requestBalance: () => {} };
  try {
    // 第 1 次：触发 effect（订阅心跳、立即拉取）
    rt.begin();
    created.length = 0;
    Comp(props);
    // 第 2 次：effect 里 setSnapshot 之后的重渲染 —— 数据在这里才生效
    rt.begin();
    created.length = 0;
    Comp(props);
  } catch (e) {
    error = e;
  } finally {
    reactStub.createElement = origCreate;
  }
  const btn = created.find((e) => e.t === "button") || null;
  const text = btn ? btn.k.map((x) => (x && x.k ? x.k.join("") : String(x))).join("") : "";
  return { text, error, btn };
};

const AMOUNTS = {
  configured: true, source: "deepseek-account", total: 550.69,
  cost: {
    total: 17.11, turn: 0.0303, last: 0.0088, turnKnown: true,
    peak: false, holiday: false, holidayDataKnown: true,
    totalTokens: { cacheReadTokens: 429097215, uncachedInputTokens: 1992610, outputTokens: 672487, cacheWriteTokens: 0 },
    turnTokens: { cacheReadTokens: 1273344, uncachedInputTokens: 291, outputTokens: 970, cacheWriteTokens: 0 },
    turns: 94, avgPerTurn: 0.182, cacheShare: 0.9942,
  },
};

console.log("  ── 用真实数据渲染（执行全部金额分支）──\n");

const cases = [
  ["完整数据", AMOUNTS],
  ["只有余额（无 cost）", { configured: true, source: "deepseek-account", total: 550.86 }],
  ["余额为 0", { configured: true, total: 0, cost: { total: 0 } }],
  ["余额为极小值", { configured: true, total: 0.0004, cost: { total: 0.00004 } }],
  ["无配置", { configured: false }],
  ["查询失败", { error: "unavailable" }],
  ["空快照", {}],
  ["null 快照", null],
];

for (const [name, snap] of cases) {
  const { text, error } = renderWith(snap);
  ck(error === null, `${name}：渲染不抛错`, error ? "★ " + error.message : text.slice(0, 60));
  if (error) {
    console.log("        " + String(error.stack).split("\n")[1]?.trim().slice(0, 110));
  }
}

// 关键断言：金额格式化真的被执行了（不是走了"未就绪"分支）
console.log("");
const withMoney = renderWith(AMOUNTS);
ck(/¥550\.69/.test(withMoney.text), "余额金额已格式化（证明 fmtMoney 被调用）", withMoney.text.slice(0, 70));
ck(/¥17\.11/.test(withMoney.text), "会话累计已格式化");
ck(/¥0\.03/.test(withMoney.text), "本轮金额已格式化");

const noCost = renderWith({ configured: true, total: 550.86 });
ck(/¥550\.86/.test(noCost.text), "无 cost 时余额仍格式化");
ck(!/undefined|NaN/.test(noCost.text), "无 cost 时不出现 undefined/NaN", noCost.text.slice(0, 70));

const tiny = renderWith({ configured: true, total: 0.0004, cost: { total: 0.00004 } });
ck(!/undefined|NaN/.test(tiny.text), "极小值不产生异常文本", tiny.text.slice(0, 70));

// ── 「（上次）」标注已按用户要求移除 ──
// 没有进行中的轮次时 host 仍会回退返回上一轮的值用于显示，但不再加任何后缀标注。
console.log("");
const asLast = renderWith({
  configured: true, total: 550.69,
  cost: { total: 17.11, turn: 0.054, turnIsLast: true, turnKnown: false, turnOpen: false },
});
ck(!/（上次）/.test(asLast.text), "turnIsLast=true 时也**不再**出现「（上次）」", asLast.text.slice(0, 80));
ck(/¥0\.054/.test(asLast.text), "仍然显示上一轮的金额");

const asLive = renderWith({
  configured: true, total: 550.69,
  cost: { total: 17.11, turn: 0.054, turnIsLast: false, turnKnown: true, turnOpen: true },
});
ck(!/（上次）/.test(asLive.text), "有进行中的轮次时也不标注", asLive.text.slice(0, 80));

// ── 面板各行：本轮消耗已移出面板，改为本日消耗（0:00–24:00） ──
console.log("");
// ⚠️ 浮层走 `createPortal`，而且只在 `typeof document !== "undefined"` 时才构造 ——
// Node 里没有 document，不补桩的话**浮层整棵子树都不会被创建**，
// 所有针对头部的断言都会假失败（实测踩过）。
// 这里给一个最小的 document 桩：浮层用到的只有 addEventListener / removeEventListener。
const prevDocument = globalThis.document;
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  body: {},
};
// ⚠️ 只检查**浮层里的 dt 行**。不能拿整棵树的文本查「本轮消耗」——
// 胶囊上也写着同一个词，而"本轮消耗"是"本轮消耗"的子串，会假失败。
//
// 抽成函数是为了能换不同的快照再渲染一次（例如切换 holidayDataKnown），
// 断言"两种状态渲染结果不同"。
//
// ⚠️ 返回的是**标签与值拼在一起**的数组：只收 dt 会漏掉"值随状态变化"这类断言
// （例如「节假日数据：已收录 / 本年未收录」——标签不变，变的是值）。
const panelRows = (snapshot) => {
  ex.__beat.snapshot = snapshot;
  hooks = []; cursor = 0;
  const props = { sessionId: "s1", refreshMs: 15000, requestBalance: () => {} };
  rt.begin();
  Comp(props);
  rt.begin();
  const out = [];
  let lastDt = null;
  const orig = reactStub.createElement;
  reactStub.createElement = (tp, p, ...k) => {
    const el = { t: tp, p, k: k.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) };
    if (tp === "dt") {
      lastDt = String(el.k[0]);
      out.push(lastDt);
    }
    if (tp === "dd") out.push(lastDt + " = " + String(el.k[0]));
    return el;
  };
  try {
    Comp(props);
  } finally {
    reactStub.createElement = orig;
  }
  return out;
};

const panelText = panelRows({
  configured: true, total: 550.69, topUp: 538.35, granted: 12.34,
  cost: {
    total: 17.11, turn: 0.054, day: 1.234, turnOpen: true, turnKnown: true,
    avgPerTurn: 0.19, turns: 90, cacheShare: 0.994,
    totalTokens: { cacheReadTokens: 100, uncachedInputTokens: 1, outputTokens: 2, cacheWriteTokens: 0 },
    dayTokens: { cacheReadTokens: 50, uncachedInputTokens: 1, outputTokens: 1, cacheWriteTokens: 0 },
    peak: false, holiday: false, holidayDataKnown: true,
  },
});
// ⚠️ 「本日消耗」已按用户要求**从正文移到头部右侧**，正文里不该再有 ——
// 与「余额」同理：同一个数出现两次会让人以为它们是两个不同的值。
ck(!panelText.includes("本日消耗"), "正文**不含**「本日消耗」行（已移到头部）", panelText.join(" / "));
ck(panelText.includes("本日 token"), "面板含「本日 token」行");
// ── 正文前两行 = 余额构成（标题是总余额，正文拆分） ──
// 用户定的版式：标题「总余额」→ 第一排「充值余额」→ 第二排「赠金余额」。
ck(panelText.some((x) => x.includes("充值余额") && x.includes("¥538.35")), "第一排是「充值余额」且取 topUp", panelText.join(" / "));
{
  const iTop = panelText.findIndex((x) => x.includes("充值余额"));
  const iBonus = panelText.findIndex((x) => x.includes("赠金余额"));
  ck(iTop >= 0 && iBonus > iTop, "行序：充值余额在赠金余额之前", `充值@${iTop} 赠金@${iBonus}`);
}
// ── 「赠金余额」行：账号的**第二个钱包** ──
// 曾经漏掉的就是这个数（host 早就发 `bonusWallets`，界面从不渲染）。
// 口径是用户定的：**没有赠金就显示 "—"**，0 也不显示 ¥0.00。
// 标签带「（优先消耗）」——官方扣费规则："当充值余额与赠送余额同时存在时，优先扣减赠送余额"。
ck(panelText.some((x) => x.includes("赠金余额") && x.includes("¥12.34")), "面板含「赠金余额」行并显示金额", panelText.join(" / "));
ck(panelText.some((x) => x.includes("赠金余额（优先消耗）")), "赠金行标注「（优先消耗）」（官方扣费顺序）");
{
  const zero = panelRows({ configured: true, total: 100, granted: 0 });
  const missing = panelRows({ configured: true, total: 100 });
  ck(zero.some((x) => x.includes("赠金余额") && x.includes("—")), "赠金为 0 时显示占位 —（不是 ¥0.00）");
  ck(missing.some((x) => x.includes("赠金余额") && x.includes("—")), "取不到赠金时同样显示占位 —");
}
// ── 「节假日数据」提示行 ──
// 未收录当年节假日时，所有法定节假日都会被按工作日高峰计价（费率约 2 倍），
// 而且不报错。原先只在「时段」的措辞上悄悄换一个说法，用户根本看不出差别 ——
// 现在单列一行显式警示。
//
// ⚠️ 但**数据齐全时不该出现**："已收录"对用户没有信息量，纯噪音；
// 这一行的存在意义是警示，不是汇报"一切正常"。
{
  const known = panelRows({ configured: true, total: 100, cost: { total: 1, holidayDataKnown: true } });
  const unknown = panelRows({ configured: true, total: 100, cost: { total: 1, holidayDataKnown: false } });
  // ⚠️ 用 `.some()` 而不是 `Array.includes("子串")` —— 后者是**精确匹配元素**，
  // 查子串永远为假（这里踩过一次，表现为"渲染明明对，断言却红"）。
  ck(!known.some((x) => x.includes("节假日数据")), "数据齐全时**不显示**「节假日数据」行（不汇报一切正常）");
  ck(
    unknown.some((x) => x.includes("本年未收录") && x.includes("偏高")),
    "数据未收录时**显式警示**（不能只换个措辞）",
  );
  ck(known.join("") !== unknown.join(""), "两种状态渲染结果不同（提示确实随数据变化）");
}
// ── 面板精简（用户要求） ──
// 「数据来源」整行移除：它回答的是"这次余额从哪读的"，属于一次性信息，
// 真正需要时看 README 即可，面板里不需要常驻。
ck(!panelText.some((x) => x.includes("数据来源")), "面板**不含**「数据来源」行（已移除）");
ck(!panelText.some((x) => x.includes("当前时段")), "「当前时段」不占正文 dt 行（已移到底部与刷新同一排）");
ck(!panelText.includes("本轮消耗"), "面板**不含**「本轮消耗」（与胶囊重复）");
ck(!panelText.includes("本轮 token"), "面板不含「本轮 token」");
// ⚠️ 「余额」已按用户要求**从正文移到头部**（官方弹窗的头部也放主数值），
// 正文里不该再有它 —— 放两处会让读者以为它们是两个不同的数。
//
// ⚠️ 判据必须是**精确匹配整行**（`=== "余额"`），不能查子串：
// 新增的「赠金余额」行是**另一个数**（账号的第二个钱包），但它含 "余额" 这个子串，
// 用 includes 会把合法的行一起判失败。
ck(!panelText.some((x) => x === "余额"), "正文**不含**「余额」行（已移到头部）");
// ⚠️ 「会话累计」也**不在正文里** —— 它就在胶囊上（实时，2 秒刷新）。
// 曾经正文里也放一行，同一个数在胶囊和浮层各出现一次；两处刷新节奏不同，
// 数字对不上时反而让人怀疑哪个是真的。与「余额」「本日消耗」同理：
// **一个数只在一个地方出现**。
ck(!panelText.includes("会话累计 "), "正文**不含**「会话累计」行（胶囊上已有，避免同一个数出现两次）");

// ── 系统性防重复：胶囊上的数字不得再出现在面板里 ──
// 逐个用户反馈过的重复来补断言太被动 —— 这里反过来做：
// 把胶囊文本里所有形如 ¥123.45 的金额抽出来，面板正文里一个都不该有。
// （留「余额」「本日消耗」在头部是刻意的：它们**不**在胶囊上。）
{
  const chipMoney = [...String(withMoney.text).matchAll(/¥[\d,]+(?:\.\d+)?/g)].map((m) => m[0]);
  const dupes = chipMoney.filter((v) => panelText.includes(v));
  ck(chipMoney.length > 0, "胶囊上确实抽到了金额（否则下面这条是空转）", chipMoney.join(" "));
  ck(
    dupes.length === 0,
    "面板正文不含胶囊上出现过的任何金额（防重复）",
    dupes.length ? "重复: " + dupes.join(", ") : "胶囊 " + chipMoney.join(" "),
  );
}

// ── 头部结构：图标 + 「余额」+ 金额 + 分割线 ──
// ⚠️ 浮层只有 `open === true` 时才会被 createPortal 创建，默认是关的。
// 所以要先"打开浮层"再采集，否则整棵浮层子树都不存在、断言全假失败。
// open 的初值是 `false`，rt 在渲染时顺手把它的 setter 记了下来（rt._boolSetter）。
/** 打开浮层并收集头部元素（className + 递归文本），供断言用。 */
const captureHead = (snapshot) => {
  ex.__beat.snapshot = snapshot;
  hooks = []; cursor = 0;
  rt._boolSetter = null;
  const props = { sessionId: "s1", refreshMs: 15000, requestBalance: () => {} };

  // 第 1 遍：挂载并捕获取 setter（此后 setter 一直有效，hooks 数组不再重置）
  rt.begin();
  Comp(props);
  if (rt._boolSetter) rt._boolSetter(true);

  // 第 2 遍：open 已为 true，这一遍才会走 createPortal
  const found = [];
  const orig = reactStub.createElement;
  reactStub.createElement = (tp, p, ...k) => {
    const el = { t: tp, p, k: k.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) };
    if (p && ["bm-head", "bm-head-main", "bm-head-value", "bm-head-rule"].includes(p.className)) {
      // 递归收集文本 —— 头部里「图标」是嵌套的 svg、金额是嵌套的 span，
      // 只看第一层会得到 "span,span,span" 这种没有信息量的结果（踩过）。
      const texts = [];
      const walk = (node) => {
        if (node === null || node === undefined || typeof node === "boolean") return;
        if (typeof node !== "object") { texts.push(String(node)); return; }
        if (node.t === "svg") { texts.push("svg"); return; }
        for (const c of node.k) walk(c);
      };
      for (const c of el.k) walk(c);
      found.push({ cls: p.className, kids: texts });
    }
    return el;
  };
  try {
    rt.begin();
    Comp(props);
  } finally {
    reactStub.createElement = orig;
  }
  return found;
};
const headNodes = captureHead({
  configured: true, total: 550.69,
  cost: { total: 17.11, turn: 0.054, day: 1.234, turnOpen: true, turnKnown: true },
});const head = headNodes.find((n) => n.cls === "bm-head");const headMain = headNodes.find((n) => n.cls === "bm-head-main");
ck(!!head, "头部元素 bm-head 存在");
ck(!!headNodes.find((n) => n.cls === "bm-head-rule"), "头部下有一条分割线 bm-head-rule");
ck(!!headMain && headMain.kids.includes("svg") && headMain.kids.includes("总余额"), "头部含「图标 + 总余额」", headMain ? headMain.kids.join(",") : "");
// 头部应含余额金额（¥550.69）——它是主数值，官方弹窗的头部也放主数值
ck(!!head && head.kids.includes("¥550.69"), "头部含余额金额 ¥550.69", head ? head.kids.join(",") : "");

// ── 底排：刷新在左，「当前时段：…」靠右 ──
// 用户要求把时段从正文移到底排、与「↻ 立即刷新」同一行右对齐，只留结论（不带判断依据）。
// 采集方式与 captureHead 一致：先打开浮层，再递归收 bm-foot / bm-foot-time 的文本。
const captureFoot = (snapshot) => {
  ex.__beat.snapshot = snapshot;
  hooks = []; cursor = 0;
  rt._boolSetter = null;
  const props = { sessionId: "s1", refreshMs: 15000, requestBalance: () => {} };
  rt.begin();
  Comp(props);
  if (rt._boolSetter) rt._boolSetter(true);
  const found = [];
  const orig = reactStub.createElement;
  reactStub.createElement = (tp, p, ...k) => {
    const el = { t: tp, p, k: k.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) };
    if (p && (p.className === "bm-foot" || p.className === "bm-foot-time")) {
      const texts = [];
      const walk = (node) => {
        if (node === null || node === undefined || typeof node === "boolean") return;
        if (typeof node !== "object") { texts.push(String(node)); return; }
        for (const c of node.k) walk(c);
      };
      for (const c of el.k) walk(c);
      found.push({ cls: p.className, kids: texts });
    }
    return el;
  };
  try {
    rt.begin();
    Comp(props);
  } finally {
    reactStub.createElement = orig;
  }
  return found;
};
{
  const idle = captureFoot({ configured: true, total: 100, cost: { total: 1, peak: false } });
  const peak = captureFoot({ configured: true, total: 100, cost: { total: 1, peak: true } });
  const foot = idle.find((n) => n.cls === "bm-foot");
  const footText = foot ? foot.kids.join("") : "";
  ck(!!foot, "底排元素 bm-foot 存在");
  ck(footText.includes("↻ 立即刷新"), "底排含「↻ 立即刷新」", footText);
  ck(footText.includes("当前时段") && footText.includes("空闲"), "底排显示「当前时段：空闲」", footText);
  ck(!footText.includes("（"), "时段结论不再带括号判断依据", footText);
  const peakText = (peak.find((n) => n.cls === "bm-foot") ?? { kids: [] }).kids.join("");
  ck(peakText.includes("高峰"), "高峰时底排显示「高峰」", peakText);
  const slot = idle.find((n) => n.cls === "bm-foot-time");
  ck(!!slot && slot.kids.includes("空闲"), "「当前时段：」后接状态值（未被截断）", slot ? slot.kids.join("|") : "");
}

// ── 「总余额」与「充值余额」是两个数，必须分开取（用户要求胶囊显示总余额）──
// 胶囊：total（充值 + 赠金）；面板头部：topUp（充值）。
// 若两处都取 total，就会出现"头部写着充值余额、数字却是总额"的错位。
{
  const split = renderWith({ configured: true, total: 600, topUp: 550, granted: 50 });
  ck(/总余额/.test(split.text) && /¥600\.00/.test(split.text), "胶囊显示「总余额」且取 total（含赠金）", split.text.slice(0, 64));
  ck(!/充值余额/.test(split.text), "胶囊上不出现「充值余额」（那是面板头部的标签）");

  const splitHeads = captureHead({ configured: true, total: 600, topUp: 550, granted: 50 });
  const hv = splitHeads.find((n) => n.cls === "bm-head-value");
  ck(!!hv && hv.kids.join("") === "¥600.00", "面板标题取 total（¥600.00 = 充值 550 + 赠金 50）", hv ? hv.kids.join("") : "(缺)");
}

// ── ⚠️⚠️ 胶囊的 className —— 曾经的**最大盲区** ──
//
// 变异实测：把 `" ready"` 从 className 里删掉，真机上 CSS 的
// `.dsh-balance-mini-chip{display:none}` 就再也没有 `.ready{display:inline-flex}`
// 来覆盖 → **胶囊彻底不可见**（与当初"胶囊十几秒后消失"同级致命），
// 而原来的 65 条断言**全部照过**，因为它们只把 btn 拼成文本，从不看 btn.p。
ck(!!withMoney.btn, "渲染出了胶囊按钮元素");
const chipClass = withMoney.btn ? String(withMoney.btn.p.className) : "";
ck(/\bready\b/.test(chipClass), "胶囊带 ready 类（CSS 靠它从 display:none 切到可见）", chipClass);
ck(/\blv-/.test(chipClass), "胶囊带余额分档类（lv-*）", chipClass);
// 分档必须**跟着余额变化**，不能恒为某一档
{
  const rich = renderWith({ configured: true, total: 999, cost: { total: 1 } });
  const poor = renderWith({ configured: true, total: 5, cost: { total: 1 } });
  const mid = renderWith({ configured: true, total: 50, cost: { total: 1 } });
  const cls = (r) => (r.btn ? String(r.btn.p.className) : "");
  ck(/lv-green/.test(cls(rich)), "余额 999 → lv-green", cls(rich));
  ck(/lv-yellow/.test(cls(mid)), "余额 50 → lv-yellow", cls(mid));
  ck(/lv-red/.test(cls(poor)), "余额 5 → lv-red", cls(poor));
  ck(cls(rich) !== cls(poor), "不同余额得到不同分档（不是恒定档位）");
}

// ── 标签↔数值必须**成对相邻** ──
// 变异实测：把「会话累计」的标题改成「本轮消耗」，原断言全过，
// 因为文本是子节点 join("") 出来的，位置信息被抹平。
// 这里断言"标签紧跟其数值"这个**只在配对正确时才成立**的关系。
ck(withMoney.text.includes("\u4f59\u989d¥550.69"), "「余额」紧跟其金额", withMoney.text);
ck(withMoney.text.includes("\u4f1a\u8bdd\u7d2f\u8ba1¥17.11"), "「会话累计」紧跟其金额", withMoney.text);
ck(withMoney.text.includes("\u672c\u8f6e\u6d88\u8017¥0.03"), "「本轮消耗」紧跟其金额", withMoney.text);
// 三个标签各出现一次（防止标签被复制/错配）
for (const cap of ["\u4f59\u989d", "\u4f1a\u8bdd\u7d2f\u8ba1", "\u672c\u8f6e\u6d88\u8017"]) {
  const n = withMoney.text.split(cap).length - 1;
  ck(n === 1, "标签「" + cap + "」在胶囊上恰好出现一次", n + " 次");
}

// ── 金额精度：必须去尾随零，且**不得多补零** ──
// 变异实测：删掉 fmtMoney 里的 `.replace(/0+$/, "")`（源码注释明令禁止的回归）
// → 原来 65 条全过，因为 /¥0\.03/ 照样能匹配 "¥0.030"。
// 这里改为**精确相等**，多一个 0 就报错。
ck(!/¥0\.030/.test(withMoney.text), "金额不留尾随零（¥0.03 而非 ¥0.030）", withMoney.text);
ck(!/¥17\.110/.test(withMoney.text), "金额不留尾随零（¥17.11 而非 ¥17.110）");
ck(!/0\.03[0-9]/.test(withMoney.text), "金额不超过 3 位小数");

// ── 无值时必须显示占位符号，而不是 null/undefined/NaN ──
{
  const empty = renderWith({});
  ck(/\u2014/.test(empty.text), "无数据时显示 " + "\u2014" + " 占位", empty.text);
  ck(!/undefined|null|NaN|\[object/.test(empty.text), "无数据时不出现 undefined/null/NaN/[object", empty.text);
}
// 「本日消耗」是补充信息，放在头部右侧。
// ⚠️ 它是**两个独立节点**（"本日消耗" 与 "¥1.234"），不是拼接成一个字符串 ——
// 这样组内才能用 gap 给两者之间留间距（用户要求"数字中间隔开一点"）。
ck(!!head && head.kids.includes("本日消耗") && head.kids.includes("¥1.234"),
  "头部右侧含「本日消耗」与其金额（两个独立节点，便于加间距）", head ? head.kids.join(",") : "");

// ── 标签与数值之间不应有大间隙：CSS 不得给数值列加 min-width ──
// 曾经为防抖动加了 `min-width:5.5em`，按最长数值预留宽度，短数值（如 ¥548.68）
// 用不满就形成明显空白，被一眼看出"间距比以前大了"。抖动由等宽数字兜住即可。
console.log("");
const clientSrc = readFileSync(process.argv[2] + "/lib/client.js", "utf8");
// ── 字号：浮层与原厂面板一致（13px），胶囊与原厂 StatsPills 一致（12px）──
// 原厂两处本来就不同：
//   StatsPills .iq1doa_root  → calc(var(--dsh-content-font-size-secondary,13px) - 1px) = 12px
//   面板内容                 → var(--dsh-content-font-size-secondary,13px)            = 13px
// 浮层曾误用前者（12px），比原厂面板小 1px，被看出"字体大小不一样"。
// ⚠️ 规则在源码里是 `"." + PANEL_CLASS + "{...` 拼出来的，不是字面类名，
// 所以按"含 PANEL_CLASS 且同一行有 font-size"来定位。
const panelLine = clientSrc.split("\n").find((l) => /PANEL_CLASS \+ "\{/.test(l)) ?? "";
// 官方浮层容器 `.Xt1eiG_panel` 是**写死的 12px + line-height:18px + padding:16px**，
// 不是 var(--dsh-content-font-size-secondary)。
// 曾在 0.9.3 里"按别处推断"把它改成 13px —— 那是错的，官方这个类写死 12px。
ck(/font-size:12px/.test(panelLine), "浮层字号 12px（对齐官方 .Xt1eiG_panel）", (panelLine.match(/font-size:[^;]+/) ?? [""])[0]);
ck(/line-height:18px/.test(panelLine), "浮层行高 18px（对齐官方）", (panelLine.match(/line-height:[^;]+/) ?? [""])[0]);
ck(/padding:16px/.test(panelLine), "浮层内边距 16px（对齐官方）", (panelLine.match(/padding:[^;]+/) ?? [""])[0]);
ck(!/font-size:var\(--dsh-content-font-size/.test(panelLine), "浮层字号不跟内容字号变量走（官方是固定值）");
// 胶囊必须保留 - 1px（那是原厂 StatsPills 的写法）
// 胶囊的字号走 FONT_SIZE 常量，检查常量本身即可。
const fontConst = (clientSrc.match(/const FONT_SIZE = "([^"]+)"/) ?? ["", ""])[1];
const chipLine = clientSrc.split("\n").find((l) => /CHIP_CLASS \+ "\{/.test(l)) ?? "";
ck(/content-font-size-secondary,13px\) - 1px/.test(fontConst), "胶囊字号与原厂 StatsPills 一致（12px）", fontConst);
ck(/FONT_SIZE/.test(chipLine), "胶囊规则确实用了 FONT_SIZE 常量");
// ⚠️ 这几条依赖 clientSrc，必须放在它**之后** —— 本项目在 fmtMoney 上踩过
// 「定义晚于使用」的 TDZ 坑，测试脚本里同样会犯（const 也有暂时性死区）。
// 头部左右两侧字重必须一致 —— 曾把「本日」写成 font-weight:400，左右粗细不同，
// 看着像两个层级的东西（用户指出）。
const headCss = (clientSrc.match(/\.bm-head\{[^}]*\}/) ?? [""])[0];
const dayCss = (clientSrc.match(/\.bm-head-day\{[^}]*\}/) ?? [""])[0];
// 右端是"本日消耗 + 金额"一组，组内需要自己的间距（官方标题行只有两项，没有这个问题）
ck(/gap:6px/.test(dayCss) && /display:inline-flex/.test(dayCss), "「本日消耗」与金额之间有间距（组内 gap）", dayCss.slice(0, 120));
ck(!/font-weight/.test(dayCss), "「本日」不覆写字重（与左边一致）", dayCss.slice(0, 90));
// 分割线：官方写法 border-bottom:.5px solid var(--dsw-alias-border-l3)
const ruleCss = (clientSrc.match(/\.bm-head-rule\{[^}]*\}/) ?? [""])[0];
// 官方 .Xt1eiG_titleRule 是 `border-top:.5px solid var(--dsw-alias-border-l2)`
// —— 注意是 **border-l2**（我先前用的 l3 更亮）。用 border-top 而非 bottom，
// 这样分割线属于头部、不会随正文高度变化而挪位。
ck(/border-top:\.5px solid var\(--dsw-alias-border-l2\)/.test(ruleCss), "分割线用官方写法（border-l2 + .5px）", ruleCss.slice(0, 100));
ck(!/var\(--dsw-alias-border-l2,/.test(ruleCss), "分割线 token 无兜底值");

// ── 字重：整个面板曾因为"正文是头部的后代"而继承了 500，看着发粗 ──
// 官方 .Xt1eiG_details 不写 font-weight（继承正文 400），但本插件的 details
// 在 .bm-head（500）之下，必须显式拉回 400。
const detailsCss = (clientSrc.match(/\.bm-details\{[^}]*\}/) ?? [""])[0];
ck(/font-weight:400/.test(detailsCss), "正文行字重显式 400（否则会继承头部的 500 而发粗）", detailsCss.slice(0, 120));
// 官方 dd **不设颜色** → 数值与标签同色（都继承 details 的 tertiary）。
// 本插件曾给数值加 label-secondary（更亮），与原厂不同 —— 现已去掉。
const ddCss = (clientSrc.match(/\.bm-details dd\{[^}]*\}/) ?? [""])[0];
ck(!/color:var\(--dsw-alias-label-secondary\)/.test(ddCss), "正文数值不另设颜色（与标签同色，同官方）", ddCss.slice(0, 110));
ck(/text-align:right/.test(ddCss), "正文数值仍右对齐（官方靠对齐而非亮度区分）");
// ── 底排「当前时段」：加粗 + 状态色；与「立即刷新」同一套字体 ──
{
  const slotCss = (clientSrc.match(/\.bm-slot\{[^}]*\}/) ?? [""])[0];
  ck(/font-weight:600/.test(slotCss), "时段结论加粗", slotCss.slice(0, 90));
  const idleCss = (clientSrc.match(/\.bm-slot-idle\{[^}]*\}/) ?? [""])[0];
  ck(/var\(--dsw-alias-state-success-primary\)/.test(idleCss), "空闲用成功绿", idleCss.slice(0, 110));
  const peakCss = (clientSrc.match(/\.bm-slot-peak\{[^}]*\}/) ?? [""])[0];
  ck(/var\(--dsw-alias-state-warn-primary\)/.test(peakCss), "高峰用警告橙（不是错误红）", peakCss.slice(0, 110));
  const footCss = (clientSrc.match(/\.bm-foot\{[^}]*\}/) ?? [""])[0];
  ck(/justify-content:space-between/.test(footCss), "底排两端对齐（刷新在左、时段靠右）", footCss.slice(0, 120));
  const footTimeCss = (clientSrc.match(/\.bm-foot-time\{[^}]*\}/) ?? [""])[0];
  ck(
    /font:inherit/.test(footTimeCss) && /font-weight:400/.test(footTimeCss)
      && /var\(--dsw-alias-label-secondary\)/.test(footTimeCss),
    "「当前时段」与「立即刷新」同一套字体/字重/亮度",
    footTimeCss.slice(0, 130),
  );
}
// 官方 .Xt1eiG_titleValue 不设颜色不设字重 → 与标题同色同粗
const hvCss = (clientSrc.match(/\.bm-head-value\{[^}]*\}/) ?? [""])[0];
ck(!/color:/.test(hvCss) && !/font-weight/.test(hvCss), "头部金额与「余额」同色同粗（同官方 titleValue）", hvCss.slice(0, 110));
ck(/font-weight:500/.test(headCss), "头部字重 500（与官方 .Xt1eiG_title 一致）");
// 头部图标间距：官方 .Xt1eiG_titleLabel 是 gap:6px
const mainCss = (clientSrc.match(/\.bm-head-main\{[^}]*\}/) ?? [""])[0];
ck(/gap:6px/.test(mainCss), "头部图标与文字间距 6px（与官方 titleLabel 一致）", mainCss.slice(0, 100));
// 头部整体：官方 title 是 gap:16px + margin-bottom:8px + justify-content:space-between
ck(/gap:16px/.test(headCss) && /margin-bottom:8px/.test(headCss), "头部 gap 16 / margin-bottom 8（与官方 title 一致）", headCss.slice(0, 120));
// 只看真实 CSS 规则，不看注释（注释里会引用旧写法作为反例说明）
const capSpanRule = (clientSrc.match(/\.dsh-balance-mini-cap\+span\{[^}]*\}/) ?? [""])[0];
ck(capSpanRule !== "" && !/min-width/.test(capSpanRule), "数值列规则没有 min-width 预留（否则标签与数字间会出现空白）", capSpanRule.slice(0, 90));
ck(/dsh-balance-mini-cap\{color:[^}]*margin-right:4px\}/.test(clientSrc), "标签与数值间距为紧凑的 4px");
ck(/font-variant-numeric:tabular-nums/.test(clientSrc), "仍用等宽数字（防止数值变化时抖动）");

// ── 余额固定 2 位小数 ──
const b1 = renderWith({ configured: true, total: 548.7 });
ck(/¥548\.70/.test(b1.text), "余额 548.7 → 显示 548.70（补零到 2 位）", b1.text.slice(0, 60));
const b2 = renderWith({ configured: true, total: 548 });
ck(/¥548\.00/.test(b2.text), "余额 548 → 显示 548.00", b2.text.slice(0, 60));
const b3 = renderWith({ configured: true, total: 548.6871 });
ck(/¥548\.69/.test(b3.text), "余额 548.6871 → 548.69（第 3 位决定第 2 位）", b3.text.slice(0, 60));

// ── 三段的小圆点与绿色亮度 ──
// 用户要求：后两段标签前加圆点（对齐原生胶囊"每段都有图标"），并把绿色调亮。
const miniRule = (clientSrc.match(/\.dsh-balance-mini-minidot\{[^}]*\}/) ?? [""])[0];
ck(miniRule !== "", "存在小方点样式 .dsh-balance-mini-minidot", miniRule.slice(0, 80));
// 绿色改用**语义 token** `--dsw-alias-state-success-primary`（官方色阶解析出来正是
// #22c55e）。不再硬编码，主题换肤时自动跟随。
const greenRule = (clientSrc.match(/\.lv-green \.dsh-balance-mini-dot\{[^}]*\}/) ?? [""])[0];
ck(/--dsw-alias-state-success-primary/.test(greenRule), "状态点绿色用官方语义 token", greenRule.slice(0, 82));
// 后两段小圆点：蓝（DeepSeek 品牌色）+ 粉（官方主题无粉色 token，只能字面量）
const sessDot = (clientSrc.match(/\.dsh-balance-mini-minidot\.dot-sess\{[^}]*\}/) ?? [""])[0];
const turnDot = (clientSrc.match(/\.dsh-balance-mini-minidot\.dot-turn\{[^}]*\}/) ?? [""])[0];
ck(/--dsw-static-deepseek-400/.test(sessDot), "会话累计小圆点用品牌蓝 token", sessDot.slice(0, 82));
ck(/#a78bfa/.test(turnDot), "本轮消耗小圆点为淡紫（官方上下文面板图例同款）", turnDot.slice(0, 82));
ck(!/dot-bal/.test(clientSrc), "余额段没有小圆点（绿点由 6px 状态点承担，避免两个绿点）");

// ── 段间留白：不得再出现字符分隔点 ──
// gap-section：原来段间渲染字面量 `·`，与后两段的绿点挨在一起显得多余，已弃用。
const codeOnly = clientSrc.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
ck(!/dsh-balance-mini-sep/.test(codeOnly), "已无字符分隔点样式 .dsh-balance-mini-sep");
ck(/dsh-balance-mini-gap\{flex:none;width:6px\}/.test(codeOnly), "段间改为纯宽度留白 gap（6px ≈ 一个字符）");
ck(!/children\.push\(sep\(\)/.test(codeOnly), "段间不再插入字符节点");

// 与原生并排的元素一律不加 var() 兜底 —— fallback 会影响 token 的最终解析值
// （分隔点颜色曾因兜底偏暗、看起来更小）。
//
// ⚠️ 例外：**浮层**自身的外观参数（底色/圆角/阴影）保留兜底是刻意的 ——
// 它们不与原生组件并排比较，兜底能让浮层在 token 缺失时仍有合理外观。
// 所以只检查胶囊那部分规则。
const chipOnly = clientSrc
  .split("\n")
  .filter((l) => !/PANEL_CLASS/.test(l))
  .join("\n");
const chipColorVars = chipOnly.match(/background:var\([^)]*\)|color:var\([^)]*\)/g) ?? [];
const withFallback = chipColorVars.filter((r) => r.includes(","));
ck(withFallback.length === 0, "胶囊的颜色 token 全都没有兜底值", withFallback.join(" ") || String(chipColorVars.length) + " 条均无兜底");

// ── 指示块形状：圆角方块（对齐官方上下文面板的图例 swatch） ──
// 官方：._2WTFBq_swatch{background:var(--meter-tint);border-radius:2px;width:8px;height:8px}
const dotRule = (clientSrc.match(/\.dsh-balance-mini-dot\{[^}]*\}/) ?? [""])[0];
const miniRule2 = (clientSrc.match(/\.dsh-balance-mini-minidot\{[^}]*\}/) ?? [""])[0];
ck(/border-radius:2px/.test(dotRule), "状态点是圆角方块（radius 2px，非 50%）", dotRule.slice(0, 90));
ck(/border-radius:2px/.test(miniRule2), "小方点也是 2px 圆角", miniRule2.slice(0, 90));
// 三个块必须**同尺寸**：5px 与 6px 面积差三成（0.69 ≈ (5/6)²），并列时肉眼一眼看出（踩过）
const wDot = Number((/width:(\d+)px/.exec(dotRule) ?? [])[1]);
const wMini = Number((/width:(\d+)px/.exec(miniRule2) ?? [])[1]);
ck(wDot === 5 && wMini === 5, "三个块尺寸一致（都是 5px）", `状态块 ${wDot}px / 小方点 ${wMini}px`);
ck(!/border-radius:50%/.test(dotRule + miniRule2), "两处都不再是圆形");
ck(/corner-shape:round/.test(dotRule + miniRule2), "与官方一致带上 corner-shape:round");

console.log("  " + "-".repeat(52));
console.log(`  ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
