# T-20260719-10 `gatekeeper dispatch` 最小版架构设计（deep-reasoner 交付，调度者已裁未决项）

## 0. 定位与不变量

dispatch 是**执行监督器**（executor/supervisor），填补 triage（事前判定）与 gate/review（事后验收）之间的空档。继承 runner.ts 的信任边界（只 spawn 用户在 agents.yaml / .gatekeeper.yml / 显式 flag 里声明的命令），自身**零模型调用**：所有状态机决策（重试/切换/等待/升级）是确定性规则，结局分类是退出码 + 正则。

fail 方向（dispatch 专属定义）：**报告并停下，交人裁决**——不确定的结局绝不标成功（"未证完成即标完成"被禁止），也绝不无界重试；阶梯有界，超界升级为 NEEDS_ATTENTION 终止在人面前。gate 的 fail-open/fail-closed 铁律不受影响。

Fork PR 安全表述：dispatch 只在 repos.yaml 登记的本地受管 checkout 上、从配置 base 分支切出的专用分支上工作，自身永不 fetch/checkout 任何 PR head ref；brief 模板不得含此类指令。

## 1. 三层核心抽象

WorkOrder（一单）--1:N--> Run（第 N 次尝试）--1:1--> Process（OS 进程组，短暂态，仅持久化 pgid）

- **WorkOrder**：order id、关联键（org/repo#issue）、目标 repo（org/name + 本地 realpath，取自 repos.yaml）、角色（MVP 固定 coder）、原始 brief、验收契约（§6）、候选阶梯（创建时由 detect + roles-policy coder 档 prefer 序冻结快照）、authoring_vendors（实际写过代码的厂商集合）。
- **Run**：run id（r001…）、CLI 名/vendor/展开命令、本 run 实际 brief（原始 + 交接附录）、pid/pgid、起止时间、结局、exit code/signal、日志路径。
- **Process**：不作持久状态机层；进程组终止复用 runner.ts 的 detached + 负 pid + SIGTERM→5s→SIGKILL。

## 2. 状态机

Run 终态（判定优先级从上到下）：

| 终态 | 判定 | 后续 |
|---|---|---|
| COMPLETED | exit 0 且交付证据齐备（§6） | 订单 → DELIVERED |
| KILLED | 操作者 dispatch cancel | 订单 → ABANDONED |
| TIMEOUT | 墙钟超限，监督器主杀 | 入阶梯 |
| STALLED | 输出活动超时，监督器主杀 | 入阶梯 |
| RATE_LIMITED | 分类器命中限额/配额模式 | 记 cooldown，切换或等待 |
| AGENT_BLOCKED | RESULT.json 显式 status: "blocked" | 直接 → NEEDS_ATTENTION（缺信息，换厂商无益） |
| EXITED_NO_EVIDENCE | exit 0 但证据缺失/无效 | 入阶梯（绝不算成功） |
| AGENT_ERROR | 非零退出、无模式命中 | 入阶梯 |
| SPAWN_FAILED | 起不来 | 配置缺陷 → NEEDS_ATTENTION |
| ORPHANED_UNKNOWN | resume 发现监督器亡、进程组亡、证据不能自证 | 按 EXITED_NO_EVIDENCE 入阶梯 |

WorkOrder 迁移：

```
PENDING --start--> RUNNING --run COMPLETED--> DELIVERED (终)
                    |- 可重试结局 + 阶梯有余 --> RUNNING（新 run，同/换 agent）
                    |- RATE_LIMITED 且无可切换替补 --> WAITING_COOLDOWN
                    |- 阶梯耗尽 / AGENT_BLOCKED / SPAWN_FAILED --> NEEDS_ATTENTION
                    |- cancel --> ABANDONED (终)
WAITING_COOLDOWN --resume（到点或 --force）--> RUNNING
WAITING_COOLDOWN / NEEDS_ATTENTION --cancel--> ABANDONED (终)
NEEDS_ATTENTION --resume [--agent X]--> RUNNING
```

终态集合 = {DELIVERED, ABANDONED}；其余状态均打印"下一条命令"提示。

## 3. 持久化与崩溃恢复

位置：resolveConfigDir(env)/dispatch/（默认 ~/.config/gatekeeper/dispatch/，复用 GATEKEEPER_CONFIG_DIR 注入点）。不放总控仓：run 状态含 pid、本机绝对路径、agent stdout（可能回显密钥），与 controls.yaml 同属 host-machine state；且一台机器的订单可横跨多个总控仓。

```
<configDir>/dispatch/orders/<order-id>/
  order.yaml         # 一次写入，仅追加 authoring_vendors 等少量字段
  journal.jsonl      # 追加式事件日志：当前状态 = fold(journal)
  brief.md
  supervisor.lock    # pid + started_at，O_EXCL
  runs/r00N/
    meta.json / brief.md / stdout.log / stderr.log / out/（RESULT.json、PROGRESS.md）
```

无守护进程：dispatch start 前台监督循环；每条迁移先落盘后动作，监督器任何时刻死亡，resume 都能 fold journal 重建并与现实对账：RUNNING 且锁内 pid 亡 → 探测 run pgid：组活 → 提示 --wait / --kill 二选一；组亡 → 按证据契约分类（证据全可判 COMPLETED，否则 ORPHANED_UNKNOWN）。关键配套：**run stdout/stderr 直接写日志文件而非 pipe 回监督器**（pipe 会随监督器同死），同时解决可观测性与活动检测。

台账衔接：订单终结时向 <cwd>/.gatekeeper/dispatch-ledger.jsonl 追加一行（org/repo#issue、结局、runs 摘要、authoring_vendors）。

## 4. 结局分类器

新模块 src/dispatch/classify.ts：确定性规则表，按 CLI 名分组，{ outcome, match: { exitCodes?, stderrPattern?, stdoutPattern? }, cooldown? }。优先级：监督器自证事实（timeout/stall/kill）> 证据契约 > 限额模式 > 其他模式 > 保守兜底（非零无命中 → AGENT_ERROR；exit 0 无证据 → EXITED_NO_EVIDENCE）。MVP 用 TS 内嵌常量表（claude/codex/grok 限额模式 + 通用网络错误），不做 YAML 外置（避免过早新增 schema 面；触发条件：第一个第三方 CLI 或单版本内模式漂移 ≥2 次）。与 KNOWN_AGENT_CLIS 分列（"怎么起" vs "怎么读尸检"），CLI name 关联。

## 5. 停滞检测与 cooldown

- 活动超时：日志文件 stall_seconds（默认 600s）无新字节 → STALLED，杀组（对应 codex 假僵死 ×3 实录）。
- 墙钟：DISPATCH_MAX_RUN_SECONDS = 14400（默认 7200），不复用不改动 MAX_AGENT_TIMEOUT_SECONDS = 3600（triage/init 的上限，两常量各守各入口）。
- RATE_LIMITED 记 resume_after（能从 stderr 捕获 reset 时间则用之，否则 per-CLI 默认，claude 类 5h）。等 vs 切：有未冷却替补 → 立即切换；无 → WAITING_COOLDOWN，剩余等待 > 15 分钟则监督器退出并打印 resume 提示（不前台长眠）。冷却到期重新入选。

## 6. 交付证据契约

exit 0 ≠ 完成。COMPLETED 需同时：
1. {out}/RESULT.json 存在且过 schema：{ apiVersion: "gatekeeper/v1", status: "delivered"|"blocked", summary, ... }（硬校验，参照 triage verdict file）；
2. 编码类订单：dispatch 分支相对 base 有 ≥1 个非 WIP 快照新 commit（git rev-list 确定性检查）。

RESULT.json 是**新的准对外标准面**：带 apiVersion、写入文档、schema 从第一版收严。【调度者裁决未决1：先入 docs/DISPATCH.md，第三方 agent 真实对接后再升格 SPEC.md。】

## 7. 切换交接协议

- 工作区协议：首 run 前校验目标工作树干净（脏则拒起）；从 base 切 gatekeeper/dispatch/<order-id> 分支，同订单所有 run 共享。
- WIP 快照：每 run 终止后（无论结局）工作树有未提交改动 → 监督器提交 "wip: run rNNN checkpoint (gatekeeper dispatch)"——交接介质是 git 本身。
- PROGRESS 检查点：brief 契约要求 agent 维护 {out}/PROGRESS.md；不写则交接降级为纯 git 证据，不阻塞。
- 交接 brief 合成（纯模板零模型）：原始 brief + 附录（历次 run 表；git log --oneline base..HEAD + git diff --stat；上一 run PROGRESS.md；失败 run stderr 尾巴；显式"接手任务，先审分支现状，续做勿重来"）。
- 跨厂商 review：authoring_vendors 为集合；交付时 reviewer 厂商 ∈ authoring_vendors → 告警 + 按 prefer 序给替补建议，MVP 不自动改派。

## 8. 重试/切换阶梯

- 同 agent 重试上限 1（仅 TIMEOUT/STALLED/AGENT_ERROR/EXITED_NO_EVIDENCE/ORPHANED_UNKNOWN）；RATE_LIMITED 不同 agent 重试，直接切换或冷却。
- 切换按订单冻结候选阶梯（prefer 厂商序），跳过冷却项。【调度者裁决未决3：冻结快照保确定性，新装 CLI 需 resume --agent 显式指名，接受此代价。】
- 总 run 上限 4，耗尽 → NEEDS_ATTENTION。
- 全自动：阶梯内重试/切换/冷却；必须过人：NEEDS_ATTENTION 恢复、ABANDONED、检测集外 agent 恢复。显式 --agent-command 起单 → 阶梯退化为单项。

## 9. 并发与锁

- 每订单单飞：supervisor.lock（O_EXCL，pid+时间），pid 存活判 stale，死锁可夺取并记 journal。
- 同目标仓互斥：起 run 前扫描全部非终态订单，同 realpath 且监督器存活 → 拒起（打印冲突订单 id）。

## 10. CLI 子命令面

```
gatekeeper dispatch start  --issue N [--brief <file>] [--agent-command ...] [--run-timeout s] [--yes]
gatekeeper dispatch status [<order-id>] [--json]
gatekeeper dispatch logs   <order-id> [--run rNNN]    # MVP：路径 + 尾部；--follow 推迟
gatekeeper dispatch resume <order-id> [--agent <cli>] [--wait|--kill] [--force]
gatekeeper dispatch cancel <order-id>
```

brief 来源：--brief 优先；仅 --issue 时确定性模板合成（issue 正文 + triage 台账 verdict 摘要与 acceptance_criteria + RESULT.json/PROGRESS.md 契约说明），src/render/dispatchBrief.ts。【调度者裁决未决2：同 issue 多条 triage 行取最后一行，E 包实现时固化入文档。】

## 11. 安全

- 命令三层解析链与 runner 一致；brief/out 注入沿用 substitutePlaceholders + shellQuote。
- 子进程环境默认透传（BYO CLI 需各自 auth 变量），仅剥离 GATEKEEPER_* 前缀（防嵌套调用读到父级控制变量）；全量白名单驳回。
- Fork 不变量见 §0。

## 范围切割

MVP 内：三层模型 + journal + 状态机；runner 日志文件化扩展；三家限额模式 + 兜底分类表；重试/切换/冷却阶梯；WIP 快照 + 交接合成；RESULT.json 契约与文档；五子命令；订单锁 + 同仓互斥；dispatch-ledger 行；issue 模式 brief 合成。

明确推迟（触发条件）：分类器 YAML 外置（第三方 CLI / 模式漂移 ≥2）；孤儿活进程深度重接管（真实出现长 run 监督器崩溃）；reviewer 自动改派（review 派发自动化立项）；多订单并行/守护进程（>2 单并发成常态）；交付自动回帖（与 gate 台账打通立项）；gc 与 logs --follow（体积/摩擦出现）；Windows 进程组（沿 runner 已文档化降级）。

## 子任务拆解（A → B∥C → D → E → F）

| 包 | 内容 | 模块 | 派谁 | 验收要点 |
|---|---|---|---|---|
| A | 订单存储 + journal + 状态机 + 锁 | src/dispatch/store.ts、machine.ts | /codex:rescue | fold 确定性（任意截断重放一致）；非法迁移表驱动全覆盖；stale 锁夺取 |
| B | runner 扩展：日志 sink + 活动回调 + 外部 abort + pgid 暴露 | src/agent/runner.ts（可选项，向后兼容） | /codex:rescue | 既有 runner/triage e2e 全绿；stall 杀组新测试 |
| C | 结局分类器 + RESULT.json schema + 证据检查 | src/dispatch/classify.ts、evidence.ts | /codex:rescue（准标准面，review 升档） | 优先级表驱动测试；exit 0 无证据必不为 COMPLETED |
| D | 监督循环 + 阶梯 + cooldown + 交接 + git 工作区协议 | src/dispatch/supervisor.ts、handoff.ts | /codex:rescue --background（最难包） | 注入式假 agent 全阶梯剧本（限额→切换→交付）；崩溃-resume e2e；脏树拒起 |
| E | CLI 五子命令 + brief 合成 + status 渲染 | src/commands/dispatch.ts、src/render/dispatchBrief.ts、cli.ts | sonnet-coder | 退出码与既有命令一致；非 TTY 需 --yes |
| F | docs/DISPATCH.md + README 节 | docs | sonnet-coder（双 review 不减） | RESULT.json 字段表与 C 包 schema 逐字段对齐 |

## 风险清单

1. B 包回归风险最高（runner 被 triage/init --run 共用）——验收含既有 e2e 全量 + 新旧模式并测。
2. 分类器模式随厂商版本漂移；误判方向已设计为安全侧（漏判限额 → AGENT_ERROR 仍入阶梯）；dogfood 期收集真实 stderr 样本入 fixture。
3. WIP 快照触发用户 hooks/LFS/签名——失败降级为交接附录少一段 git 证据，不阻塞切换；旁路与否实测裁定。
4. 孤儿进程 exit code 不可得——证据契约兜底；"孤儿成功但证据不全"保守判失败重跑（宁重跑不虚报）。
5. 5h 冷却期间休眠/时钟——resume_after 绝对时间戳；status 须把可恢复时间放最显眼位置。
