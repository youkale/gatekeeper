# T-20260720-03 filelock 双 stale waiter ABA 修复（身份域标记 CAS + nonce 终验）

## 缘起

A 包编码期间 codex 指控既有 withFileLock（T-09 合入）stale 回收存在 ABA；claude(opus) 在 A 包外审中用可执行模型独立证实（盲删 rm 不重验 pid → 双 waiter 双入临界区）。列为 D 包硬前置。

## 闭环过程（编码 sonnet-coder，3 轮 + 1 次仲裁）

- R1 交付 rename-CAS 方案 → claude(opus) FAIL（可执行模型 3/3 复现：rename 按路径非 inode 仲裁，延迟观测者搬走活锁照样双入）+ grok FAIL（独立收敛到同一缺陷——罕见跨路重叠，说明缺陷根本性）。
- R2 交付身份域标记 CAS（(dev,ino) 派生标记路径 O_EXCL 仲裁 + 删前 stat 重验，全交错手工论证）→ claude PASS（探针亲验：延迟观测者重放、三 waiter + 标记复用、崩溃窗口 fail-loud 24ms、release 免核验反例搜索均成立）；grok FAIL 2 条（孤儿标记永久卡锁；ino 复用重开 ABA）。
- **仲裁**：孤儿标记裁 non-blocker（复合崩溃 → 响亮失败零腐化可人工恢复，优于修复前的"自愈即缺陷"；自愈机制会在标记层复刻盲删竞态，不做）；ino 复用裁采纳 nonce 加固。
- R3 限定加固（锁内容 pid\nnonce、终验 handle 式重读全匹配、双超时文案分流 + 人工恢复指引、doc 三节、测试注入口 retryDelayMs/maxAttempts）→ claude PASS（三 waiter 结构重跑无回归、死→活→死文案状态机亲测、旧格式残余窗口三理由裁可接受）+ grok PASS（字节零污染、测试确定性逻辑核实、5 连跑复验）。

## 验收（调度者，2026-07-20）

filelock 10/10 ×5 无 flake；全链 690/690（R3 交付时）；定向复核（filelock+全部调用方测试文件）绿；控制字节零。→ 验收提交。

## 遗留（一行级，随 D 包吸收）

- identitiesMatch 可收紧为 observed.nonce === current.nonce（对 legacy vs 新格式假阳性再加一道，无合法回收损失）。
- lastDeadMarkerPath 在 identity === undefined 分支未清空（末次迭代文案可能引用过期 marker 路径，仅诊断措辞影响）。
- 模块头注释 "content = holder PID" 未更新为两行格式。
- 既有 busy-spin（stale-不可回收分支无 sleep）与 stat().catch 吞错——修复前既有行为，记录不动。

## 教训（入 LESSONS 候选）

并发原语的 review 必须要求可执行模型/探针级验证——本任务三轮中每一轮的关键裁定（击落 rename-CAS、证实协议主体、验证文案状态机）都来自亲跑探针而非读代码；纯阅读式 review 在此类任务上两次给出过错误的通过信号（R1 编码者自证、R2 文档论证）。
