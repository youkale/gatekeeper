# T-20260718-01 M1 引擎核心

- **规格**：docs/designs/M1-engine.md（调度者产出，经 Plan agent 压力测试修正）
- **编码**：Codex（/codex:rescue 后台，session 019f710f-a7b4-7702-9843-4434c8c43e1c，24m31s）
- **交付**：src/engine/ 5 文件（types/schema/registry/match/verdict，1304 行含测试）、fixtures/cases/ 20 条语料（含 4 个真实案例）、tests/ 2 文件；27/27 测试绿

## Review 第 1 轮（并行）

- **codex-reviewer**：FAIL（thread 019f7127-8b4e-7163-a31e-e2842d3cd4f9）
  - [P1｜误阻塞] docs/designs/M2-cli.md 退出码契约把基建故障归入 exit 2，CI 直用裸 CLI 时故障变合并阻塞，违反 fail-open 铁律。**仲裁：成立，但属调度者设计文档缺陷**——已由调度者修订 M2 规格（check/gate 仅参数级用法错误 exit 2，注册表/git/网络故障一律 fail-open exit 0 + GATEKEEPER DEGRADED 警告；强拦截职责移交注册表仓库 CI 的 validate；新增 --strict-infra 本地调试档）。
  - [P2｜正确性] registry.ts:132 `toJS()` 未加保护，YAML alias 错误（`a: *missing`）抛裸 ReferenceError 击穿结构化错误契约。**仲裁：成立，派回 Codex 修复（第 2 轮）**。
- **claude-reviewer（opus 档，重派一次：首次派生实例异常返回零工具调用，作废）**：PASS
  - 18 项对抗 probe：匹配语义 7 条全一致、枚举兜底方向正确、哨兵值专项（hunk 状态机剔除 +++/---、allow_actors 大小写、override 不降档 forbidden-edit）全过。
  - Non-blocker ①（采纳为文档义务，M8 落实）：if_content 对 +/- 行按整行 test 不剥前导符，`^` 锚定 pattern 会静默漏命中——SPEC 必须注明"if_content 正则不得锚定行首"。
  - Non-blocker ②：EngineInput.status 无运行时校验（信任 M2 caller，符合纯函数区边界）。

## Review 第 2 轮（增量）

- 修复范围：registry.ts toJS 守卫（try/catch → RegistryIssue 五字段 → RegistryParseError）+ malformed-alias 测试（28/28 绿）。
- **claude-reviewer（opus）：PASS**。probe 实证：循环 alias 走 zod 结构化路径无死循环；billion-laughs 10^4 展开被同一 catch 转结构化 issue；合法 anchor+alias 无误伤；catch 范围单语句无过宽；无重复包裹。
  - Non-blocker ③：alias 错误 throw 立即中止会丢弃已累积的其他文件 issue（诊断完整性退化，方向仍 fail-closed）——遗留债，M2 或后续按需累积化。
  - Non-blocker ④：billion-laughs 场景复用 anchor hint 文案略误导（actual 字段已含真实原因）。
- **codex-reviewer：PASS**（thread 019f7134-489f-7ad0-8ae0-753c5bd80cb4，adversarial-review 携 blocker 焦点）。确认修复正确、无新 blocker、无越界；其沙箱 EPERM 无法跑全量 vitest，由调度者在主环境补跑。

## 验收（调度者，2026-07-18）

- `npm run typecheck` ✅ `npm test` 28/28 ✅ `npx biome check src tests` ✅
- **终态：双 PASS，2 轮闭环，验收通过并提交。**遗留债：non-blocker ①（SPEC 注明 if_content 勿锚定行首，M8）、③（alias 错误 issue 累积化，按需）、④（billion-laughs hint 文案）。
