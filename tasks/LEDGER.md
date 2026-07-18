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

### 遗留债队列（活动，v1.1 候选）

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
