# T-20260720-06 dispatch D 包：监督循环（最难包）

## 交付

- src/dispatch/supervisor.ts：监督循环全量——supervisor 锁先行、B 包 runner 四选项接入、双计时器（活动 600s/墙钟 DISPATCH_MAX_RUN_SECONDS=14400 独立常量）、C 包分类（监督器自证事实短路优先，自然信号死亡 + blocked 证据例外保留 AGENT_BLOCKED）、journal 先行纪律（每迁移先落盘后动作，三个折叠函数从 journal 确定性重建 + 幂等重放）、§8 阶梯（同 agent 2 run/RATE_LIMITED 直切/总上限 4/冷却>15min 退出留提示）、同仓互斥 peer 锁（malformed/live 保守拒起）、confirm-dead 双态修复、authoring_vendors 指纹追踪 + REVIEWER_VENDOR_CONFLICT 结构化告警。
- src/dispatch/handoff.ts：确定性交接合成（动态延长栅栏防逃逸、stderr 4000 截断、无本机路径泄漏）。
- src/dispatch/workspace.ts：git 工作区协议——base OID 原子冻结、脏树拒起、WIP 快照失败降级不阻塞、assertSafeDispatchBaseRef 前置拒绝 refs/pull//FETCH_HEAD/merge-requests 等（fork 安全）。
- 测试 43 条：假 agent 全阶梯剧本、崩溃-resume（journal 截断重放）、互斥矩阵、confirm-dead。

## 偏离项裁定（编码者自报 3 处，全部裁可接受）

- {out} 语义按 B 包落地契约取 result_path/progress_path 分立——按实。
- A 包 ATTENTION_REQUIRED 枚举缺 RATE_LIMITED → 迁移记 AGENT_ERROR + 显式 reason；claude 裁定：run meta 真实记录、fold 零功能影响、非对外标准面——审计忠实性瑕疵非缺陷；**记债**：后续向 attentionOutcomeSchema 向后兼容追加 RATE_LIMITED。
- A 包无 sidecar 类型化写入器 → D 包自带原子 sidecar，不改保护文件——按实。

## 闭环

编码 codex（1h11m，内审 + deep-reasoner 仲裁）；外审 claude(opus) PASS（探针级：journal 纪律穷举、24 例 ref 安全探针、阶梯逐条对照、-z porcelain rename 解析探针）+ grok PASS（git 命令面全列审计无 fetch/push/PR head、注入确定性、字节完整）。non-blocker 记档：atomicWrite 补 fsync 对齐 A 包、SIGKILL sleep(0) 探测窗口、HEAD ref 接受备查、attention 枚举追加。

## 验收（调度者，2026-07-20）

typecheck ✅ 761/761 ✅ biome ✅ build ✅ check:governance ✅ 字节零 → 验收提交。
