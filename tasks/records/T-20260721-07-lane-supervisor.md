# T-20260721-07 review C 包：lane 并行监督器（最难包）

## 交付（codex，16 分钟 + 修复轮 7 分钟）

- src/review/supervisor.ts（~1700 行）：superviseReviewCycle（冻结 lane 快照并行 spawn、journal 先行、隐藏轮工作目录原子发布）；无效路阶梯（同候选重试 1 → 非 authoring 替补 → 必需路耗尽 UNAVAILABLE→ARBITRATION 永不折 PASS）；RATE_LIMITED 切换/冷却/同轮 resume；per-lane stall 600s + REVIEW_MAX_LANE_SECONDS=3600；只读指纹污染 INVALID+告警；reviewFix 编排（waive→fix brief→ad-hoc 修复单钉原 candidate+reuseBranch→FIX_DISPATCHED→监督→DELIVERED 自动增量轮）；崩溃恢复（fold 对账 + promoteJournalConcludedRound 终态幂等提升——修复轮产物）；双向仓互斥 + busy 豁免（只过滤 owning cycle，注入式不污染 dispatch 默认路径）。
- 三硬交接全落实：laneIdSchema 全量校验、waived 持久化排除增量 brief、修复单钉定传参。
- 测试 15 条：全剧本矩阵（双审对账无缺项）+ 精确崩溃窗口探针。

## 闭环（降级验收）

- grok 掉登录（GROK_UNAVAILABLE）→ 按铁律 5 降级：对抗性 claude(opus) 替补第二路（"对方缺席从严"），**grok 恢复后补审记债**。
- R1：主路 claude(opus) FAIL 1 blocker（探针实锤：ROUND_CONCLUDED 落盘后 rename 前崩溃 → 整轮永久搁浅无恢复路径，BLOCKED 不能 fix）；替补路 PASS（矩阵对账/注入审计/字节）。
- 修复轮：编码者**有论证拒绝处方 (a)**（会倒置 journal-first 且修不了存量）选 (b) 终态幂等提升 + 四窗口论证 + 崩溃探针；顺带 HEAD^..HEAD 兜底改显式抛错、orphan fix order 语义核实归档（同 association_key 二次 createOrder 生成新 id 无冲突）。
- R2：主路 PASS——探针重放 + R2 轮泛化 + 伪造 staged ×3 拒绝 + 幂等复验；**独立裁定同意 (b) 胜过自己的 (a)**（架构一致性）。

## E 包交接

- superviseReviewCycle 终态分支未接 promote（设计明文 review resume 为恢复动词）——E 的 CLI 层建议 start 检测非 PENDING 时内部委托 resume。
- 双必需路同时限额仅首路记 COOLDOWN 事件（可观测性，行为安全）。

## 验收（调度者，2026-07-21，降级标注）

typecheck ✅ 1006/1006 ✅ biome ✅ build ✅ governance ✅ 字节零 → 验收提交。补审债：grok 恢复后对本包增量审。
