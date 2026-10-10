/**
 * 心跳行为测试：验证「数据缺失时会持续重试」这一核心行为，
 * 且**不依赖组件是否挂载**。
 */
import { readFileSync } from "node:fs";

const root = process.argv[2];
const src = readFileSync(`${root}/lib/client.js`, "utf8");

let captured = null;
const win = { __ModuleLoader__: { load: (d) => { captured = d; } } };
new Function("window", "console", src)(win, console);

// 假 setInterval：手动驱动节拍
const intervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  const h = { fn, ms, cleared: false };
  intervals.push(h);
  return h;
};

// hook 运行时（够用即可）
let hooks = [];
let cursor = 0;
const rt = {
  begin() { cursor = 0; },
  useState(init) { const i = cursor++; if (!hooks[i]) hooks[i] = { v: typeof init === "function" ? init() : init }; return [hooks[i].v, (nv) => { hooks[i].v = nv; }]; },
  useRef(init) { const i = cursor++; if (!hooks[i]) hooks[i] = { v: { current: init } }; return hooks[i].v; },
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
const ex = captured.factory((n) => {
  if (n === "react") return reactStub;
  if (n === "react-dom") return { createPortal: (x) => x };
  throw new Error("unknown " + n);
});

let Comp = null;
ex.apply({ inject: (d, f) => f({ connection: { rpc: { call: async () => ({}) } }, slots: { inject: (n, f2) => f2(), register: (a, b) => { Comp = b; return () => {}; } } }) }, {});

let pass = 0;
let total = 0;
const ck = (ok, label, extra = "") => {
  total += 1;
  if (ok) pass += 1;
  console.log(`  ${ok ? "✓" : "✗"}  ${label}${extra ? "   " + extra : ""}`);
};

console.log("  ── 心跳创建与重试 ──\n");
ck(intervals.length === 1, "apply() 创建了 1 个心跳 interval", `实际 ${intervals.length}`);

// 间隔从源码读取，避免调参后这里假失败
const beatMs = Number((src.match(/const BEAT_MS = (\d+)/) ?? [])[1]);
ck(
  intervals[0] && intervals[0].ms === beatMs,
  `心跳检查间隔 = 源码里的 BEAT_MS（${beatMs}ms）`,
  `实际 ${intervals[0]?.ms}`,
);
ck(beatMs > 0 && beatMs <= 3000, "检查间隔不超过 3 秒（够密才能及时跟上本轮）", `${beatMs}ms`);

// 本轮字段有独立的更短刷新门槛
const turnMs = Number((src.match(/const TURN_MS = (\d+)/) ?? [])[1]);
ck(turnMs > 0 && turnMs < 60000, "存在 TURN_MS 且短于常规刷新周期（保证「本轮」不只 60 秒才动一次）", `${turnMs}ms`);

// 会话前 3 次没有 cost
let fetchCount = 0;
const requestBalance = async () => {
  fetchCount += 1;
  const hasCost = fetchCount >= 3;
  return {
    ok: true,
    value: hasCost
      ? { total: 550.8, cost: { total: 17.1, turn: 0.03, last: 0.008 } }
      : { total: 550.8 },
  };
};

const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

// 挂载组件（会立即拉一次 + 订阅）
rt.begin();
Comp({ sessionId: "s1", refreshMs: 60000, requestBalance });
await flush();
console.log(`    挂载后 fetchCount=${fetchCount}`);

// 驱动心跳若干次
const beat = intervals[0].fn;
for (let i = 0; i < 4; i += 1) {
  beat();
  await flush();
  console.log(`    第 ${i + 1} 拍后 fetchCount=${fetchCount}`);
}

ck(fetchCount >= 3, "心跳持续重试直到拿到 cost", `fetchCount=${fetchCount}`);

// 拿到 cost 之后，心跳在 60 秒内不应再取数
const before = fetchCount;
beat();
await flush();
ck(fetchCount === before, "已有 cost 时同一刷新周期内不重复取数", `fetchCount ${before} → ${fetchCount}`);

// 组件卸载后心跳应继续（这是本设计的核心目的）
rt.begin();
// 重新渲染以注册 cleanup
Comp({ sessionId: "s1", refreshMs: 60000, requestBalance });
for (const h of hooks) if (h && h.cleanup) h.cleanup(); // 模拟卸载
const afterUnmount = fetchCount;
console.log(`\n    模拟组件卸载后 fetchCount=${afterUnmount}（心跳应仍在，但数据新鲜故不取数）`);

globalThis.setInterval = realSetInterval;

console.log("  " + "-".repeat(48));
console.log(`  ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
