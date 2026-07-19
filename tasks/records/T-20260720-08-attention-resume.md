# T-20260720-08 D 包回补：NEEDS_ATTENTION resume + agent override

## 缘起

E 包接线时发现 supervisor 未兑现设计 §2 明文边 `NEEDS_ATTENTION --resume [--agent X]--> RUNNING`：遇 attention 无条件早退，且无阶梯覆盖入口。

## 交付（codex，14m41s，仅两文件）

- SuperviseWorkOrderInput 增 resumeFromAttention?/agentOverride?（向后兼容；未传时行为逐字节等价——journal 字节级回归断言）。
- resume 全链：override 单候选 / 无 override 沿冻结阶梯下一未耗尽候选；总上限 4 不重置、override 不可绕过；durable schedule 先于 ORDER_RESUMED 落盘（journal 先行纪律延续），崩溃重放 schedule 不匹配 → STATE_REPAIR_FAILED 拒绝猜测候选（fail-closed）。
- machine.ts/types.ts 零改动（迁移边与事件 schema 本已预留）。

## 闭环

codex 内审 2 轮 + 三路 PASS；外部合并终审（与 E 接线为一个功能单元）claude(opus)+grok 双 PASS——claude 亲跑探针验证 cap×override 2×2 矩阵与 sidecar 缺失/伪造两分支的 STATE_REPAIR_FAILED 方向；grok 核销 13 条新测试断言实质性与向后兼容。

## 验收（调度者，2026-07-20）

同 T-07 合并验收链全绿 → 验收提交。
