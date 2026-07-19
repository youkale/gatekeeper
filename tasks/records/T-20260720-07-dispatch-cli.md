# T-20260720-07 dispatch E 包：CLI 五子命令 + brief 合成 + status 渲染

## 交付

- src/commands/dispatch.ts（~1000 行）+ src/cli.ts 注册：start/status/logs/resume/cancel 五子命令；退出码约定 0=DELIVERED（及无害 no-op）/2=用户配置错/3=非交付终态与基建故障，**绝不返回 1**（gate block 专属）；非 TTY --yes 强制；同 issue 多 triage 行取最后一行；cooldown 可恢复时间最显眼；--json 结构化。
- src/render/dispatchBrief.ts：issue 模式 brief 确定性合成（RESULT.json 契约文本与 C 包 schema 逐字段一致、围栏动态延长防逃逸、行内字段统一消毒、零本机路径泄漏）。
- resume --agent 三层解析接线（检测集内 / BYO tier2/3 回落 / 解析不到 exit 2），非 NEEDS_ATTENTION 时告警忽略。

## 闭环（编码 sonnet-coder，2 轮 + 合并终审）

- R1：claude(opus)+grok 双 FAIL 独立收敛同一 blocker——cancel 空闲态分支 try 无 catch，journal 故障穿透顶层以 exit 1 崩出（gate 专属码，双重违规）；另 6 项 NB 全采纳（INVALID_DATA→2、帮助文案、brief 相对路径化、消毒统一、类型校验、测试断言）。
- R2：双 PASS 逐项核销（回归测试证实命中空闲态分支、锁释放、订单状态完好）。
- 合并终审（与 T-08 作为一个功能单元）：双 PASS。
- E 包在实现中**暴露了 D 包对设计 §2 的两处未兑现**（NEEDS_ATTENTION resume 边、agent override 入口）→ 立项 T-08 回补，体现"接口消费方是设计兑现度的最好检验"。

## 遗留（记债）

- 候选阶梯逻辑与 assign.ts 复刻（待统一导出）；triage 台账 cwd vs 目标仓锚定不一致（F 包文档化）；resumeHint cap 拒绝文案歧义 + cap×override 组合探针固化为回归测试（清理批次）；PENDING cancel 无迁移边（按设计现状，exit 2 指引）。

## 验收（调度者，2026-07-20）

typecheck ✅ 820/820 ✅ biome ✅ build ✅ check:governance ✅ 字节零 → 验收提交。
