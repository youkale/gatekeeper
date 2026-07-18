# M6 任务包：需求门 + 角色-模型选型策略（T-20260718-06）

## 范围

- `roles-policy.yaml`（仓库根，数据发布件）：
  ```yaml
  apiVersion: gatekeeper/v1
  tiers:
    deep-reasoner:            # 顶级推理档，按序取第一个可用
      prefer: ["anthropic/claude-fable-5", "anthropic/claude-opus-4-8", "openai/gpt-5.6-sol"]
    coder:
      prefer: ["openai/gpt-5.4-codex", "anthropic/claude-sonnet-5"]
    reviewer:
      prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8", "xai/grok-5-code"]
      count: 2                # 默认双路
      cross_vendor: true      # 尽量跨厂商对抗
  ```
- `src/roles/policy.ts` — 解析 roles-policy + 求交可用 provider（读 pi 配置 `~/.pi/agent/`  的 models/auth 清单，路径可注入便于测试；读不到 → 降级为"仅提示"）
- `src/commands/triage.ts` — `gatekeeper triage --issue <n> --repo org/x --registry <dir> [--post]`：
  1. GitHub API 拉 issue（标题/正文/labels/作者）。
  2. 组装判断简报：需求内容 + 注册表契约摘要 + 消费方图谱（该需求文本中提到的 repo/路径与契约的交集高亮）+ deep-reasoner 输出模板（是否做/为什么/建议级别/验收要求/派工方案：coder 1 + reviewer 2 跨厂商，模型从 roles-policy 实际可用集选）。
  3. 默认打印简报（交 pi 的 deep-reasoner 角色）；`--post` 时把**已完成的判断结果文件**（`--verdict-file`）以结构化评论回写 issue 并打 label（gatekeeper:accepted/rejected/needs-info），台账行写入本地 JSONL（关联键 `org/repo#N`）。
  - 判断本身不在 CLI 内做——零模型不变量。
- `src/commands/doctor.ts` 追加：roles-policy 各档在当前 pi 配置下是否有可用模型（deep-reasoner 档空 → 显著告警）。
- `.github/ISSUE_TEMPLATE/gatekeeper-request.yml` — 结构化需求模板（描述/动机/影响 repo/期望级别）。
- `tests/triage.test.ts`、`tests/roles-policy.test.ts`。

## 台账行格式（issue 侧，与 PR 侧共用 schema_version）

```json
{"schema_version":1,"kind":"triage","key":"org/repo#12","decision":"accepted","reason_summary":"…","suggested_level":"…","dispatch":{"coder":"…","reviewers":["…","…"]},"at":"<caller 传入>"}
```

## 验收

`cd /Users/sean/dev_projects/gatekeeper && npm run typecheck && npm test && npx biome check src tests`

## 禁止

CLI 内不做任何模型调用；pi 配置读取失败必须优雅降级（fail-open 提示，不阻断 triage 简报生成）。
