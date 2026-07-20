# T-20260721-06 review D 包：blocker 聚合去重 + 三种 brief 合成（纯函数）

## 交付（sonnet-coder，2 轮）

- src/review/aggregate.ts：aggregateBlockers（(file,line,title) 精确去重、跨路 endorsements 置顶、确定性铸号 B-rN-LN-NN、TOO_MANY_BLOCKERS>99 fail-closed）；resolveRefs（ref 存在性 + NEW_IN_INCREMENTAL 标记 + danglingRefs 记录，不中断整轮）；applyWaivers（未知 id 结构化报错）。
- src/render/reviewBrief.ts：首轮/增量/修复三种 brief（角色卡内嵌、VERDICT 契约段、run_token/round 注入、只读警告、范围锁指令）；helper 与契约段复制自 dispatchBrief（逐字节一致经双审比对）+ 同步义务注释；category 枚举源码层 schema 反射派生（消除手工副本）。

## 闭环

R1：claude FAIL 1 blocker（laneNumber 正则放行前导零 lane id，铸出违约 id——探针实锤；grok 同点降档 NB，仲裁按"模块自证契约违约不因调用方前提豁免"裁 blocker 成立）+ 双路共 9 条 NB 采纳 6。R2：claude PASS（探针重放核销、反射链响亮失败实证、L1- 空 cli 段边界裁可接受）。

## C/E 交接记录（关键）

1. C 包 busy 互斥豁免：FIXING 态 cycle 起修复单会被自家 busy 扫描拒绝——必须设计豁免通道（F 包外审预警）。
2. C 包构造 LaneVerdict 前须对 laneId 做 laneIdSchema 全量校验（D 的 laneNumber 只校前缀）。
3. C/E 组装 priorBlockers 须排除已 waive 项（使重提已 waive 问题必被 NEW_IN_INCREMENTAL 置顶）。
4. NEW_IN_INCREMENTAL 置顶排序归渲染/status 层。

## 验收（调度者，2026-07-21）

typecheck ✅ 991/991 ✅ biome ✅ build ✅ governance ✅ 字节零 → 验收提交。
