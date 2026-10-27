import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { appendCapped } from '../log.js'

/* ---------------- 1. 日志上限 ---------------- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-log-'))
  const file = path.join(dir, 'x.log')
  for (let n = 0; n < 30; n += 1) appendCapped(file, `line ${n} 0123456789abcdef`, 300, 1)
  assert.ok(fs.statSync(file).size <= 300, 'log stays under cap')
  assert.ok(fs.existsSync(`${file}.1`), 'rotated once')
  fs.rmSync(dir, { recursive: true, force: true })
}

/* ---------------- 2. 宿主半身 ---------------- */
const original = globalThis.fetch
const captured = []
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init)
  captured.push({ url: request.url, body: await request.clone().text() })
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
}

let command
let requestHandler
const ctx = {
  commands: { register: definition => { command = definition; return () => {} } },
  on: (name, handler) => { if (name === 'agent/request') requestHandler = handler },
  effect: () => {},
}

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-apply-'))
apply(ctx, {
  jsonMode: { marker: 'DSH_JSON_MODE', markerScope: 'system' },
  params: { persistFile: '' },
  log: { logFile: path.join(logDir, 'suite.log'), maxBytes: 65536 },
})

// 2a. responses：系统提示词带标记 -> text.format
await globalThis.fetch('http://x/v1/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', instructions: '契约：DSH_JSON_MODE', input: [{ role: 'user', content: 'hi' }] }),
})
assert.deepEqual(JSON.parse(captured.at(-1).body).text, { format: { type: 'json_object' } }, 'responses text.format')

// 2b. chat：system role 带标记 -> response_format
await globalThis.fetch('http://x/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 'DSH_JSON_MODE' }, { role: 'user', content: 'hi' }] }),
})
assert.deepEqual(JSON.parse(captured.at(-1).body).response_format, { type: 'json_object' }, 'chat response_format')

// 2c. 只有会话正文带标记 -> 不注入
await globalThis.fetch('http://x/v1/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', instructions: 'be brief', input: [{ role: 'user', content: 'DSH_JSON_MODE' }] }),
})
assert.equal(JSON.parse(captured.at(-1).body).text, undefined, 'conversation marker must not arm JSON mode')

// 2d. /params
assert.ok(command && command.name === 'params', 'command registered')
assert.ok(requestHandler, 'agent/request hooked')
const agent = { id: 'session-suite' }
const run = rawInput => command.handler({ commandId: 'c', agent, rawInput, attachments: [], signal: new AbortController().signal })
assert.match(run('').text, /本会话覆盖：（无）/)
assert.equal(run('temperature=0.3 max_tokens=4096').kind, 'success')
assert.equal(run('temperature=9').kind, 'error')
const baseConfig = { provider: 'p', model: 'm', temperature: 1, maxTokens: 1000, reasoningEffort: 'high' }
const merged = await requestHandler({ agent, turn: 1, step: 1 }, async () => baseConfig)
assert.equal(merged.temperature, 0.3)
assert.equal(merged.maxTokens, 4096)
assert.equal(merged.reasoningEffort, 'high')
assert.equal(baseConfig.temperature, 1, 'base config untouched')
assert.equal(run('reset').kind, 'success')
assert.equal((await requestHandler({ agent, turn: 2, step: 1 }, async () => baseConfig)).temperature, 1)

globalThis.fetch = original
fs.rmSync(logDir, { recursive: true, force: true })
console.log('suite self-test passed: 9/9')
