# dsh-balance-mini

[![tests](https://github.com/jiangpengtkd-alt/dsh-balance-mini/actions/workflows/tests.yml/badge.svg)](https://github.com/jiangpengtkd-alt/dsh-balance-mini/actions/workflows/tests.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![version](https://img.shields.io/badge/version-0.10.2-informational.svg)](./CHANGELOG.md)

DSH（DeepSeek Harness）Web GUI 插件：在输入框下方那一排显示 **DeepSeek 余额** 与 **消费**，点击可展开明细。

```
◉ 余额 ¥554.68   ● 会话累计 ¥19.33   ● 本轮消耗 ¥0.054
```

三个数各带标签，含义必须分清（混淆会得出完全错误的结论）：

顺序按「变化速度」由慢到快排列，最活跃的数字在最右边。三段**始终占位**，
算不出来时显示 `—`（不整段省略，否则数字会左右横移）：

| 数 | 含义 | 口径 |
|---|---|---|
| **余额** | 账户充值余额 | 快照值，不含赠送余额 |
| **会话累计** | 本会话建立至今的累计 | 官方 `tokenUsage.totals` |
| **本轮消耗** | **你这一句话花了多少** —— 从发出到此刻的合计 | `当前 totals − 本轮起点的 totals`，实时累加，答完停住 |

位置与交互对齐原厂 `StatsPills`（会话统计 / token 用量 / 上下文那三个胶囊）：透明胶囊、悬停出底色、点击弹浮层、外部点击或 Esc 关闭。

> 官方 UI **从不展示消费金额**，也**不展示单次/单轮用量** ——
> 因为 `tokenUsage` 的 `wire.view` 只把累计值发给客户端。
> 本插件读取 host 原始状态并自行计价，详见下面「数据来源」。

## 特点

- **实时**：余额与会话累计 15 秒一轮；**「本轮消耗」2 秒一轮** —— 回答过程中能看到它在涨
- **本日消耗汇总当天所有会话**：扫会话日志按事件时间求和，不是只看当前会话
- **峰谷自适应**：单价按官方规则实时切换（高峰 = 工作日 9-12 / 14-18 点；法定节假日全天按空闲）
- **外观对齐原厂**：字号、字重、行高、内边距、分割线**逐条抄自官方 CSS 模块**，不是估的（见「实现要点」）
- **零依赖**：纯 JavaScript，无原生模块，无 install / postinstall 脚本
- **不联网**：余额走本机 DSH 账号服务，费用从本机会话日志计算，运行时不访问任何外部接口

## 快速开始

```bash
dsh plugin --profile desktop add dsh-balance-mini-0.10.3.tgz
```

装完**重启 DSH**。`desktop` 是 profile 名，换成你自己的。
发版包在 [`releases/`](./releases)，完整安装说明与排查清单见 [INSTALL.md](./INSTALL.md)。

**想先看效果、不用装**：

```bash
node tools/gen-preview.mjs      # 生成 docs/preview.html
```

打开 `docs/preview.html` —— 里面把**原厂胶囊**与本插件胶囊并排渲染，可直接比对样式。

## 测试

五套测试全是纯 Node、零依赖、**不联网**，也不用启动 DSH。

> **运行环境要求 Node ≥ 22.15.0** —— host 端用 `node:zlib` 的 `zstdDecompressSync`
> 解压会话日志，该 API 自 Node 22.15.0 起提供。（DSH 桌面版内置的是 Node 24，满足。）

```bash
node tools/selftest.mjs         # 57 项  host 端到端（余额、计费、回环校验、换轮基准）
node tools/render-test.mjs .    # 85 项  渲染（金额精度、标签配对、胶囊可见性、面板结构）
node tools/heartbeat-test.mjs . #  6 项  心跳独立于组件、节奏参数
node tools/refresh-test.mjs .   # 13 项  「立即刷新」的排队与补发
node tools/gen-preview.mjs      # 19 项  预览页自检
```

退出码 0 即全部通过。CI 在 Node 22 / 24 上跑（[.github/workflows/tests.yml](./.github/workflows/tests.yml)）。

> ⚠️ 测试里刻意放了几条**只有实现正确时才成立**的等式断言
> （例如"第二次开新轮时本轮消耗 ≈ 0 且小于会话累计"）。
> 它们不是装饰：0.10.0 修掉的那个高危 bug（换轮不重置基准 →「本轮消耗」等于「会话累计」）
> 就是靠一条这样的断言才被抓住的，并用**变异测试**验证过"把缺陷注回去测试确实会失败"。
> 详见 [CHANGELOG](./CHANGELOG.md) 的 0.10.0 与 0.10.2。

## 项目结构

```
lib/
  client.js        浏览器端：胶囊 + 浮层（手写 createElement，无构建步骤）
  index.js         host 端：余额读取、token 计费、本日跨会话扫描
  holidays.js      法定节假日表（唯一的年度维护点）
tools/             五套测试 + 预览生成器
docs/preview.html  样式预览（由 gen-preview.mjs 生成，需与源码同步）
releases/          发布包（.tgz 安装包 + .zip 完整包）
CHANGELOG.md       完整版本历史（含每个 bug 的根因与修法）
INSTALL.md         安装与排查
```

## 安装位置

```
C:\Users\<user>\.dsh\plugins\dsh-balance-mini     ← 本目录（插件源码）
        ├─ lib/index.js        host 半身
        ├─ lib/client.js       client 半身（浏览器）
        ├─ lib/holidays.js     法定节假日数据（唯一的年度维护点）
        ├─ cordis.patch.yml    bundle 激活层
        ├─ docs/preview.html   样式预览（浏览器打开）
        └─ tools/gen-preview.mjs  预览生成器（从 client.js 求值，见「预览」一节）
```

profile 侧通过 junction 引用，不需要把代码放进 profile 目录：

```
C:\Users\<user>\.dsh\profiles\desktop\
    ├─ package.json       dependencies: dsh-balance-mini → link:C:/Users/<user>/.dsh/plugins/dsh-balance-mini
    ├─ pnpm-lock.yaml     同上（specifier / version）
    └─ node_modules\dsh-balance-mini  →  Junction 指向本目录
```

**改代码后要重启 DSH 才生效**（host 半身必须重启；client 半身随 host 一起重新生成）。
如果想改完立刻看到效果，开发时可以让 `pnpm run dev:web` 同时运行以启用 client bundle 热重建。

## 平台支持

插件**代码本身是跨平台的**：

- 纯 JavaScript，**无原生模块**（无 `.node`）、**无 install/postinstall 脚本**、无运行时依赖
- 无 `win32` / `process.platform` / `process.arch` 判断，无盘符或反斜杠硬编码
- 唯一的文件路径访问走 `path.join(os.homedir(), ".dsh")`，在 macOS / Linux 上自动解析为
  `/Users/<你>/.dsh`、`/home/<你>/.dsh`
- `cordis.patch.yml` 用的是 POSIX 相对路径 `./cordis.patch.yml`
- client bundle 运行在浏览器里，与操作系统无关
- 节假日表是内置静态数据，运行时**不访问任何外部接口**

**但宿主（DSH 桌面版）目前只有 Windows x64 一个构建**，依据是安装目录里的构建元数据
`resources/app.asar` → `dsh/desktop-runtime.json`：

```json
{ "platform": "win32", "arch": "x64", "release": { "version": "0.2.0-rc.2" } }
```

即当前发行版**只针对 win32-x64 构建**。没有可信的公开下载源可以按平台列出可用构建，
所以这里不再引用具体 URL —— 之前版本引用过一个更新源地址并声称"实测 200"，
实际上那些路径**全部 404**（包括 win-x64），属于想当然写下的，不该拿来做依据。

结论：macOS / Linux 上暂时**没有可安装的 DSH 宿主**，自然也就装不了这个插件 ——
这不是插件的问题。官方发布对应构建后，本包**无需任何改动**即可安装。

一旦官方发布 macOS 或 Linux 版 DSH，本包**无需任何改动**即可安装：

```bash
dsh plugin --profile desktop add ~/Downloads/dsh-balance-mini-0.10.3.tgz
```

（把版本号换成你实际下载到的那个文件名 —— 包名里的版本会随发布变化。）

完整的平台说明、三种安装方式、以及"装完没反应"的排查步骤，见
[INSTALL.md](./INSTALL.md)。

## 数据来源（都是官方接口，不自己造数据）

| 显示项 | 来源 | 说明 |
|---|---|---|
| 余额 | `ctx.deepseekAccount.getBalance(client)` | DSH 账号服务；已处理凭据读取、Platform 的五个 `x-client-*` 头、余额超时与 401 失效。兜底可走 `GET api.deepseek.com/user/balance`（API Key 账号）。**是充值余额，不含赠送余额** |
| 会话累计 | `ctx.sessionProjections.stateOf(session, "tokenUsage")` 的 `totals` | 官方 `@deepseek-ai/dsh-token-meter` 注册的会话投影 |
| **本轮消耗** | `当前 totals − 本轮起点 totals` | **本插件补出来的口径**。官方只有 `totals`（整会话）与 `last`（最近一步），没有"一轮合计"。做法：在 `turn/start` 事件记下当时的 `totals` 作基准（按会话存 `WeakMap`），每次请求做差 |
| 每轮平均消耗 | 会话累计 ÷ `sessionStats.turns` | 官方 `session-stats` 投影提供轮数。这是现有数据下唯一能回答"一句话大约多少钱"的数 |
| 缓存占比 | `totals.cacheReadTokens ÷ 四项之和` | 解释成本为何低：缓存读取单价 0.02，未缓存输入 1，差 50 倍 |

> **为什么要自己补「本轮」**：官方 `tokenUsage` 的 `wire.view` 是
> `view: state => state.totals` —— **只把累计值发给客户端**，`last`（最近一步）
> 与 `turnBoundary` 都留在 host 侧，官方 UI 因此从不展示"单次/单轮花了多少"。
> 本插件用 `stateOf()` 读 host 原始状态才拿到 `last.buckets`；而"本轮合计"
> 官方根本没算，是用 `turn/start` 基准做差补出来的。
>
> 三个数的含义务必分清，混淆会得出完全错误的结论：
> **余额**（账户快照）· **本轮**（这一句话从发问到此刻）· **会话**（本会话建立至今）。

计价按 DeepSeek 官方价目表（元/百万 tokens，`deepseek-flash`）：

| | 空闲时段 | 高峰时段 |
|---|---|---|
| 输入（缓存**命中**） | 0.02 | 0.04 |
| 输入（缓存**未命中**） | 1 | 2 |
| 输出 | 4 | 8 |

## 高峰 / 空闲是怎么判断的

依据 DeepSeek 官方文档（[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 注 2）原文：

> 空闲时段价格为高峰时段价格的一半。**北京时间周一至周五（不含中国法定节假日）
> 9:00 - 12:00、14:00 - 18:00 为高峰时段**；其余时段，包括**周末及中国法定节假日
> 全天**均为空闲时段。

译成判定式（`lib/index.js` 的 `computeCost`）：

```js
// 1. 先把本机时间换算成北京时间（getTimezoneOffset() 是"UTC 减本地"的分钟数）
const beijing = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
const weekday = day >= 1 && day <= 5;                                   // 周一~周五
const inPeak  = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);  // 9-12、14-18
const holiday = isStatutoryHoliday(年, 月, 日);                          // 见 lib/holidays.js
const peak = weekday && inPeak && !holiday;
```

四条规则，缺一不可：

| 情况 | 判定 |
|---|---|
| 周末（含**调休补班**的周六日） | 空闲 |
| 法定节假日（即使落在周一至周五） | 空闲 |
| 周一至周五、非节假日、9–12 或 14–18 点 | **高峰** |
| 其余一切 | 空闲 |

**为什么不需要"调休补班日"数据**：规则写的是"周一至周五"，而 DeepSeek 另明确说明
"[调休上班的周末、中国法定节假日全天均按空闲时段计费](https://m.163.com/dy/article/L77765420511B8LM.html)"。
补班日基本都是周六日，本就不在"周一至周五"之列，所以**不会产生新的高峰时段** ——
只需要"法定节假日"这一张表。

### 节假日数据与维护

`lib/holidays.js` 内置"放假日期表"，2025 与 2026 两年已收录。数据来自国务院办公厅
每年发布的《关于XXXX年部分节假日安排的通知》，2026 年已与
[官方原文](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)逐条核对一致。

> **每年 11 月前后**国务院会公布次年安排。届时重新生成即可（把年份换成需要的）：
>
> ```bash
> node -e "fetch('https://timor.tech/api/holiday/year/2027').then(r=>r.json()).then(b=>console.log(Object.entries(b.holiday).filter(([,v])=>v.holiday===true).map(([k])=>k).sort().join(' ')))"
> ```
>
> 把输出填进 `STATUTORY_HOLIDAYS` 对应年份即可。

**未收录的年份会自动回退**：`isStatutoryHoliday()` 返回 `false`，退化为"仅按工作日 + 时段"
判断，不会报错，只是那年的法定节假日会偏高估约一倍。展开浮层里的「时段」一行会写出
判断依据（`空闲（法定节假日全天）` / `空闲（非工作日或非高峰时段）` / `高峰（工作日 9-12 / 14-18点）`），
便于直接核对。

> **另一层近似（无法消除）**：`tokenUsage` 投影给的是**累计总数**，把不同时段的用量
> 加总在一起了。所以跨时段的长会话，累计金额是按"当前时刻的费率"折算的近似值。
> 要精确需从会话日志逐步读每次请求的时间戳与用量、分段计价 —— 成本过高，未实现。

## 配置

可选，在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: balance-mini
  name: dsh-balance-mini
  config:
    refreshMs: 30000    # 余额刷新间隔（毫秒，默认 60000）
    timeoutMs: 15000    # 余额查询超时（毫秒，默认 15000）
    baseURL: https://api.deepseek.com   # 仅 API Key 兜底路径使用
```

## 实现要点（踩过的坑，改代码前请先看）

1. **client bundle 必须是经典脚本，不是 ES module。**
   宿主用 `window.__ModuleLoader__.load({ id, factory })` 加载，`factory` 里用 `module.exports` 导出。
   写成顶层 `export` 会直接 `SyntaxError` → **web 启动失败**，宿主为了自保会把整个 bundle 从
   `dsh.profile.bundles` 摘掉（历史 crash 日志里是 `web boot: 1 entry did not activate`）。
   插件加载失败时，宿主提供"禁用第三方插件"恢复入口，那会**备份并重置** profile patch。

2. **不要用 `ctx.connection.rpc.handle()` 注册通道。**
   它内部走 `owner.webServer.register()`，而 `owner` 取的是 connection 实例自己的 ctx，
   读不到 `webServer`（与本插件加载时机无关，重试 15 次错误一字不变），恒抛
   `cannot get property "webServer" without inject`。
   改用**本插件自己的 ctx**：`ctx.webServer.register({ kind:"prefix", path, handler })`。

3. **客户端 RPC 是带信封的协议，不是普通 POST。**
   请求 `{ type:"client-request", rpcId, method, payload }` →
   响应必须是 `{ type:"server-response", rpcId, result:{ ok:true, value } }`；
   失败时 `result.error` 的 `code`/`message`/`details` **三者都必需**，`details` 还必须是对象，
   否则客户端解析时抛 `TypeError`。`rpcId` 必须原样回传（否则 `rpcId mismatch`）。

4. **绕过了 Connection 的 BrowserAuth，所以自己把门。**
   路由只接受 Host 为 `127.0.0.1` / `localhost` / `::1` 的请求，否则 403 —— 别把这个检查删掉。

5. **会话刚建立的头几秒取不到费用是正常的。**
   `ctx.sessions.get()` 只认"活着"的会话；此时 `computeCost` 静默返回 `undefined`，
   由客户端 **3 秒快速重试**补上（取到后回到 60 秒节奏）。这是设计，不是 bug。

6. **不要给 design token 的 `var()` 加兜底值。**
   原厂组件一律写 `var(--token)`，不加 fallback。加兜底看似更健壮，实际会让该属性
   解析出与原厂**不同**的值，产生难以察觉的视觉偏差 —— 本插件在这上面栽过两次：

   | token | 加兜底的后果 |
   |---|---|
   | `--dsh-content-font-size-secondary` | 胶囊字号与另外三个胶囊不一致（0.1.1 修） |
   | `--dsw-alias-separator-primary` | 分隔点亮度只有原厂的一半，看着更小更虚（0.2.2 修） |

   只有 token **确实可能缺失**时才加兜底。DSH 的主题层保证这些 token 存在。

7. **投影形状是扁平的。**
   `useProjection("tokenUsage")` 返回的对象**直接**带 `uncachedInputTokens` / `outputTokens` /
   `cacheReadTokens` / `cacheWriteTokens`，**没有 `totals` 包一层**（host 侧 `stateOf` 返回的
   才有 `{ totals, last }`）。两处读取形状不同，别混。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-balance-mini
```

然后删掉本目录即可。也可以手动把 `dsh-balance-mini` 从 profile 的
`package.json` 的 `dsh.profile.bundles` 数组里移除、并删除
`node_modules\dsh-balance-mini` 链接。

## 刷新节奏

| 常量 | 值 | 含义 |
|---|---|---|
| `BEAT_MS` | 1000 | 心跳**检查**频率（醒来判断是否需要取数，不代表每次都发请求）。必须 ≤ `TURN_MS`，否则检查粒度成为瓶颈 |
| `TURN_MS` | 2000 | 「本轮消耗」距上次取数超过此值就重取 —— 它是活跃字段，一个回答里会跳好几次 |
| `refreshMs` | 15000 | 其余字段（余额、会话累计）的常规周期，可用插件 config 覆盖。**活跃周期取 `min(refreshMs, TURN_MS)`**，所以配得比 2000 小才有意义 |
| `DAY_SCAN_TTL_MS` | 60000 | host 端「本日消耗」跨会话扫描的缓存时长（扫描约 150ms，不能每 2 秒做一次） |

失败退避：连续取数失败时重试门槛按 `refreshMs × 2^(n-1)` 递增，上限 60 秒，成功后清零。
没有它的话"取不到数"会退化成 **1 秒一次**的永久轮询（未配置 key 的用户挂机一天约 8 万次请求）。

> ⚠️ 这张表曾长期与源码不符（写着 2000 / 8000 / 60000，实际是 1000 / 2000 / 15000）。
> 现在 `tools/selftest.mjs` 有一条断言直接比对文档与源码，改常量不改文档会被测出来。


心跳在**模块级**（`beatStart()` 在 `apply` 里调用一次），**组件卸载不会终止它**。
这是刻意设计：插槽会被宿主反复重挂，轮询若挂在组件 effect 上就会被 cleanup 清掉
（实测曾导致每次启动只请求 1 次）。

```bash
node tools/heartbeat-test.mjs
```

覆盖：心跳只创建一个、节奏参数与源码一致、数据缺失时持续重试、
数据新鲜时不重复取数、组件卸载后心跳仍存活。

### 两个已知权衡（审查时确认过，不是 bug）

1. **切会话瞬间可能显示上一个会话的数据**：心跳只有一个全局 `sessionId` 槽位，
   切换会话时新值在 render 阶段写入，但**已在途的请求**返回的仍是旧会话的结果，
   会先渲染一次。下一次心跳（≤ `TURN_MS`）就被新数据覆盖。
   刻意不为此加防护 —— 账户余额本来就与会话无关，而"会话累计"在切换瞬间
   两个值都是合理的，"先显示旧值再刷新"比"先清空再填"更不刺眼。

2. **连点「立即刷新」可能被吞掉一次**：`beatFetchNow()` 有 `inflight` 去重，
   若手动刷新恰好撞上进行中的请求就直接返回。2 秒后心跳自然会补上。



## 自测

```bash
node tools/selftest.mjs
```

**不需要启动 DSH。** 它加载真实的 `lib/index.js`、用桩 ctx 调 `apply()`、从注册的
路由里取出 handler 直接喂 HTTP 形状的假请求，然后断言响应内容（22 项）。

覆盖关键路径：新会话（`turnBoundary.openTurnStartSeq` 为 `null`，**这里曾导致
`cost` 整块消失**）→ 本轮建立 → 同轮累加 → 新轮重置 → 无 sessionId →
会话不存在 → 非回环请求被拒(403) → GET 可用 → 未知 RPC 方法。

金额断言用**同一套价目表独立算一遍再比对**，不是"看着像对"。

> 为什么值得维护这个脚本：host 半身的问题过去只能靠"改代码 → 让用户重启 →
> 肉眼看界面"发现，一轮好几分钟，而且我为此**误判过两次** ——
> 一次把"进程还跑着旧代码"当成逻辑 bug，一次因 mock 里 `turnSeq` 一直有值
> 而漏掉 `null` 分支。这类错误在真机上要用户配合才能暴露。

## 预览

`docs/preview.html` 用浏览器直接打开。**该文件的 CSS 由生成器从 `lib/client.js`
求值得到**，不是手抄 —— 手抄必然会与实现脱节：

> ⚠️ 本项目吃过这个亏：预览里曾写着手抄的 `margin:0 1px`（分隔点间距）、
> `gap:6px`、缺少 hover 变亮，与实机全都不符，而 README 却声称"与实机一致"。
> 现在预览页的样式**不可能脱节**，因为它是从同一份定义生成的。

预览页包含 5 节：

1. 实机排布（上下文圆圈 + 余额胶囊）
2. **与原厂胶囊并排** —— 直接比对分隔点大小/亮度/间距、字号
3. 点击展开的浮层（含「时段」判断依据）
4. 余额分档与异常状态
5. **字号跟随设置** —— 演示 13 / 14 / 15px 下与原厂胶囊同步变化

### 改动样式后重新生成

```bash
node tools/gen-preview.mjs            # 写回 docs/preview.html
node tools/gen-preview.mjs <路径>      # 或写到指定位置
```

生成器会**自检 5 条关键规则**（`gap:0`、`sep` 的 `margin:0 6px`、状态点间距、
hover 变亮、颜色 token 无兜底）；任一条不通过就以非零码退出，提示你可能改了
`client.js` 的 CSS 数组结构。

需要位图时用浏览器截图（不随包分发，因为它无法自动保持最新）：

```bash
msedge --headless=new --force-device-scale-factor=2 --window-size=780,900 \
       --screenshot=preview.png file:///<绝对路径>/docs/preview.html
```

### 两条硬约束

> **字号必须用同一个 calc 表达式，别写死 px**：
>
> ```css
> font-size:   calc(var(--dsh-content-font-size-secondary,13px) - 1px);
> line-height: calc(20px + var(--dsh-content-font-delta-secondary,0px));
> ```
>
> 写死 px（曾用过 `font-size:12px`）会与另外三个原厂胶囊不一致 —— 用户能一眼看出来。

> **不要给颜色类 design token 的 `var()` 加兜底值。**
> 原厂一律写 `var(--token)`。加兜底（如 `var(--dsw-alias-separator-primary, rgba(128,128,128,.5))`）
> 可能让该属性解析出与原厂不同的值 —— 分隔点变暗后会显得更小。
> 详见下面「实现要点」第 6 条。
