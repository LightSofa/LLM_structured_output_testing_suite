import { appendCapped } from './log.js'

/**
 * LLM_structured_output_testing_suite —— 预设侧半身
 *
 * 挂在 preset 的 plugins 里，把这个预设的 agent 视野里的宿主工具掩掉：
 *   ctx.tools.restrict({ deny }) 的语义是「restrict global tools for the calling agent scope」，
 *   因此只影响选中该预设的会话。
 *
 * config:
 *   allow: []          保留的工具名（默认空 = 全部掩掉）
 *   denyExtra: []      点名掩掉（宿主按 agent 作用域注册的工具走这里）
 *   logFile: ''        日志路径
 *   maxBytes: number   单个日志上限（默认 1 MiB，0 = 不限）
 *   keepFiles: number  轮转保留份数（默认 1，0 = 清空重写）
 *   verbose: boolean   是否记录「nothing to hide」这类重复行（默认关）
 */

export const inject = ['tools']

const DEFAULTS = { allow: [], denyExtra: [], logFile: '', maxBytes: 1024 * 1024, keepFiles: 1, verbose: false }

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const list = value => (Array.isArray(value) ? value.filter(name => typeof name === 'string' && name.length > 0) : [])
  const size = value => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined)
  return {
    allow: list(source.allow),
    denyExtra: list(source.denyExtra),
    logFile: typeof source.logFile === 'string' ? source.logFile : DEFAULTS.logFile,
    maxBytes: size(source.maxBytes) ?? DEFAULTS.maxBytes,
    keepFiles: size(source.keepFiles) ?? DEFAULTS.keepFiles,
    verbose: source.verbose === true,
  }
}

export function apply(ctx, rawConfig) {
  const config = normalize(rawConfig)
  const denied = new Set()
  const releases = []

  const log = (line) => {
    // eslint-disable-next-line no-console
    console.warn(`[structured-output:preset] ${line}`)
    appendCapped(config.logFile, `${new Date().toISOString()} ${line}`, config.maxBytes, config.keepFiles)
  }

  const denyTool = (name) => {
    try {
      const release = ctx.tools.restrict({ deny: [name] })
      if (typeof release === 'function') releases.push(release)
      denied.add(name)
      return true
    } catch (error) {
      // 框架错误里会附一整串 known global tools，截断后再落盘，避免刷日志
      const message = String(error?.message ?? error).split(';')[0].slice(0, 120)
      log(`skip ${name}: ${message}`)
      denied.add(name)
      return false
    }
  }

  const sweep = (label) => {
    let visible
    try {
      visible = ctx.tools.schemas().map(schema => schema.name)
    } catch (error) {
      log(`schemas() failed: ${error?.message ?? error}`)
      return
    }
    const targets = visible.filter(name => !config.allow.includes(name) && !denied.has(name))
    if (targets.length === 0) {
      if (config.verbose) log(`${label}: nothing to hide (visible=${visible.length}, allowed=${config.allow.length}, denied=${denied.size})`)
      return
    }
    let applied = 0
    for (const name of targets) if (denyTool(name)) applied += 1
    log(`${label}: visible=${visible.length} denied=${applied} kept=${visible.length - applied}`)
  }

  sweep('activation')

  if (config.denyExtra.length > 0) log(`denyExtra=${config.denyExtra.join(',')}`)
  for (const name of config.denyExtra) {
    if (denied.has(name)) continue
    let known = true
    try {
      known = ctx.tools.get(name) !== undefined
    } catch {
      known = true
    }
    if (!known) {
      // 这个 profile 根本没装对应插件：不试、不刷日志。
      denied.add(name)
      if (config.verbose) log(`denyExtra ${name}: not present in this profile`)
      continue
    }
    const ok = denyTool(name)
    log(`denyExtra ${name}: ${ok ? 'accepted' : 'refused'}`)
  }

  try {
    ctx.on('tools/change', () => sweep('tools/change'))
  } catch (error) {
    log(`cannot listen tools/change: ${error?.message ?? error}`)
  }

  try {
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent
      if (!agent) return
      let names = []
      try {
        names = ctx.tools.schemas(agent).map(schema => schema.name)
      } catch (error) {
        log(`agent schemas() failed: ${error?.message ?? error}`)
        return
      }
      const extra = names.filter(name => !config.allow.includes(name) && !denied.has(name))
      log(`agent=${agent.id} visible=${names.length} [${names.join(',')}]${extra.length ? ` extra=${extra.join(',')}` : ''}`)
      for (const name of extra) denyTool(name)
    })
  } catch (error) {
    log(`cannot listen agent/created: ${error?.message ?? error}`)
  }

  const release = () => {
    for (const disposer of releases.splice(0)) {
      try {
        disposer()
      } catch {
        // ignore
      }
    }
    log('released')
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => release, 'structured-output: preset release')
    else ctx.on?.('dispose', release)
  } catch {
    // 保持限制生效
  }
}
