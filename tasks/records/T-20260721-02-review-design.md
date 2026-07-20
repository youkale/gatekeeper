# T-20260721-02 review 闭环产品化设计（deep-reasoner 交付，调度者已裁 2 项未决）

## 0. 定位与不变量

`gatekeeper review` 是**判定监督器**：驱动 N 路 reviewer CLI 对一个 diff 主体做对抗审查，机器收割结构化 verdict，驱动「blocker → 修复 → 增量复审」轮次，直到人终判。与 dispatch 为姊妹监督器：dispatch 监督"产出 diff"，review 监督"判定 diff"。

- 零模型不变量：本体只做组路/spawn/schema 校验/确定性聚合去重/状态机；判断在 reviewer CLI，裁决在人。
- fail 方向（比 dispatch 更严）：**无法建立合法 verdict 的路绝不折算 PASS**（判定缺失 fail-closed）；基建故障停在报告态，不产出伪 PASS。
- exit code 沿 dispatch：0 正常终态；2 用户/配置错；3 report-and-stop；1 永不使用（gate 专属）。
- 前台无守护进程；每迁移先 journal 后副作用；永不 fetch/checkout PR head。

## 1. 三层抽象

ReviewCycle（rc-*，一个闭环）--1:N--> Round（第 R 轮）--1:N--> Lane（一路 reviewer run）；BLOCKED Round 可外键挂修复用 dispatch WorkOrder。

- Cycle：subject（{kind:"dispatch-order", order_id} 或 {kind:"diff", repo, base_ref[, head_ref]}）、目标 repo、排除厂商集（authoring_vendors）、轮次上限（默认 3）、lane 组路快照（创建时冻结）。
- Round：轮号、各 lane 结果、聚合 verdict、修复订单外键、subject 指纹（实际所审 HEAD OID + 工作树摘要——防"审的不是验收的"）。
- Lane：与 dispatch Run 同构（brief/日志/meta/out/VERDICT.json），验收契约不同：产出 VERDICT.json 而非 commit，且必须只读。

## 2. 存储与耦合（裁点 5：独立 store + 外键）

理由：① review 可审非 dispatch 产出（--diff/人写 PR）；② dispatch journal 事件是 strict 判别联合，塞入即改已文档化状态面；③ 一单可多次 review，1:N 天然外键。

```
<configDir>/review/cycles/<cycle-id>/
  cycle.yaml  journal.jsonl  subject.md  supervisor.lock（复用 dispatch/lock.ts CAS 链）
  rounds/R1/summary.json + lanes/L1-codex/ L2-claude/ L3-grok/（brief+日志+out/VERDICT.json）
```

状态机**不共用 machine.ts 边表**：新建 src/review/machine.ts（同 fold 模式，独立边表）——dispatch 的 transitionTable 类型锚定其事件联合，泛化 = 改双审通过的核心模块。journal store 复用 filelock/fold 惯用法（提逻辑不提表）。

**修复回派（裁点 3 关键修正）**：不复用 resume——dispatch 状态机 DELIVERED 无出边（machine.ts:20-28，文档化终态），加边即破坏准标准面。改为：外键关联的 ad-hoc 修复订单（`org/repo@adhoc-fix-<cycle>-r<N>`）；authoring 连续性靠 ① 候选阶梯钉死原交付 candidate（铁律"派回原编码者"）② 工作区复用原 dispatch 分支续跑（F 包给 workspace 加可选模式，默认行为不变）。修复单 DELIVERED → 同一前台进程自动起下一轮增量复审。

## 3. 状态机（九态，终态仅 ACCEPTED/ABANDONED）

PENDING, REVIEWING, WAITING_COOLDOWN, BLOCKED, FIXING, AWAITING_ACCEPT, ARBITRATION, ACCEPTED, ABANDONED

| 事件 | 迁移 |
|---|---|
| CYCLE_CREATED | → PENDING（首事件） |
| ROUND_STARTED | PENDING→REVIEWING；FIXING→REVIEWING（修复交付自动增量轮）；ARBITRATION→REVIEWING（仲裁 extend 授 +1 轮） |
| LANE_CONCLUDED | audit（REVIEWING 内） |
| COOLDOWN_STARTED / CYCLE_RESUMED | REVIEWING↔WAITING_COOLDOWN（必需路限流无替补；resume 续本轮未完 lane） |
| ROUND_CONCLUDED | →AWAITING_ACCEPT（必需路全 PASS）；→BLOCKED（必需路 FAIL 且轮数<上限）；→ARBITRATION（FAIL 且达上限，或必需路无法成路） |
| BLOCKER_WAIVED | audit（BLOCKED 内，记 id+操作者理由） |
| FIX_DISPATCHED | BLOCKED→FIXING；AWAITING_ACCEPT→FIXING（人采纳 advisory 派修） |
| FIX_FAILED | FIXING→BLOCKED（修复单未 DELIVERED） |
| CYCLE_ACCEPTED | AWAITING_ACCEPT→ACCEPTED；ARBITRATION→ACCEPTED |
| CYCLE_CANCELLED | 六个非终态→ABANDONED（PENDING 无 cancel 边，孤儿手删） |
| LOCK_TAKEN_OVER | audit |

轮满（默认 3，冻结）强制入 ARBITRATION；extend 每次仅 +1 轮并 journal 留痕。

## 4. Lane 组路（裁点 1）

start 时确定并冻结：detectAgentClis(reviewer tier) → roles-policy reviewer 档 prefer 序（复用 assign.ts cross_vendor 逻辑）→ **剔除 authoring_vendors**（dispatch 订单主体自动读；--diff 主体用 --authored-by 显式声明，缺省告警）→ 前 count（默认 2）路为必需路，prefer 溢出且本机检测到的为 advisory 路（缺席不阻塞）。必需路凑不满 → 拒发，除非 --allow-degraded（DEGRADED 标记 + ledger 补审债）。

【调度者裁决未决 1：MVP 维持隐式规则（溢出即 advisory，零 schema 改动）；REVIEW.md 响亮警示"roles-policy 换序即改变必需/advisory 划分"；显式 advisory 字段推迟，触发：首次换序意外漂移或首个自定义 quorum 需求。】

审查 brief 合成（src/render/reviewBrief.ts 纯模板）：diff 范围 + subject.md（交付报告+自评风险，要求逐条复核）+ code-reviewer 角色卡 + VERDICT 契约与 run_token + 第 2 轮起上轮 blocker 清单（带 id）+ 范围锁指令。

## 5. VERDICT.json 契约（准标准面，裁点 2 采纳并加强）

src/review/verdict.ts + schema/review-verdict.schema.json，strict，文档先落 docs/REVIEW.md 后升 SPEC（沿 Evolution 条款）：

{ apiVersion:"gatekeeper/v1", verdict:"pass"|"fail", run_token:"<brief 注入一次性令牌，必须回显>", round:N,
  blockers:[{id?,ref?,file,line?,title,evidence,suggested_fix?,category?}], non_blockers:[...], out_of_scope:[...]? }

硬不变量（superRefine）：fail ⇔ blockers≥1；pass ⇔ blockers 空。

**证据门**（缺一即 INVALID）：① VERDICT.json 存在且过 strict schema（无 {out} 的 CLI 走 runner stdout→result_path 直录——codex 只读沙箱主通道，顺带清偿已记录债）；② run_token 与本 run 注入值一致 + round 与当前轮一致（机器化根除 opus 样板返回 ×3 与 codex 陈旧结果复用两类实录病灶）；③ **只读校验**：lane 起止工作区指纹比对（复用 workspace fingerprint），不一致 → INVALID(REVIEWER_WROTE_REPO) + cycle 级告警进仲裁材料。

无效路：同候选重试 1 → 换非 authoring 替补（降级链产品化，替补 brief 带"对方缺席从严"）→ 必需路替补耗尽 → ARBITRATION（绝不折算 PASS）。RATE_LIMITED 直接切换或 COOLDOWN（复用 classify.ts）。wrapper 转述保真问题就此消解：VERDICT 直出，中间层为零，现役三个包装 agent 退役为参照物。

## 6. 轮次流转与人的位置（裁点 3/4）

- 必需路全 PASS → AWAITING_ACCEPT：`review status --report` 递材料（各路 verdict 原文/advisory 发现/轮次史/指纹核验），人 `review accept [--note]` 终判。advisory FAIL 置顶提示不改状态。
- 有 blocker → BLOCKED：确定性聚合去重（file+line+title 精确匹配合并，跨路命中记多路背书=高置信信号）铸稳定 id。人的裁定收敛为一条命令：`review fix <id> [--waive B-xx --reason "…"]... [--adopt <advisory-id>]...`——waive 即采纳裁定（journal 留痕），未 waive 全进修复 brief；命令随即前台执行修复监督 + 自动增量轮（人到场按一次扳机，之后全自动）。--auto-fix 无人扳机推迟（触发：连续 ≥5 次 fix 零 waive）。
- 增量复审 brief：上轮未 waive 清单（id）+ 修复 commit 范围 + 范围锁指令（只判 (a) 各 id 是否修复 (b) 是否引入新 blocker；勿重开已过面）。范围锁机器侧：无 ref 的新 blocker 仍按 blocker（fail-closed）但打 NEW_IN_INCREMENTAL 标记置顶，仲裁可 waive——零模型下机器只标记不裁越界。
- 轮满/必需路无法成路/只读污染 → ARBITRATION：`review arbitrate --decision accept|abandon|extend --reason "…"`（CLI 参数 + journal 事件，不做交互式/裁决文件）。
- 崩溃恢复：`review resume`——fold 对账，孤儿 lane 按证据门重判，FIXING 态透传 dispatch resume。

【调度者裁决未决 2：接受 fix 一条命令串行（journal 恢复覆盖功能面）；缓解——fix 打印阶段横幅 + 文档写明 Ctrl-C 后 review resume 路径；中间报告态待 dogfood 摩擦实录再立项。】

## 7. 与 gate 衔接（裁点 6：切割）

MVP：ACCEPTED/ABANDONED 时向目标仓 .gatekeeper/review-ledger.jsonl 追加一行（cycle/subject/轮数/各路厂商终判/waive 清单/DEGRADED/指纹）。新增 `review render --format comment`：产出版本化独立 marker 的结论块（**绝不复用 gate sticky marker**——对外标准面；碰撞按检查单测试），body 形态可被 gate 既有 comment-scan/review lane 原语 body_matches 命中——自指闭环接口备好。
**诚实防伪边界**：本地 ledger 本机可信网络不可信；成为 gate 证据的唯一正道是**受信通道过账**（持 token 的人/CI 发 render 产物为 PR comment/check-run，信任锚=发布者身份）。本地文件直喂 gate **驳回**（伪造面无法关闭）；review publish 自动过账 + lanes.d 预设推迟至受信通道债清偿。

## 8. 并发/费用（裁点 7 其余）

N 路单前台进程并行（--max-parallel 默认=必需路数）；per-lane stall 600s + 墙钟 REVIEW_MAX_LANE_SECONDS=3600（独立常量）。结构性 lane 总数上界 ≤ max_rounds×(必需+advisory)×2；文档诚实注明"时间上限是费用上限的代理"。目标仓互斥：review 起 lane 前扫 dispatch 活动订单（同 realpath RUNNING 拒起）；反向扫描加进 dispatch busy 检查（F 包小改）。

## MVP 切割

进第一版：cycle store/journal/状态机/锁；VERDICT 契约+证据门（token/round/只读三验）；lane 并行监督+重试/替补/冷却；聚合去重+修复/增量 brief；外键回派（续分支）；命令族 start/status/logs/fix/accept/arbitrate/resume/cancel/render；双 subject；review-ledger；docs/REVIEW.md。
推迟（触发条件）：--auto-fix（连续 ≥5 次零 waive）；per-lane worktree 事前隔离（首次真实 REVIEWER_WROTE_REPO 或并行多 cycle）；review publish + lanes.d 预设（受信通道债清偿）；roles-policy quorum/advisory 显式字段（首个非默认需求/换序漂移实录）；语义级去重（精确去重漏合并 ≥2）；VERDICT 升 SPEC（第三方对接）；logs --follow/Windows（沿 dispatch 降级）。

## 分包（A → B∥F → C → D → E → G）

| 包 | 内容 | 模块 | 派谁 | 验收要点 |
|---|---|---|---|---|
| A | cycle 类型/store/journal/状态机/锁复用 | src/review/{types,store,machine}.ts | /codex:rescue | fold 截断重放一致；九态×全事件表驱动；轮满强制仲裁 |
| B | VERDICT 契约+证据门 | src/review/verdict.ts + schema/review-verdict.schema.json | /codex:rescue，review 升档 opus（准标准面） | pass/blockers 互锁；token/round 错配必 INVALID；stdout 直录 |
| F | dispatch 小扩展：workspace 续分支可选模式 + busy 扫描纳入 review | src/dispatch/{workspace,supervisor}.ts, commands/dispatch.ts | /codex:rescue（触碰已交付面） | 既有 831 测试零回归；默认路径逐字节等价 |
| C | lane 并行监督器 | src/review/supervisor.ts | /codex:rescue --background（最难） | 假 reviewer 全剧本；崩溃-resume e2e；指纹污染 INVALID；必需路缺失绝不折 PASS |
| D | 聚合去重+brief 合成（纯函数） | src/review/aggregate.ts + src/render/reviewBrief.ts | sonnet-coder | 去重确定性；跨路背书；ref/NEW_IN_INCREMENTAL；waive 排除 |
| E | CLI 命令族+report+review-ledger | src/commands/review.ts + cli.ts | sonnet-coder | 退出码同构 §1.3；marker 碰撞测试；非 TTY --yes |
| G | docs/REVIEW.md + README | docs | sonnet-coder（双 review 不减，派工提示含双向核对要求） | 字段表/边表逐项对齐 |

派工提示遵 LESSONS：并发/锁类要求可执行探针；自评风险逐条复核；文档类双向核对。

## 风险

1. 裸 reviewer CLI 直出干净 JSON 的能力（最高不确定）：证据门安全侧兜底（混寒暄即 INVALID）；KNOWN_AGENT_CLIS 可配 per-CLI JSON 输出旗标；C 包验收含三家真机冒烟；某家不稳则降 advisory 记债。
2. F 包回归（dispatch 全流量共用面）：全量既有测试 + 续分支新剧本。
3. 非流式 stall 盲区延伸：3600s 墙钟兜底，误杀方向安全。
4. 精确去重漏合并同义 blocker：不伤正确性，人 waive 兜；语义去重零模型下不可产品内做。
5. 增量轮重翻旧账以 NEW_IN_INCREMENTAL 出现，最坏推高轮次进仲裁——方向安全，频发则迭代角色卡措辞。
