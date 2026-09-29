/**
 * 「几点执行」这类自然语言时间的解析。
 *
 * 独立成模块的原因：MCP 入口（src/mcp/server.ts）在文件末尾直接启动 stdio 服务器，
 * 从测试里 import 它会连带把服务器拉起来。时间解析是纯函数，抽出来才可测。
 */

const pad = (n: number): string => String(n).padStart(2, '0')

export function localParts(d: Date): { date: string; time: string } {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

/** 本地日期 YYYY-MM-DD（不是 UTC）。 */
export function localDateString(d: Date = new Date()): string {
  return localParts(d).date
}

/**
 * 宽松解析执行时间。agent 可能给这些形态：
 *   "16:00" / "16:00:00"          → 今天该时刻，已过则顺延到明天
 *   "4:00 PM" / "4pm"             → 同上（12 小时制）
 *   "2026-09-24T16:00"            → 直接采用
 *   "2026-09-24 16:00"            → 直接采用
 *   ISO 8601（带时区）             → 换算成本地时间
 */
export function parseRunAt(input: string): { date: string; time: string } | null {
  const s = (input ?? '').trim()
  if (!s) return null

  // 年月日 + 时分
  const full = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})/)
  if (full) {
    const month = Number(full[2])
    const day = Number(full[3])
    const hour = Number(full[4])
    const minute = Number(full[5])
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
    return { date: `${full[1]}-${pad(month)}-${pad(day)}`, time: `${pad(hour)}:${pad(minute)}` }
  }

  // 只有时间（12 小时制或 24 小时制）
  const timeOnly =
    s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i) ?? s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (timeOnly) {
    let hour = Number(timeOnly[1])
    const minute = Number(timeOnly[2] ?? 0)
    const meridiem = (timeOnly[3] ?? '').toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    if (hour > 23 || minute > 59) return null
    const d = new Date()
    d.setHours(hour, minute, 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    return localParts(d)
  }

  // 兜底：交给 Date 解析（含带时区的 ISO）
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) return localParts(parsed)
  return null
}

/** 给人/给 agent 看的时间描述，顺带算出倒计时。 */
export function describeWhen(date: string, time: string): string {
  const target = new Date(`${date}T${time}:00`).getTime()
  if (Number.isNaN(target)) return `${date} ${time}`
  const diff = target - Date.now()
  if (diff <= 0) return `${date} ${time}（该时间已过）`
  const h = Math.floor(diff / 3_600_000)
  const min = Math.round((diff % 3_600_000) / 60_000)
  return `${date} ${time}（约 ${h > 0 ? `${h} 小时 ${min} 分钟` : `${min} 分钟`}后）`
}
