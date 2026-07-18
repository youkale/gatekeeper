# 任务台账（LEDGER）

每个进入双 review 闭环的任务一行：DISPATCH 时登记，终结时补全。完整记录在 `tasks/records/T-<日期>-<序号>-<slug>.md`。

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260718-01 | M1 | 引擎核心：schema/registry/匹配器/verdict + fixture 语料（规格：docs/designs/M1-engine.md） | codex | R1: codex FAIL + claude(opus) PASS；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-01-m1-engine-core.md |

| T-20260718-02 | M2 | 本地 CLI：gitdiff provider + check/validate + e2e（规格：docs/designs/M2-cli.md） | sonnet-coder | R1: 双 FAIL（8 项）；R2: 双 PASS（2 轮） | ✅ 验收提交 | records/T-20260718-02-m2-cli.md |

### 遗留债队列（活动）

- [T-01] SPEC 注明 if_content 正则不得锚定行首（M8 落实）
- [T-01] registry alias 错误 throw 丢弃已累积 issue，按需累积化（诊断完整性，非判定缺陷）
- [T-01] billion-laughs 场景 hint 文案复用 anchor 措辞（低优）
- [T-02] M8 文档义务：--working-tree 不含 untracked 文件；resolveBaseRef 仅探本地 main/master（CI 需显式 --base 或先 fetch 建分支）

## 遗留债队列

（降级期待补审任务、未决 non-blocker 归集；无则空）
