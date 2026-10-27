# LLM_structured_output_testing_suite

把这一轮做出来的三样东西合成一个 bundle：**JSON 模式注入** + **采样参数覆盖** + **空白预设（JSON 契约 + 工具清空）**。

## 装法

```powershell
# 在目标 profile 的 Harness 里（plugin_manager 作用于当前 profile）
plugin_manager install_bundle  target: C:\Users\zf\.dsh\plugins\LLM_structured_output_testing_suite
```

安装后 profile 的 `dsh.profile.bundles` 里会出现 `LLM_structured_output_testing_suite`。

## 两个半身

| 半身 | 装载位置 | 作用 |
|---|---|---|
| 宿主半身 `index.js` | bundle patch 的 `structured-output-suite` 行（全局） | ①包 `globalThis.fetch` 注入 `response_format` / `text.format`；②注册 `/params` 并挂 `agent/request` |
| 预设半身 `preset.js` | 预设 `blank` 的 `plugins` 列表 | 用 `ctx.tools.restrict` 把宿主工具从该预设的 agent 视野里掩掉 |

## 用法

**JSON 模式**：系统提示词里出现 `DSH_JSON_MODE` 才会注入（会话正文、工具输出里的同名串不算）。

- `chat/completions` → `body.response_format = { type: "json_object" }`
- `responses` → `body.text.format = { type: "json_object" }`

```yaml
jsonMode:
  marker: DSH_JSON_MODE
  markerScope: system   # any = 任何文本都算（仅测试用）
  dryRun: false         # true = 只记日志不改请求
  paths: [/chat/completions, /responses]
  format: json_object
```

**采样参数**（`/params`，按会话生效，重启后保留）：

```
/params                              # 查看
/params temperature=0.3 max_tokens=4096
/params effort=low stop=</end>|STOP
/params temperature=off              # 撤掉单项
/params reset                        # 清空
```

只覆盖 `temperature / maxTokens / reasoningEffort / stop` —— 这四项是 `LlmCallConfig` 的全集；`top_p`、`seed` 之类只能走 fetch 层注入。

## 两个预设（切换输出模式）

| 预设 | id | order | 输出 | persona |
|---|---|---|---|---|
| 空白 | `blank` | 90 | 普通文本，不注入 `response_format` | 无 |
| JSON输出 | `json` | 91 | 强制 JSON，注入 `response_format` / `text.format` | `DSH_JSON_MODE` + 契约 |

两者的共同点：都挂 `preset.js` 把宿主工具掩掉（`denyExtra` 用于点名 Agent Teams 那批按 agent 作用域注册的工具；没装 Agent Teams 的 profile 会记录 `refused`，不影响其它工具）。

所以**切换输出模式 = 换预设开会话**：选「JSON输出」走强制 JSON，选「空白」走普通文本。系统提示词里出现 `DSH_JSON_MODE` 才会注入，因此「空白」天然不会触发。

## 日志

全部在 `logs/` 下，默认单个文件上限 1 MiB、保留 1 份轮转（`*.log.1`），`maxBytes: 0` 可关闭上限。

- `suite.log` —— 宿主半身：hook 装载、注入记录、参数套用
- `restrict.log` —— 预设半身：每次掩掉了什么、被拒绝的名字

## 自测

```powershell
node --check index.js
node --check preset.js
node test\self-test.mjs     # 9/9：日志上限、responses/chat 注入、标记作用域、/params 全流程
```
