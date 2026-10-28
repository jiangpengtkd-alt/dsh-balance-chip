/**
 * 端到端自测：**不需要启动 DSH 就能验证 host 半身的真实代码路径**。
 *
 * 做法：加载真实的 `lib/index.js`，用桩 ctx 调 `apply()`，从它注册的路由里取出
 * handler 直接喂 HTTP 形状的假请求，然后断言响应内容。
 *
 * 为什么要有这个：host 半身的问题（尤其是 `cost` 整块消失那种）过去只能靠
 * "改代码 → 让用户重启 → 肉眼看界面"来发现，一轮就是好几分钟，而且容易误判
 * （曾把"进程还跑着旧代码"当成逻辑 bug，也曾在事件回调里读投影造成重入而不自知）。
 * 有了它，改完当场就能验证，不必打扰用户。
 *
 * 用法（从插件根目录）：
 *   node tools/selftest.mjs
 *   退出码 0 = 全部通过
 *
 * 覆盖：新会话（turnBoundary 无值）→ 本轮建立 → 同轮累加 → 新轮重置 →
 * 无 sessionId → 会话不存在 → 非回环请求被拒。
 */
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);

const SESSION_ID = "session-selftest";
const now = Date.now();

// ── 桩数据：形状与官方投影一致 ──
let totals = {
  uncachedInputTokens: 1953348,
  outputTokens: 614008,
  cacheReadTokens: 378407167,
  cacheWriteTokens: 0,
};
let openTurnStartSeq = null; // 新会话时官方给的是 null（不是 number）
const session = { id: SESSION_ID };
const sessionStats = {
  turns: 77, steps: 911, llmMs: 1, toolMs: 1, ttftMs: 1, ttftSteps: 1, decodeMs: 1, decodeTokens: 1,
};
const BALANCE = { currency: "CNY", balance: "553.5079747" };
/** 赠金钱包。可变 —— 账号侧是**两个钱包**（充值余额 / 赠金余额），两者要分别验。 */
let bonusWallets = [];

const stateOf = (_s, key) => {
  if (key === "tokenUsage") {
    return {
      totals,
      last: { turn: 77, step: 3, buckets: { uncachedInputTokens: 214, outputTokens: 186, cacheReadTokens: 552832, cacheWriteTokens: 0 } },
    };
  }
  if (key === "turnBoundary") return { openTurnStartSeq, lastStepStartSeq: 1, lastTurn: 77 };
  if (key === "sessionStats") return sessionStats;
  return undefined;
};

let registered = null;
const ctx = {
  sessions: { get: (id) => (id === SESSION_ID ? session : undefined) },
  sessionProjections: { stateOf },
  webServer: { register: (route) => { registered = route; return () => {}; } },
  effect: (fn) => { fn(); },
  deepseekAccount: {
    getBalance: async () => ({ status: "ready", value: [BALANCE], bonusWallets }),
  },
  logger: { warn: () => {} },
};

mod.apply(ctx, undefined);
if (!registered) {
  console.error("  ✗ apply() 没有注册路由");
  process.exit(1);
}

/**
 * 造一个 HTTP 形状的假请求/响应，模拟宿主把请求交给路由。
 *
 * ⚠️ 必须带 `socket.remoteAddress`：路由的回环校验以**对端地址**为主判据
 * （`Host` 头是请求方可伪造的，不能单独作为门槛）。
 */
function http({ host = "127.0.0.1:19387", remoteAddress = "127.0.0.1", body, method = "POST" } = {}) {
  const raw = JSON.stringify(body ?? {});
  const req = {
    method,
    url: "/balance-mini/fetch",
    headers: { host },
    socket: { remoteAddress },
    setEncoding() { return this; },
    on(ev, fn) {
      if (ev === "data") fn(raw);
      if (ev === "end") fn();
      return this;
    },
  };
  let out = "";
  let status = null;
  const res = {
    writeHead(code) { status = code; },
    setHeader() {},
    end(chunk) { out += chunk ?? ""; },
  };
  return {
    req,
    res,
    done: async () => {
      await registered.handler(req, res);
      await new Promise((r) => setTimeout(r, 30)); // 让异步分支跑完
      return { status, text: out, json: safeParse(out) };
    },
  };
}

const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const envelope = (payload, rpcId = `r${Math.random().toString(36).slice(2, 8)}`) => ({
  type: "client-request",
  rpcId,
  method: "fetch",
  payload,
});

const fetchCost = async (payload) => {
  const { json } = await http({ body: envelope(payload) }).done();
  return json?.result?.value;
};

/** 手工算一遍期望金额，确保不是"看着像对" */
const price = (b, peak = false) =>
  (b.uncachedInputTokens * (peak ? 2 : 1)
    + b.cacheReadTokens * (peak ? 0.04 : 0.02)
    + b.cacheWriteTokens * (peak ? 2 : 1)
    + b.outputTokens * (peak ? 8 : 4)) / 1e6;

let pass = 0;
let total = 0;
const ck = (ok, label, detail = "") => {
  total += 1;
  if (ok) pass += 1;
  console.log(`  ${ok ? "✓" : "✗"}  ${label}${detail ? `   ${detail}` : ""}`);
};

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 本文件里有若干条断言是对源码做正则的（"某写法还在/已移除"）。它们**必须**
 * 在剥掉注释后的文本上跑，否则会有两类假结果：
 *   · 假失败：本项目的注释风格恰恰是"曾经用过 xxx 所以现在不用了"，
 *     句子里就含被禁的字面量（例如 `setTimeout(tick`），不剥注释就会误报。
 *   · 假通过：反过来，注释里提到某个词也能满足"存在 xxx"这类正向断言。
 * render-test.mjs 早就有这个做法（codeOnly），这边一直漏了。
 */
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // 行注释（避开 http:// 这类）

const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;

// ══ 场景 1：新会话 —— turnBoundary 的 openTurnStartSeq 是 null ══
// 这是曾经的真实故障：基准永不建立 → turnBase 恒 undefined → cost 整块消失。
console.log("  ── 场景 1：新会话（openTurnStartSeq = null）──");
{
  const v = await fetchCost({ sessionId: SESSION_ID });
  ck(v?.cost !== undefined, "cost 存在（曾经这里整块消失）");
  ck(near(v?.cost?.total, price(totals, v?.cost?.peak)), "会话累计金额正确", `¥${v?.cost?.total?.toFixed(4)}`);
  // 新会话、无进行中的轮次、也还没有过任何一轮结束 → 本轮无值可显示，
  // 客户端会显示占位 "—"（三段始终占位，不整段省略）。
  ck(v?.cost?.turn === undefined, "本轮为 undefined（无实时值也无历史轮次 → 界面显示占位）");
  ck(near(v?.cost?.avgPerTurn, price(totals, v?.cost?.peak) / sessionStats.turns), "每轮平均消耗 = 会话累计 ÷ 轮数");
  ck(v?.cost?.cacheShare > 0.99, "缓存占比 > 99%", `${(v?.cost?.cacheShare * 100).toFixed(1)}%`);
  ck(v?.topUp === Number(BALANCE.balance), "充值余额读取正常", `¥${v?.topUp}`);
  ck(v?.total === Number(BALANCE.balance), "无赠金时总余额 = 充值余额", `¥${v?.total}`);
  ck(v?.granted === undefined, "无赠金钱包时 granted 为 undefined（界面显示占位）");
}

// ══ 场景 1b：赠金余额 —— 账号的**第二个钱包** ══
// 曾经漏掉的就是这个数：host 早就把 bonusWallets 发出来了，但界面从不渲染。
// 三个字段的口径必须分清：topUp=充值余额、granted=赠金余额、total=总余额（两者之和）。
console.log("\n  ── 场景 1b：赠金余额 ──");
{
  bonusWallets = [{ currency: "CNY", balance: "12.34" }];
  const v = await fetchCost({ sessionId: SESSION_ID });
  ck(v?.granted === 12.34, "赠金余额读取正常", `¥${v?.granted}`);
  ck(v?.topUp === Number(BALANCE.balance), "赠金不影响「充值余额」", `¥${v?.topUp}`);
  ck(near(v?.total, Number(BALANCE.balance) + 12.34), "总余额 = 充值 + 赠金", `¥${v?.total?.toFixed(4)}`);
  // 币种不对齐时回退到第一个赠金钱包 —— 不能因为币种拼写差异就整行消失
  bonusWallets = [{ currency: "USD", balance: "1.5" }];
  const v2 = await fetchCost({ sessionId: SESSION_ID });
  ck(v2?.granted === 1.5, "币种不一致时回退到首个赠金钱包", `$${v2?.granted}`);
  ck(near(v2?.total, Number(BALANCE.balance) + 1.5), "总余额按回退到的赠金计算");
  bonusWallets = [];
}

// ══ 场景 2：本轮开始（有了 openTurnStartSeq），累计增长 ══
console.log("\n  ── 场景 2：本轮开始，累计增长 ──");
{
  openTurnStartSeq = 6040;
  const grew = { uncachedInputTokens: 500, outputTokens: 1200, cacheReadTokens: 800000, cacheWriteTokens: 0 };
  const before = { ...totals };
  totals = {
    uncachedInputTokens: totals.uncachedInputTokens + grew.uncachedInputTokens,
    outputTokens: totals.outputTokens + grew.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + grew.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens + grew.cacheWriteTokens,
  };
  const v = await fetchCost({ sessionId: SESSION_ID });
  ck(v?.cost?.turn !== undefined, "本轮有值");
  ck(near(v?.cost?.turn, price(grew, v?.cost?.peak)), "本轮金额 = 本轮增量计价", `¥${v?.cost?.turn?.toFixed(6)}`);
  ck(typeof v?.cost?.turn === "number" && v.cost.turn > 0, "本轮是正的实时值（有进行中的轮次）");
  void before;
}

// ══ 场景 3：同轮内继续增长 → 基准保持，金额累加 ══
console.log("\n  ── 场景 3：同轮内继续增长（基准应保持）──");
{
  const grew = { uncachedInputTokens: 100, outputTokens: 300, cacheReadTokens: 400000, cacheWriteTokens: 0 };
  const baseBefore = { ...totals };
  totals = {
    uncachedInputTokens: totals.uncachedInputTokens + grew.uncachedInputTokens,
    outputTokens: totals.outputTokens + grew.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + grew.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens + grew.cacheWriteTokens,
  };
  const v = await fetchCost({ sessionId: SESSION_ID });
  // 本轮 = 场景 2 的增量 + 本次增量
  const expectTurn = price(grew, v?.cost?.peak) + price({ uncachedInputTokens: 500, outputTokens: 1200, cacheReadTokens: 800000, cacheWriteTokens: 0 }, v?.cost?.peak);
  ck(near(v?.cost?.turn, expectTurn), "本轮为两段增量之和（基准未重置）", `¥${v?.cost?.turn?.toFixed(6)}`);
  void baseBefore;
}

let liveTurnBefore;

// ══ 场景 4：进入新一轮 → 基准重置，从 0 重新累加 ══
console.log("\n  ── 场景 4：进入新一轮（openTurnStartSeq 变化）──");
{
  // 先记下"上一轮进行中的实时值"（后面 4b 要拿它比对）
  liveTurnBefore = (await fetchCost({ sessionId: SESSION_ID }))?.cost?.turn;

  openTurnStartSeq = 7000;
  const v0 = await fetchCost({ sessionId: SESSION_ID });
  // 新轮开始：基准刚重置，此刻"本轮"= 上一轮结束到现在的增量。
  // 由于进入新轮这一步本身就会消耗（读投影、切换），这个值可能不是 0；
  // 关键是它**只算本轮**，不含上一轮的历史。
  ck(typeof v0?.cost?.turn === "number", "有进行中的轮次 → 本轮必为数字（可以是 0）");
  ck(v0?.cost?.turn !== undefined, "本轮有值（不是 undefined）", `¥${v0?.cost?.turn?.toFixed(6)}`);
  void liveTurnBefore;

  const grew = { uncachedInputTokens: 0, outputTokens: 200, cacheReadTokens: 100000, cacheWriteTokens: 0 };
  const baselineTurn = v0?.cost?.turn ?? 0;
  totals = {
    ...totals,
    outputTokens: totals.outputTokens + grew.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + grew.cacheReadTokens,
  };
  const v1 = await fetchCost({ sessionId: SESSION_ID });
  ck(near(v1?.cost?.turn, baselineTurn + price(grew, v1?.cost?.peak)), "本轮累加 = 起始值 + 本次增量", `¥${v1?.cost?.turn?.toFixed(6)}`);
  ck(v1?.cost?.turn > 0, "有消耗后本轮为正数（实时值，非回退值）");
}

// ══ 场景 4b：**轮次结束后回退显示上一轮的值** ══
// 这是"每次打开默认显示上次"的核心行为：没有进行中的轮次时不留空白。
console.log("\n  ── 场景 4b：轮次结束（openTurnStartSeq 变回 null）──");
{
  const duringTurn = (await fetchCost({ sessionId: SESSION_ID }))?.cost?.turn;
  ck(typeof duringTurn === "number" && duringTurn > 0, "结束前：本轮有实时值", `¥${duringTurn?.toFixed(6)}`);

  openTurnStartSeq = null; // 一轮结束
  const after = await fetchCost({ sessionId: SESSION_ID });
  // 轮次已结束：本轮不再有实时值，应回退为"上一轮结束时"记录的值
  ck(after?.cost?.turn !== undefined, "结束后：本轮不是 undefined（回退显示上一轮的值）", `¥${after?.cost?.turn?.toFixed(6)}`);
  ck(after?.cost?.turn > 0, "回退值是一个正数（不是 0 也不是 undefined）");
  ck(near(after?.cost?.turn, duringTurn), "回退值 = 该轮结束时的实时值",
    `¥${after?.cost?.turn?.toFixed(6)} vs ¥${duringTurn?.toFixed(6)}`);
}

// ══ 场景 4c：**第二次开新轮必须重置基准**（回归：曾经永不重置）══
//
// 这是审查发现的严重缺陷，且极难在界面上察觉：
//   场景 4 只做"一次"轮次切换，而缺陷要到"第二次"才暴露 ——
//   旧实现的新轮分支只调 recordFinishedTurn()、**不重置基准也不更新身份**，
//   于是 prev.turnSeq 冻结在第一轮的 seq 上，此后每一次 fetch 都命中该分支：
//     · 「本轮消耗」= 当前 totals − 第一轮基准 = **整个会话累计**（与面板同值）
//     · 同一轮内每次 fetch 都重复触发 recordFinishedTurn
//   数字看起来依然"合理"，所以只能靠断言抓。
console.log("\n  ── 场景 4c：第二次开新轮（基准必须重置）──");
{
  // 先把会话推到"已经过完整一轮"的状态：开一轮 → 消耗 → 结束
  openTurnStartSeq = 8000;
  await fetchCost({ sessionId: SESSION_ID });
  totals = {
    ...totals,
    outputTokens: totals.outputTokens + 400,
    cacheReadTokens: totals.cacheReadTokens + 200000,
  };
  await fetchCost({ sessionId: SESSION_ID });
  openTurnStartSeq = null; // 第一轮结束
  await fetchCost({ sessionId: SESSION_ID });

  // 关键：第二次开新轮。此刻 totals 未变，所以「本轮消耗」必须回到 ≈ 0。
  openTurnStartSeq = 9000;
  const atNewTurn = await fetchCost({ sessionId: SESSION_ID });
  const turnAtNewTurn = atNewTurn?.cost?.turn;
  const sessionTotal = atNewTurn?.cost?.total;

  ck(typeof turnAtNewTurn === "number", "新轮开始：本轮是数字", `¥${turnAtNewTurn?.toFixed(6)}`);
  ck(
    typeof turnAtNewTurn === "number" && typeof sessionTotal === "number" && turnAtNewTurn < sessionTotal,
    "第二次开新轮：本轮消耗 **小于** 会话累计（旧实现下两者相等）",
    `本轮 ¥${turnAtNewTurn?.toFixed(6)} vs 累计 ¥${sessionTotal?.toFixed(6)}`,
  );
  ck(
    typeof turnAtNewTurn === "number" && turnAtNewTurn < 1e-9,
    "第二次开新轮：本轮消耗 ≈ 0（基准已重置到现在）",
    `¥${turnAtNewTurn?.toFixed(9)}`,
  );

  // 同一轮内重复 fetch 不应再被误判成"新轮"（旧实现下每次 fetch 都会重置 lastTurn）
  const before = (await fetchCost({ sessionId: SESSION_ID }))?.cost?.last;
  await fetchCost({ sessionId: SESSION_ID });
  await fetchCost({ sessionId: SESSION_ID });
  const after3 = (await fetchCost({ sessionId: SESSION_ID }))?.cost?.last;
  ck(near(before, after3), "同一轮内反复 fetch：上次值不再被反复重算",
    `¥${before?.toFixed(6)} vs ¥${after3?.toFixed(6)}`);
}

// ══ 场景 5：无 sessionId ══
console.log("\n  ── 场景 5：无 sessionId ──");
{
  const v = await fetchCost({});
  ck(v?.cost === undefined, "cost 为 undefined（正常，客户端不会传空 id）");
  ck(v?.total === Number(BALANCE.balance), "余额仍返回");
}

// ══ 场景 6：会话不存在 ══
console.log("\n  ── 场景 6：会话不存在 ──");
{
  const v = await fetchCost({ sessionId: "no-such-session" });
  ck(v?.cost === undefined, "cost 为 undefined（正常）");
}

// ══ 场景 7：非回环请求被拒（余额不应泄露到局域网）══
console.log("\n  ── 场景 7：非回环请求 ──");
{
  const { status, text } = await http({ host: "192.168.1.5:19387", remoteAddress: "192.168.1.5", body: envelope({ sessionId: SESSION_ID }) }).done();
  ck(status === 403, "外部主机被拒（403）");
  ck(!text.includes("553.5"), "响应里不含余额");
}

// ══ 场景 7b：**伪造 Host 头的远程请求也必须被拒**（回归）══
//
// 这是审查发现的漏洞：原来的校验只看 `Host`，而那是请求方自填的。
// webServer 的 host 配成 0.0.0.0 时（官方说明这种姿态不携带认证），
// 任何能连到端口的人只要发 `Host: 127.0.0.1` 就能读到余额。
// 现在主判据是 `socket.remoteAddress`，所以这个请求必须被拒。
console.log("\n  ── 场景 7b：伪造 Host 的远程请求（回归）──");
{
  const { status, text } = await http({
    host: "127.0.0.1:19387", // ← 谎报成回环
    remoteAddress: "203.0.113.9", // ← 但对端是公网地址
    body: envelope({ sessionId: SESSION_ID }),
  }).done();
  ck(status === 403, "Host 谎报成 127.0.0.1、对端却是公网 → 仍拒（403）");
  ck(!text.includes("553.5"), "响应里不含余额");

  // 反向对照：对端是回环但 Host 是外部域名 → 也应拒（防 DNS rebinding）
  const rebind = await http({
    host: "evil.example.com",
    remoteAddress: "127.0.0.1",
    body: envelope({ sessionId: SESSION_ID }),
  }).done();
  ck(rebind.status === 403, "Host 是外部域名（DNS rebinding 形态）→ 也拒（403）");

  // 三种回环写法都应放行
  for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const okCase = await http({ host: "127.0.0.1:19387", remoteAddress: addr, body: envelope({ sessionId: SESSION_ID }) }).done();
    ck(okCase.status !== 403, `对端 ${addr} 视为回环（放行）`, "status=" + okCase.status);
  }
}

// ══ 场景 8：GET 也应可用（手动 curl 排查用）══
console.log("\n  ── 场景 8：GET 请求 ──");
{
  const { status, json } = await http({ method: "GET" }).done();
  const v = json?.value ?? json;
  ck(status === 200, "GET 返回 200");
  ck(v?.configured === true, "GET 也能拿到余额");
}

// ══ 场景 9：非 fetch 的 RPC 方法应报错 ══
console.log("\n  ── 场景 9：未知 RPC 方法 ──");
{
  const { json } = await http({ body: { type: "client-request", rpcId: "rx", method: "delete-everything", payload: {} } }).done();
  ck(json?.result?.ok === false, "未知方法返回 ok:false");
  ck(typeof json?.result?.error?.details === "object", "error.details 是对象（客户端解析要求）");
}

// ══ 场景 10：客户端取数架构（静态回归检查）══
// 轮询必须是**模块级心跳**，不能挂在组件 effect 上 —— 详见 tools/heartbeat-test.mjs
console.log("\n  ── 场景 10：客户端取数架构 ──");
{
  const c = codeOnly(readFileSync(join(root, "lib", "client.js"), "utf8"));
  ck(/const beat = \{/.test(c), "存在模块级心跳对象 beat");
  ck(/function beatStart\(\)/.test(c), "存在 beatStart()");
  ck(/async function beatFetchNow\(/.test(c), "存在 beatFetchNow()");
  ck(/async function beatFetchNow\(force = false\)/.test(c), "beatFetchNow 带 force 形参（手动刷新可排队）");
  ck(/function beatRefresh\(/.test(c), "存在 beatRefresh()（点「立即刷新」走它）");
  ck(/beat\.pending = true/.test(c), "飞行中点击会排队（不再被静默吞掉）");
  ck(/setInterval\(/.test(c), "心跳用 setInterval（固定节拍，链条不会断）");
  ck(/beatStart\(\);/.test(c), "apply() 里启动了心跳");
  ck(/beat\.listeners\.add\(/.test(c), "组件订阅心跳结果");
  ck(!/setTimeout\(tick/.test(c), "已移除挂在 effect 上的链式 setTimeout 轮询");
  ck(!/\[request, refreshMs/.test(c), "依赖数组不含裸 request");
  ck(/beat\.sessionId = sessionId/.test(c), "render 阶段同步写入 sessionId（否则首次拉取会被跳过）");
  // ⚠️ 不变式：检查粒度必须 ≤ 取数周期，否则检查频率成为瓶颈
  // （注释里明写了这条，但一直没有断言 —— 设成 BEAT_MS=3000 / TURN_MS=2000 仍会全绿）
  {
    const beatMs = Number((/const BEAT_MS = (\d+)/.exec(c) ?? [])[1]);
    const turnMs = Number((/const TURN_MS = (\d+)/.exec(c) ?? [])[1]);
    ck(Number.isFinite(beatMs) && Number.isFinite(turnMs) && beatMs <= turnMs,
      "BEAT_MS ≤ TURN_MS（检查粒度不得成为瓶颈）", `BEAT_MS=${beatMs} TURN_MS=${turnMs}`);

    // ── 文档与源码的数值必须一致 ──
    //
    // ⚠️ README 里那张「刷新节奏」表曾经长期是错的：写着 BEAT_MS=2000 / TURN_MS=8000 /
    // refreshMs=60000，而源码实际是 1000 / 2000 / 15000。文档漂移没有任何机制能发现，
    // 只能靠这条断言。改常量忘了改文档 → 这里直接报错。
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const docRow = (name) => {
      const m = new RegExp("\\|\\s*`" + name + "`\\s*\\|\\s*(\\d+)").exec(readme);
      return m ? Number(m[1]) : NaN;
    };
    const refreshDefault = Number(
      (/refreshMs = isNum\(props\.refreshMs\) && props\.refreshMs > 0 \? props\.refreshMs : (\d+)/.exec(c) ?? [])[1],
    );
    const dayTtl = Number(
      (/const DAY_SCAN_TTL_MS = (\d+)/.exec(codeOnly(readFileSync(new URL("../lib/index.js", import.meta.url), "utf8"))) ?? [])[1],
    );
    const rows = [
      ["BEAT_MS", beatMs, docRow("BEAT_MS")],
      ["TURN_MS", turnMs, docRow("TURN_MS")],
      ["refreshMs", refreshDefault, docRow("refreshMs")],
      ["DAY_SCAN_TTL_MS", dayTtl, docRow("DAY_SCAN_TTL_MS")],
    ];
    for (const [name, actual, documented] of rows) {
      ck(Number.isFinite(actual) && actual === documented,
        `README 的 ${name} 与源码一致`, `源码 ${actual} / 文档 ${documented}`);
    }
  }
}
// ── 场景 11：本日消耗走"跨会话日志扫描" ──
console.log("\n  ── 场景 11：本日消耗的取数路径 ──");
{
  const src = codeOnly(readFileSync(new URL("../lib/index.js", import.meta.url), "utf8"));
  ck(/const scanTodayUsage = /.test(src), "存在 scanTodayUsage（跨会话日志扫描）");
  ck(/const dayUsage = /.test(src), "存在 dayUsage（带 60 秒缓存的入口）");
  ck(/zstdDecompressSync/.test(src), "用 zstdDecompressSync 解压会话日志");
  ck(/0x28, 0xb5, 0x2f, 0xfd/.test(src), "按 zstd 帧魔数切帧（多帧文件不能整份解）");
  ck(/beijingDayStartMs/.test(src), "用北京时间当天 0:00 作为过滤边界");
  // 曾经的 bug：用 subtractBuckets(totals, undefined) "归一化" → 恒返回 undefined
  ck(!/subtractBuckets\(totals, undefined\)/.test(src), "没有用 subtractBuckets 归一化累加结果（会恒返回 undefined）");
  ck(!/dayBaseBySession/.test(src), "已移除废弃的会话级基准");
  // 回归：本日消耗必须按**事件时间**逐条计价。
  // 曾经的实现是「汇总全天 token → × priceRateNow()」：数字会在 09:00/12:00/
  // 14:00/18:00 四个边界上，在没有任何新用量的情况下翻倍或腰斩。
  ck(/rateAt\(event\.time\)/.test(src), "本日消耗按事件时间逐条计价");
  ck(!/priceBuckets\(totals, priceRateNow\(\)\)/.test(src), "没有回退成「全天 token × 当前单价」");
}

// ── 场景 12：时段边界（确定性 —— 固定时间戳，不依赖运行时刻与机器时区）──
//
// 为什么必须有这一条：此前整套测试的期望值写死"空闲价"，于是在工作日高峰时段
// （北京 09:00-12:00 / 14:00-18:00）跑，5 条金额断言会整整差一倍。同一个提交按
// "什么时候跑"给出不同结果，而 CI 恰恰会在中国白天推送时变红。
// 时段判断是纯函数 tierAt(ms)，就该像代码一样用固定输入测边界。
console.log("\n  ── 场景 12：时段边界（固定时间戳）──");
{
  // 北京墙钟 → epoch ms（北京 = UTC+8，故减去 8 小时）
  const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
  const cases = [
    ["周三 08:59", bj(2026, 10, 28, 8, 59), false],
    ["周三 09:00", bj(2026, 10, 28, 9, 0), true],
    ["周三 11:59", bj(2026, 10, 28, 11, 59), true],
    ["周三 12:00", bj(2026, 10, 28, 12, 0), false],
    ["周三 13:59", bj(2026, 10, 28, 13, 59), false],
    ["周三 14:00", bj(2026, 10, 28, 14, 0), true],
    ["周三 17:59", bj(2026, 10, 28, 17, 59), true],
    ["周三 18:00", bj(2026, 10, 28, 18, 0), false],
    ["周六 10:00", bj(2026, 10, 31, 10, 0), false],
    ["周日 15:00", bj(2026, 11, 1, 15, 0), false],
    ["国庆 10:00", bj(2026, 10, 1, 10, 0), false],
  ];
  for (const [label, ms, wantPeak] of cases) {
    const tier = mod.tierAt(ms);
    const rate = mod.rateAt(ms);
    ck(tier.peak === wantPeak, `${label} → ${wantPeak ? "高峰" : "空闲"}`, `peak=${tier.peak}`);
    ck(rate.miss === (wantPeak ? 2 : 1) && rate.hit === (wantPeak ? 0.04 : 0.02) && rate.out === (wantPeak ? 8 : 4),
      `${label} · 单价档位正确`, `miss=${rate.miss} hit=${rate.hit} out=${rate.out}`);
  }
  // 同一批 token 在两档下的金额必须正好差 2 倍（逐事件计价的前提）
  const b = { uncachedInputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1e6, cacheWriteTokens: 0 };
  const sum = (r) => (b.uncachedInputTokens * r.miss + b.cacheReadTokens * r.hit + b.outputTokens * r.out) / 1e6;
  ck(near(sum(mod.rateAt(bj(2026, 10, 28, 10, 0))), sum(mod.rateAt(bj(2026, 10, 28, 12, 30))) * 2),
    "高峰价 = 空闲价 × 2");
}

console.log("  " + "-".repeat(52));
console.log(`  ${pass}/${total} 项通过${pass === total ? "" : "   ← 有失败项"}`);
process.exit(pass === total ? 0 : 1);
