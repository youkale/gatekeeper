# 任务台账（LEDGER）

每个进入双 review 闭环的任务一行：DISPATCH 时登记，终结时补全。完整记录在 `tasks/records/T-<日期>-<序号>-<slug>.md`。

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260718-01 | M1 | 引擎核心：schema/registry/匹配器/verdict + fixture 语料（规格：docs/designs/M1-engine.md） | codex | R1: codex FAIL + claude(opus) PASS；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-01-m1-engine-core.md |
| T-20260718-02 | M2 | 本地 CLI：gitdiff provider + check/validate + e2e（规格：docs/designs/M2-cli.md） | sonnet-coder | R1: 双 FAIL（8 项）；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-02-m2-cli.md |
| T-20260718-03 | M3 | GitHub 侧：PR provider + gate lanes + sticky comment + doctor + lane schema 四原语（规格：docs/designs/M3-github.md） | codex | R1: codex FAIL(5) + claude PASS(2 升级) + grok 缺席；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-03-m3-github.md |
| T-20260718-04 | M4 | Action 与工作流：action.yml + tsup 打包 + 参考 workflow + audit/stats（规格：docs/designs/M4-action.md） | codex | R1: codex 通道假僵死→降级（claude FAIL + grok FAIL 各 1）；R2: 双 PASS；补审：codex 又出 2 blocker→修复→双确认 PASS | ✅ 验收提交（含补审闭环 b7590f1） | records/T-20260718-04-m4-action.md |
| T-20260718-05 | M5 | init 委托版：scan/brief/init 命令（规格：docs/designs/M5-init.md） | sonnet-coder | R1: 三路全 FAIL（各独家）；R2: claude/grok PASS + codex 3 新项；R3: 双 PASS + fixture 可移植性微审闭环（3 轮+） | ✅ 验收提交 | records/T-20260718-05-m5-init.md |
| T-20260718-06 | M6 | 需求门 + 角色-模型选型策略（规格：docs/designs/M6-triage.md） | sonnet-coder | R1: claude PASS + codex FAIL(6) + grok FAIL(1)；R2: codex FAIL(3)；R3: codex FAIL(1)→仲裁外科修复→单点确认+测试收口（4 轮） | ✅ 验收提交 | records/T-20260718-06-m6-triage.md |
| T-20260718-07 | M7 | pi extension + 角色包（规格：docs/designs/M7-pi-extension.md） | grok-coder | R1: codex FAIL(3)+claude FAIL(3)（isError 死字段经宿主源码取证）；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-07-m7-pi-extension.md |
| T-20260718-08 | M8 | SPEC/README/deep-reasoner 隔离节（codex 编写）+ Syncify 真实注册表验收（调度者） | codex / 调度者 | 文档：claude(opus) PASS + grok PASS（2 条措辞微调验收时落实）；真实验收矩阵 7 场景全过 | ✅ 验收提交（dde56f5） | records/T-20260718-08-final-acceptance.md |

**MVP 全里程碑（M0–M8）已交付。** 最终状态：298 测试全绿、SPEC/README 落地、真实生态验收通过。

| T-20260718-09 | 治理硬化 | 自身注册表 + 自门禁 workflow + 台账检查器（四缺口 ③④） | sonnet-coder | 5 轮（R1 三路 FAIL→R2/R3 codex 逐层击穿→deep-reasoner 仲裁推翻 review 触发器设计→R4 双 FAIL→终案：ruleset 锁文件部署模型） | ✅ 验收提交 | records/T-20260718-09-governance-hardening.md |

| T-20260718-10 | 清债 | doctor 触发器 lint + registry 错误累积 + hint 文案 + selfgate workflow_dispatch | sonnet-coder | R1: claude(opus) FAIL(1 默认 mode 枚举) + grok PASS(4nb 采 1)→处方修复+文案补齐 | ✅ 验收提交 | records/T-20260718-10-11-debt-clearing.md |
| T-20260718-11 | 清债 | review 事件中继（workflow_run 桥接）——codex 内审自阻+裁决降级 best-effort | codex | codex 内部双审 FAIL→BLOCKED_REDESIGN→调度者裁决选项2（诚实降级）；外部 claude(opus)/grok 双审该实现 PASS | ✅ 验收提交 | records/T-20260718-10-11-debt-clearing.md |

| T-20260719-01 | 中立化 | agent 绑定纠偏 A：integrations/pi 迁移 + docs/roles 角色卡 + RuntimeAvailabilityProvider 解耦 + 全面文案中立 | sonnet-coder | R1: claude PASS + grok PASS（共 6 nb，4 项润色验收时落实） | ✅ 验收提交 | records/T-20260719-01-agent-neutrality.md |

| T-20260719-02 | 中立化 | agent 绑定纠偏 B：integrations/mcp MCP server（三工具，真实协议测试） | sonnet-coder | R1: claude FAIL(活体协议损坏复现)+grok FAIL(SDK 源码取证)同一并发缺陷；R2: claude PASS（真实 stdio 12 路并发零污染） | ✅ 验收提交 | records/T-20260719-02-mcp-server.md |

| T-20260719-03 | 易用性 | 交互简化 A：配置发现 + adopt(--control 登记) + provision(总控批量落地)，中途三次用户设计修正全吸收 | sonnet-coder | R1: grok PASS(6nb 采 2) + claude FAIL(worktree ENOTDIR 整批崩溃，活体复现)；R2: claude PASS（common-dir 正解 + 批次纵深防御定性合规） | ✅ 验收提交 | records/T-20260719-03-usability.md |

| T-20260719-04 | 易用性 | 交互简化 B：BYO agent runner（agent.command 配置 + 双模式 runner + triage/init --run） | sonnet-coder | R1: claude FAIL(shell 引用，双场景活体) + grok FAIL(exit code 一致性、进程组终止)；R2: 双 PASS（三修复全 mutation 对照） | ✅ 验收提交 | records/T-20260719-04-byo-runner.md |

| T-20260719-05 | 易用性 | init-control：总控一键初始化（骨架+角色卡物化+roles-policy 副本，控制仓副本优先回落包内） | sonnet-coder | R1: claude FAIL(--force 清空 repos.yaml 数据丢失，活体) + grok PASS(6nb 采 4，含 basename 误判边界)；R2: claude PASS（逐字节存活+decoy 反证） | ✅ 验收提交 | records/T-20260719-05-init-control.md |

| T-20260719-06 | 角色包 | code-reviewer 角色卡蒸馏（实战方法论产品化，第五卡；判例自指验证首例） | sonnet-coder | R1: grok PASS(3nb) + claude FAIL(评论嵌本机绝对路径——正中卡内判例#1)；R2: claude PASS（偏离裁定接受+隔离副本 mutation 实证） | ✅ 验收提交 | records/T-20260719-06-code-reviewer-card.md |

| T-20260719-07 | 角色包 | CLI 探测与角色自动选配（detect/assign/agents.yaml/三级解析链/doctor 健康检查） | sonnet-coder | R1: codex FAIL(4，含进程组复发)+claude FAIL(2)+grok PASS(采2)；R2: codex FAIL(2，含自我反转经仲裁安全优先裁定)+claude PASS；R3: codex 三项确认+新条经复核为沙箱误判驳回（3 轮） | ✅ 验收提交 | records/T-20260719-07-cli-detection.md |

- [T-07 低优] tests/agent-detect.test.ts 相对段用例的 chdir-free 硬化（codex 处方：path.relative 构造，免疫未来 pool 切换；当前默认 forks 池下 511 全绿，非缺陷）

| T-20260719-08 | 运维 | Syncify 生态真实接入（新总控仓 syncify-governance：init-control + 4 真实契约 + 6 仓 adopt + provision agents-md/hooks + 零参数冒烟三仓全对） | 调度者 | 运维操作无 review 轮 | ✅ 完成（总控仓 9b7b170） | tasks/records/T-20260719-08-syncify-onboarding.md |

| T-20260719-09 | 设计修正 | adopt 零接触化（用户裁定：登记信息只进总控仓，被管仓不得有任何修改）+ 用户级 controls 索引反向发现保零参数 | sonnet-coder | codex+claude(opus)+grok 三路，4 轮（R3 超限仲裁授权补充轮），三路计 15 项实质缺陷 | ✅ 完成（581 测试） | tasks/records/T-20260719-09-adopt-zero-touch.md |

| T-20260719-10 | 架构设计 | dispatch 最小版设计：CLI 进程统一抽象 + 状态机 + 限额/挂掉的切换与重唤起（用户立项） | deep-reasoner | 设计交付，无 review 轮（实现包 A-F 各自走闭环） | ✅ 设计定稿（调度者已裁 3 项未决） | tasks/records/T-20260719-10-dispatch-design.md |

| T-20260720-01 | 复杂编码 | dispatch A 包：订单存储 + journal 事件溯源 + 状态机 + 监督器锁（设计见 T-10 record §1-3/§9） | codex | codex 内审 3 轮 + 调度者发起外审 claude(opus)/grok 双 PASS | ✅ 验收提交（617 测试；filelock ABA 指控经 claude 独立证实 → D 包前置债 T-20260720-03） | tasks/records/T-20260720-01-dispatch-foundation.md |

| T-20260720-02 | 复杂编码 | dispatch B 包：runner 日志 sink + 活动回调 + 外部 abort + pgid 暴露（向后兼容可选项，设计 §5/拆解表B） | codex | codex 内审 + 外审 claude(opus)/grok 双 PASS | ✅ 验收提交（684 测试） | tasks/records/T-20260720-02-runner-extension.md |
| T-20260720-03 | 缺陷修复 | filelock.ts 双 stale waiter ABA 竞态（codex 指控、claude 可执行模型证实：盲删 rm 不重验 pid）——D 包硬前置 | sonnet-coder | claude(opus)+grok 双路 3 轮 + 1 仲裁（codex 占线降级，补审随 C 包后执行） | ✅ 验收提交（身份域标记 CAS + nonce 终验） | tasks/records/T-20260720-03-filelock-aba.md |

| T-20260720-04 | 复杂编码（准标准面） | dispatch C 包：结局分类器 + RESULT.json schema + 交付证据检查（设计 §4/§6/拆解表C） | codex | codex 内审 2 轮 + 外审 claude(opus)/grok 双 PASS；AGENT_ERROR 放宽偏离项经改裁驳回 | ✅ 验收提交（716 测试） | tasks/records/T-20260720-04-classifier-evidence.md |

| T-20260720-05 | 缺陷修复 | filelock 补审返工：marker 记 owner + 恢复文案静默前置 + lockPath symlink fail-closed（codex 补审 2 blocker） | sonnet-coder | claude(opus)+grok 双 PASS（攻击场景可执行重放核销） | ✅ 验收提交 | tasks/records/T-20260720-05-filelock-rework.md |
| T-20260720-06 | 复杂编码 | dispatch D 包：监督循环 + 阶梯 + cooldown + 交接合成 + git 工作区协议（设计最难包，拆解表D） | codex | codex 内审 + 外审 claude(opus)/grok 双 PASS（探针级验证）；3 偏离项全裁可接受 | ✅ 验收提交（761 测试） | tasks/records/T-20260720-06-supervisor.md |

| T-20260720-07 | 常规编码 | dispatch E 包：CLI 五子命令 + brief 合成 + status 渲染（拆解表E） | sonnet-coder | claude(opus)+grok 2 轮 + 合并终审双 PASS（R1 双路同缺陷交叉印证退出码铁律） | ✅ 验收提交（820 测试） | tasks/records/T-20260720-07-dispatch-cli.md |

| T-20260720-08 | 复杂编码 | D 包回补：NEEDS_ATTENTION resume→RUNNING + --agent 阶梯覆盖（设计 §2 明文边，E 包暴露缺口） | codex | codex 内审 + 合并终审 claude(opus)/grok 双 PASS（探针级） | ✅ 验收提交 | tasks/records/T-20260720-08-attention-resume.md |

| T-20260720-09 | 常规编码（文档化标准面） | dispatch F 包：docs/DISPATCH.md + README 节（拆解表F，双 review 不减） | sonnet-coder | claude(opus) PASS + grok 3 轮（2 blocker 均文档-代码矛盾类，逆向反查所得） | ✅ 验收提交 | tasks/records/T-20260720-09-dispatch-docs.md |

| T-20260721-01 | 常规编码 | dispatch start 免 issue 发起（--issue 可选化 + ad-hoc 关联键；顺带修父级 --help 退出码措辞） | sonnet-coder | claude(opus)+grok 双 PASS 零 blocker | ✅ 验收提交（831 测试） | tasks/records/T-20260721-01-adhoc-dispatch.md |

| T-20260721-02 | 架构设计 | review 闭环产品化设计：多路发起/verdict 证据门/轮次状态机/blocker 回派/仲裁升级（用户立项） | deep-reasoner | 设计交付，无 review 轮（实现包 A-G 各自走闭环） | ✅ 设计定稿（调度者已裁 2 项未决） | tasks/records/T-20260721-02-review-design.md |

| T-20260721-03 | 复杂编码 | review A 包：cycle 类型/store/journal/九态状态机/锁复用（含授权例外：dispatch/lock.ts 抽参数化 CAS 原语） | codex | codex 内审（降级自审，如实标注）+ 外审 claude(opus)/grok 双 PASS | ✅ 验收提交（872 测试） | tasks/records/T-20260721-03-review-cycle-foundation.md |

| T-20260721-04 | 复杂编码（准标准面） | review B 包：VERDICT.json 契约 + 证据门（token/round/只读三验，设计 §5） | codex | codex 内审 2 轮 + 外审 claude(opus)/grok 双 PASS 零 blocker | ✅ 验收提交（948 测试） | tasks/records/T-20260721-04-verdict-contract.md |

| T-20260721-05 | 复杂编码 | review F 包：dispatch workspace 续分支可选模式 + busy 扫描纳入 review cycles（触碰已交付面，设计拆解表F） | codex | codex-reviewer + claude-reviewer + grok-reviewer 三路 PASS（零 blocker） | ✅ 验收完成（未提交，按用户要求） | tasks/records/T-20260721-05-dispatch-review-extensions.md |

| T-20260721-06 | 常规编码 | review D 包：blocker 聚合去重 + 修复/增量 brief 合成（纯函数，设计拆解表D） | sonnet-coder | claude+grok 2 轮（laneNumber blocker 两路收敛仲裁裁定） | ✅ 验收提交（991 测试） | tasks/records/T-20260721-06-aggregate-brief.md |

| T-20260721-07 | 复杂编码 | review C 包：lane 并行监督器（最难包：spawn/重试/替补/冷却/只读指纹/孤儿对账/修复回派编排） | codex | claude(opus) 主路 2 轮 + 对抗 claude 替补路（grok 掉登录降级，补审记债）；崩溃搁浅 blocker 经 (b) 方案修复获独立裁定认可 | ✅ 验收提交（1006 测试，降级标注） | tasks/records/T-20260721-07-lane-supervisor.md |

| T-20260721-08 | 常规编码 | review E 包：CLI 命令族 start/status/logs/fix/accept/arbitrate/resume/cancel/render + review-ledger（拆解表E） | sonnet-coder | claude(opus) 主路 2 轮 + 对抗 claude 替补（grok 缺席降级）；release 穿透 blocker 同族第 2 例触发规范修订 | ✅ 验收提交（1053 测试，降级标注） | tasks/records/T-20260721-08-review-cli.md |

| T-20260721-09 | 常规编码（文档化标准面） | review G 包：docs/REVIEW.md + README 节（拆解表G，双 review 不减、双向核对） | sonnet-coder | DISPATCH | 进行中 | - |

### 遗留债队列（活动，v1.1 候选）

- [降级补审] T-20260721-07 C 包 + T-20260721-08 E 包 grok 补审（grok 掉登录期间由对抗 claude 替补，通道恢复后增量审）


- [dogfood] codex headless 模板缺沙箱写权限旗标（dispatch 用途下无法 commit，首个生产订单实证）
- [dogfood] 非流式 CLI（claude -p）运行期零输出 → stall 检测盲区，需替代活动信号或 per-CLI 阈值


- [接入信号] init-control 给总控仓自身写 .gatekeeper.yml（hub 侧零参数）
- [接入信号] gatekeeper 进 GitLab runner（npm 发布或烧进 syncify-ci 镜像）——CI 注入的硬前置
- [接入信号] doctor 平台感知（GitLab 生态不应报 GitHub workflow 告警）

- [v1.1] enforce: hard 的真实前置：受信外部通道（GitHub App/webhook → repository_dispatch 触发默认分支 workflow）——workflow_run 桥接已实现但可被 PR 压制脉冲，仅 best-effort（T-11 裁决结论）
- [T-09] schedule/workflow_dispatch 兜底 job 真实 runner 联调（现可 gh workflow run 手动触发验证）

- [T-07] pi-extension npm 自包含发布（tarball 打包 ../src）——真实 pi 运行时联调已完成 ✅（pi -e 端到端判定正确，2026-07-18）
- [T-01] registry alias 错误 throw 丢弃已累积 issue，按需累积化（诊断完整性，非判定缺陷）
- [T-01] billion-laughs 场景 hint 文案复用 anchor 措辞（低优）
- [产品 v2 候选，源自减法清单] consumer verify 命令跨 repo 执行编排；台账 CI 写入（ledger 分支 one-file-per-event）；finding 级聚合；GitLab CI 平台支持（Syncify 生态实际用 GitLab——真实验收发现的需求信号）

### 已清偿

- [T-04] codex 补审 ✅（发现 2 条穿透降级双审的 blocker 并修复，跨厂商补漏价值实证）
- [T-06→M8] deep-reasoner 运行隔离约束 ✅（dde56f5）
- 全部 M8 文档义务（if_content 锚定、[bot] 陷阱、pending 运维提示、COMMENT_AUTHOR、--working-tree、base 解析、doctor ENOENT）✅（SPEC/README，claude 逐条核对落实）
- [T-03] grok 未登录 ✅（用户登录后 M5 起三路全勤）
