# T-20260720-04 dispatch C 包：结局分类器 + RESULT.json 证据契约（准标准面）

## 交付

- src/dispatch/classify.ts：确定性分类器——五级优先级（监督器自证 > 证据 > 限额 > 其他模式 > 保守兜底），三家限额模式 + 通用网络兜底（样本自拟标注待 dogfood 替换）；cooldown 解析（vendor-clause 绑定、相对时长/严格 ISO、BigInt 防溢出、过去时间戳拒绝；claude 5h 默认，codex/grok 1h 自选默认待文档化）；非法终止组合走结构化异常（UNREPRESENTABLE/UNATTESTED_TERMINATION），绝不伪造 outcome。
- src/dispatch/evidence.ts：RESULT.json 最小三字段 strict schema（apiVersion/status/summary）+ git 证据（hash+NUL subject 记录防空 subject 漏检，WIP 前缀排除）；COMPLETED = exit 0 且双证据；blocked → AGENT_BLOCKED。
- schema/dispatch-result.schema.json：准标准面机器可读形态，与 zod 逐字段一致（双审亲验）。
- 测试 86 条：优先级表驱动全覆盖、"未证完成"全变体穷举、分类器产出对 A 包 runSchema 逐一 safeParse。

## 裁定记录

- **AGENT_ERROR 放宽偏离项：驳回**（调度者初裁采纳，被 claude(opus) 论证推翻后改裁）——分类器无 signal-only 生产者，无生产者的 schema 放宽 = 无偿扩大已提交标准面；且重载 AGENT_ERROR 混同"运行报错"与"信号杀"语义。D 包若遇真实非背书信号死亡，以显式版本化变更新增独立 SIGNALED 终态。

## 闭环

编码 codex（27.5 分钟，内审两轮）；外审 claude(opus) PASS + grok PASS 零 blocker。non-blocker 记档：schema 对齐测试宜从 zod 推导（F 包）、"retry in" 变体漏判限额（保守方向，dogfood 收样本后补）、WIP 前缀可收严、1h 默认入 DISPATch 文档、样本标注统一。

## 验收（调度者，2026-07-20）

typecheck ✅ 716/716 ✅ biome ✅ build ✅ check:governance ✅ 字节零污染 → 验收提交。
