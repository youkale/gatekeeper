# T-20260721-03 review A 包：cycle 地基与共享监督器锁

## 任务与范围

按 `T-20260721-02` 权威设计 §0–§3 落地 review cycle 的类型、存储、journal、九态状态机与监督器锁地基，不接 CLI。初始任务禁止修改 `src/dispatch/`；实现前确认其 hard-link CAS 原语均为私有，无法让 review 合法复用。调度者随后明确授权唯一受控例外：只重构 `src/dispatch/lock.ts` 导出参数化 CAS 原语，既有 dispatch 入口必须保持外部行为不变。

未修改 `src/config/`、`src/engine/`、其他 dispatch 模块或任何既有测试断言；未引入模型调用；未 commit/push。

## 交付

- `src/review/types.ts`：九态、双 subject、冻结 lane 路由/初始轮次上限、DEGRADED、Round/Lane 元数据及 §3 全 journal 事件的 strict Zod schema。Round verdict 从 required lane 结果确定性重算，advisory 不参与聚合。
- `src/review/machine.ts`：独立表驱动边表与纯 `foldJournal`；三类 audit 事件不迁移；轮号顺序、轮满强制仲裁、提前仲裁和 extend 恰 `+1` 均由重放校验。
- `src/review/store.ts`：`<configDir>/review/cycles/<cycle-id>/` 布局；注入时钟/随机源；完整 staging 目录后 rename 发布；journal 锁内先完整 fold、再 Buffer 短写重试和 sync；结构化错误及 round/lane 交叉一致性校验。
- `src/dispatch/lock.ts`：抽出并导出参数化 hard-link CAS 公共原语；既有 `acquireSupervisorLock(orderId)` 改为领域适配入口。
- `src/review/lock.ts`：只提供 cycle 路径、review takeover 事件和 review 错误域映射的薄封装。
- `tests/review-{store,machine,lock}.test.ts`：前缀重放、九态全事件矩阵、轮满/extend、损坏 journal、创建中断、配置隔离、CAS 复用和 stale takeover，并覆盖 required 聚合伪 PASS 反例。

## CAS 行为等价

- dispatch adapter 仍在进入公共原语前解析相同的 config/order 路径，并传入原有三条目录诊断文案；公共原语继续抛 `DispatchLockError` 及原 code。
- live holder、损坏锁、claim 发布、stale 删除、owner-safe release 等分支仍执行原函数体；只把 order 路径和 takeover 事件构造提升为参数/回调。
- takeover 回调仍位于新锁发布后、返回 handle 前；回调失败仍在 claim 链下释放新 owner，并以原 `stale takeover audit failed for <lockPath>` 错误上抛。
- dispatch adapter 构造的 `LOCK_TAKEN_OVER` 字段、时间戳来源与 append seam 均不变；既有全部 dispatch 测试零修改通过。

## Review 闭环

- Codex companion 首轮因只读沙箱无法创建 job log（EPERM）而按角色卡返回 `CODEX_UNAVAILABLE`；grok 额度预检同因会话状态目录权限返回 `GROK_UNAVAILABLE`；Claude CLI 存在但未登录。所有不可用通道均未采信占位输出。
- 按 `CLAUDE.md` 降级规程启用两路独立、从严只读审查。R1 两路均以可执行探针复现同一 blocker：required lane FAIL/INVALID 可被 summary 声明为 PASS/AWAITING_ACCEPT。
- blocker 派回原编码 agent：required 全 PASS 才 PASS；不可用类优先聚合为 UNAVAILABLE；其余 required FAIL 聚合为 FAIL；advisory 不影响；load 拒绝遗漏冻结 required route。
- R2 两路分别重跑探针和聚焦测试，均 PASS，无新 blocker。

## 自评风险

- Round/Lane 持久化字段是设计 §1 的首次具体化；实现只表达“Round 含逐 lane 结果、Lane 与 dispatch Run 同构”的明文要求，未预判 B 包 VERDICT 内容。
- 公共 CAS 原语仍以 `DispatchLockError` 为底层错误；review adapter 在 acquire/release 两侧映射为 `ReviewLockError`。若未来出现第三个监督器，可再在明确需求下抽象错误工厂，本包不继续泛化。
- immutable claim/release artifact 与 PID 复用风险继承已验收的 dispatch 锁设计；本次仅参数化路径和审计回调，没有改变其单机、同文件系统信任边界。
- cycle/round/lane 跨文件更新不是一个事务；本包保证 cycle 创建原子和 journal 单行持久化/重放一致，后续 supervisor 必须继续遵守“journal 先于副作用”和 staging 发布协议。

## 偏离项

- 修改 `src/dispatch/lock.ts` 是相对初始硬边界的唯一偏离，已由调度者在本任务续场中明确仲裁授权。未修改 dispatch 边表、types、store、config 或既有测试。

## 验收

最终命令证据由调度者在 R2 双 PASS 后执行并记录于交付报告；治理检查包含本记录与 LEDGER 终态。

## 外部审查（调度者发起，2026-07-21）

- claude(opus) PASS 零 blocker：锁重构经 git diff 逐分支 + 独立探针确认纯提取参数化（审计失败释放路径/live holder/双 waiter 场景复验）；状态机十二事件逐边一致；伪聚合 PASS 修复双重上锁无同族残留；错误域映射全集覆盖。
- grok PASS 零 blocker：八文件字节零污染；diff 形态裁定"纯提取+委托"；schema 反例探测全拒；九态×全事件矩阵真全覆盖；lock 复用零算法复制。
- non-blocker 记档（后续包吸收）：前缀重放宜逐前缀 golden 断言、导出类型注释密度、journal 单一信任根交叉校验、短写重试定向测试、diff subject repo 格式防护、extend 折叠逻辑双处内联、SUPERVISOR_LOCK_FILENAME 常量重复。
- 调度者验收：typecheck ✅ 872/872 ✅ biome ✅ build ✅ governance ✅ → 验收提交。
