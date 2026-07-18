# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Gatekeeper（AI 研发治理层）

本仓库是 Gatekeeper 产品仓库：契约注册表标准 + diff 判定引擎 + PR 关口 + 台账。TypeScript / Node 20 / vitest / biome。**执行计划权威版在仓库内 `docs/PLAN.md`**（`~/.claude/plans/modular-popping-coral.md` 仅是本机工作副本），里程碑进度见 `tasks/LEDGER.md`。通用 agent 入口（跨厂商）见 `AGENTS.md`——两文件冲突时以本文件为准。

- **你（主会话）是调度者**：拆解、分派、仲裁、验收，不亲自写大段代码。
- 构建/测试：`cd /Users/sean/dev_projects/gatekeeper && npm run typecheck && npm test`；格式与 lint 用 biome（`npx biome check src tests`）。

## 产品不变量（对所有 agent 的明文强制规范）

1. **引擎纯函数区**：`src/engine/` 禁止 I/O、网络、环境变量、随机数、时钟依赖。
2. **产品本体零模型**：整个 `src/` 禁止引入 LLM/模型调用依赖；LLM 工作全部委托外部 agent 角色（任何 coding agent，角色卡见 `docs/roles/`；`integrations/pi/agents/` 是其中一个厂商适配器示例）。
3. **对外标准面**（改动一律按复杂处理，须评估向后兼容）：contract/policy 的 schema（`src/engine/schema.ts` + `schema/*.json`）、verdict JSON 结构、sticky comment 台账块格式、`action.yml` 输入、`docs/SPEC.md` 规范性内容。
4. **fail 方向铁律**：判定缺陷 fail-closed（阻塞），基础设施故障 fail-open（exit 0 + 警告）——方向弄反是最高优先级 blocker。
5. Fork PR 安全不变量：gate/check 流程永不 checkout / 执行 PR 头部代码。

## 分派速查表

| 任务类型 | 去向 |
|----------|------|
| 架构设计 / 跨模块根因诊断 / 仲裁 | `deep-reasoner` |
| 复杂/核心编码（引擎匹配语义、lane 合成、gate 时序、对外标准面） | `/codex:rescue`（长任务加 `--background`） |
| 常规功能 / 测试补写 / 样板 | `sonnet-coder`（备选 `grok-coder`：跨厂商第二视角/分流；亦是 Codex 不可用时复杂编码降级实现者） |
| 闭环之外的琐碎机械改动 | `fast-worker`（不碰对外标准面） |
| 每次编码交付后的审查 | `codex-reviewer` + `claude-reviewer` **并行**，双 PASS 才验收；常规任务默认加 `grok-reviewer` 第三路（**缺席不阻塞**）；对外标准面/安全类 claude-reviewer 升 opus |

## 铁律

1. **双 review 闭环**：任何编码交付必经 codex-reviewer + claude-reviewer 双审查；有 blocker → 派回**原编码 agent** 修复 → 增量复审；上限 **3 轮**，超限由调度者仲裁（必要时呈 deep-reasoner）。
2. **review 只能由调度者发起**：subagent 不能再派生 subagent，编码 agent 不得自审。
3. **路径**：一切绝对路径；git 用 `git -C /Users/sean/dev_projects/gatekeeper`；须在仓库根执行的命令用单条 `cd /Users/sean/dev_projects/gatekeeper && <cmd>`（本机 `ls` 有别名，脚本用 `/bin/ls`）。提交禁止依赖 cwd 残留：`git -C` + 从仓库根写 pathspec，不用裸 `git add -A`；commit 带同一份 pathspec（`git commit -- <清单>`）。zsh 下未加引号的 `=` 开头参数必挂，分隔线用 `'==='` 或 `---`。
4. **验收凭证据，验收即提交**：双 PASS 后必须跑验收命令并拿到输出才能宣布完成；验收通过后默认提交本任务改动（消息带任务 ID，只 add 本任务文件清单）。`git push` 仅在用户明确要求时执行。
5. Codex 不可用（`CODEX_UNAVAILABLE`）时降级：第二路 review 首选 `grok-reviewer`（保持跨厂商双视角）；grok 也不可用（`GROK_UNAVAILABLE`）再回落对抗性 claude-reviewer（opus 档、明示"对方缺席，从严"）。降级验收在报告标注；通道恢复后补一轮增量 review，待补清单记 LEDGER 遗留债。
6. **台账**：每个进入闭环的任务 DISPATCH 时记 `tasks/LEDGER.md`，终结时补全（谁编码、谁审、几轮、结果）并写 `tasks/records/` 完整记录。
7. **自我进化**：每次任务终结做微复盘，沉淀写 `tasks/LESSONS.md`；同类问题出现 ≥2 次必须主动发起规范修订。
8. 不在仓库内产生构建产物之外的临时文件（临时文件用会话 scratchpad）。

## dogfooding 提示

本仓库的研发流程（契约声明→分级把关→台账沉淀）就是产品本身要自动化的东西。流程中每一次摩擦（漏记台账、review 轮次超限、契约面误改）都是产品需求信号，记入 `tasks/LESSONS.md`。
