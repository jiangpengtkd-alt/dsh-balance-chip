/**
 * 中国法定节假日日期表（仅"放假"日，不含调休补班日）。
 *
 * 用途：DeepSeek 的计价规则是
 *   "北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
 *    其余时段，包括周末及中国法定节假日全天均为空闲时段。"
 *   —— https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 所以判断高峰前要先排除法定节假日。
 *
 * 为什么不需要"调休补班日"数据：规则写的是"周一至周五"，官方另说明
 * "调休上班的周末、中国法定节假日全天均按空闲时段计费" —— 补班日（多为周六日）
 * 本就不在周一至周五之列，因此不会产生新的高峰时段。
 *
 * 数据来源：国务院办公厅《关于XXXX年部分节假日安排的通知》（每年 11 月前后发布），
 * 经 timor.tech 的公开接口整理。2026 年数据已与官方原文逐条核对一致：
 *   https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 *
 * ⚠️ 维护方式：国务院通常每年 11 月公布次年安排。到时会话里说一句
 *   "更新 holidays.js"，按下面命令重新生成即可。未收录的年份会**自动回退**为
 *   "仅按工作日 + 时段"判断（不会报错，只是法定节假日那几天会偏高估价）。
 *
 *   重新生成（把年份换成需要的）：
 *     node -e "fetch('https://timor.tech/api/holiday/year/2027').then(r=>r.json()).then(b=>console.log(Object.entries(b.holiday).filter(([,v])=>v.holiday===true).map(([k])=>k).sort().join(' ')))"
 *
 * 格式：年份 → 月-日 的数组，日期已排序。
 */
export const STATUTORY_HOLIDAYS = {
  // 元旦 1/1，春节 1/28-2/4，清明 4/4-4/6，劳动 5/1-5/5，端午 5/31-6/2，国庆中秋 10/1-10/8
  2025: [
    "01-01", "01-28", "01-29", "01-30", "01-31", "02-01", "02-02", "02-03", "02-04",
    "04-04", "04-05", "04-06",
    "05-01", "05-02", "05-03", "05-04", "05-05",
    "05-31", "06-01", "06-02",
    "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07", "10-08",
  ],
  // 元旦 1/1-1/3，春节 2/15-2/23，清明 4/4-4/6，劳动 5/1-5/5，端午 6/19-6/21，中秋 9/25-9/27，国庆 10/1-10/7
  2026: [
    "01-01", "01-02", "01-03",
    "02-15", "02-16", "02-17", "02-18", "02-19", "02-20", "02-21", "02-22", "02-23",
    "04-04", "04-05", "04-06",
    "05-01", "05-02", "05-03", "05-04", "05-05",
    "06-19", "06-20", "06-21",
    "09-25", "09-26", "09-27",
    "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07",
  ],
};

/**
 * 判断某个北京时间日期是否落在法定节假日。
 *
 * 用 O(1) 的 Set 查表，避免每次计价都做线性查找（该函数每次请求会调用）。
 *
 * @param {number} year - 北京时间的公历年。
 * @param {number} month - 北京时间月份，1-12。
 * @param {number} day - 北京时间日期。
 * @returns {boolean} 是法定节假日返回 true；该年份未收录时返回 false（自动回退）。
 */
const cache = new Map();
function holidaySetOf(year) {
  let set = cache.get(year);
  if (set === undefined) {
    const list = STATUTORY_HOLIDAYS[year];
    set = Array.isArray(list) ? new Set(list) : null;
    cache.set(year, set);
  }
  return set;
}

export function isStatutoryHoliday(year, month, day) {
  const set = holidaySetOf(year);
  if (set === null) return false;
  const key = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return set.has(key);
}

/** 该年份是否收录了节假日数据（供 UI 说明判断依据是否完整）。 */
export function hasHolidayData(year) {
  return holidaySetOf(year) !== null;
}
