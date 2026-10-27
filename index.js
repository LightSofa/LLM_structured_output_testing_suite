import fs from 'node:fs'
import path from 'node:path'
import { makeLogger } from './log.js'

/**
 * LLM_structured_output_testing_suite —— 宿主侧半身
 *
 * 两件事合并在这一个插件里：
 *   1) JSON 模式：包一层 globalThis.fetch，对 /chat/completions 注入 response_format、
 *      对 /responses 注入 text.format；仅当系统提示词里出现 marker 时才注入。
 *   2) 采样参数覆盖：注册人类命令 /params，并在 agent/request waterfall 里把本会话
 *      的覆盖并进 LlmCallConfig（temperature / maxTokens / reasoningEffort / stop）。
 *
 * 预设侧半身见 ./preset.js（工具清空），两者由同一 bundle 的 cordis.patch.yml 挂载。
 */

const PATCHED = Symbol.for('LLM_structured_output_testing_suite/fetch')

/* ============================ 1. JSON 模式注入 ============================ */

const JSON_DEFAULTS = {
  enabled: true,
  marker: 'DSH_JSON_MODE',
  markerScope: 'system',
  dryRun: false,
  matchURLs: [],
  paths: ['/chat/completions', '/responses'],
  format: 'json_object',
  requireTools: false,
  logToolNames: true,
}

function normalizeJsonMode(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const config = { ...JSON_DEFAULTS }
  if (typeof source.enabled === 'boolean') config.enabled = source.enabled
  if (typeof source.marker === 'string' && source.marker.length > 0) config.marker = source.marker
  if (source.markerScope === 'any' || source.markerScope === 'system') config.markerScope = source.markerScope
  if (typeof source.dryRun === 'boolean') config.dryRun = source.dryRun
  if (typeof source.requireTools === 'boolean') config.requireTools = source.requireTools
  if (typeof source.logToolNames === 'boolean') config.logToolNames = source.logToolNames
  if (typeof source.format === 'string' && source.format.length > 0) config.format = source.format
  if (Array.isArray(source.matchURLs)) config.matchURLs = source.matchURLs.filter(value => typeof value === 'string' && value.length > 0)
  if (Array.isArray(source.paths)) {
    const paths = source.paths.filter(value => typeof value === 'string' && value.startsWith('/'))
    if (paths.length > 0) config.paths = paths
  }
  return config
}

function describe(input, init) {
  try {
    if (typeof input === 'string' || input instanceof URL) {
      return {
        url: String(input),
        method: String(init?.method ?? 'GET').toUpperCase(),
        contentType: new Headers(init?.headers).get('content-type') ?? '',
        request: undefined,
      }
    }
    if (input && typeof input === 'object' && typeof input.url === 'string' && typeof input.method === 'string') {
      return {
        url: input.url,
        method: String(init?.method ?? input.method).toUpperCase(),
        contentType: String(init?.headers ? new Headers(init.headers).get('content-type') : input.headers?.get?.('content-type') ?? ''),
        request: input,
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function isModelCall(info, config) {
  if (!info || info.method !== 'POST') return false
  if (!info.contentType.toLowerCase().includes('json')) return false
  if (config.matchURLs.length > 0 && !config.matchURLs.some(part => info.url.includes(part))) return false
  let pathname
  try {
    pathname = new URL(info.url).pathname
  } catch {
    return false
  }
  return config.paths.some(suffix => pathname.endsWith(suffix))
}

async function readBodyText(info, init) {
  const body = init?.body
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8')
  if (info.request && typeof info.request.clone === 'function') return info.request.clone().text()
  return undefined
}

function collectStrings(value, out, depth = 0) {
  if (depth > 6 || out.length > 4000) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return out
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1)
  }
  return out
}

/** 只认系统提示词：instructions / system role。会话正文、工具输出里的同名串不算。 */
function systemTexts(body) {
  const texts = []
  if (typeof body.instructions === 'string') texts.push(body.instructions)
  if (body.instructions && typeof body.instructions === 'object') collectStrings(body.instructions, texts)
  if (typeof body.system === 'string') texts.push(body.system)
  const push = (item) => {
    if (!item || typeof item !== 'object') return
    if (item.role !== 'system' && item.role !== 'developer') return
    collectStrings(item.content, texts)
  }
  if (Array.isArray(body.messages)) body.messages.forEach(push)
  if (Array.isArray(body.input)) body.input.forEach(push)
  return texts.join('\n')
}

function carriesMarker(body, marker, scope) {
  if (scope === 'any') return collectStrings([body], []).join('\n').includes(marker)
  return systemTexts(body).includes(marker)
}

function applyFormat(body, isResponses, config) {
  if (isResponses) {
    const current = body.text && typeof body.text === 'object' ? body.text : {}
    if (current.format) return false
    body.text = { ...current, format: { type: config.format } }
    return true
  }
  if (body.response_format !== undefined) return false
  body.response_format = { type: config.format }
  return true
}

async function intercept(input, init, config, stats, log) {
  const info = describe(input, init)
  if (!isModelCall(info, config)) return undefined

  let text
  try {
    text = await readBodyText(info, init)
  } catch {
    return undefined
  }
  if (typeof text !== 'string' || text.length === 0) return undefined

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined

  const model = typeof body.model === 'string' ? body.model : '?'
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0
  const isResponses = new URL(info.url).pathname.endsWith('/responses')
  const label = `${isResponses ? 'responses' : 'chat'} model=${model} tools=${toolCount}`

  if (!carriesMarker(body, config.marker, config.markerScope)) {
    stats.seen += 1
    return undefined
  }
  if (config.requireTools && toolCount === 0) {
    log(`skip (no tools) ${label}`)
    return undefined
  }

  const changed = applyFormat(body, isResponses, config)
  if (!changed) {
    log(`skip (format already set) ${label}`)
    return undefined
  }

  const nextText = JSON.stringify(body)
  if (config.logToolNames && toolCount > 0) {
    // 只在真的要注入时才记工具清单，避免每个请求都刷一行
    const names = body.tools.map(tool => tool?.name ?? tool?.function?.name ?? '?')
    log(`tool names (${names.length}): ${names.join(',')}`)
  }
  if (config.dryRun) {
    log(`dry-run: would inject ${config.format} | ${label}`)
    return undefined
  }

  const request = info.request
    ? new Request(info.request, { body: nextText })
    : new Request(info.url, { ...(init ?? {}), body: nextText })
  stats.injected += 1
  log(`injected ${config.format} | ${label} | ${info.url}`)
  return request
}

function installJsonMode(ctx, config, log) {
  if (!config.enabled) {
    log('jsonMode: disabled by config')
    return
  }
  const original = globalThis.fetch
  if (typeof original !== 'function') {
    log('jsonMode: globalThis.fetch 不可用，未安装')
    return
  }
  if (original[PATCHED]) {
    log('jsonMode: 已有实例接管 fetch，跳过')
    return
  }

  const stats = { seen: 0, injected: 0 }
  const patched = async function patchedFetch(input, init) {
    try {
      const replacement = await intercept(input, init, config, stats, log)
      if (replacement) return original(replacement)
    } catch (error) {
      log(`jsonMode: intercept 失败，原样放行：${error?.message ?? error}`)
    }
    return original(input, init)
  }
  Object.defineProperty(patched, PATCHED, { value: true })

  globalThis.fetch = patched
  log(`jsonMode: fetch hook installed | marker=${config.marker} | paths=${config.paths.join(',')}`)

  const release = () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
    log(`jsonMode: fetch hook released | seen=${stats.seen} injected=${stats.injected}`)
  }
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => release, 'structured-output: fetch hook')
    else ctx?.on?.('dispose', release)
  } catch {
    // 保持钩子生效
  }
}

/* ============================ 2. 采样参数覆盖 ============================ */

const ALIASES = new Map([
  ['temperature', 'temperature'],
  ['temp', 'temperature'],
  ['max_tokens', 'maxTokens'],
  ['max_output_tokens', 'maxTokens'],
  ['max_completion_tokens', 'maxTokens'],
  ['maxtokens', 'maxTokens'],
  ['effort', 'reasoningEffort'],
  ['reasoning_effort', 'reasoningEffort'],
  ['reasoning', 'reasoningEffort'],
  ['stop', 'stop'],
])

const LABEL = { temperature: 'temperature', maxTokens: 'maxTokens', reasoningEffort: 'reasoningEffort', stop: 'stop' }

const PARAMS_DEFAULTS = { enabled: true, defaults: {}, persistFile: '' }

function normalizeControls(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const controls = {}
  if (source.temperature !== undefined && source.temperature !== null) {
    const value = Number(source.temperature)
    if (!Number.isFinite(value) || value < 0 || value > 2) throw new TypeError('temperature 需要 0–2 之间的数字')
    controls.temperature = value
  }
  if (source.maxTokens !== undefined && source.maxTokens !== null) {
    const value = Number(source.maxTokens)
    if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) throw new TypeError('max_tokens 需要正整数（≤ 1000000）')
    controls.maxTokens = value
  }
  if (source.reasoningEffort !== undefined && source.reasoningEffort !== null) {
    const value = String(source.reasoningEffort)
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(value)) throw new TypeError('effort 需要字母开头的短标识')
    controls.reasoningEffort = value
  }
  if (source.stop !== undefined && source.stop !== null) {
    const list = Array.isArray(source.stop) ? source.stop : [source.stop]
    const values = list.map(String).map(value => value.trim()).filter(Boolean)
    if (values.length > 0) controls.stop = values
  }
  return controls
}

function parseAssignments(text) {
  const controls = {}
  const unset = []
  const chunks = String(text).split(/[\s,]+/).map(part => part.trim()).filter(Boolean)
  if (chunks.length === 0) return { controls, unset }
  for (const chunk of chunks) {
    const index = chunk.indexOf('=')
    if (index <= 0) throw new TypeError(`无法识别 "${chunk}"，请用 key=value 形式`)
    const key = ALIASES.get(chunk.slice(0, index).trim().toLowerCase())
    if (!key) throw new TypeError(`不支持的参数 "${chunk.slice(0, index)}"`)
    const value = chunk.slice(index + 1).trim()
    if (value === '' || /^(off|null|default|unset)$/i.test(value)) {
      unset.push(key)
      continue
    }
    const single = normalizeControls(key === 'stop' ? { stop: value.split('|') } : { [key]: value })
    Object.assign(controls, single)
  }
  return { controls, unset }
}

function describeControls(controls) {
  const entries = Object.entries(controls ?? {})
  if (entries.length === 0) return '（无）'
  return entries.map(([key, value]) => `${LABEL[key] ?? key}=${Array.isArray(value) ? value.join('|') : value}`).join(' ')
}

function installParams(ctx, config, log) {
  if (!config.enabled) {
    log('params: disabled by config')
    return
  }

  let base = {}
  try {
    base = normalizeControls(config.defaults ?? {})
  } catch (error) {
    log(`params: defaults 无效：${error.message}`)
  }

  const overrides = new Map()
  if (config.persistFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(config.persistFile, 'utf8'))
      for (const [sessionId, controls] of Object.entries(saved ?? {})) {
        try {
          overrides.set(sessionId, normalizeControls(controls))
        } catch {
          // 单条坏了就跳过
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') log(`params: 读取 ${config.persistFile} 失败：${error.message}`)
    }
  }

  const save = () => {
    if (!config.persistFile) return
    try {
      fs.mkdirSync(path.dirname(config.persistFile), { recursive: true })
      const data = Object.fromEntries(overrides)
      const temporary = `${config.persistFile}.${process.pid}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
      fs.renameSync(temporary, config.persistFile)
    } catch (error) {
      log(`params: 写入 ${config.persistFile} 失败：${error.message}`)
    }
  }

  try {
    const dispose = ctx.commands.register({
      name: 'params',
      description: '查看或设置本会话的模型采样参数（temperature / max_tokens / effort / stop）',
      input: { hint: 'temperature=0.3 max_tokens=4096 effort=low | reset | 留空=查看' },
      handler: (invocation) => {
        const sessionId = invocation.agent.id
        const raw = String(invocation.rawInput ?? '').trim()
        const current = overrides.get(sessionId) ?? {}
        try {
          if (raw === '' || /^(show|list|status|ls)$/i.test(raw)) {
            return {
              kind: 'success',
              text: [
                `本会话覆盖：${describeControls(current)}`,
                `兜底 defaults：${describeControls(base)}`,
                '用法：/params temperature=0.3 max_tokens=4096 effort=low ；/params reset 清空',
              ].join('\n'),
            }
          }
          if (/^(reset|clear|off|unset)$/i.test(raw)) {
            overrides.delete(sessionId)
            save()
            log(`params: reset session=${sessionId}`)
            return { kind: 'success', text: '已清空本会话的采样参数覆盖。' }
          }
          const { controls, unset } = parseAssignments(raw)
          const next = { ...current, ...controls }
          for (const key of unset) delete next[key]
          if (Object.keys(next).length === 0) overrides.delete(sessionId)
          else overrides.set(sessionId, next)
          save()
          log(`params: update session=${sessionId} -> ${describeControls(next)}`)
          return { kind: 'success', text: `已更新。本会话覆盖：${describeControls(next)}（下一次请求生效）` }
        } catch (error) {
          return { kind: 'error', text: `参数无效：${error.message}` }
        }
      },
    })
    if (typeof dispose === 'function') {
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'structured-output: /params command')
      else ctx.on?.('dispose', dispose)
    }
    log(`params: /params registered | defaults=${describeControls(base)} | sessions=${overrides.size}`)
  } catch (error) {
    log(`params: /params 注册失败：${error?.message ?? error}`)
  }

  ctx.on('agent/request', async (payload, next) => {
    const callConfig = await next()
    try {
      const sessionId = payload?.agent?.id
      const override = overrides.get(sessionId) ?? {}
      const merged = { ...base, ...override }
      const entries = Object.entries(merged).filter(([, value]) => value !== undefined)
      if (entries.length === 0) return callConfig
      log(
        `params: apply session=${sessionId} turn=${payload?.turn} step=${payload?.step} model=${callConfig.model} ` +
          `${describeControls(merged)} | before temperature=${callConfig.temperature} maxTokens=${callConfig.maxTokens} effort=${callConfig.reasoningEffort}`,
      )
      return { ...callConfig, ...merged }
    } catch (error) {
      log(`params: hook 失败：${error?.message ?? error}`)
      return callConfig
    }
  })

  log('params: agent/request hook installed')
}

/* ============================ 入口 ============================ */

export const inject = ['commands']

export function apply(ctx, rawConfig) {
  const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const logConfig = source.log && typeof source.log === 'object' ? source.log : {}
  const log = makeLogger(logConfig)

  log('suite: activating')
  installJsonMode(ctx, normalizeJsonMode(source.jsonMode), log)
  installParams(ctx, { ...PARAMS_DEFAULTS, ...(source.params && typeof source.params === 'object' ? source.params : {}) }, log)
  log('suite: active')
}
