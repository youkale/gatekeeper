# M7 任务包：pi extension + 角色包（T-20260718-07）

## 范围

`pi-extension/`（独立 package，name: `pi-gatekeeper`，keywords 含 `pi-package`；依赖主包引擎）：

- `pi-extension/index.ts` — pi 扩展入口（`export default function (pi: ExtensionAPI)`）：
  - `pi.registerTool` `gatekeeper_check`：参数 {registryDir, base?}；内部跑本地 gitdiff + evaluate，返回 verdict JSON + explain 文本。agent 在改代码前/后可自查契约命中。
  - `pi.registerCommand` `/gatekeeper-init`：读 init 简报文件路径参数，提示词引导当前会话按简报起草 contracts/*.yaml，并在结束时提示运行 gatekeeper validate。
  - `pi.registerCommand` `/gatekeeper-triage`：读 triage 简报，引导以 deep-reasoner 角色（经 pi-subagents delegate）产出判断文件，提示 gatekeeper triage --post 回写。
- `pi-extension/agents/` — pi-subagents 自定义角色定义（格式参照 pi-subagents 文档的 agent 文件规范）：
  - `contract-scout.md` — 单 repo 契约信号侦察（输入 scan.json 片段，输出候选契约事实清单，不写 YAML）
  - `registry-drafter.md` — 汇总多 scout 输出起草 contracts/*.yaml（严格遵循 SPEC 模板，level 只用 policy 已有值）
  - `registry-reviewer.md` — 对照 SPEC 审草稿（glob 过宽/漏 consumer/级别不当），输出修订意见
  - `deep-reasoner.md` — 需求门判断角色（M6 输出模板；模型档位说明引用 roles-policy.yaml 偏好序）
- `pi-extension/README.md` — 安装（`pi install npm:pi-gatekeeper` 目标形态；本地开发 `pi -e ./pi-extension/index.ts`）、模型绑定示例（settings `subagents.agentOverrides` 按 roles-policy 偏好序配置）。
- `pi-extension/package.json` + tsconfig；类型依赖 `@mariozechner/pi-coding-agent`（devDependency，仅取 ExtensionAPI 类型；运行时由 pi 提供）。

## 约束

- 扩展是薄包装：所有判定逻辑 import 主包引擎，不复制实现。
- 无 pi 环境时主包一切功能不受影响（扩展是可选交付物）。
- 主仓库测试不依赖 pi 运行时：扩展入口做纯单元测试（mock ExtensionAPI 记录注册行为）`tests/pi-extension.test.ts`。

## 验收

`cd /Users/sean/dev_projects/gatekeeper && npm run typecheck && npm test && npx biome check src tests pi-extension`
另：`cd pi-extension && npx tsc --noEmit`（若独立 tsconfig）。
