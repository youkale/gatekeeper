# Gatekeeper MVP 执行计划

## Context

在 `/Users/sean/dev_projects/gatekeeper`（空目录，已 git init）从零构建 "Gatekeeper"——AI 研发治理层 MVP。定位：任何 coding agent / AI reviewer 之上的中立治理层，以"多 repo 契约门"为唯一楔子。三个已定的产品决策不变：①集成点在 git/PR 层（CLI + GitHub Action），不碰 agent 运行时；②核心引擎只做"结构"不做"能力"，声明式注册表 + diff 匹配，零模型、确定性、可离线；③注册表格式开源抢标准位，商业化留在聚合/裁决/台账。

计划已经过一轮独立压力测试（Plan agent 对照 Syncify 生态 4 个真实契约案例：CI 镜像 tag、Slink header 协议、artifact manifest、manuals 同步链路），以下设计吸收了全部关键修正。

## 技术选型（按用户确认修订）

- **TypeScript / Node 20**，与 pi-mono 同栈；工具链对齐 pi-mono 惯例（biome 做 lint/format）。CLI 用 commander（`npx` 零安装），GitHub Action 用 node20 runtime + tsup 打包的 dist。
- 依赖极薄：`yaml`、`zod`、`picomatch`、`commander`；GitHub REST 用内置 fetch（自己处理分页），不引 octokit。
- **模型策略（用户拍板）：Gatekeeper 产品本体零模型调用，所有 LLM 工作委托给 pi + pi-subagents 的角色 agent**。模型多厂商、按角色绑定，全部由 pi 的 settings 管理（`subagents.agentOverrides` 每角色可指定不同模型）。Gatekeeper 交付的是**角色定义 + 任务简报 + 确定性验证闭环**，不是模型客户端——这让"核心零模型"从目录约定升级为产品全局事实。
- **agent 侧集成 = pi extension + 角色包**（替代原计划的 MCP 快速跟进）：薄插件包装引擎——注册 `gatekeeper_check` 工具供 agent 查询契约命中；随包发布 gatekeeper 角色 agent 定义（见 init 设计）。放在 `pi-extension/`，复用核心库，不引入新逻辑。
- **核心引擎纯函数**：输入 `{changed files（含 status/oldPath/patch）, registry, repo 身份}` → 输出带完整判定溯源的 verdict 对象。git diff 和 PR API 只是两个数据提供者。

## 注册表格式（开源标准，最重要的产出）

**契约文件只声明事实，policy.yaml 统一声明后果**——契约里只有 `level` 外键，M-of-N/阻塞档位全部集中在 policy，避免格式退化成配置垃圾场。

`contracts/*.yaml`（每契约一文件）：
```yaml
apiVersion: gatekeeper/v1
name: artifact-manifest
description: 构建制品 manifest schema
level: breaking-review-required
authority:
  repo: org/schemas
  paths: ["manifest/schema.json"]
consumers:
  - repo: org/deploy
    paths: ["deploy/reader/**"]
    exclude: ["**/fixtures/**"]
    verify: "make verify-manifest"   # MVP 只展示不执行
    role: consumer                    # consumer(默认) | producer | mirror-frozen
```

`policy.yaml`：lanes 定义（4 种原语：human-approval / review / check-run / comment-scan，含 freshness 规则）、levels（enforcement: block|warn + M-of-N require）、`adoption.enforcement_override: warn`（第一周全局降档开关）、override label（紧急逃生口，记入台账）。

**匹配语义 v1 完整集**（不再多）：include glob + exclude、`dot:true`（否则 `.github/` 匹配不到——CI tag 契约会静默失效）、rename 双路径匹配（`-M`，权威文件被改名移出 glob 是最 breaking 的事件）、delete 状态溯源、可选 `if_content: <regex>` 对 patch 行做内容级收窄（CI 镜像 tag 和 header 协议两个真实案例路径匹配纯靠 glob 必然产生噪音，必须有这个；patch 拿不到时 fail-open 视为命中）、`mirror-frozen` 角色 + `allow_actors` 白名单（manuals 部署副本禁手改 → 独立判定类型 `forbidden-edit`）。同 repo 可同时是 authority 和 consumer。

厂商 lane 预设作为**数据文件**随包发布（`lanes.d/coderabbit.yaml` 等）：厂商改措辞时发预设文件，不发代码版本。

## 需求门（issue triage，用户新增需求）

需求进入研发的第一道关口，与 PR 契约门同构："确定性外壳 + pi 角色出判断"：

- **结构化 issue 模板**（需求描述/动机/影响范围/期望级别），落在注册表 repo 或目标 repo。
- **`gatekeeper triage --issue <N>`**：确定性部分——拉取 issue、组装判断简报（需求内容 + 契约注册表 + 消费方图谱，让判断者知道这个需求会波及哪些契约）、把判断结果以结构化评论写回 issue 并打 label（`gatekeeper:accepted` / `gatekeeper:rejected` / `gatekeeper:needs-info`）、记入台账。
- **判断本身委托给 `deep-reasoner` 角色**（pi-subagents，随角色包发布）：输出固定结构——是否需要做、为什么（对齐产品定位/是否已有契约覆盖/波及面与成本）、建议级别与验收要求，以及**派工方案**（见下方角色-模型选型策略）。
- pi extension 侧提供 `/gatekeeper-triage <issue>` 编排命令；判断结论进台账，与 PR 门共用同一份记录格式。
- **issue ↔ 台账强关联**：台账记录统一带关联键（`org/repo#issue`）。triage 行记 issue 判定；PR 门的台账行自动解析 PR body 的 `Closes/Fixes #N`（或 `gatekeeper:issue=N` 显式标注）回链到源 issue。由此形成完整链路：需求 issue → deep-reasoner 判定 → 派工 → PR 契约判定 → 各路 review 结论 → 合并结果。`stats` 支持按需求维度聚合（一个需求花了几个 PR、几轮 review、触碰了哪些契约）——这是护城河数据的最小闭环。

## 角色-模型选型策略（能力感知，用户新增）

用户可能配置了一堆 provider，但**角色绑定模型要按能力分级挑，不是随便用默认**：

- 随包发布 `roles-policy.yaml`（数据文件，可随模型演进独立发版，同 lanes.d 思路）：
  - **deep-reasoner 档**：偏好序 `claude-fable-5` → `claude-opus-4-8` → `gpt-5.6-sol`（顶级推理档），与用户在 pi 里实际配置的 provider 求交集，取最高可用。
  - **coder / reviewer 档**：由 deep-reasoner 在派工时依据任务复杂度从策略表挑选；**reviewer 默认两路、尽量跨厂商**（对抗 review，避免同源盲区），双 PASS 才算过——这是 project-manager 双 review 铁律的产品化。
- `gatekeeper doctor` 增加一项：读 pi 配置检查可用 provider 能否满足策略表（deep-reasoner 档无可用模型时明确告警降级）。
- reviewer 子代理的结论建议以 PR review 形式落回 GitHub，从而被 gate 的 lane 体系统一读取——pi 侧闭环与 CI 侧闭环共用同一套 M-of-N 仲裁。

## 铁律级护栏（week-1 信任保卫）

1. **只有"判定"能 block，基础设施故障永远 exit 0 + 警告评论**（注册表拉不到/token 过期/API 500 不许挡全组织的 PR），v1 不可配置。
2. 判定溯源从第一天进 verdict 对象（file → glob → 契约 → policy 条款），`check --explain` 和 sticky comment 都渲染它。
3. `gatekeeper:override` label 绕过 + 台账留痕（谁、何时）。
4. 零契约命中时不发评论；PENDING（等 lane）与 FAIL 在评论中明确区分。
5. `validate`（schema + glob lint）/ `doctor`（校验 required check 名字真实生效）/ `audit`（检查 glob 是否还能匹配到文件，防注册表漂移）三个健康命令。

## GitHub 机制要点

- 硬阻塞 = job exit code + branch protection required check；`doctor` 校验配置真实生效。
- **Gate 重触发是核心设计**：workflow 除 `pull_request` 外必须监听 `pull_request_review` + `check_suite: completed`，否则 gate 在 reviewer 完成前先跑、永远红。参考 workflow 模板直接内置。
- Fork PR：引擎只消费 API 文件列表、从不 checkout PR 代码 → `pull_request_target` 是安全的，此不变量写入文档并在 action 内强调。
- 台账 MVP 不从 CI 写任何存储：**sticky comment 内嵌 fenced JSON 块即台账行**，`stats` 按需从 API 收割已合并 PR 聚合。本地 CLI 用户另有 JSONL。零写入基建、零竞态、零额外 token 权限。SQLite 砍掉。

## 目录结构

```
gatekeeper/
  .claude/agents/  # 本项目研发阵容：deep-reasoner sonnet-coder fast-worker claude-reviewer codex-reviewer
  CLAUDE.md        # 调度规范与铁律（M0）
  tasks/           # LEDGER.md records/ LESSONS.md（本项目自己的台账）
  src/
    engine/        # 纯函数：schema.ts(zod) registry.ts match.ts verdict.ts
    providers/     # gitdiff.ts(本地) github.ts(PR API, fetch+分页)
    gate/          # lanes.ts(4原语+M-of-N合成) presets 加载
    render/        # comment.ts(sticky+JSON块) explain.ts text/json 输出
    commands/      # check gate validate doctor audit stats init triage
    init/          # 确定性部分：扫描清单生成 + 任务简报 + 草稿验证（无模型调用）
    cli.ts  action.ts
  pi-extension/    # pi 插件：gatekeeper_check 工具 + /gatekeeper-init 命令
    agents/        # 角色定义：contract-scout / registry-drafter / registry-reviewer / deep-reasoner
  lanes.d/         # coderabbit.yaml copilot.yaml greptile.yaml human.yaml
  schema/          # contract / policy 的 JSON Schema（发布件，供编辑器校验）
  action.yml
  docs/SPEC.md     # 注册表格式规范（标准文档，含 4 个真实案例）
  examples/        # 示例注册表 + 参考 workflow（含重触发事件）
  fixtures/cases/  # 表驱动判定语料（4 个真实契约为规范样例，测试与文档共用）
  tests/
```

## 本项目自身研发治理（M0，写第一行产品代码之前落地）

照 project-manager 的模式为 gatekeeper 配一套研发 agent 阵容与调度规范——既保代码质量，也是 dogfooding（gatekeeper 台账纪律的原型就是自己）：

- **`.claude/agents/`**（改编自 project-manager 现有定义，验证命令换成本项目的 `npm run typecheck && npm test`、biome）：
  - `deep-reasoner`：架构设计/跨模块根因/仲裁（opus 档）。
  - `sonnet-coder`：常规功能/测试补写/样板（复杂/核心编码走 `/codex:rescue`）。
  - `fast-worker`：闭环外琐碎机械改动。
  - `claude-reviewer` + `codex-reviewer`：每次编码交付后**并行双审查、双 PASS 才验收**，blocker 派回原编码 agent，上限 3 轮；claude-reviewer 保留对抗性检查清单（改编为 TS/vitest 语境：枚举完备性、错误路径契约、哨兵值碰撞、声明字段真实生效点）。
- **`CLAUDE.md`**：调度身份（主会话拆解/分派/仲裁/验收，不亲写大段代码）、分派速查表、铁律（双 review 闭环、review 只由调度者发起、绝对路径与 `git -C`、验收凭证据+验收即提交、台账必记）。
- **`tasks/LEDGER.md` + `tasks/records/` + `tasks/LESSONS.md`**：每个进入闭环的任务 DISPATCH 时记台账、终结时补全并写完整记录；微复盘沉淀 LESSONS。

## 实施里程碑（顺序执行，每步可验证）

0. **M0 研发治理脚手架**：上节全部文件落地（agents ×5、CLAUDE.md、tasks 三件套）；从 M1 起所有编码任务走双 review 闭环并记台账。
1. **M1 引擎核心**：zod schema + registry 加载 + 匹配器（glob/exclude/rename/delete/if_content/mirror-frozen）+ verdict 与溯源。表驱动 fixture 语料（含 4 个真实契约 + 边界：rename 出 glob、删除权威文件、binary fail-open、同 repo 双角色、exclude 优先级、dot 目录）。
2. **M2 本地 CLI**：gitdiff provider（`--name-status -M -U0`）+ `check --explain/--json` + `validate`。e2e：临时 git repo fixture 跑真 CLI 断言退出码与 JSON。
3. **M3 GitHub 侧**：PR provider（files/reviews/check-runs/comments，分页）+ sticky comment upsert + gate lane 合成（M-of-N + freshness）+ `doctor`。lane 合成用录制的真实 API payload 做 fixture。
4. **M4 Action 与工作流**：action.yml + tsup 打包 + 参考 workflow（含重触发、fork 安全说明、override label）+ `audit` + `stats`（评论收割 + 本地 JSONL）。
5. **M5 init（委托版）**：拆成"确定性三明治"——CLI 生成扫描清单与任务简报（repo 列表、文件树、候选信号：共享 schema 文件/CI 配置/HTTP header 常量），中间的起草工作由 pi-subagents 角色完成（`contract-scout` 并行扫 N 个 repo → `registry-drafter` 合成 contracts/*.yaml → `registry-reviewer` 对照 SPEC 审），最后 `gatekeeper validate` 收口。不同角色可绑不同厂商模型，全由 pi settings 管理。预期中等召回、人工确认，不承诺"理解代码"。
6. **M6 需求门 + 选型策略**：issue 模板 + `triage` 命令（拉取/简报/回写评论与 label/台账行）+ `deep-reasoner` 角色定义与判断输出结构 + `roles-policy.yaml`（deep-reasoner 偏好序 fable-5/opus-4.8/gpt-5.6-sol；coder/reviewer 由 deep-reasoner 派，reviewer 双路跨厂商对抗）+ doctor 的 provider 能力检查。判断委托给 pi，命令本身零模型。
7. **M7 pi extension + 角色包**：薄插件包装引擎——`gatekeeper_check` 自定义工具 + `/gatekeeper-init`、`/gatekeeper-triage` 编排命令；随包发布全部角色 agent 定义（contract-scout / registry-drafter / registry-reviewer / deep-reasoner）；跟随 pi 扩展规范（`.pi/extensions/` 布局 + pi-subagents 自定义 agent 格式）。
8. **M8 文档与打磨**：SPEC.md（标准文档，英文）、README（英文）、examples 全量走通；**最终验收：用 Syncify 生态 4 个真实契约（CI 镜像 tag、Slink header、artifact manifest、manuals 同步链）写第一份真实注册表，对真实 repo 的历史 diff 跑 `check --explain` 验证判定正确**，案例（脱敏后）进 SPEC 作规范样例。

## 验证方式

- `npm run typecheck && npm test`（vitest：判定语料 + schema 错误信息快照 + comment 渲染快照 + lane 合成 payload fixture）。
- e2e 脚本：临时目录建 git repo → 改动命中 fixture 契约 → 跑构建后的 CLI 断言。
- 最终验收：用 Syncify 生态 4 个真实契约写一份注册表，本地对真实 repo diff 跑 `check --explain`，输出判定正确且可解释。
- GitHub 真实联调（sandbox repo）列为手动步骤，不阻塞交付。

## 明确不做（MVP 减法，含压力测试后追加的）

自建 reviewer、语义索引、agent 编排/UI、finding 聚合、自动规范修订、SaaS、GitHub 以外平台；**consumer verify 命令只展示不执行**（跨 repo 编排是 v2）；SQLite；台账 CI 写入基建（评论即台账）。
