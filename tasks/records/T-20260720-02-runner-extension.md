# T-20260720-02 dispatch B 包：runner 日志 sink / 活动回调 / 外部 abort / pgid 暴露

## 交付

src/agent/runner.ts 四个向后兼容可选项（缺省路径与旧实现逐字节等价，25 条 triage/init 消费方用例原样全绿）：
- 日志 sink：detached 同进程组 relay 中继写文件——监督器死亡不断流；sink 打开失败回退 pipe、运行期写失败降级不杀 agent（RLIMIT_FSIZE 集成探针验证）；结果结构标注降级。
- 活动时间戳：可选回调，relay 模式经 best-effort IPC（100ms 批量），pipe 模式 data 事件直报。
- 外部 AbortSignal：走既有 SIGTERM→5s→SIGKILL 组阶梯；kind:"external-abort" 与 natural/timeout 三分类，首触发因果保序。
- onSpawn 暴露 {pid,pgid}：POSIX relay 为组长、agent 同组，杀组一网打尽。

## 闭环

- 编码 codex（34 分钟），内审三轮自报通过。
- 外审（调度者发起）：claude(opus) PASS 零 blocker——缺省路径与旧 HEAD 逐行比对、relay 生命周期四象限、LESSONS 规约（新 spawn 点杀组 + EPIPE/EFBIG 守卫）、abort 因果全核实，并亲手补射两个未测组合（pipe+活 sink、relay+非零退出）验证正确；grok PASS 零 blocker——字节、POSIX skip、消费方兼容。
- Non-blocker 记录：readAppendedOutput 全文件读入（大日志内存代价）、IPC 断连路径无直接测试、EFBIG 文案断言脆弱、relay 孤儿运维说明缺失、非 relay abort 未单测——D 包或运维文档酌情吸收。
- 交付时验收链曾被并行 T-03 工位的中间态测试红阻断（arrivals=3，后证实为合法忙轮询非回归）——多 agent 同树并行的固有摩擦，记 LESSONS 候选。

## 验收（调度者，2026-07-20）

typecheck ✅ 684/684 ✅ biome ✅ check:governance ✅（含并行工位当前落盘状态）→ 验收提交（仅 B 包 pathspec）。
