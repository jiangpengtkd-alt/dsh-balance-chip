/**
 * dsh-balance-chip —— client（浏览器）半身
 *
 * 重要：本文件是**经典脚本**，不是 ES module。宿主用模块加载器把 client bundle
 * 当普通脚本执行，必须走 window.__ModuleLoader__.load(...) 包装并用
 * module.exports 导出——写成 `export` 会直接 SyntaxError，导致 web 启动失败、
 * 整个 bundle 被宿主摘掉。
 *
 * 职责只有两件：定时向 host 要「余额 + 费用」，把结果渲染成输入框下方那一排的
 * 小胶囊。**所有计价与数据读取都在 host 侧完成**（含被投影 wire.view 过滤掉的
 * 单次用量），客户端不做任何计算、不维持任何跨渲染状态。
 *
 * 挂载位置：conversation.composer.dock（与上下文圆圈同一个 flex 容器），
 * 用 CSS order 排在 ContextMeter 之后，即圆圈右边。
 */
window.__ModuleLoader__.load({
	id: "dsh-balance-chip",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		// 原厂组件用 createPortal 把浮层挂到 body（见 dsh-client-ui-chat 的 TimePill）。
		const reactDOM = require("react-dom");

		const RPC_CHANNEL = "/balance-mini";
		const CSS_ID = "dsh-balance-mini/chip.css";
		const CHIP_CLASS = "dsh-balance-mini-chip";
		const PANEL_CLASS = "dsh-balance-mini-panel";

		// 外观与字号严格对齐原厂 StatsPills（`@deepseek-ai/dsh-client-ui-chat` 的 .iq1doa_*）：
		//   .root —— font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px)
		//            line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))
		//            gap:12px（胶囊之间）
		//   .pill —— 透明按钮、无边框、border-radius:999px、padding:1px 8px、gap:6px，
		//            font:inherit + line-height:inherit（**不自己定字号**），
		//            悬停/展开时才出现底色（--dsw-alias-interactive-bg-hover）
		// 与原厂 StatsPills 逐条对齐（括号内是原厂值）：
		//   padding:1px 8px ✓ / border-radius:999px ✓ / border:none ✓ / background:0 0 ✓
		//   font-size、line-height 用同一 calc 表达式 ✓
		//   **gap 只管 icon 与文字**（原厂 gap:6px），胶囊内部的分隔点靠自己的
		//     `margin:0 6px` 撑间距 —— 这里曾把间距放到胶囊 gap 上、又给点加了
		//     1px margin，导致点两侧变成 7px，看起来比原厂的更挤更小。
		//   现在胶囊内 gap 设为 0（本插件的子元素只有"状态点+文字+分隔点+数字"，
		//   没有 icon 需要 gap），间距全部交给 sep 的 margin。
		//   注意最外层 .dock 的 gap:12px 是**胶囊之间**的间距，不受影响。
		//   hover/展开时文字由 tertiary 变亮为 secondary（原厂行为）
		const FONT_SIZE = "calc(var(--dsh-content-font-size-secondary,13px) - 1px)";
		const LINE_HEIGHT = "calc(20px + var(--dsh-content-font-delta-secondary,0px))";

		const CSS = [
			// ⚠️ 颜色类 token **一律不带兜底值**：原厂组件写的是 var(--token)，
			// 加了兜底反而会让该属性解析出与原厂不同的值（已踩两次，见 CHANGELOG 0.2.2）。
			"." + CHIP_CLASS + "{display:none;order:1;box-sizing:border-box;align-items:center;gap:0;padding:1px 8px;border-radius:999px;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:" + FONT_SIZE + ";font-weight:inherit;line-height:" + LINE_HEIGHT + ";font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;user-select:none}",
			"." + CHIP_CLASS + ".ready{display:inline-flex}",
			"." + CHIP_CLASS + ":hover," + "." + CHIP_CLASS + "[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			// 内层只负责布局与数字对齐，不引入任何字号/行高差异
			"." + CHIP_CLASS + ">span{display:block;font:inherit;line-height:inherit}",
			// 状态点（余额段前面那个 6px 的指示块）。颜色是**余额分档**的语义指示：
			//   ≥100 绿 · 20–99 黄 · 1–19 红 · 其他灰
			//
			// ⚠️ 绿色曾用 #10b981，被反馈"太暗"；改用 `--dsw-alias-state-success-primary`
			// —— 官方色阶解析出来正好是 #22c55e（更亮的绿），且是**语义 token**而非硬编码。
			// 黄与红同样走官方 state token，避免自己挑色与主题脱节。
			// 这些 token 无兜底（与原生并排的元素一律不加 fallback）。
			//
			// ⚠️ 形状是**圆角方块**而非圆形 —— 对齐官方「上下文已用」面板的图例色块：
			//     `._2WTFBq_swatch{background:var(--meter-tint);border-radius:2px;
			//       width:8px;height:8px;margin-right:6px}`
			// 官方对"颜色指示器"用的就是小方块。半径按比例缩：官方 8px 用 2px，
			// 这里 6px 用 2px（略圆一点，小尺寸下 1.5px 几乎看不出圆角）。
			//
			// `corner-shape:round` 与官方写法一致（新式圆角语法，不支持的浏览器忽略）。
			//
			// ⚠️ 尺寸 5px（曾 6px）。6px 在"上下文圆圈 + 四个胶囊"并排时**偏重**，
			// 被反馈"确实略重"。三个块统一缩小，右边距同步从 6px 收到 5px
			// （5px 的块配 6px 间距会显得松）。
			//
			// 圆角保持 2px：5px 配 2px 比官方 8px 配 2px 更圆一点，但在这种小尺寸下
			// 1.5px 与 2px 肉眼几乎无差，取整成 2px 让两条规则完全一致、便于维护。
			".dsh-balance-mini-dot{corner-shape:round;width:5px;height:5px;border-radius:2px;flex:none;background:var(--dsw-alias-label-quaternary);align-self:center;margin-right:5px}",
			"." + CHIP_CLASS + ".lv-green .dsh-balance-mini-dot{background:var(--dsw-alias-state-success-primary)}",
			"." + CHIP_CLASS + ".lv-yellow .dsh-balance-mini-dot{background:var(--dsw-alias-state-warn-primary)}",
			"." + CHIP_CLASS + ".lv-red .dsh-balance-mini-dot{background:var(--dsw-alias-state-error-primary)}",
			"." + CHIP_CLASS + ".lv-gray .dsh-balance-mini-dot{background:var(--dsw-alias-label-quaternary)}",
			// 小圆点（「会话累计」「本轮消耗」标签前各一个，5px，比状态点略小）。
			//
			// 为什么加：原生胶囊每一段前面都有图标，三段只有余额段有点会显得不齐。
			//
			// 配色：**三段各一色，便于区分**（曾三点同色，被反馈"不好看"）：
			//   ① 余额     = 绿
			//   ② 会话累计 = 蓝（DeepSeek 品牌色）
			//   ③ 本轮消耗 = 粉
			//
			// ⚠️ 小圆点是「段标识」而**不是状态**，所以不随余额分档变色 ——
			// 那样三个点会一起变，反而失去"区分三段"的作用。
			// 余额的红/黄告警语义由 6px 状态点单独承担。
			//
			// ⚠️ 第三色取**淡紫** \`#a78bfa\`，出处是官方「上下文已用」面板的图例
			// （工具定义那一条的色块，就在 ui-conversation/lib/client.js 里）。
			//
			// 曾用过粉色 \`#f472b6\`（真实存在于实机渲染中，像素采样为 #f272b4），
			// 但用户看上下文面板的图例时以为那是粉、并指名要它 —— 所以改用面板同款淡紫。
			// 淡紫还有个好处：与绿、蓝在深色背景下的**区分度更大**。
			//
			// 官方主题六族（amber/blue/deepseek/green/neutral/red）里没有紫或粉的 token，
			// 所以这一色只能取字面量；绿与蓝走官方 token。
			//
			// 尺寸与状态点**完全一致（6px）**。
			//
			// ⚠️ 曾做成 5px（想让"段内装饰"比"段首状态块"轻一点），被反馈
			// "这三个好像不一样大"。原因是 5px 的面积只有 6px 的 **69%**
			// （0.69 ≈ (5/6)²），差 1px 在面积上差三成，肉眼很明显。
			// 三个块并列时任何尺寸差都会被看出来，所以尺寸必须一致。
			//
			// 尺寸随后又从 6px 收到 **5px**（6px 整体偏重），两条规则同步改。
			// 圆角仍 2px，与状态块完全相同 —— 两条规则的参数现在一模一样，
			// 只有颜色与右边距不同。
			//
			// 间距仍用 4px（比状态块的 5px 紧）：状态块是整段的"开头"，
			// 需要与后面拉远一点；后两段的块只是段内标识，贴着标签更自然。
			".dsh-balance-mini-minidot{corner-shape:round;width:5px;height:5px;border-radius:2px;flex:none;background:var(--dsw-alias-label-quaternary);align-self:center;margin-right:4px}",
			// ② 会话累计 —— 蓝（DeepSeek 品牌蓝 #7aaaff）
			"." + CHIP_CLASS + " .dsh-balance-mini-minidot.dot-sess{background:var(--dsw-static-deepseek-400)}",
			// ③ 本轮消耗 —— 淡紫（官方上下文面板图例同款）
			"." + CHIP_CLASS + " .dsh-balance-mini-minidot.dot-turn{background:#a78bfa}",
			// 段间留白：**不渲染字符**，只留宽度。
			//
			// 原先这里是一条分隔点规则（照抄原厂的 `.iq1doa_sep`：
			// `color:var(--dsw-alias-separator-primary);margin:0 6px`）。
			// 但后两段各自带上绿点后，那个 `·` 与绿点挨在一起显得多余，故弃用字符分隔符。
			//
			// 宽度 6px ≈ 12px 字号下一个字符的宽度 —— 对应"余额数字后面留一个字符再接绿点"。
			// 用 flex 盒子而不是空白文本：不占字符、不受字体影响、也不会被文本节点合并。
			"." + CHIP_CLASS + " .dsh-balance-mini-gap{flex:none;width:6px}",
			// 标签（余额/会话累计/本轮消耗）：原厂没有这种「标签+数值」的胶囊，是本插件独有。
			//
			// 颜色用 `--dsw-alias-label-tertiary` —— 与**原生胶囊文字完全同色**
			// （原厂 `.iq1doa_pill{color:var(--dsw-alias-label-tertiary)}`）。
			//
			// ⚠️ 曾用更暗的 `--dsw-alias-label-quaternary`，被反馈"文字太暗"。
			// 既然旁边就是原生胶囊，直接用同一档最省事也最协调。
			//
			// ⚠️ **不带兜底值**：`var(--token, fallback)` 里的 fallback 会影响 token 的
			// 最终解析结果（实测分隔点颜色就因此偏暗、看起来更小）。与原生并排的元素
			// 一律写成无兜底的形式。
			"." + CHIP_CLASS + " .dsh-balance-mini-cap{color:var(--dsw-alias-label-tertiary);margin-right:4px}",
			// 「本轮」在回答过程中会变化，加一个极轻的过渡避免数字跳变时闪烁。
			//
			// ⚠️ **不要加 min-width**。曾经为了让数值宽度恒定（防左右横移）写了
			// `min-width:5.5em`，结果标签与数字之间出现明显空白 —— 因为这个宽度
			// 是按最长数值预留的，而「余额 ¥548.68」这类短数值根本用不满，
			// 多出来的空间就成了视觉间隙。实测被一眼看出"间距比以前大了"。
			//
			// 抖动本身可接受：等宽数字（tabular-nums）已保证同一数量级下宽度一致，
			// 只有金额位数变化时才会轻微移动，值远小于恒定预留造成的空白。
			"." + CHIP_CLASS + " .dsh-balance-mini-cap+span{transition:color .15s;font-variant-numeric:tabular-nums}",
			// 浮层容器 —— 逐条对齐官方的 `.Xt1eiG_panel`（dock 行那个统计弹窗的类）：
			//   background:var(--dsw-specific-menu)   color:var(--dsw-alias-label-secondary)
			//   width:max-content  min-width:min(300px,100vw - 24px)  max-width:min(440px,100vw - 24px)
			//   padding:16px   font-size:12px   line-height:18px   position:fixed
			//
			// ⚠️ 字号是**写死的 12px**，不是 `var(--dsh-content-font-size-secondary)`。
			// 曾两次改错这个值：先 12px、后"按别处推断"改成 13px、最后查回官方原文确认 12px。
			// 官方不同弹窗字号并不统一，**必须从对应类自己的规则里读**，不能从同类组件推断。
			//
			// 颜色/圆角/阴影这类"浮层自身外观"保留兜底是刻意的：它们不与原生组件并排比较
			// （与胶囊不同 —— 胶囊是并排的，那里的 token 一律不加兜底）。
			"." + PANEL_CLASS + "{z-index:1100;box-sizing:border-box;padding:16px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-specific-menu,#1b1e26);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.35));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));cursor:default}",
			// ── 头部：图标 + 「余额」+ 金额，右端「本日消耗」+ 金额 ──
			//
			// 逐条对齐官方 `.Xt1eiG_title`（gap:16px / margin-bottom:8px / font-weight:500 / space-between）。
			// 主数值放头部是官方做法，也让正文不必重复同一个数。
			"." + PANEL_CLASS + " .bm-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}",
			// 图标与「余额」两字一组，gap 取官方 headerLeading 的 8px
			"." + PANEL_CLASS + " .bm-head-main{display:inline-flex;align-items:center;gap:6px;flex:none}",
			// 金额用与正文数值同一档色（label-secondary），与「余额」二字区分开
			// 官方 `.Xt1eiG_titleValue` **不设颜色、不设字重** —— 与标题同色同粗。
"." + PANEL_CLASS + " .bm-head-value{font-variant-numeric:tabular-nums}",
			// 右端「本日消耗 + 金额」——**做成一组**，组内用 gap 分隔。
			//
			// ⚠️ 官方 \`.Xt1eiG_titleValue\` 是**紧贴**标题的（官方标题行只有两项，
			// 靠 \`justify-content:space-between\` 把那一项推到右端）。本插件头部三项，
			// 结构与官方不同，所以右端这一组需要自己的组内间距。
			//
			// 字重与左边一致（继承 500）—— 曾写成 400，左右粗细不同，看着像两个层级（用户指出）。
			"." + PANEL_CLASS + " .bm-head-day{margin-left:auto;display:inline-flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
			// 头部下方的分割线。官方写法：`border-top:.5px solid var(--dsw-alias-border-l2)`。
			// 官方用的是 border-l2（比 l3 更淡）；**不要加兜底值**，
			// 兜底会影响 token 的最终解析结果（本项目在分隔点上踩过这个坑）。
			// 用 height:0 + border-bottom 而不是 height:1px + background：
			// 前者才能画出真正的 0.5px 细线。
			"." + PANEL_CLASS + " .bm-head-rule{height:0;border-top:.5px solid var(--dsw-alias-border-l2);margin:0 0 10px}",
			// ⚠️ 官方 `.Xt1eiG_details` **不设 font-weight**，继承到的是正文的 400。
			// 但本插件的 details 是头部（font-weight:500）的**后代**，不加这条会连 500 一起继承，
			// 整个面板都变粗 —— 用户反馈的"而且还粗了"就是这个原因。
			// 所以这里必须显式写 400，把权重拉回正文档。
			"." + PANEL_CLASS + " .bm-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary);font-weight:400}",
			"." + PANEL_CLASS + " .bm-details dt{margin:0}",
			// ⚠️ 官方 dd **不设颜色** —— 数值与标签**同色**（都继承 details 的 tertiary）。
// 本插件曾给数值加 label-secondary（更亮）"让数字更醒目"，但那就与原厂不同了。
// 官方的做法是靠**右对齐 + 等宽数字**区分，不靠亮度。
"." + PANEL_CLASS + " .bm-details dd{margin:0;font-variant-numeric:tabular-nums;text-align:right}",
			// 「当前时段」移到底部与「立即刷新」同一排：结论加粗，两种状态各给一个颜色。
			// 空闲 = 成功绿（便宜），高峰 = 警告橙（贵一倍，是提醒不是错误）。
			// 两者都用官方语义 token，跟随主题明暗，不写死色值。
			"." + PANEL_CLASS + " .bm-slot{font-weight:600}",
			"." + PANEL_CLASS + " .bm-slot-idle{color:var(--dsw-alias-state-success-primary)}",
			"." + PANEL_CLASS + " .bm-slot-peak{color:var(--dsw-alias-state-warn-primary)}",
			// 底排：刷新在左，时段靠右，两端对齐。
			// 「当前时段：」四个字与「↻ 立即刷新」**同一套字体**：同字号、同字重、同亮度
			// （font:inherit + 400 + secondary，和 .bm-refresh 完全一致），
			// 只有后面的值带颜色（空闲绿 / 高峰橙）。
			"." + PANEL_CLASS + " .bm-foot{display:flex;align-items:center;justify-content:space-between;gap:16px}",
			"." + PANEL_CLASS + " .bm-foot-time{font:inherit;font-weight:400;color:var(--dsw-alias-label-secondary)}",
			"." + PANEL_CLASS + " .bm-rule{height:1px;background:var(--dsw-alias-separator-primary);margin:8px 0}",
			// 「↻ 立即刷新」。内联样式换不出来禁用态，所以提到 CSS 里。
			// 颜色用 secondary（比正文 tertiary 亮一档），让它是可点的样子。
			"." + PANEL_CLASS + " .bm-refresh{font:inherit;color:var(--dsw-alias-label-secondary);background:0 0;border:0;padding:0;cursor:pointer;transition:color .12s}",
			"." + PANEL_CLASS + " .bm-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			"." + PANEL_CLASS + " .bm-refresh.busy,.dsh-balance-mini-panel .bm-refresh:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-mini";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		function levelOf(value) {
			if (typeof value !== "number") return "lv-gray";
			if (value >= 100) return "lv-green";
			if (value >= 20) return "lv-yellow";
			if (value >= 1) return "lv-red";
			return "lv-gray";
		}

		/**
		 * 段间留白（**不是分隔符**）。
		 *
		 * 原来这里渲染一个字面量 `·`（分隔点）。但后两段各自带绿点后，`·` 与绿点
		 * 挨在一起显得多余（"绿点前面的小白点"），故改为**纯宽度占位**：
		 * 不渲染任何字符，只留出约一个字符的空白。
		 *
		 * 宽度取 6px ≈ 12px 字号下一个字符的宽度，对应"余额数字后面留一个字符再接绿点"。
		 */
		/**
		 * 段间留白。
		 *
		 * ⚠️ 必须带 `key`：它和同数组里其他子元素（cell 产生的 span）并排，
		 * 缺 key 时 React 每次都报 "unique key" 警告，该位置也退化成按下标协调。
		 */
		function gap(key) {
			return react.createElement("span", { key, className: "dsh-balance-mini-gap" });
		}

				// ══════════════════════════════════════════════════════════════════════
		// 模块级取数心跳
		//
		// 为什么不让组件自己轮询（两次实机失败换来的结论）：
		//   1. 依赖数组里放 `request`（插槽的 inject 工厂每次渲染都产生新引用）
		//      → effect 被反复重建 → cleanup 清掉"3 秒后重试"的定时器 → 只请求 1 次。
		//   2. 把 `request` 挪进 ref 之后**仍然只请求 1 次** —— 宿主探针日志为证。
		//      说明还有别的 cleanup 在跑（插槽重挂载等）：只要轮询的生命周期挂在组件上，
		//      就有被中断的风险。
		//
		// 所以把轮询提到模块级、用 `setInterval` 固定节拍：
		//   · 心跳只创建一次，**组件卸载不会终止它**
		//   · 组件只订阅（订阅断了心跳照跑），并在挂载时立即触发一次拉取
		//   · 固定节拍不需要"上一跳完成后才排下一跳"，不存在链条断裂问题
		//
		// DSH 冷启动时 host 还没把会话载入内存（`ctx.sessions.get()` 返回空 → 响应没有
		// `cost`），需要十几秒；心跳每 3 秒重试，正好覆盖这段窗口。
		// ══════════════════════════════════════════════════════════════════════
		const BEAT_MS = 1000;
		const beat = {
			request: null,
			sessionId: undefined,
			refreshMs: 15000,
			snapshot: undefined,
			at: 0,
			listeners: new Set(),
			inflight: false,
			started: false,
			timer: null,
			/**
			 * 连续失败次数，用于**退避**。
			 *
			 * ⚠️ 没有它的时候有个真实缺陷：取不到数（未配置 key、host 报错）时
			 * `beatStale()` 第一个条件恒为真 → 按 `BEAT_MS`(1 秒) 一直重试。
			 * 未配置余额的用户挂机一天会被打约 8 万次请求，而 host 每次都要读
			 * 会话投影并重新计价。
			 */
			fails: 0,
			/**
			 * 手动刷新的排队标记。
			 *
			 * ⚠️ 没有它的时候，「↻ 立即刷新」在**有请求正在飞行**时是完全的空操作 ——
			 * `beatFetchNow()` 第一行就被 `inflight` 守卫挡掉，按钮毫无反应也没有任何提示。
			 * 心跳每 2 秒一轮、单次超时 8 秒，所以"飞行中"这个窗口命中概率并不低，
			 * 用户会觉得按钮时灵时不灵。
			 *
			 * 现在改成排队：飞行中点一下就**记下来**，等当前这次结束后立刻再发一次，
			 * 保证"点了就一定有一次真正的新数据"。
			 */
			pending: false,
		};

		/** 当前该用多长的"活跃周期"。 */
		function beatTurnMs() {
			// 「本轮消耗」是活跃字段，想刷得快；但**不能超过用户配置的 refreshMs** ——
			// 曾经硬编码 TURN_MS，导致 `config.refreshMs` 整条链路是死配置
			// （填 60000 也照样 2 秒一取）。
			const configured = typeof beat.refreshMs === "number" && beat.refreshMs > 0 ? beat.refreshMs : 15000;
			return Math.min(configured, TURN_MS);
		}

		/** 连续失败时的重试门槛：2 秒 → 4 → 8 …… 上限 60 秒。 */
		function beatRetryMs() {
			const base = Math.max(beat.refreshMs || 15000, beatTurnMs());
			return Math.min(base * Math.pow(2, Math.max(0, beat.fails - 1)), 60000);
		}

		/** 把最新快照推给所有订阅者（单个订阅者出错不影响其他订阅者与心跳） */
		function beatEmit() {
			for (const fn of beat.listeners) {
				try {
					fn(beat.snapshot);
				} catch {
					/* 忽略单个订阅者的异常 */
				}
			}
		}

		/**
		 * 是否该重新取数。
		 *
		 * 三个条件，**取"或"**：
		 *   1. 缺数据（没取过 / 没有 cost / cost.total 不是数字）→ 立刻重试
		 *   2. 距上次取数超过 refreshMs（常规轮询节奏，默认 15 秒）
		 *   3. 距上次取数超过 TURN_MS —— 「本轮消耗」是活跃字段
		 *
		 * ⚠️ 条件 3 是必需的：「本轮」在一个回答里会跳好几次，若只按 refreshMs 刷新，
		 * 这个数字会明显滞后，看起来就像"一直显示 —"（曾经的真实故障）。
		 *
		 * ## 节奏为什么是这几个值
		 *
		 * 实际更新间隔 = TURN_MS（**不是** BEAT_MS —— 后者只是"醒来检查"的粒度）。
		 * 想更快就调小 TURN_MS，但每次取数都要让宿主读会话投影并重新计价：
		 *
		 *   TURN_MS  每分钟请求   观感
		 *   1000     60          与 2 秒几乎无差别，纯浪费
		 *   2000     30          已经"跟着走"
		 *   4000     15          略有滞后感
		 *
		 * 取 2000：人眼在这个量级已分辨不出更快。BEAT_MS 必须 ≤ TURN_MS，
		 * 否则检查粒度会成为瓶颈（设 3000 而 TURN_MS=2000 的话，实际间隔是 3000）。
		 *
		 * refreshMs 从 60 秒压到 15 秒：余额与「会话累计」变化慢，15 秒足够，
		 * 而 60 秒会让它们在回答过程中显得不动。
		 */
		const TURN_MS = 2000;
		function beatStale() {
			if (beat.at === 0) return true;
			const age = Date.now() - beat.at;
			// ⚠️ **先看退避**：连续失败时用递增的门槛，避免退化成 1 Hz 永久轮询。
			if (beat.fails > 0) return age >= beatRetryMs();
			const cost = beat.snapshot && beat.snapshot.cost;
			if (!cost || typeof cost.total !== "number") return true;
			if (age >= beat.refreshMs) return true;
			// 本轮金额是活跃字段：用更短的周期刷新
			return age >= beatTurnMs();
		}

		/**
		 * 取一次数。
		 *
		 * `force` 区分两种调用者：
		 *   · 心跳 / 挂载时首次拉取（force=false）—— 有请求在飞就直接返回，不排空转
		 *   · 用户点「↻ 立即刷新」（force=true）—— **飞行中也要排队**，
		 *     等当前这次结束后立刻补发一次，保证"点了就一定有一次新数据"。
		 */
		async function beatFetchNow(force = false) {
			if (beat.inflight) {
				// 手动刷新：记下意图，本次结束后补发（见 finally）
				if (force) beat.pending = true;
				return;
			}
			if (!beat.request) return;
			const sid = beat.sessionId;
			if (sid === undefined) return;
			beat.inflight = true;
			try {
				// ⚠️ 必须带超时。`inflight` 是个闩锁：一次不落地的 RPC 会让它永远是 true，
				// 此后每次心跳都在上面那行原地返回 —— 界面永久停在旧数字，只能刷新页面。
				// 宿主不可用/网络异常时 rpc.call 未必会 reject，所以不能只依赖 catch。
				let signal;
				try {
					signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
						? AbortSignal.timeout(8000)
						: undefined;
				} catch {
					signal = undefined;
				}
				const response = signal !== undefined ? await beat.request(sid, signal) : await beat.request(sid);

				// ⚠️ 会话可能在请求飞行期间切走了：旧会话的响应不能当成新会话的数据，
				// 也不该刷新 beat.at（否则最长一个周期内不会纠正）。
				if (sid !== beat.sessionId) return;

				if (response && response.ok === true) {
					beat.snapshot = response.value;
					beat.fails = 0;
				} else {
					beat.snapshot = { error: "unavailable" };
					beat.fails += 1;
				}
			} catch {
				if (sid === beat.sessionId) {
					beat.snapshot = { error: "unavailable" };
					beat.fails += 1;
				}
			} finally {
				beat.inflight = false;
				if (sid === beat.sessionId) beat.at = Date.now();
			}
			beatEmit();

			// 手动刷新在飞行期间被排队了 → 补发一次。
			// 放在 finally 之后（此时 inflight 已复位），所以递归调用不会再被守卫挡掉。
			if (beat.pending) {
				beat.pending = false;
				// 不 await：本函数已被调用方 fire-and-forget，补发这次同样不必等。
				void beatFetchNow();
			}
		}

		/** 用户点「↻ 立即刷新」：强制取一次，飞行中也算数（会排队）。 */
		function beatRefresh() {
			return beatFetchNow(true);
		}

		/**
		 * 启动心跳（幂等）。在 apply() 里调用一次即可。
		 *
		 * \`BEAT_MS\` 是**检查的频率**，不是取数的频率 —— 每次醒来先问
		 * \`beatStale()\`，只有确实过期才发请求（见 TURN_MS / refreshMs 两个门槛）。
		 * 所以这里设得比实际刷新更密也无妨。
		 */
		function beatStart() {
			if (beat.started) return;
			beat.started = true;
			beat.timer = setInterval(() => {
				if (beatStale()) beatFetchNow();
			}, BEAT_MS);
		}

		/**
		 * 停掉心跳并释放引用。
		 *
		 * ⚠️ 心跳仍然是**模块级**的（组件的挂载/卸载不影响它 —— 这是刻意的），
		 * 但它的生命周期应该跟着**插件**走而不是跟着**进程**走：
		 * 插件被停用后定时器若继续跑，就会拿着已经 dispose 的 scope 每秒发 RPC
		 * （异常被静默吞掉）；热重载则会重新求值整个 bundle，旧的 beat 对象与新
		 * 定时器互不知情，于是 N 次重载 = N 份轮询。
		 *
		 * 由 apply() 通过 ctx.effect 的 disposer 调用。
		 */
		function beatStop() {
			if (beat.timer !== null) {
				clearInterval(beat.timer);
				beat.timer = null;
			}
			beat.started = false;
			beat.request = null;
			beat.listeners.clear();
		}

		/** 浮层优先放在锚点上方；上方空间不足则翻到下方，并夹在视口内。 */
		function useAnchoredPosition(open, anchorRef, panelRef) {
			const [pos, setPos] = react.useState(null);
			react.useLayoutEffect(() => {
				if (!open) {
					setPos(null);
					return;
				}
				const GAP = 8;
				const MARGIN = 8;
				const measure = () => {
					const a = anchorRef.current;
					const p = panelRef.current;
					if (!a || !p) return;
					const ar = a.getBoundingClientRect();
					const pr = p.getBoundingClientRect();
					let top = ar.top - pr.height - GAP;
					if (top < MARGIN) top = Math.min(ar.bottom + GAP, window.innerHeight - pr.height - MARGIN);
					let left = ar.left + ar.width / 2 - pr.width / 2;
					left = Math.max(MARGIN, Math.min(left, window.innerWidth - pr.width - MARGIN));
					setPos({ position: "fixed", top: top, left: left });
				};
				measure();
				const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : undefined;
				window.addEventListener("resize", measure);
				window.addEventListener("scroll", measure, true);
				return () => {
					if (raf !== undefined) cancelAnimationFrame(raf);
					window.removeEventListener("resize", measure);
					window.removeEventListener("scroll", measure, true);
				};
			}, [open, anchorRef, panelRef]);
			return pos;
		}

		function BalanceChip(props) {
			// ⚠️ 兜底值必须与 beat 的默认值一致（15000）。
			// 曾经这里写 60000 而 apply() 传 15000 —— props 缺失时反而把插件的默认值
			// 覆盖成更慢的值，两边不一致。
			const refreshMs = isNum(props.refreshMs) && props.refreshMs > 0 ? props.refreshMs : 15000;
			const request = props.requestBalance;
			// 会话 id 由框架作为 slot props 注入（官方组件同样从 props 取）。
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : undefined;

			const [snapshot, setSnapshot] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			// nonce：点一次「↻ 立即刷新」加一；刷新结束后**复位成 0**。
			// 所以 `nonce > 0` 本身就表示"刷新中"，不必再加一个 state。
			//
			// ⚠️ 刻意不引入 `const [refreshing, setRefreshing] = useState(false)`：
			// render-test 的 hook 桩用"初值为 false"来识别 open 的 setter
			// （见 tools/render-test.mjs 的 `if (hooks[i].v === false) rt._boolSetter = set`），
			// 再加一个 false 初值的 state 会把 open 的 setter 覆盖掉，
			// 导致测试里浮层永远打不开、头部断言集体假失败。
			// 用派生值既避免了这个问题，也少一份需要同步的状态。
			const [nonce, setNonce] = react.useState(0);
			const refreshing = nonce > 0;
			const anchorRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const pos = useAnchoredPosition(open, anchorRef, panelRef);

			/**
			 * 组件只做两件事：**把上下文交给心跳** + **订阅结果**。
			 * 轮询本身在模块级（见文件上方 beat* 一组函数），组件挂载/卸载都不影响它。
			 * 心跳直接读模块级的 `beat.request`，所以这里不需要再存一份 ref。
			 */

			// ⚠️ 上下文在 **render 阶段同步写入**，不要放进 effect：
			// 心跳是模块级的，随时可能触发；若依赖 effect 写入，第一次 `beatFetchNow()`
			// 可能读到还没设置的 sessionId 而直接返回（漏掉首次拉取）。
			// 这正是本地心跳测试抓到的 bug（fetchCount 恒为 0）。
			beat.request = request;
			beat.sessionId = sessionId;
			beat.refreshMs = refreshMs;

			// 立即拉一次（不等下一个心跳节拍）
			// ⚠️ nonce 变化（点了「立即刷新」）走的是**同一个 effect** —— 所以这里要调
			// 带 force 的那个函数，否则飞行中点击仍会被 inflight 守卫吞掉。
			// 判断依据：nonce 不为 0 就说明是用户点的（初值 0 只在挂载时出现）。
			react.useEffect(() => {
				if (nonce > 0) void beatRefresh();
				else void beatFetchNow();
			}, [refreshMs, sessionId, nonce]);

			// 「刷新中」的复位：轮询 beat 的状态，直到既不 inflight 也没有排队，才把
			// nonce 归零（按钮随之复原）。
			//
			// 用轮询而不是在按钮的 onClick 里直接 setTimeout，是为了覆盖**被排队**的情况：
			// 排队时请求要等当前这次结束才发，按钮应该全程显示"刷新中"。
			// 归零会再触发上面那个 effect，但 `nonce > 0` 不成立，所以只走 beatFetchNow()
			// —— 那是幂等的（数据新鲜时 beatStale() 为假，不发请求）。
			react.useEffect(() => {
				if (nonce === 0) return undefined;
				let cancelled = false;
				const check = () => {
					if (cancelled) return;
					if (!beat.inflight && !beat.pending) {
						setNonce(0);
						return;
					}
					setTimeout(check, 120);
				};
				const t = setTimeout(check, 120);
				return () => {
					cancelled = true;
					clearTimeout(t);
				};
			}, [nonce]);

			react.useEffect(() => {
				const onBeat = (next) => setSnapshot(next);
				beat.listeners.add(onBeat);
				// 已有结果就立刻渲染，避免插槽重挂时白屏
				if (beat.snapshot !== undefined) setSnapshot(beat.snapshot);
				return () => {
					beat.listeners.delete(onBeat);
				};
			}, []);

			// 展开时：外部点击、Esc 关闭（对齐原厂 useStatDialog 的行为）
			react.useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					const t = event.target;
					if (anchorRef.current && anchorRef.current.contains(t)) return;
					if (panelRef.current && panelRef.current.contains(t)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			const data = snapshot || {};
			// 字段对应 host /balance-mini 的响应：
			//   余额 = value.total（不是 balance！这里曾写错，导致恒显示"未就绪"）
			//   费用 = value.cost.{total,turn,day,…}
			//
			// ⚠️ 一律用 isNum（含 Number.isFinite）而不是裸 `typeof === "number"`：
			// RPC 若走结构化克隆而不是 JSON，NaN 会**原样到达**，
			// 于是 `typeof NaN === "number"` 成立 → 渲染出「¥NaN」「NaN%」。
			// `data.total` = **总余额**（充值 + 赠金）—— 胶囊上那个数。
			const balanceYuan = isNum(data.total) ? data.total : null;
			// `data.topUp` = **充值余额**（浮层正文第一排「充值余额」）。
			// 回退到 data.total 只为了兼容 0.10.x 的旧 host —— 那时 `total` 本来就等于
			// 充值余额（没有赠金字段），所以回退在语义上是对的。
			const topUpYuan = isNum(data.topUp) ? data.topUp : balanceYuan;
			const turnYuan = data.cost && isNum(data.cost.turn) ? data.cost.turn : null;
			const totalYuan = data.cost && isNum(data.cost.total) ? data.cost.total : null;

			let level = "lv-gray";
			let label = "\u603b\u4f59\u989d \u2026";
			if (data.error) {
				label = "\u603b\u4f59\u989d" + (data.error === "unavailable" ? "\u4e0d\u53ef\u7528" : "\u67e5\u8be2\u5931\u8d25");
			} else if (!data.configured) {
				label = "\u603b\u4f59\u989d\u672a\u914d\u7f6e";
			} else if (balanceYuan === null) {
				label = "\u603b\u4f59\u989d\u672a\u5c31\u7eea";
			} else {
				level = levelOf(balanceYuan);
				// 余额也带货币符号，与后面的消费金额视觉一致
				label = "\u00a5" + fmtMoney(balanceYuan, 2);
			}

			/**
			 * 是不是一个可用的数字。
			 *
			 * ⚠️ 必须带 `Number.isFinite`，不能只写 `typeof x === "number"`：
			 * RPC 若走结构化克隆（而非 JSON），`NaN` / `Infinity` 会**原样到达**，
			 * 而 `typeof NaN === "number"` 是成立的 —— 于是会渲染出「¥NaN」「NaN%」。
			 * 项目里所有数值判断统一走这个函数。
			 */
			function isNum(v) {
				return typeof v === "number" && Number.isFinite(v);
			}

			/** token 数按中文习惯缩位：1.2亿 / 3784万 / 12k / 856 */
			// ⚠️ 用**函数声明**而不是 const 箭头函数：与 money/fmtMoney 保持一致，
			// 避免"定义在使用之后"的 TDZ —— 本项目曾因 fmtMoney 是 const 而在渲染期
			// 抛 ReferenceError，React 直接把整棵子树卸载（胶囊消失）。
			function fmtCount(n) {
				if (!isNum(n)) return "\u2014";
				if (n >= 1e8) return (n / 1e8).toFixed(2) + "\u4ebf";
				if (n >= 1e4) return (n / 1e4).toFixed(1) + "\u4e07";
				return Math.round(n).toLocaleString("en-US");
			}

			/**
			 * 金额格式化：**四舍五入到最多 3 位小数，再去掉尾随零**。
			 *
			 *   554.13029422 → "554.13"      （3 位后是 0，去掉）
			 *   13.2645023   → "13.265"      （3 位有效）
			 *   0.095213     → "0.095"
			 *   0.1          → "0.1"         （不是 "0.100"）
			 *   0.001        → "0.001"
			 *   1            → "1"
			 *   555.4        → "555.4"
			 *
			 * 为什么是 3 位而不是原样：接口给的余额/累计带 8 位小数，那是平台内部用
			 * `big.js` 算出的原值（官方并不规定显示位数），照搬对人类没有意义 ——
			 * 金额不会便宜到需要 8 位精度。3 位足够看清"本轮"的成本量级（¥0.095），
			 * 又不会出现 ¥0.095213 这种噪声。
			 *
			 * ⚠️ 别改成"不四舍五入"：曾按原样显示，余额变成 ¥554.13029422。
			 *
			 * @param {number} n - 金额（元）。
			 * @returns {string} 最多 3 位小数、已去尾随零；非数字返回 "—"。
			 */
			/**
			 * 金额格式化。
			 *
			 * 默认：按数值自身精度最多 3 位小数，并去掉尾随零
			 *   （554.13029422 → 554.13、0.095213 → 0.095、0.1 → 0.1）
			 *
			 * 传 `min` 时：至少保留这么多位小数，不足则补零
			 *   （余额用 min=2：548.7 → 548.70、548.68 → 548.68）
			 *
			 * 第 min+1 位决定第 min 位的取值 —— 这就是 `toFixed(min)` 的标准四舍五入，
			 * 不额外加任何规则。
			 *
			 * @param {number} n - 金额（元）。
			 * @param {number} [min] - 最少保留的小数位；省略则按数值自身精度、上限 3 位。
			 */
			function fmtMoney(n, min) {
				if (typeof n !== "number" || !Number.isFinite(n)) return "\u2014";
				const digits = typeof min === "number" && min > 0 ? min : 3;
				// toFixed 会补零，所以必须再去尾随零；否则 554.13 会显示成 554.130
				const s = n.toFixed(digits).replace(/0+$/, "");
				const trimmed = s.endsWith(".") ? s.slice(0, -1) : s;
				// 指定了最少位数就补回来（余额固定 2 位，便于纵向对齐）
				if (typeof min !== "number" || min <= 0) return trimmed;
				if (!trimmed.includes(".")) return trimmed + "." + "0".repeat(min);
				const dec = trimmed.split(".")[1];
				return dec.length >= min ? trimmed : trimmed + "0".repeat(min - dec.length);
			}

			/**
			 * 金额占位：**没有办法计算时显示 "—"，而不是把整段省掉**。
			 *
			 * 曾经的做法是"没有本轮就省略最后那段"，结果是刚打开 DSH 时只有两段、
			 * 发出消息后突然变三段 —— 数字左右横移，看起来像坏了。
			 * 现在三段**始终占位**，只是无值时显示 "—"，位置固定不动。
			 *
			 * 注意 "—" 与 "¥0" 的区别：显示 ¥0 会被读成"本轮没花钱"，而实际可能是
			 * "还算不出来"（例如本轮刚开始、基准刚建立）。用 "—" 表达"暂无数据"更准确。
			 *
			 * ⚠️ 必须定义在 fmtMoney 之后、被 row()/cell() 使用之前 —— `const` 有暂时性
			 * 死区，放在后面会抛 ReferenceError（本插件踩过一次）。
			 */
			function money(v, min) {
				return isNum(v) ? "\u00a5" + fmtMoney(v, min) : "\u2014";
			}

			// 展开后的明细（键值对，走原厂的 dt/dd 网格样式）
			const rows = [];
			const row = (k, v) => {
				if (v === null || v === undefined) return;
				rows.push(react.createElement("dt", { key: k }, k), react.createElement("dd", { key: k + "-v" }, v));
			};

			// ── 金额（本插件的核心：官方 UI 完全不展示钱数） ──
			// 行序按"统计口径由大到小"：余额（账户）→ 会话累计（本会话）→ 本日消耗（本日）→ 每轮平均消耗
			//
			// ⚠️ **面板里不放「本轮消耗」**。它已经在胶囊上实时显示，放进面板是重复的；
			// 而面板里更需要的是"今天一共花了多少"这种胶囊放不下的口径。
			// 这也让面板与胶囊**各有侧重**：胶囊看即时，面板看汇总。
			//
			// 各行**始终存在**：算不出来时显示 "—"（由 money() 处理），不整行省略 ——
			// 否则浮层高度会随状态变化，看起来像少了一行。
			// ⚠️ 「余额」不在正文里 —— 已移到头部（官方弹窗的头部也放主数值）。
			// 放两处会让读者以为"头部那个"和"正文那个"是两个不同的数。
			//
			// ⚠️ **「会话累计」也不在正文里** —— 它就在胶囊上，而且是实时的（2 秒刷新）。
			// 曾经这里也放一行，于是同一个数在胶囊和浮层里各出现一次；
			// 两处刷新节奏不同（胶囊 2 秒、浮层跟随同一次快照但视觉上不在同一处），
			// 数字对不上时反而让人怀疑哪个是真的。与「余额」「本日消耗」同理：
			// **一个数只在一个地方出现**。
			// 需要总耗时看胶囊；需要"每次问话花多少"看下面的「每轮平均消耗」。
			//
			// ⚠️ 「本日消耗」不在正文里 —— 已移到头部右侧。
			//
			// 「赠金余额」——账号侧有**两个钱包**：充值余额（正文第一排）与赠金余额（这一行）。
			// 官方账号设置页把两者并列（语言包：`balance: "充值余额"` /
			// `bonusBalance: "赠金余额"`），而本插件此前只画了前者 —— 赠金**完全看不见**，
			// 偏偏它是**会过期**的那部分，用户最需要知道还剩多少。
			//
			// 显示口径（用户定的）：**没有赠金就显示 "—"** —— 0 与"取不到"一律算"没有"，
			// 不显示 "¥0.00"。所以这里不是 money()（它会把 0 格式化成 ¥0.00），
			// 而是显式判 `> 0`。想改回"0 也显示金额"只需去掉这个判断。
			//
			// 标签后缀「（优先消耗）」来自官方扣费规则原文：
			//   "当充值余额与赠送余额同时存在时，优先扣减赠送余额。"
			//   —— https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
			// 这不是补充说明，而是回答"我充了钱为什么先扣那 22 块"的唯一线索。
			// 正文前两行 = 账户余额的**构成**（标题是总额，这里是拆分）：
			//   第一排 充值余额、第二排 赠金余额 —— 两行相加就是标题那个数。
			row("\u5145\u503c\u4f59\u989d", money(topUpYuan, 2));
			row("\u8d60\u91d1\u4f59\u989d\uff08\u4f18\u5148\u6d88\u8017\uff09", isNum(data.granted) && data.granted > 0 ? money(data.granted, 2) : "\u2014");
			row("\u6bcf\u8f6e\u5e73\u5747\u6d88\u8017", data.cost && isNum(data.cost.avgPerTurn)
				? "\u00a5" + fmtMoney(data.cost.avgPerTurn) + " \u00b7 " + data.cost.turns + " \u8f6e"
				: "\u2014");

			// ── token（不给官方那五项明细，只给成本视角：总量与缓存占比） ──
			const tt = data.cost && data.cost.totalTokens;
			if (tt) {
				const sum = tt.cacheReadTokens + tt.uncachedInputTokens + tt.outputTokens + tt.cacheWriteTokens;
				// 「会话累计 token」——强调是**跨天累加**的会话总量，不是本轮也不是今日。
				row("\u4f1a\u8bdd\u7d2f\u8ba1 token", fmtCount(sum));
				const share = data.cost && isNum(data.cost.cacheShare) ? data.cost.cacheShare : null;
				// 「会话命中缓存」——上面总量里命中缓存的那部分。
				// 之所以能占 99%：每跑一步都要把整个上下文重读一遍，而重读全走缓存（0.02/百万）。
				row("\u4f1a\u8bdd\u547d\u4e2d\u7f13\u5b58", fmtCount(tt.cacheReadTokens) + (share !== null ? "\uff08" + (share * 100).toFixed(1) + "%\uff09" : ""));
			}
			// 本日 token：与上面的「本日消耗」同一区间，口径一致。
			// ⚠️ 原先是「本轮 token」—— 与胶囊上的实时值重复，且换了口径后这里也该跟着换。
			if (data.cost && data.cost.dayTokens) {
				const dt = data.cost.dayTokens;
				row("\u672c\u65e5 token", fmtCount(dt.cacheReadTokens + dt.uncachedInputTokens + dt.outputTokens + dt.cacheWriteTokens));
			}

			// ── 计价依据 ──
			// 用官方的短术语：命中（缓存命中）/ 未命中（缓存未命中）/ 输出。
			// 行名带「元/百万 token」——否则这三个数字会被当成"花了多少钱"。
			row("\u5355\u4ef7\uff08\u5143/\u767e\u4e07 token\uff09", data.cost
				? "\u547d\u4e2d " + (data.cost.peak ? "0.04" : "0.02")
					+ " \u00b7 \u672a\u547d\u4e2d " + (data.cost.peak ? "2" : "1")
					+ " \u00b7 \u8f93\u51fa " + (data.cost.peak ? "8" : "4")
				: null);
			// 只留结论：高峰 / 空闲。括号里的判断依据（工作日 9-12/14-18、
			// 法定节假日全天、非工作日…）在浮层里太长，用户反馈"啰嗦"。
			// 依据仍然可查：数据缺失时有专门的「节假日数据」警示行，规则见 README。
			//
			// 位置：不再占正文一行，而是移到底部与「↻ 立即刷新」同一排（靠右），
			// 显示成「当前时段：空闲」。两种状态各上一个官方语义色：
			// 空闲 = 成功绿（便宜），高峰 = 警告橙（贵一倍，是提醒不是错误）。
			const slotText = data.cost
				? react.createElement(
					"span",
					{ className: "bm-slot " + (data.cost.peak ? "bm-slot-peak" : "bm-slot-idle") },
					data.cost.peak ? "\u9ad8\u5cf0" : "\u7a7a\u95f2",
				)
				: null;
			// ⚠️ 当年节假日数据缺失时**必须显式警示**（原先只把措辞从"非工作日或非高峰"
			// 悄悄换成"非高峰时段"，两者读起来几乎一样，用户根本看不出差别）。
			//
			// 后果不是"少个提示"那么轻：未收录年份的**所有法定节假日**都会被按
			// 工作日高峰计价，费率约为空闲时段的 2 倍，而且不报错、界面也看不出来。
			// 每年 11 月国务院公布次年安排，这个状态是常态需要维护的。
			//
			// ⚠️ **只在缺数据时出现**，数据齐全时整行不显示 —— 这一行的存在意义是警示，
			// 不是汇报"一切正常"；"已收录"对用户没有任何信息量，纯噪音。
			// 代价：缺数据的年份会让浮层多一行（布局跳动），但那种年份本来就应该被看见。
			if (data.cost && data.cost.holidayDataKnown === false) {
				row("\u8282\u5047\u65e5\u6570\u636e", "\u672c\u5e74\u672a\u6536\u5f55 \u00b7 \u8282\u5047\u65e5\u671f\u95f4\u8d39\u7528\u53ef\u80fd\u504f\u9ad8");
			}

			/**
			 * 余额图标（钱包）。
			 *
			 * 官方 lexicon 里**没有金额类图标**（91 个图标中无 wallet/coin/money），
			 * 所以自绘一个。格式严格对齐官方 `IconClockOutlineRegular` 的做法：
			 *   \`viewBox="0 0 16 16"\`、\`fill="none"\`、\`stroke="currentColor"\`、\`strokeWidth 1\`、
			 *   \`aria-hidden="true"\`、尺寸走 \`size\` 参数（官方默认也是 16）。
			 * 用 currentColor 才能跟随面板文字色（与官方图标一致，不写死颜色）。
			 */
			function walletIcon(size) {
				const s = typeof size === "number" ? size : 16;
				return react.createElement(
					"svg",
					{
						width: s,
						height: s,
						viewBox: "0 0 16 16",
						fill: "none",
						xmlns: "http://www.w3.org/2000/svg",
						"aria-hidden": "true",
						style: { flex: "none", display: "block" },
					},
					// 只画两笔：钱包轮廓 + 侧面扣子。
					// ⚠️ 曾在 16px 里塞进「矩形 + 中间的卡槽横线 + 扣子」三样，
					// 结果糊成一团、认不出是什么。小尺寸图标必须**减笔**，
					// 留一个能认出的剪影即可。
					react.createElement("rect", {
						x: "1.5", y: "3.5", width: "13", height: "9", rx: "2",
						stroke: "currentColor", strokeWidth: "1",
					}),
					react.createElement("circle", {
						cx: "11", cy: "8", r: "1.2",
						stroke: "currentColor", strokeWidth: "1", fill: "none",
					}),
				);
			}

			const panel = open && typeof document !== "undefined"
				? reactDOM.createPortal(
					react.createElement(
						"div",
						{
							ref: panelRef,
							className: PANEL_CLASS,
							role: "dialog",
							// 无障碍名称：与新的头部结构对应（头部现在是「余额 + 本日」，
							// 正文是会话累计等明细）。旧名「余额与消耗」已不准确。
							"aria-label": "\u4f59\u989d\u4e0e\u6d88\u8017\u660e\u7ec6",
							style: pos || { position: "fixed", visibility: "hidden", top: 0, left: 0 },
						},
						// 头部：图标 + 「余额」+ 金额，右端「本日消耗」+ 金额。
						//
						// 结构对齐官方弹窗（会话统计 / Token 用量都是「图标 + 名称 + 数值」+ 分割线）。
						// 但官方标题行只有**两项**（titleLabel / titleValue，靠 space-between 推到两端），
						// 本插件右端多一组「本日消耗」，所以：
						//   左端 = bm-head-main（图标 + 充值余额）
						//   中 = bm-head-value（余额金额）
						//   右端 = bm-head-day（本日消耗 + 其金额，**组内用 gap 分隔**）
						// 右端做成"一组"而不是"标签+数字两个并列项"，是为了让标签与数字成对，
						// 不会被 space-between 拉散。
						//
						// ⚠️ 标签是「充值余额」而不是「余额」：账号有**两个钱包**（充值 / 赠金），
						// 正文首行就是「赠金余额」——只写「余额」会让读者分不清这是总额还是其中一部分。
						// 两个标签同构（X 余额）之后，关系是自明的。胶囊上仍用短标签「余额」：
						// 每多两个字，那段就宽约 26px，而胶囊是常驻的、没有解释空间。
						react.createElement(
							"div",
							{ className: "bm-head" },
							react.createElement("span", { className: "bm-head-main" }, walletIcon(18), "\u603b\u4f59\u989d"),
							react.createElement(
								"span",
								{ className: "bm-head-value" },
								balanceYuan !== null ? "\u00a5" + fmtMoney(balanceYuan, 2) : (data.error ? "\u67e5\u8be2\u5931\u8d25" : "\u2014"),
							),
							data.cost && typeof data.cost.day === "number"
								? react.createElement(
									"span",
									{ className: "bm-head-day" },
									react.createElement("span", null, "\u672c\u65e5\u6d88\u8017"),
									react.createElement("span", null, "\u00a5" + fmtMoney(data.cost.day)),
								)
								: null,
						),
						react.createElement("div", { className: "bm-head-rule" }),
						react.createElement("dl", { className: "bm-details" }, rows),
						react.createElement("div", { className: "bm-rule" }),
						// 底排：「↻ 立即刷新」在左，「当前时段：空闲」靠右。
						//
						// ⚠️ 这里曾经只做 `setNonce(n => n + 1)` —— nonce 变化确实会让上面
						// 那个 effect 重跑，但 effect 里调的是**不带 force** 的 `beatFetchNow()`，
						// 它第一行就被 `inflight` 守卫挡掉。心跳 2 秒一轮、单次超时 8 秒，
						// 所以"有请求在飞"的窗口命中概率不低 → 按钮时灵时不灵，且毫无提示。
						//
						// 现在：nonce 变化走 `beatRefresh()`（飞行中会排队），
						// 并用 `refreshing` 给出可见反馈（含排队等待的整段时间）。
						react.createElement(
							"div",
							{ className: "bm-foot" },
							react.createElement(
								"button",
								{
									type: "button",
									className: "bm-refresh" + (refreshing ? " busy" : ""),
									disabled: refreshing,
									// 已禁用时再点由浏览器拦住；禁用本身也是"正在刷新"的视觉信号
									onClick: () => setNonce((n) => n + 1),
									title: refreshing ? "\u6b63\u5728\u5237\u65b0\u2026" : "\u91cd\u65b0\u83b7\u53d6\u4f59\u989d\u4e0e\u6d88\u8017",
								},
								refreshing ? "\u21bb \u5237\u65b0\u4e2d\u2026" : "\u21bb \u7acb\u5373\u5237\u65b0",
							),
							slotText === null
								? null
								: react.createElement(
									"span",
									{ className: "bm-foot-time" },
									"\u5f53\u524d\u65f6\u6bb5\uff1a",
									slotText,
								),
						),
					),
					document.body,
				)
				: null;

			/** 无障碍标签：把三段读成一句话，屏幕阅读器不会念丢标签。顺序与视觉一致 */
			const ariaLabel = [
				// 胶囊常驻，显示**总余额**（充值 + 赠金）：一眼看到"还有多少钱"。
				// 面板里再拆开：头部「充值余额」+ 正文「赠金余额」。
				"\u603b\u4f59\u989d " + (balanceYuan !== null ? "\u00a5" + fmtMoney(balanceYuan, 2) : label),
				"\u4f1a\u8bdd\u7d2f\u8ba1 " + money(totalYuan),
				"\u672c\u8f6e\u6d88\u8017 " + money(turnYuan),
			].join("\uff0c");

			// 胶囊按「标签 + 数字」成对渲染：只有数字时无法分辨是余额、本轮还是会话，
			// 这三个数一旦混淆就会得出完全错误的结论（曾因此误解过）。
			// 带标签会变长，但语义不含糊 —— 这是刻意的取舍。
			//
			// 顺序按「变化速度」排：余额（15 秒刷新，几乎不动）→ 会话累计（每步递增）
			// → 本轮消耗（每步重置累加，跳动最明显）。最活跃的数字落在最右边，
			// 视线自然停在它上面。
			//
			// 每段一个圆点，**三段各一色**便于区分（绿 / 蓝 / 粉）。
			//
			// 曾经三点同色（跟随余额分档），但视觉上分不出三段，被反馈"不好看"。
			// 现在颜色是"段标识"而非"状态"：余额的红/黄告警仍由 6px 状态点单独承担。
			//
			// ⚠️ **余额段不再额外加小圆点** —— 它前面已经有 6px 状态点（就是那个绿点），
			// 再加一个 5px 绿点会出现"两个绿点"，实机与预览都踩过。
			// 所以下面的余额段 dotClass 传空。
			const cell = (key, caption, text, dotClass) => [
				...(dotClass
					? [react.createElement("span", { className: "dsh-balance-mini-minidot " + dotClass, key: key + "-d" })]
					: []),
				react.createElement("span", { className: "dsh-balance-mini-cap", key: key + "-c" }, caption),
				react.createElement("span", { key: key + "-v" }, text),
			];

			const children = [react.createElement("span", { className: "dsh-balance-mini-dot", key: "dot" })];
			// ① 余额（账户充值余额，快照值）—— 绿点由上面的 6px 状态点承担，此处不加
			children.push(...cell("bal", "\u603b\u4f59\u989d", label));
			// ② 会话累计：本会话建立至今的累计 —— 蓝
			children.push(gap("gap-sess"), ...cell("sess", "\u4f1a\u8bdd\u7d2f\u8ba1", money(totalYuan), "dot-sess"));
			// ③ 本轮消耗：这一句话从发问到此刻的合计 —— 粉
			children.push(gap("gap-turn"), ...cell(
				"turn",
				"\u672c\u8f6e\u6d88\u8017",
				// 没有进行中的轮次时 host 回退返回上一轮的值（用户要求不再标注"上次"）
				money(turnYuan),
				"dot-turn",
			));

			// 结构对齐原厂：页面里只有「按钮 + 浮层」两个节点。
			// order:1 写在按钮自己身上（原厂的 .anchor 也是直接作为 dock 的 flex item），
			// 不再套一层 span —— 少一层 DOM，也避免外层 span 的行高/字体参与布局。
			return react.createElement(
				react.Fragment,
				null,
				react.createElement(
					"button",
					{
						ref: anchorRef,
						type: "button",
						className: CHIP_CLASS + " ready " + level,
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						"aria-label": ariaLabel,
						onClick: () => setOpen(!open),
					},
					children,
				),
				panel,
			);
		}

		/**
		 * 本插件需要的依赖：`slots` 用于注册 dock 插槽，`connection` 用于发 RPC 取余额。
		 */
		const inject = ["slots", "connection"];

		/**
		 * 全程 try/catch：宿主把客户端插件激活失败当致命错误（web boot:
		 * entry did not activate），会连带让启动失败并把 bundle 摘掉。
		 * 这里吞掉异常，最坏情况退化为"不显示胶囊"。
		 */
		function apply(ctx, config) {
			try {
				ensureCss();
				// 启动模块级取数心跳（幂等）。轮询不依赖组件挂载 —— 见文件上方 beat* 说明。
				beatStart();

				// ⚠️ 心跳是模块级的（组件卸载不停它），但**插件停用时必须停**：
				// 否则定时器会拿着已 dispose 的 scope 每秒发 RPC（异常被静默吞掉），
				// 热重载还会因 bundle 重新求值而叠加出多份轮询。
				// 用 ctx.effect 的 disposer 把生命周期绑到插件上。
				if (ctx && typeof ctx.effect === "function") {
					try {
						ctx.effect(() => beatStop, "balance-mini heartbeat");
					} catch {
						/* 老宿主没有 effect 就退化为进程级（与之前行为一致） */
					}
				}

				const parsed = Number(config && config.refreshMs);
				const refreshMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;

				ctx.inject(inject, (scope) => {
					try {
						// 会话 id 由 slot props 提供，组件渲染时传进来（见 BalanceChip）。
						// host 用它从会话投影读 tokenUsage（含被 wire.view 过滤掉的 last），
						// 并把「余额 + 单次 + 累计」一并算好返回。
						//
						// ⚠️ 这个 inject 工厂**只创建一次、引用保持稳定**。
						// `register(options, component)` 会把 `options.inject` 原样存进注册条目；
						// 若写成内联箭头函数（每次求值都是新身份），插槽会认为换了新条目，
						// 从而重建组件。官方 dock 条目的写法同样是把依赖一次算好传进去。
						const requestBalance = (sessionId, signal) =>
							scope.connection.rpc.call(RPC_CHANNEL, "fetch", { sessionId: sessionId }, signal);
						const stableInject = () => ({ refreshMs: refreshMs, requestBalance: requestBalance });
						scope.slots.inject("conversation.composer.dock", () => scope.slots.register({
							name: "conversation.composer.dock",
							id: "balance-mini",
							priority: 50,
							inject: stableInject,
						}, BalanceChip));
					} catch (error) {
						if (typeof console !== "undefined") console.warn("[dsh-balance-mini] dock mount failed:", error);
					}
				});
			} catch (error) {
				if (typeof console !== "undefined") console.warn("[dsh-balance-mini] apply failed:", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
