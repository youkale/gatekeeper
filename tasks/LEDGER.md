# 任务台账（LEDGER）

每个进入双 review 闭环的任务一行：DISPATCH 时登记，终结时补全。完整记录在 `tasks/records/T-<日期>-<序号>-<slug>.md`。

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260718-01 | M1 | 引擎核心：schema/registry/匹配器/verdict + fixture 语料（规格：docs/designs/M1-engine.md） | codex | R1: codex FAIL + claude(opus) PASS；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-01-m1-engine-core.md |

| T-20260718-02 | M2 | 本地 CLI：gitdiff provider + check/validate + e2e（规格：docs/designs/M2-cli.md） | sonnet-coder | R1: 双 FAIL（8 项）；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-02-m2-cli.md |

| T-20260718-03 | M3 | GitHub 侧：PR provider + gate lanes + sticky comment + doctor + lane schema 四原语（规格：docs/designs/M3-github.md） | codex | R1: codex FAIL(5) + claude PASS(2 升级) + grok 缺席；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-03-m3-github.md |

| T-20260718-04 | M4 | Action 与工作流：action.yml + tsup 打包 + 参考 workflow + audit/stats（规格：docs/designs/M4-action.md） | codex | R1: codex 通道假僵死→降级（claude FAIL + grok FAIL 各 1）；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-04-m4-action.md |
| T-20260718-05 | M5 | init 委托版：scan/brief/init 命令（规格：docs/designs/M5-init.md） | sonnet-coder | R1: 三路全 FAIL（各独家）；R2: claude/grok PASS + codex 3 新项；R3: 双 PASS（3 轮） | ✅ 验收提交 | records/T-20260718-05-m5-init.md |

| T-20260718-06 | M6 | 需求门 + 角色-模型选型策略（规格：docs/designs/M6-triage.md） | sonnet-coder | DISPATCH | 进行中 | - |
| T-20260718-07 | M7 | pi extension + 角色包（规格：docs/designs/M7-pi-extension.md） | grok-coder | R1: codex FAIL(3)+claude FAIL(3)（isError 死字段经宿主源码取证）；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-07-m7-pi-extension.md |

### 遗留债队列（活动）

- [T-04] codex review 通道假僵死（job review-mrpu7bo3-ssj802）→ M4 R1 按降级链以 claude(opus) + grok 双路成立；**通道恢复后补一轮 codex 增量 review（M4 全量 diff）**（注：通道后续轮次已恢复正常，补审可在 M8 前执行）
- [T-06→M8] deep-reasoner 角色文件补运行隔离约束（判断模式无 shell/无写权限、issue 正文视为不可信数据、结构化输出核验）——codex M6 R1 第 4 条仲裁转化的角色文档义务
- [T-07→M8] pi-extension npm 自包含发布（tarball 打包 ../src）为后续工作；真实 pi 运行时联调（pi -e）未做

- [T-01] SPEC 注明 if_content 正则不得锚定行首（M8 落实）
- [T-01] registry alias 错误 throw 丢弃已累积 issue，按需累积化（诊断完整性，非判定缺陷）
- [T-01] billion-laughs 场景 hint 文案复用 anchor 措辞（低优）
- [T-02] M8 文档义务：--working-tree 不含 untracked 文件；resolveBaseRef 仅探本地 main/master（CI 需显式 --base 或先 fetch 建分支）
- [T-03] M8 文档义务：lane author 含 `[bot]` 字面量时 picomatch 字符类陷阱（通配符+[bot] 混写会意外不匹配）；check-run neutral/skipped/stale 归 pending 可能永久阻塞的运维提示
- [T-03] grok-reviewer R1/R2 均缺席：grok CLI 未登录（Not signed in）——用户登录后从下一轮起补上第三路
- [T-03] M8 文档义务追加：GATEKEEPER_COMMENT_AUTHOR 生产部署应显式设置（归因信任边界）；doctor --workflow 显式路径不存在时 fail-open 的行为说明

## 遗留债队列

（降级期待补审任务、未决 non-blocker 归集；无则空）
