# T-20260718-10 / T-20260718-11 遗留债清理

## T-10（sonnet-coder）：doctor 触发器 lint + registry 错误累积 + hint 区分 + workflow_dispatch

- 交付四项全落；R1 claude(opus) FAIL 1 条——lint 要求显式 `mode: gate`，但 action.yml 默认值即 gate，省略写法被静默放行（枚举完备性，方向反）→ 处方修复 `(mode ?? "gate") === "gate"` + 双测试；grok PASS，4 nb 采纳 1（受信列表文案补 workflow_dispatch）。已知边界记录：CLI 形态 gate 不识别、`/gatekeeper/i` 宽匹配、表达式 mode 不识别。
- registry 错误累积化经 claude 亲验：两文件异类错误并存 issues 全收、`.issues` 结构不变（标准面兼容）、纯函数区无 I/O。

## T-11（codex）：review 事件中继（workflow_run 桥接）

- 实现完整（review-ping 无特权脉冲、selfgate workflow_run 接入、PR 号三路解析含 head_sha API 反查、fail-open 语义）。
- **codex 内部双审 + 仲裁把自己的设计拦下**（BLOCKED_REDESIGN）：桥接 workflow 定义同样取自 PR merge ref，PR 可改写/删除 review-ping.yml 压制脉冲——中继只能保证"脉冲到达即受信重算"，不能保证"脉冲必达"。
- **调度者裁决：选项 2（诚实降级）**——桥接保留为 best-effort 纵深防御；README/注释明确不消除 stale-pass、不构成 hard 前置；真实 hard 前置（GitHub App/webhook → repository_dispatch）记 v1.1 债（App 基建属 MVP 明确排除项）。
- 外部双审：claude(opus) 对实现全绿（三路径 payload fixture 亲跑、桥接无特权核对、表述无残留过度声明）；grok PASS（触发器/if 矩阵、README 一致性、控制字节全过）。

## 同期完成（调度者直接执行）

- **pi 真实运行时联调 ✅**：`pi -ne -e ./pi-extension/index.ts` 加载成功、`gatekeeper_check` 注册、端到端调用对真实 git 历史判定 `block / spec-normative`，与 CLI 一致。

## 验收（调度者，2026-07-18）

- typecheck ✅ 334/334 ✅ biome ✅ build ✅ validate ✅ check:governance ✅
- **终态：验收提交。**遗留债终态见 LEDGER（v1.1：App 中继、npm 自包含发布；联调债已清）。
