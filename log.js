import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_MAX_BYTES = 1024 * 1024
export const DEFAULT_KEEP_FILES = 1

/**
 * 追加一行日志；超过 maxBytes 先轮转 xxx.log -> xxx.log.1。
 * keepFiles = 0 直接清空重写，maxBytes = 0 表示不限。任何 IO 失败都静默吞掉。
 */
export function appendCapped(logFile, entry, maxBytes = DEFAULT_MAX_BYTES, keepFiles = DEFAULT_KEEP_FILES) {
  if (!logFile) return
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const line = `${entry}\n`
    const limit = maxBytes > 0 ? maxBytes : 0
    let current = 0
    try {
      current = fs.statSync(logFile).size
    } catch {
      current = 0
    }
    if (limit > 0 && current + Buffer.byteLength(line, 'utf8') > limit) {
      if (keepFiles > 0) {
        for (let index = keepFiles; index > 1; index -= 1) {
          const from = `${logFile}.${index - 1}`
          const to = `${logFile}.${index}`
          try {
            fs.renameSync(from, to)
          } catch {
            // 没有上一份就跳过
          }
        }
        try {
          fs.rmSync(`${logFile}.1`, { force: true })
        } catch {
          // ignore
        }
        try {
          fs.renameSync(logFile, `${logFile}.1`)
        } catch {
          fs.writeFileSync(logFile, '')
        }
      } else {
        fs.writeFileSync(logFile, '')
      }
    }
    fs.appendFileSync(logFile, line)
  } catch {
    // ignore
  }
}

export function makeLogger(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const logFile = typeof source.logFile === 'string' ? source.logFile : ''
  const maxBytes = Number.isFinite(source.maxBytes) && source.maxBytes >= 0 ? Math.floor(source.maxBytes) : DEFAULT_MAX_BYTES
  const keepFiles = Number.isFinite(source.keepFiles) && source.keepFiles >= 0 ? Math.floor(source.keepFiles) : DEFAULT_KEEP_FILES
  const prefix = typeof source.prefix === 'string' && source.prefix ? source.prefix : 'structured-output'
  let consoleBudget = 20
  return (line) => {
    const entry = `${new Date().toISOString()} ${line}`
    if (consoleBudget > 0) {
      consoleBudget -= 1
      // eslint-disable-next-line no-console
      console.warn(`[${prefix}] ${line}`)
    }
    appendCapped(logFile, entry, maxBytes, keepFiles)
  }
}
