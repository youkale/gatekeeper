# T-20260720-09 dispatch F 包：docs/DISPATCH.md + README 节（文档化准标准面）

## 交付

- docs/DISPATCH.md（~275 行）：定位与 fail 方向（"报告并停下"，退出码 0/2/3、1 永属 gate）、RESULT.json 契约（逐字段对齐 zod + JSON Schema，{out} 文件路径语义精确澄清——调度者冒烟实测踩过的坑）、状态机（六态+十终态+逐边表+ASCII 图）、分类五级与 cooldown、阶梯与交接、恢复手册（崩溃-resume/孤儿对账/冷却/attention/filelock 两段式，错误文案逐字摘录自源码）、已知限制诚实清单（含 RATE_LIMITED 记账偏离、样本待校准、triage 台账锚定差异）。
- README：dispatch 节（定位 + 五命令表 + 指向）与 triage 衔接句。

## 闭环（编码 sonnet-coder，3 轮）

- R1：claude(opus) PASS（八项源码对照全绿）；grok FAIL 1 blocker——退出码表"resume/cancel 已终结返回 0"对 resume-on-ABANDONED 不成立（实际 3），三处自相矛盾；grok 系主动越出核查清单读实现反查声明而得。
- R2：修好原 blocker，但 §3.1 收窄措辞时把 start 误归 already-terminal 类——grok 再 FAIL（修复过程新引入）。
- R3：单句修复，grok 核销 PASS（四分句逐一与三函数分支吻合）。

## 验收（调度者，2026-07-20）

typecheck ✅ 820/820 ✅ check:governance ✅ 字节零 → 验收提交。dispatch 最小版（T-10 立项）全部六包 + 三附属任务至此收官。
