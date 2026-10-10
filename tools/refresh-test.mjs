/**
 * 「↻ 立即刷新」的行为测试。
 *
 * 为什么单独一个文件：这条路径**不能用复刻来测**。
 * 我先后写了四版复刻脚手架，每一版都因细节差异给出错误结论
 * （await 时机、多场景共用 resolver、resolver 被覆盖），
 * 而真实实现明明是对的。最终改为**直接从 lib/client.js 里 eval 出 beat 状态机**，
 * 测的就是会上线的那段代码。
 *
 * 覆盖：
 *   · 飞行中点击 → 排队，结束后自动补发（用户点了一定有新数据）
 *   · 连点三下 → 合并为一次，不会打爆
 *   · 空闲时点击 → 直接生效
 *   · 对照：心跳调用（不带 force）在飞行中仍静默去重，**不**排队
 *
 * 用法：node tools/refresh-test.mjs [插件根目录]
 */
/**
 * 在**真实源码**上验证「立即刷新」，不靠复刻。
 *
 * 做法：读出 lib/client.js，把 beat 状态机那一段连同它的依赖一起 eval 出来
 * （源码是纯函数式的一组 function + 一个 const 对象，不涉及 React/DOM），
 * 然后像组件那样调用它。
 *
 * 这样测的就是真正会上线的代码，而不是我手抄的复刻版。
 */
import { readFileSync } from "node:fs";

// 不传参时默认取本文件所在插件的根目录（方便直接 node tools/refresh-test.mjs）
const ROOT = process.argv[2] ?? new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = readFileSync(ROOT + "/lib/client.js", "utf8");

// 抽出从 `const BEAT_MS` 到 `function beatRefresh` 结束的那一段
const start = src.indexOf("const BEAT_MS");
const endMarker = "function beatRefresh() {";
const end = src.indexOf(endMarker);
if (start < 0 || end < 0) {
  console.log("  ✗ 找不到 beat 段落（源码结构变了？）");
  process.exit(1);
}
const endOfFn = src.indexOf("\n\t\t}", end) + 4;
const beatSrc = src.slice(start, endOfFn);

// 这一段依赖的少量外部符号：TURN_MS 在其中，其余是标准全局。
// ⚠️ 只导出切片里**确实存在**的函数（beatStart/beatStop 在 beatRefresh 之后，不在切片内）。
const factory = new Function(`
  ${beatSrc}
  return { beat, beatFetchNow, beatRefresh, beatStale };
`);

let pass = 0;
let fail = 0;
const ck = (ok, label, extra) => {
  if (ok) pass += 1; else fail += 1;
  console.log("  " + (ok ? "\u2713" : "\u2717") + "  " + label + (extra ? "   " + extra : ""));
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 15; i += 1) await tick(); };

console.log("");
console.log("  == 用真实源码的 beat 状态机（不是复刻）==");

// ── A. 飞行中点击，应该排队并在结束后补发 ──
{
  const m = factory();
  const resolvers = [];
  let fetches = 0;
  m.beat.request = () => {
    fetches += 1;
    return new Promise((res) => { resolvers.push(() => res({ ok: true, value: { cost: { total: 1 } } })); });
  };
  m.beat.sessionId = "s1";

  // 组件挂载时的 effect：nonce===0 → beatFetchNow()
  void m.beatFetchNow();
  await tick();
  ck(fetches === 1, "挂载发出第 1 个请求", "fetches=" + fetches);
  ck(m.beat.inflight === true, "此刻 inflight=true");

  // 用户点「立即刷新」：nonce 变 1 → effect 走 beatRefresh()
  void m.beatRefresh();
  await tick();
  ck(m.beat.pending === true, "★ 飞行中点击 → beat.pending 被置位", "pending=" + m.beat.pending);
  ck(fetches === 1, "没有并发第二个请求", "fetches=" + fetches);

  // 放行第一发
  resolvers[0]();
  await settle();
  ck(fetches === 2, "★ 第一发结束后自动补发（点了就一定有新数据）", "fetches=" + fetches);
  ck(m.beat.pending === false, "排队标记已清空");
  if (resolvers[1]) resolvers[1]();
  await settle();
}

// ── B. 对照：不带 force 的调用在飞行中应被吞掉 ──
{
  const m = factory();
  const resolvers = [];
  let fetches = 0;
  m.beat.request = () => {
    fetches += 1;
    return new Promise((res) => { resolvers.push(() => res({ ok: true, value: {} })); });
  };
  m.beat.sessionId = "s1";

  void m.beatFetchNow();
  await tick();
  void m.beatFetchNow(); // 心跳那种调用（不带 force）
  await tick();
  ck(fetches === 1 && m.beat.pending === false, "（对照）心跳调用在飞行中被静默去重，不排队", "fetches=" + fetches);
  resolvers[0]();
  await settle();
  ck(fetches === 1, "（对照）心跳不会补发", "fetches=" + fetches);
}

// ── C. 连点三下只补发一次 ──
{
  const m = factory();
  const resolvers = [];
  let fetches = 0;
  m.beat.request = () => {
    fetches += 1;
    return new Promise((res) => { resolvers.push(() => res({ ok: true, value: {} })); });
  };
  m.beat.sessionId = "s1";

  void m.beatFetchNow();
  await tick();
  void m.beatRefresh();
  void m.beatRefresh();
  void m.beatRefresh();
  await tick();
  ck(m.beat.pending === true, "三次点击合并成一个排队标记");
  resolvers[0]();
  await settle();
  ck(fetches === 2, "只补发 1 次", "fetches=" + fetches);
  if (resolvers[1]) resolvers[1]();
  await settle();
}

// ── D. 空闲时点击直接生效 ──
{
  const m = factory();
  let fetches = 0;
  m.beat.request = async () => { fetches += 1; return { ok: true, value: {} }; };
  m.beat.sessionId = "s1";
  await m.beatFetchNow();
  await settle();
  ck(fetches === 1, "第一发完成");
  await m.beatRefresh();
  await settle();
  ck(fetches === 2, "空闲时点击直接发", "fetches=" + fetches);
  ck(m.beat.pending === false, "不留排队标记");
}

console.log("");
console.log("  " + "-".repeat(58));
console.log("  " + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
