# T-20260720-01 dispatch A 包：订单存储、journal、状态机与锁

## 任务与范围

按 `T-20260719-10` 权威设计的 §0–§3、§9 落地 dispatch 最小版 A 包。该包只提供带测试的地基模块，不接 CLI；未修改 `src/engine/`、`integrations/`、`action.yml`、`docs/SPEC.md`、既有 `src/config/` 或 `src/commands/`，未引入模型调用，亦未 commit/push。

## 交付

- `src/dispatch/types.ts`：WorkOrder、Run、6 种订单状态、10 种 Run 终态、journal discriminated union 及 strict zod schema。Run meta 校验 active/terminal 字段、exit/signal 语义、`rNNN` 和 id 派生路径。
- `src/dispatch/store.ts`：`resolveConfigDir(env)/dispatch/orders/<id>` 布局；注入时钟/UUID 的订单创建；临时目录完整写入后 rename 发布；journal 完整 Buffer 短写重试、sync、同锁读取；结构化 `CORRUPT`；order/run/journal 硬校验；load/list。
- `src/dispatch/machine.ts`：纯函数 `foldJournal` 与表驱动 `assertTransition`，仅实现设计 §2 的边；锁夺取事件为 audit-only。
- `src/dispatch/lock.ts`：长持有 `supervisor.lock`（pid + started_at、`O_EXCL`、活 PID 拒绝、死 PID 夺取并写 journal）；不可变 hard-link CAS claim 链串行化夺取/释放并防 stale waiter ABA。
- `tests/dispatch-{store,machine,lock}.test.ts`：前缀重放确定性、非法迁移全表拒绝、schema 正反例、损坏 journal、创建中断/空目录/同 ID 并发、短写+并发读、stale 双 waiter、ownership-safe release、配置目录隔离。

## Review 闭环（编码 codex，3 轮）

- R1：codex FAIL（Run meta 语义/路径、retry 新旧 run id、cancel 字段关系、空目录 no-clobber）；claude FAIL（journal 短写、Run 终态语义）；grok FAIL（复用 `withFileLock` 的 stale guard 双 waiter 竞态）。全部采纳并派回原编码 agent。
- R2：claude PASS、grok PASS；codex 单点 FAIL（终态 Run 必须显式持久化 `exit_code` 与 `signal`，未知用 null）。派回原编码 agent 做限定修复。
- R3：codex PASS、claude PASS；双必需 review 闭环完成。grok 的 R2 锁复审已 PASS。

## 关键决策与设计细化

- 权威设计没有规定 order.yaml 字段名或 journal 事件序列化名；A 包首次具体化为 strict `gatekeeper/v1` 内部契约。原始 brief 的规范载体是 `brief.md`，order.yaml 以 `brief_path` 引用，加载聚合返回 `brief`。
- `RUN_RETRY_SCHEDULED` 同时记录 `previous_run_id` 与 `next_run_id`，保证事件落盘后立即崩溃仍可无歧义恢复；`LOCK_TAKEN_OVER` 不改变订单状态。
- journal sync 失败返回 `WRITE_FAILED`，不伪称持久化成功；上层重试前必须重新 load，不能盲目重复 append。
- 偏离任务中“直接复用或薄封装 filelock”的优先路径：审查构造出既有 `withFileLock` stale guard 的 ABA 双进入反例，且任务禁止修改既有 `src/config/filelock.ts`。因此监督器锁在 `lock.ts` 内采用不可变 hard-link CAS claim 链；store 的短 read/modify/write 仍直接复用 `withFileLock`。这是为维持 §9 单飞语义的显式安全偏离。

## 自评风险

- 锁按设计只用 PID 存活探测；PID 被无关进程复用时可能假 `HELD`。`started_at` 是 owner 记录和释放校验的一部分，但本包不跨平台探测实际进程启动时间。
- `supervisor.lock` 发布与 `LOCK_TAKEN_OVER` journal 是跨文件两步，进程在两步之间死亡会漏记该次夺取；下一次仍可按 stale PID 恢复，但审计不完全原子。
- immutable claim/release 文件不 GC，查找成本随单订单锁操作次数线性增长；MVP 每单次数有界，GC 本就由权威设计推迟，后续出现体积/延迟信号时需补。
- takeover journal 失败会尝试在 claim 下释放新锁；若极端 I/O 故障令 cleanup 也失败，原始错误仍为 `LOCK_IO_FAILED`，残锁要等 owner PID 死后再走 stale 恢复。
- journal sync 失败时字节可能已经进入页缓存但持久性未知；调用方必须 reload 后决定，不保证“错误即未写入”。
- 本包只读取并硬校验已经存在的 run meta，没有新增 Run 创建/更新 API；后续 supervisor 包必须沿用同目录原子发布与本 schema。
- 文件本身已 sync，目录发布依赖同目录 rename 的原子可见性；未额外 fsync 父目录，与仓库 `repos.ts`/`controls.ts` 先例一致，不宣称跨断电的目录项持久化保证。

## 验收

调度者在最终代码上运行：

```text
npm run typecheck && npm test && npx biome check src tests scripts integrations && npm run build && npm run check:governance

Test Files  36 passed (36)
Tests  617 passed (617)
Checked 89 files in 102ms. No fixes applied.
ESM Build success in 73ms
gatekeeper check:governance: OK (0 errors, 0 warning(s))
```

新增 7 文件另做控制字节扫描；本机 BSD grep 不支持 `-P`，故保留该命令的真实失败证据并以等价 Perl 字节范围扫描补证（零命中），同时 `file` 均识别为 ASCII/UTF-8 text。

## 外部审查（调度者发起，2026-07-20）

- claude(opus)：PASS 零 blocker——迁移表与设计 §2 逐边相等、machine 零 I/O、CORRUPT/权限分类正确、hard-link CAS 恰一接管论证与测试成立；**独立仲裁证实 codex 对 src/config/filelock.ts 的双 stale waiter ABA 指控**（可执行模型复现双入临界区；根因 :102 盲删不重验 pid）→ 危害评级：窄窗口本地配置丢更新；A 包自身路径均有兜底不受影响 → 处置：T-20260720-03 立项，D 包硬前置。
- grok：PASS 零 blocker——字节完整性零命中、runId 边界手工推导一致、journal union 与迁移表逐条一致、hard-link 协议纯 POSIX 语义（EXDEV fail-loud）；6 条 non-blocker 记录在案（claim 链不 GC、PID 复用、两处理论 flakiness、run schema 部分终态值域缺口留给 C 包、listOrders fail-loud 噪音面）。
- 调度者验收：typecheck ✅ 617/617 ✅ biome ✅ build ✅ check:governance ✅ → 验收提交。
