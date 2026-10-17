/**
 * dsh-balance-mini —— host 半身
 *
 * 职责：按会话 id 读取 DeepSeek 余额与 token 用量，算好费用，经 HTTP 路由
 * 交给浏览器半身显示。凭据只在本机解析使用，永不进浏览器、不进响应体。
 *
 * 余额两条路径，按优先级：
 *   1) 首选：ctx.deepseekAccount.getBalance(client)
 *      —— DSH 自己的账号服务，已处理凭据读取、Platform 的五个客户端头、
 *         余额超时与 401 失效逻辑。不重复实现，也不接触 token。
 *   2) 兜底：直连 GET {baseURL}/user/balance（API Key 计费账号才适用）
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { hasHolidayData, isStatutoryHoliday } from "./holidays.js";


export const name = "balance-mini";
/**
 * host 半身的依赖：
 *   connection         —— 注册 RPC 通道。
 *   webServer          —— **必需**。rpc.handle 内部走 owner.webServer.register()
 *                         给通道挂 HTTP 路由，owner 是调用方的 ctx，不声明就会抛
 *                         "cannot get property \"webServer\" without inject"。
 *   sessions           —— 按 id 取会话对象，交给投影注册表读状态。
 *   sessionProjections —— stateOf(session, "tokenUsage") 读取**原始 host 状态**。
 *                         投影的 wire.view 只把 totals 发给客户端，last 被过滤掉；
 *                         stateOf 不走 wire view，所以能拿到 last.buckets
 *                         —— 这正是「单次实时消耗」的数据来源。
 *
 * 不声明 deepseekAccount：它是异步注册的服务，放进 inject 会让本插件在它就绪前
 * 被挂起（挂起的插件不执行 apply）。改为在 handler 里用 ctx.get 惰性解析。
 */
export const inject = ["connection", "webServer", "sessions", "sessionProjections"];

const RPC_CHANNEL = "/balance-mini";
const DEEPSEEK_DEFAULT_BASE = "https://api.deepseek.com";
const API_KEY_ENV = "DEEPSEEK_API_KEY";
/** 与 DSH 客户端上报一致的构建版本，Platform 客户端头会用到。 */
const CLIENT_VERSION = "0.2.0-rc.2";

function normalizeConfig(config) {
  const raw = config && typeof config === "object" ? config : {};
  const timeout = Number(raw.timeoutMs);
  const base = typeof raw.baseURL === "string" && raw.baseURL.length > 0
    ? raw.baseURL.replace(/\/+$/, "")
    : DEEPSEEK_DEFAULT_BASE;
  return { timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15000, baseURL: base };
}

/** 官方 total_balance 为字符串（如 "110.00"），数字同样兼容。 */
function toNumber(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** DSH 账号服务要求的调用方元数据（Platform 客户端头由它派生）。 */
function clientMetadata(ctx) {
  let locale = "zh-CN";
  try {
    const active = ctx?.locale?.getSnapshot?.().active;
    if (typeof active === "string" && active.length > 0) locale = active;
  } catch {
    /* 取不到就沿用默认语言 */
  }
  return {
    version: CLIENT_VERSION,
    locale,
    // Platform 约定：东为正的整秒偏移
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

/**
 * 惰性取账号服务：优先用 Cordis 的 ctx.get(name)（官方推荐的按名解析），
 * 退化为属性访问。两种写法都试，避免因解析方式差异而静默拿不到服务。
 */
function accountService(ctx) {
  try {
    const viaGet = typeof ctx.get === "function" ? ctx.get("deepseekAccount") : undefined;
    if (viaGet && typeof viaGet.getBalance === "function") return viaGet;
  } catch {
    /* 落到属性访问 */
  }
  const direct = ctx.deepseekAccount;
  return direct && typeof direct.getBalance === "function" ? direct : undefined;
}

/**
 * 首选路径：走 DSH 账号服务。
 * @returns 归一化余额，或 undefined 表示"该服务没拿到可用数据"。
 */
async function readViaAccountService(ctx) {
  const account = accountService(ctx);
  if (!account) return undefined;
  let result;
  try {
    result = await account.getBalance(clientMetadata(ctx));
  } catch {
    return undefined;
  }
  if (!result || result.status !== "ready" || !Array.isArray(result.value)) return undefined;
  const wallet = result.value.find((item) => item && toNumber(item.balance) !== undefined);
  if (!wallet) return undefined;
  const bonus = Array.isArray(result.bonusWallets)
    ? result.bonusWallets.filter((item) => item && toNumber(item.balance) !== undefined)
    : [];
  const currency = typeof wallet.currency === "string" ? wallet.currency : "CNY";
  // ⚠️ 账号侧是**两个钱包**，不是一个数：
  //   `result.value`        → 充值余额（normal_wallets）
  //   `result.bonusWallets` → 赠金余额（bonus_wallets，送的那部分，会过期）
  // 官方账号设置页把它们并列展示（语言包里 `balance: "充值余额"` /
  // `bonusBalance: "赠金余额"`）。
  //
  // 归一化成三个字段，含义固定，两条取数路径（账号服务 / API Key）口径一致：
  //   `topUp`   = 充值余额
  //   `granted` = 赠金余额（没有赠金钱包 → undefined，界面显示「—」，不伪造 0）
  //   `total`   = **总余额** = 充值 + 赠金（胶囊上那个数；赠金缺省时即等于充值）
  // 按币种对齐钱包；币种拼写不一致时回退第一个赠金钱包（否则整行会莫名消失）。
  const grantedWallet = bonus.find((item) => item.currency === currency) ?? bonus[0];
  const granted = grantedWallet ? toNumber(grantedWallet.balance) : undefined;
  const topUp = toNumber(wallet.balance);
  return {
    source: "deepseek-account",
    currency,
    topUp,
    granted,
    total: topUp + (granted ?? 0),
    bonus: bonus.map((item) => ({ currency: item.currency, balance: toNumber(item.balance) })),
  };
}

/**
 * DSH 的主目录。
 *
 * ⚠️ 必须与 readCredentialFile 用**同一个**推导方式：
 * 会话日志的扫描根目录曾经写死成 `join(homedir(), ".dsh", "sessions")`，
 * 而凭据那边认 `DSH_HOME`。两个路径一旦不一致，在设了 DSH_HOME 的机器上
 * 「本日消耗」会去读**另一个安装**的日志 —— 要么恒为空、要么把不属于本实例的
 * 消耗算进来，而且不报错。抽成一处，两边共用。
 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** 兜底：直读 ~/.dsh/.credentials.yaml（凭据缝不可用时）。 */
async function readCredentialFile() {
  try {
    const { readFile } = await import("node:fs/promises");
    const path = join(dshHome(), ".credentials.yaml");
    const text = await readFile(path, "utf8");
    const line = text.split(/\r?\n/).find((l) => /^\s*DEEPSEEK_API_KEY\s*:/.test(l));
    if (!line) return undefined;
    const value = line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function resolveApiKey(ctx) {
  try {
    const hit = await ctx.credentials?.resolve?.(API_KEY_ENV);
    if (hit && typeof hit.value === "string" && hit.value) {
      return { key: hit.value, source: `credentials:${API_KEY_ENV}` };
    }
  } catch {
    /* 缝不可用时继续兜底 */
  }
  const fromEnv = process.env[API_KEY_ENV];
  if (typeof fromEnv === "string" && fromEnv) return { key: fromEnv, source: `env:${API_KEY_ENV}` };
  const fromFile = await readCredentialFile();
  if (fromFile) return { key: fromFile, source: "file:.credentials.yaml" };
  return { key: undefined, source: "none" };
}

/** 兜底路径：API Key 计费账号的公开余额接口。 */
async function readViaApiKey(ctx, baseURL, timeoutMs) {
  const { key, source } = await resolveApiKey(ctx);
  if (!key) return { configured: false, source };
  const response = await fetch(`${baseURL}/user/balance`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`http ${response.status}`);
  const payload = await response.json();
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const first = infos.find((item) => item && toNumber(item.total_balance) !== undefined);
  if (!first) throw new Error("no balance in response");
  // 官方 /user/balance 的 `total_balance` **本身就是总额**（= granted + topped_up），
  // 与账号路径的 normal_wallets 口径不同。这里统一成同样的三个字段：
  //   topUp = topped_up_balance；granted = granted_balance；total = total_balance
  // `total` 两条路径都表示"总余额"，界面可以直接用。
  const total = toNumber(first.total_balance);
  const granted = toNumber(first.granted_balance);
  const toppedUp = toNumber(first.topped_up_balance);
  return {
    configured: true,
    source,
    currency: typeof first.currency === "string" && first.currency ? first.currency : "CNY",
    topUp: toppedUp !== undefined ? toppedUp : (granted !== undefined && total !== undefined ? total - granted : total),
    granted,
    total,
    available: payload.is_available === true,
  };
}

/**
 * 求两个 token 桶的差（当前累计 − 轮起点基准 = 本轮增量）。
 * 逐字段相减并夹到非负：累计值只会单调增长，出现负数说明基准比当前新
 * （理论上不会），夹紧比返回负值安全。
 *
 * @param {object} current - 当前 totals。
 * @param {object|undefined} base - 轮起点时的 totals；缺省表示无基准。
 * @returns {object|undefined} 增量桶，或 undefined 表示无基准可算。
 */
function subtractBuckets(current, base) {
  if (!base || typeof base !== "object") return undefined;
  if (!current || typeof current !== "object") return undefined;
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const diff = {
    uncachedInputTokens: Math.max(0, num(current.uncachedInputTokens) - num(base.uncachedInputTokens)),
    outputTokens: Math.max(0, num(current.outputTokens) - num(base.outputTokens)),
    cacheReadTokens: Math.max(0, num(current.cacheReadTokens) - num(base.cacheReadTokens)),
    cacheWriteTokens: Math.max(0, num(current.cacheWriteTokens) - num(base.cacheWriteTokens)),
  };
  const any = diff.uncachedInputTokens + diff.outputTokens + diff.cacheReadTokens + diff.cacheWriteTokens;
  return any > 0 ? diff : undefined;
}

/**
 * 当前时段的单价（元/百万 tokens，deepseek-flash）。
 *
 * 官方规则（api-docs.deepseek.com 计价页 注 2）：
 *   "北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
 *    其余时段，包括周末及中国法定节假日全天均为空闲时段。"
 *
 * 所以**先排除法定节假日，再判断工作日与时段** —— 假日全天按空闲计价。
 * 未收录该年份节假日数据时只能按"工作日 + 时段"近似（会高估假日那几天）。
 *
 * @returns {{hit:number, miss:number, out:number}} 缓存命中 / 未命中 / 输出 的单价。
 */
function priceRateNow() {
  const now = new Date();
  // 换算到北京时间：getTimezoneOffset() 是"UTC 减本地"的分钟数，+480 分钟即 +8 区。
  const beijing = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const day = beijing.getDay();
  const hour = beijing.getHours() + beijing.getMinutes() / 60;
  const weekday = day >= 1 && day <= 5;
  const inPeakHours = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  const holiday = isStatutoryHoliday(beijing.getFullYear(), beijing.getMonth() + 1, beijing.getDate());
  const peak = weekday && inPeakHours && !holiday;
  return { hit: peak ? 0.04 : 0.02, miss: peak ? 2 : 1, out: peak ? 8 : 4 };
}

/** 按给定单价把一段 token 桶折算成金额（元）；桶为空或全零时返回 undefined。 */
function priceBuckets(buckets, rate) {
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  if (!buckets || typeof buckets !== "object") return undefined;
  const tokens = num(buckets.uncachedInputTokens) + num(buckets.outputTokens) + num(buckets.cacheReadTokens) + num(buckets.cacheWriteTokens);
  if (tokens === 0) return undefined;
  return (num(buckets.uncachedInputTokens) * rate.miss
    + num(buckets.cacheReadTokens) * rate.hit
    + num(buckets.cacheWriteTokens) * rate.miss
    + num(buckets.outputTokens) * rate.out) / 1e6;
}

/**
 * 按会话 id 读取 token 用量并计价。
 *
 * 数据来源：`ctx.sessionProjections.stateOf(session, "tokenUsage")` —— host 侧原始
 * 状态，不像 wire.view 那样只导出 totals，所以能拿到 `last.buckets`（最近一步的
 * 用量），这正是官方 UI 从不展示的那部分数据（官方只把 totals 发给浏览器）。
 *
 * 形状（usage-projection.js 的 stateSchema）：
 *   { totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
 *     last: { turn, step, buckets: { 同样四个字段 } } | null }
 *
 * 计价按 DeepSeek 官方价目表（元/百万 tokens，deepseek-flash）：
 *   空闲/高峰 —— 缓存命中 0.02/0.04、缓存未命中 1/2、输出 4/8
 * 高峰 = 北京时间周一至周五（不含法定节假日）9:00-12:00、14:00-18:00。
 * 法定节假日无法从本地推算，会偏高估；其余时段判定准确。
 *
 * @param {object} ctx - 插件上下文。
 * @param {string} sessionId - 目标会话 id。
 * @param {object|undefined} turnBase - 本轮起点时的 totals（无则本轮金额不可算）。
 * @param {number|undefined} turns - 官方 sessionStats 的轮数，用于每轮平均消耗。
 * @param {number|undefined} lastTurn - 上一轮的最终消耗；没有进行中的轮次时用它代替 undefined，
 *   这样界面能显示"上次"而不是空白（见 apply 里的 lastTurnBySession）。
 * @param {{yuan?: number, tokens?: object}|undefined} dayInfo - 「本日」消耗与 token
 *   （北京时间 0:00 起、**跨全部会话**统计，由 dayUsage() 算好传入）。
 * @param {boolean} hasOpenTurn - turnBoundary.openTurnStartSeq 是否为数字（有进行中的轮次）。
 */
function computeCost(ctx, sessionId, turnBase, turns, dayInfo, lastTurn, hasOpenTurn) {
  // 取不到会话或用量时静默返回 undefined。会话刚建立的头几秒确实可能查不到
  // （ctx.sessions.get 只认活着的会话），客户端会用 3 秒间隔快速重试补上。
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  let session;
  try {
    session = ctx.sessions.get(sessionId);
  } catch {
    return undefined;
  }
  if (!session) return undefined;
  let state;
  try {
    state = ctx.sessionProjections.stateOf(session, "tokenUsage");
  } catch {
    return undefined;
  }
  if (!state || typeof state !== "object") return undefined;

  const now = new Date();
  // 换算到北京时间：getTimezoneOffset() 是"UTC 减本地"的分钟数，+480 分钟即 +8 区。
  const beijing = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const day = beijing.getDay();
  const hour = beijing.getHours() + beijing.getMinutes() / 60;

  // 官方规则（https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 注 2）：
  //   "北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
  //    其余时段，包括周末及中国法定节假日全天均为空闲时段。"
  const weekday = day >= 1 && day <= 5;
  const inPeakHours = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  const holiday = isStatutoryHoliday(beijing.getFullYear(), beijing.getMonth() + 1, beijing.getDate());
  // 该年份未收录节假日数据时，只能按"工作日 + 时段"近似（会高估假日那几天）。
  const holidayDataKnown = hasHolidayData(beijing.getFullYear());
  // 法定节假日全天按空闲计价，所以先排除假日再判断时段。
  const peak = weekday && inPeakHours && !holiday;
  // 单价单独抽成 priceRateNow()，好让 handler 里记录"上一轮结束值"时能复用同一套规则。
  const rate = priceRateNow();

  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const priceOf = (b) => priceBuckets(b, rate);

  const totalYuan = priceOf(state.totals);
  const lastBuckets = state.last && typeof state.last === "object" ? state.last.buckets : undefined;
  const lastYuan = priceOf(lastBuckets);
  // 本轮金额 = (当前 totals − 轮起点 totals)，即这一轮从发问到此刻的合计。
  const turnBuckets = subtractBuckets(state.totals, turnBase);
  const turnYuan = priceOf(turnBuckets);
  if (totalYuan === undefined && lastYuan === undefined && turnYuan === undefined) return undefined;

  const pick = (b) => (b && typeof b === "object"
    ? {
      uncachedInputTokens: num(b.uncachedInputTokens),
      outputTokens: num(b.outputTokens),
      cacheReadTokens: num(b.cacheReadTokens),
      cacheWriteTokens: num(b.cacheWriteTokens),
    }
    : undefined);

  const totalTokens = pick(state.totals);

  /**
   * 有没有"进行中的轮次"？由调用方从 turnBoundary.openTurnStartSeq 得到。
   *
   * ⚠️ 不能用 `turnBuckets === undefined` 代替：**本轮刚开始、增量恰为 0** 与
   * "根本没有进行中的轮次"都会得到 undefined，但语义完全不同。
   *
   * 显示策略（两分支，刻意简单）：
   *   · 有进行中的轮次 → 用实时值（可能为 0 = 本轮刚开始）
   *   · 没有进行中的轮次 → 用**上一轮结束时**记录的值，避免界面留空白
   *     （"每次打开默认显示上次"就是靠这一条）
   */
  const openTurn = hasOpenTurn === true;
  const turnValue = openTurn
    ? (turnYuan !== undefined ? turnYuan : 0)
    : lastTurn;

  return {
    // 金额：会话累计 / 本轮合计（无进行中的轮次时为上一轮的值）/ 最近一步
    total: totalYuan,
    turn: turnValue,
    last: lastYuan,
    // 本日消耗与 token（北京时间 0:00–24:00 区间内的增量）
    day: dayInfo && typeof dayInfo === "object" ? dayInfo.yuan : undefined,
    dayTokens: dayInfo && typeof dayInfo === "object" && dayInfo.tokens ? pick(dayInfo.tokens) : undefined,
    peak,
    // 判断依据一并返回，便于界面说明"为什么是空闲/高峰"
    holiday,
    holidayDataKnown,
    totalTokens,
    // 每轮平均消耗：会话累计 ÷ 官方轮数（sessionStats.turns）
    avgPerTurn: totalYuan !== undefined && typeof turns === "number" && turns > 0
      ? totalYuan / turns
      : undefined,
    turns: typeof turns === "number" && turns > 0 ? turns : undefined,
    // 缓存占比：解释成本为何这么低（缓存读取单价 0.02，未缓存输入 1，差 50 倍）
    cacheShare: totalTokens && (totalTokens.cacheReadTokens + totalTokens.uncachedInputTokens + totalTokens.outputTokens + totalTokens.cacheWriteTokens) > 0
      ? totalTokens.cacheReadTokens / (totalTokens.cacheReadTokens + totalTokens.uncachedInputTokens + totalTokens.outputTokens + totalTokens.cacheWriteTokens)
      : undefined,
  };
}

export function apply(ctx, config) {
  const { timeoutMs, baseURL } = normalizeConfig(config);

  /**
   * 每轮对话的 token 累计基准（按会话对象）。
   *
   * 为什么要这个：官方 tokenUsage 只有两个口径 —— `totals`（整个会话累计）与
   * `last`（最近一步）。而用户真正关心的是"我这一句话花了多少"，那是**一轮**
   * （turn）的合计，官方不提供。
   *
   * 一轮的合计 = 当前 totals − 本轮开始时的 totals。所以需要记住本轮起点。
   *
   * ⚠️ **不要在 `ctx.on("session/event")` 回调里读投影。** 曾经那么做过
   * （监听 turn/start 立刻快照），结果造成重入：官方投影注册表自己也监听同一事件
   * 做 fold，在它派发过程中读同一注册表会破坏其状态，之后所有 `stateOf` 全部失败
   * —— 表现为 `cost` 整块消失，且要运行一段时间后才出现，极难定位。
   *
   * 现在改为**纯 fetch 时读取**：用官方 `turnBoundary` 投影的 `openTurnStartSeq`
   * 作为"当前轮"的身份（同一轮内该值不变），比对上轮记录；变化即说明新的一轮开始，
   * 把当前 totals 记为基准。
   *
   * 用 WeakMap 按会话对象存活：会话被回收时基准自动释放。
   */
  const turnBaseBySession = new WeakMap();

  /** 复制一份 totals（官方注明 stateOf 返回的是 live 值，调用方不得修改）。 */
  const snapshotTotals = (session) => {
    try {
      const state = ctx.sessionProjections.stateOf(session, "tokenUsage");
      const t = state && typeof state === "object" ? state.totals : undefined;
      if (!t || typeof t !== "object") return undefined;
      return {
        uncachedInputTokens: Number(t.uncachedInputTokens) || 0,
        outputTokens: Number(t.outputTokens) || 0,
        cacheReadTokens: Number(t.cacheReadTokens) || 0,
        cacheWriteTokens: Number(t.cacheWriteTokens) || 0,
      };
    } catch {
      return undefined;
    }
  };

  /**
   * 每个会话「上一轮结束时的消耗」（按会话对象，WeakMap 自动释放）。
   *
   * 用途：没有进行中的轮次时（刚打开 DSH、或上一轮刚结束），界面显示这个值，
   * 而不是显示空白 `—`。这样用户一打开就能看到"上一次问话花了多少"。
   *
   * ⚠️ 存在内存里，**DSH 重启后为空** —— 那时要等新一轮结束才有值。
   * 这是刻意的取舍：会话事件既有历史可以重算，但需要额外读整条日志，
   * 而这里要的只是一个"上次"参考值。
   */
  const lastTurnBySession = new WeakMap();

  /** 把 prev（某轮起点）到此刻的差值作为"上一轮最终值"记录下来。 */
  const recordFinishedTurn = (session, prev) => {
    const finished = subtractBuckets(snapshotTotals(session), prev.totals);
    const yuan = priceBuckets(finished, priceRateNow());
    if (yuan !== undefined) lastTurnBySession.set(session, yuan);
  };

  /** 北京时间的日期戳（YYYY-MM-DD），用于判断是否跨天。 */
  function beijingDayKey(now = new Date()) {
    // getTimezoneOffset() 是"UTC 减本地"的分钟数，+480 分钟即 +8 区
    const beijing = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
    const y = beijing.getFullYear();
    const m = String(beijing.getMonth() + 1).padStart(2, "0");
    const d = String(beijing.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /** 北京时间当天 0:00 对应的毫秒时间戳（用于按时间过滤日志事件）。 */
  function beijingDayStartMs(now = new Date()) {
    const beijing = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
    // Date.UTC 把"北京日期"当成 UTC 构造，再减回 8 小时即真实 UTC 毫秒
    return Date.UTC(beijing.getFullYear(), beijing.getMonth(), beijing.getDate()) - 480 * 60000;
  }

  /**
   * 返回「本日」的消耗金额与 token 用量。
   *
   * 与「本轮消耗」用的是同一套差值手法，只是基准换成"当天 0:00 的累计"：
   * 首次被问到就建基准；跨天则把基准重置为当前的累计值（即新一天的起点）。
   *
   * @returns {{yuan: number|undefined, tokens: object|undefined}} 当天 0:00 起的增量。
   */
  /**
   * 扫描**所有会话**的日志，累计"今天"（北京时间 0:00 起）的 token 用量。
   *
   * ## 为什么不能只用宿主内存里的会话
   *
   * `ctx.sessions.list()` 只给**已载入内存的活会话**。DSH 重启后只有当前打开的会话
   * 在内存里，其余会话（今天跑过的）都读不到 —— 而用户要的是"当天所有会话的总和"。
   * 所以必须下沉到磁盘上的会话日志。
   *
   * ## 为什么日志里能按天切分
   *
   * 官方写下的 `assistant/message` 事件**同时带时间和用量**：
   * ```json
   * {"type":"assistant/message","seq":12267,"time":1791653047821,
   *  "data":{"turn":134,"step":17,"usage":{
   *    "inputTokens":209,"outputTokens":330,
   *    "cacheReadTokens":286592,"cacheWriteTokens":0,"totalTokens":287131}}}
   * ```
   * 有 `time` 就能精确按天求和，不需要"午夜基准"这种近似手段。
   *
   * ## 为什么成本可接受
   *
   * 日志是**追加写**的，最新事件在文件末尾，而压缩是**分帧 zstd**（每帧几个事件）。
   * 所以从最后一个帧往前扫、遇到早于今天 0:00 的事件就停 —— 只需解压当天那一段。
   * 实测：8 个会话共 12MB 日志，扫描耗时约 190ms（其中大部分会话当天无活动，
   * 扫一两帧就停）。
   *
   * ⚠️ `zstdDecompressSync` 只解**第一帧**，多帧文件必须逐帧解压 —— 直接用它会
   * 得到空结果（本项目踩过：9.5MB 的日志"解压出 0KB"）。
   *
   * ⚠️ 这是**同步 IO**，跑在请求路径上，所以先用 `statSync(...).mtimeMs` 挡掉
   * 一整天没动过的会话（见下方循环内的说明）。
   *
   * @returns {{yuan?: number, tokens?: object}}
   */
  const scanTodayUsage = () => {
    const dayStart = beijingDayStartMs();
    const cacheRoot = join(dshHome(), "sessions");
    const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    let workspaces;
    try {
      workspaces = readdirSync(cacheRoot);
    } catch {
      return { yuan: undefined, tokens: undefined };
    }

    // zstd 帧魔数 28 B5 2F FD
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

    for (const ws of workspaces) {
      let ids;
      try {
        ids = readdirSync(join(cacheRoot, ws));
      } catch {
        continue;
      }
      for (const id of ids) {
        const file = join(cacheRoot, ws, id, "session.v4.jsonl.zstd");

        // ⚠️ **先用 mtime 挡掉一整天没动过的会话**，再决定要不要读文件。
        //
        // 这一步是必需的：扫描是**同步 IO**、且跑在请求路径上（handler → dayUsage）。
        // `readFileSync` 与魔数全量索引都是整文件 O(n)，"遇到今天之前就停"只省下
        // **解压**那一部分。日志大的用户每次刷新（缓存 60 秒）都会让宿主事件循环
        // 冻结数百毫秒到数秒 —— GUI 与所有会话事件一起卡住。
        //
        // mtime 早于今天 0:00 ⇒ 该文件里不可能有今天的用量（日志是追加写、只增不改），
        // 直接跳过。实测本机 11 个会话里有 7 个能被这一步挡掉，省掉约 1/4 的字节量；
        // 用户会话越多、这个比例越高（历史会话远多于当天活跃会话）。
        try {
          if (statSync(file).mtimeMs < dayStart) continue;
        } catch {
          continue; // 文件不存在（空会话）或不可读
        }

        let buf;
        try {
          buf = readFileSync(file);
        } catch {
          continue; // 正在被独占写入
        }

        // 索引所有帧的起始偏移
        const offsets = [];
        let i = 0;
        for (;;) {
          const at = buf.indexOf(MAGIC, i);
          if (at < 0) break;
          offsets.push(at);
          i = at + 4;
        }

        // 从尾部往前扫，遇到今天之前的事件即停
        for (let k = offsets.length - 1; k >= 0; k -= 1) {
          const start = offsets[k];
          const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
          let text;
          try {
            text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
          } catch {
            continue; // 该帧可能正在写入，跳过
          }
          let oldest = Infinity;
          for (const line of text.split("\n")) {
            if (line === "") continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (typeof event.time === "number" && event.time < oldest) oldest = event.time;
            const usage = event.data && event.data.usage;
            if (!usage || typeof event.time !== "number") continue;
            if (event.time < dayStart) continue;
            // 官方 projection 把 usage.inputTokens 归入 uncachedInputTokens
            totals.uncachedInputTokens += Number(usage.inputTokens) || 0;
            totals.outputTokens += Number(usage.outputTokens) || 0;
            totals.cacheReadTokens += Number(usage.cacheReadTokens) || 0;
            totals.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0;
          }
          if (oldest < dayStart) break; // 已越过今天的边界
        }
      }
    }

    // ⚠️ 不要用 subtractBuckets 来"归一化" —— 它要求 base 是对象，
    // 传 undefined 会**直接返回 undefined**（见该函数第一行），
    // 于是本日消耗永远算不出来。totals 本身就是从 0 累加的增量，直接用。
    const tokens = pickTokens(totals);
    const yuan = priceBuckets(totals, priceRateNow());
    // 只返回被消费的两个字段。曾经还回 sessions/scannedMs 作诊断，但调用方
    // （dayUsage → handler）与客户端都没读过，属于死负载。
    return { yuan, tokens };
  };

  /** 从桶里取四个字段（与 snapshotTotals 同形状），全零时返回 undefined。 */
  function pickTokens(b) {
    if (!b || typeof b !== "object") return undefined;
    const sum = (Number(b.uncachedInputTokens) || 0) + (Number(b.outputTokens) || 0)
      + (Number(b.cacheReadTokens) || 0) + (Number(b.cacheWriteTokens) || 0);
    if (sum === 0) return undefined;
    return {
      uncachedInputTokens: Number(b.uncachedInputTokens) || 0,
      outputTokens: Number(b.outputTokens) || 0,
      cacheReadTokens: Number(b.cacheReadTokens) || 0,
      cacheWriteTokens: Number(b.cacheWriteTokens) || 0,
    };
  }

  /**
   * 「本日消耗」带缓存：扫描要 ~190ms，不能每次 fetch（2 秒一次）都做。
   * 缓存 60 秒；跨天自动失效。
   */
  const DAY_SCAN_TTL_MS = 60000;
  let dayCache = { day: "", at: 0, value: undefined };
  const dayUsage = () => {
    const day = beijingDayKey();
    const now = Date.now();
    if (dayCache.value !== undefined && dayCache.day === day && now - dayCache.at < DAY_SCAN_TTL_MS) {
      return dayCache.value;
    }
    const value = scanTodayUsage();
    dayCache = { day, at: now, value };
    return value;
  };

  /** handler(endpoint, payload) → RPC result 形状：{ ok, value } 或 { ok:false, error } */
  const handler = async (endpoint, payload) => {
    if (endpoint !== "fetch") {
      return { ok: false, error: { code: "bad-request", message: `unknown endpoint: ${endpoint}` } };
    }

    const queriedAt = new Date().toISOString();
    // 费用与余额同源返回：客户端不做任何计算，只负责显示。
    const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    let cost;
    try {
      const session = typeof sessionId === "string" && sessionId !== "" ? ctx.sessions.get(sessionId) : undefined;
      let turnBase;
      let turns;
      let day;
      // 当前轮的身份（turnBoundary.openTurnStartSeq）。声明在**外层**，
      // 因为 computeCost 调用处也要用它判断"有没有进行中的轮次"。
      let turnSeq;
      if (session) {
        // ── 本轮基准：**只在 fetch 时读投影，绝不在事件回调里读** ──────────────
        // 曾经的做法是在 ctx.on("session/event") 里捕获 turn/start 并立刻调 stateOf()
        // 取快照。那会造成重入：官方投影注册表自己也在监听同一事件做 fold，
        // 在它派发过程中读同一注册表有破坏其状态的风险。现已完全移除订阅。
        //
        // 现在用官方 turnBoundary 投影的 openTurnStartSeq 作为"当前轮"的身份：
        // 同一轮内该值不变，变化即说明新的一轮开始了。
        //
        // ⚠️ **turnSeq 读不到时也必须建基准**。踩过的坑：新会话还没有 turn/start，
        // openTurnStartSeq 是 null（不是 number），于是整个分支被跳过、基准永不建立、
        // turnBase 恒为 undefined → computeCost 返回 undefined → **cost 整块消失**，
        // 界面什么都不显示。所以这里用 undefined 也照样记录，只是把身份标记为"未知"。
        try {
          const boundary = ctx.sessionProjections.stateOf(session, "turnBoundary");
          if (boundary && typeof boundary === "object" && typeof boundary.openTurnStartSeq === "number") {
            turnSeq = boundary.openTurnStartSeq;
          }
        } catch {
          turnSeq = undefined;
        }

        const prev = turnBaseBySession.get(session);
        if (prev === undefined) {
          // 本会话第一次问：以当前累计值作为基准（此前的历史消耗不计入"本轮"）。
          const snap = snapshotTotals(session);
          if (snap !== undefined) turnBaseBySession.set(session, { turnSeq, totals: snap });
        } else if (turnSeq !== undefined && prev.turnSeq === undefined) {
          // 首次问话时读不到 openTurnStartSeq（会话刚建立），现在读到了 —— 只补记身份，
          // **不动基准**，基准仍以首次问话那一刻为准。
          //
          // ⚠️ 这个分支必须排在下面「新的一轮」之前：prev.turnSeq === undefined 时
          // 更下面的 `prev.turnSeq !== turnSeq` 同样成立，会被误判成新轮而重置基准。
          turnBaseBySession.set(session, { turnSeq, totals: prev.totals });
        } else if (turnSeq !== undefined && prev.turnSeq !== turnSeq) {
          // 进入了新的一轮。
          //
          // 先把**上一轮**的最终值记下来：此刻 totals 还停在上一轮结束时的状态，
          // 与 prev.totals（上一轮起点）的差值就是上一轮的完整消耗。
          // 这样没有进行中的轮次时，界面可以显示上次的值而不是空白。
          //
          // ⚠️ 必须**在重置基准之前**算，否则差值会被清零。
          recordFinishedTurn(session, prev);

          // ⚠️⚠️ **必须重置基准，并把身份一起更新成新的 turnSeq。**
          //
          // 曾经漏掉了这一步，导致一个很隐蔽的严重 bug：
          //   prev.turnSeq 一直停在第一轮的 seq 上 → **之后每一次 fetch 都命中本分支**，
          //   基准永远读回第一轮的值 → 「本轮消耗」= 当前 totals − 第一轮基准
          //   = **整个会话累计**，与面板里的「会话累计」同值；
          //   同时 lastTurn 被每次 fetch 反复覆盖成累计值。
          //   表现是"新的一轮开始时本轮消耗不归零"，而数字看起来仍然合理，极难发现。
          //
          // 身份必须一起更新：只改 totals 不改 turnSeq 的话，下一次 fetch 仍然
          // prev.turnSeq !== turnSeq，会继续落进本分支、继续重置（基准永远停在"上一次 fetch"）。
          const freshSnap = snapshotTotals(session);
          turnBaseBySession.set(session, {
            turnSeq,
            // 新一轮的起点 = 此刻的累计值。
            // 取不到就置 undefined（本轮显示占位），**不要回退用 prev.totals** ——
            // 那会让新一轮一开局就显示上一轮的花费，是错的数。
            totals: freshSnap,
          });
        } else if (turnSeq === undefined && prev.turnSeq !== undefined) {
          // 一轮结束了（openTurnStartSeq 从数字变回 null）：把该轮最终值记为"上次"。
          recordFinishedTurn(session, prev);
          // 基准**保留不动**（此时 totals 已停在轮末，是下一轮开始前最准的参照）；
          // 等下一轮开始时那个分支再用当时的实时快照重置，并把身份更新成新 seq。
          //
          // ⚠️ 这里**不要**把 turnSeq 写成 undefined：
          // 写了的话下一轮开始时 prev.turnSeq === undefined，会命中上面那个
          // "首次补记身份"分支（只补身份、不重置基准），于是基准又永远停在旧值。
        }
        turnBase = turnBaseBySession.get(session)?.totals;

        // 本日消耗与 token（北京时间 0:00 起算）。放在这里而非 computeCost 里，
        // 是因为它需要**建立/重置基准**这个副作用，属于会话级状态维护。
        day = dayUsage();

        try {
          const stats = ctx.sessionProjections.stateOf(session, "sessionStats");
          if (stats && typeof stats.turns === "number") turns = stats.turns;
        } catch {
          turns = undefined;
        }
      }
      cost = computeCost(
        ctx, sessionId, turnBase, turns, day,
        session ? lastTurnBySession.get(session) : undefined,
        turnSeq !== undefined,
      );
    } catch {
      cost = undefined;
    }

    // 1) 首选：DSH 账号服务
    try {
      const viaAccount = await readViaAccountService(ctx);
      if (viaAccount) {
        return { ok: true, value: { configured: true, queriedAt, account: true, cost, ...viaAccount } };
      }
    } catch {
      // 账号服务不可用：继续走 API Key 兜底
    }

    // 2) 兜底：API Key
    try {
      const viaKey = await readViaApiKey(ctx, baseURL, timeoutMs);
      return { ok: true, value: { queriedAt, account: false, cost, ...viaKey } };
    } catch (error) {
      const message = error && error.name === "TimeoutError" ? "timeout" : String(error?.message ?? error).slice(0, 120);
      // 只回错误类别，绝不回响应体（可能含敏感信息）
      return { ok: true, value: { configured: true, queriedAt, account: false, cost, error: message } };
    }
  };

  /**
   * 注册余额路由。
   *
   * 为什么不用 ctx.connection.rpc.handle()：该方法的 owner 取的是 connection 实例
   * 自己的 ctx，它读不到 webServer（与加载时机无关，重试 15 次错误一字不变），
   * 恒抛 "cannot get property \"webServer\" without inject"。而本插件自己的 ctx
   * 能访问 ctx.webServer（它在本插件的 inject 里），所以直接注册 HTTP 路由。
   *
   * 安全：绕过了 Connection 的 BrowserAuth，因此自行校验请求来源只接受回环地址，
   * 避免余额被局域网读到。
   */
  /**
   * 是否来自本机。
   *
   * ⚠️ **主判据是对端地址，不是 `Host` 头。**
   *
   * 曾经只查 `Host`，但那**是请求方自填的**：webServer 的 host 配成 `0.0.0.0` 时
   * （官方 README 说明这种姿态"有意向网络开放，不携带 TLS/认证/来源策略"），
   * 任何能连到端口的人只要发 `Host: 127.0.0.1` 就能读到余额与消耗 ——
   * 而本路由**绕过了 Connection 的 BrowserAuth**，这道检查是唯一门槛。
   *
   * 现在以 `req.socket.remoteAddress` 为准（回环有 `127.0.0.1` / `::1` /
   * IPv4-mapped 的 `::ffff:127.0.0.1` 三种写法），`Host` 校验保留作第二道 ——
   * 它挡的是 DNS rebinding（浏览器把攻击者域名解析到 127.0.0.1 后发请求，
   * 此时对端确实是回环，但 Host 会是那个域名）。
   */
  const isLoopbackRequest = (req) => {
    // 第一道：对端必须真的是回环。
    const remote = String(req.socket?.remoteAddress ?? "").toLowerCase();
    const remoteOk =
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1" ||
      remote.startsWith("127.");
    if (!remoteOk) return false;

    // 第二道：Host 头也得是本机名（挡 DNS rebinding）。
    const host = String(req.headers.host ?? "");
    const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    return name === "127.0.0.1" || name === "localhost" || name === "::1";
  };

  /**
   * 读请求体并解析 JSON。
   *
   * ⚠️ 必须处理 `close`：客户端连上后 body 没发完就断开时，`end` 永远不会触发，
   * promise 永不 settle → handler 挂起且不写任何响应。加 `close` 与超时兜底。
   */
  const readBodyJson = (req) =>
    new Promise((resolve) => {
      let raw = "";
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), 5000);
      // 声明按 UTF-8 字符流解码：不这样做的话，多字节字符被 chunk 边界切断会变成
      // 替换字符，JSON.parse 随之失败。（当前 payload 只有 ASCII，属于防御性处理。）
      try {
        req.setEncoding("utf8");
      } catch {
        /* 某些流不支持，忽略 */
      }
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 65536) raw = raw.slice(0, 65536); // 防御性上限
      });
      req.on("end", () => {
        if (raw.trim() === "") return finish(undefined);
        try {
          finish(JSON.parse(raw));
        } catch {
          finish("PARSE_ERROR");
        }
      });
      req.on("error", () => finish(undefined));
      req.on("close", () => finish(undefined));
    });

  /**
   * 两种请求形状都支持：
   *  1) 浏览器半身经 connection.rpc.call 发来的**带信封** RPC：
   *     { type:"client-request", rpcId, method, payload }
   *     必须回 { type:"server-response", rpcId, result:{ ok:true, value } }。
   *     客户端校验 rpcId（不符即抛 rpcId mismatch），所以 rpcId 必须原样回传；
   *     失败形状还要求 error.details 是对象，否则客户端解析时抛 TypeError。
   *  2) 裸 JSON POST（手动排查用），直接回 { ok, value }。
   */
  const routeHandler = async (req, res) => {
    const pathname = (() => {
      try {
        return new URL(req.url ?? "/", "http://x").pathname;
      } catch {
        return "";
      }
    })();
    const endpoint = pathname.startsWith(RPC_CHANNEL + "/") ? pathname.slice(RPC_CHANNEL.length + 1) : "";

    const write = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    };

    if (req.method !== "POST" && req.method !== "GET") return write(405, { error: "method not allowed" });
    if (!isLoopbackRequest(req)) return write(403, { error: "forbidden" });
    if (endpoint === "") return write(404, { error: "missing endpoint" });

    const body = req.method === "POST" ? await readBodyJson(req) : undefined;
    if (body === "PARSE_ERROR") return write(400, { error: "body is not JSON" });

    const isEnvelope = body !== null && typeof body === "object" && body.type === "client-request" && typeof body.rpcId === "string";
    const rpcId = isEnvelope ? body.rpcId : undefined;
    const method = isEnvelope ? String(body.method ?? "") : endpoint;

    const reply = (result) => {
      if (!isEnvelope) return write(200, result);
      if (method !== endpoint) {
        return write(200, {
          type: "server-response",
          rpcId,
          result: {
            ok: false,
            error: {
              code: "gateway/bad-request",
              message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
              details: { issues: [] },
            },
          },
        });
      }
      return write(200, { type: "server-response", rpcId, result });
    };

    try {
      const payload = isEnvelope && body.payload !== null && typeof body.payload === "object" ? body.payload : {};
      return reply(await handler(method, payload));
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 200);
      // 信封里回业务失败（带 details），裸请求回结构化错误；都不落进传输异常分支
      return reply({ ok: false, error: { code: "internal", message, details: {} } });
    }
  };

  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: "prefix", path: RPC_CHANNEL, handler: routeHandler }),
      "balance-mini: /balance-mini route",
    );
  } catch (error) {
    ctx.logger?.warn?.(`balance-mini: route registration failed: ${String(error?.message ?? error)}`);
  }
}
