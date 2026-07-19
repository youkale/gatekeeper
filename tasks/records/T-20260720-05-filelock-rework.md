# T-20260720-05 filelock 补审返工（marker owner + symlink 防线）

## 缘起

T-03 验收提交后，codex 补审（降级欠账清偿）在 e0d165c 上发现两条前两路共同盲区的 blocker：① 人工恢复文案可撤销活仲裁（暂停在终验后-删除前窗口的 reclaimer + 操作员照文案删除 + 新 waiter 建锁 → 恢复后的 reclaimer 删掉新活锁双入；marker 无 owner 信息无从判别）；② lockPath 末端 symlink 使 alias 与 canonical 两进程对同一 inode 派生两个不同 marker，仲裁域分裂双入。

## 交付（sonnet-coder）

- F1：marker 内容写入回收者 pid\nstarted_at（终验前写入）；超时文案两段式（读 marker pid → kill -0 判活 → 存活绝不删 / 确认死才清理）；新增 beforeReclaimDelete 测试钩子（终验后-删除前暂停点）。
- F2：readLockIdentity 前置 lstat，lockPath 末端 symlink 即 fail-closed（结构化错误，不烧重试预算）；lstat→open TOCTOU 由终验第二次 lstat 兜底（经中途换链实证）。POSIX 语义验证：O_EXCL 遇任意 symlink 恒 EEXIST 不穿透，单点设防充分。
- 文档：withFileLock 短锁定位（~5s 上限、对比 dispatch/lock.ts 长锁）；头注释两行格式更新。

## 闭环

外审 claude(opus) PASS——两个攻击场景可执行重放验证闭合（暂停存活操作员流、真孤儿端到端恢复、alias/canonical 双进程、TOCTOU 中途换链）；grok PASS——字节零污染、文案断言语义精确对应、symlink 用例真实性、lstat 跨平台外推、12 用例 5 连跑独立复验。non-blocker 记档：断言可钉顺序、升级前空 marker 过渡边角、悬空/相对链接补测加固。

## 验收（调度者，2026-07-20）

filelock 12/12 ×5 无 flake；定向复核绿；718/718（交付时全链）；字节零。→ 验收提交。filelock 六轮跨厂商审查弧线至此闭合（T-09 合入 → A 包指控 → T-03 三轮+仲裁 → codex 补审 → T-05 返工）。
