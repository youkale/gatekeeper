# LESSONS

任务终结微复盘的沉淀。同类问题出现 ≥2 次必须发起规范修订（改 CLAUDE.md / agent 定义），并在此标注修订链接。

条目格式：`- [T-ID] 现象 → 教训 → 处置（无/已修订 <文件>）`

- [T-20260718-05] 编码 agent 产出文件混入不可见 NUL 字节（0x00 伪装空格）：typecheck/lint/测试全绿但 git 判整文件二进制，PR diff 对审查隐身——仅被 grok 第三路（其工具拒读二进制）暴露 → 交付验收与 review 都不该只看"测试绿"：新增源文件应过一次文本完整性检查（`file` 输出非文本 / `git diff` 报 Binary 即异常）→ 处置：修复清单已含全仓自查；若再现将把文本完整性检查写入 sonnet-coder/claude-reviewer 角色文件。**根因补充（修复轮定位）**：疑似 Write 工具在内容含 `}${`（模板字面量相邻边界）处插入控制字节的工具层缺陷；规避写法：拼接键值用数组 `.join()` 而非相邻模板插值；含大量模板字面量的新文件写完做一次 `file`/字节自查。
- [T-20260718-02/-04] EPIPE 守卫在 cli.ts 修过后，M4 新入口 action.ts 复发同类缺失（守卫未随"新进程入口"同步）→ 同类问题 ≥2 次触发规范：**每新增进程入口（bin/action/未来 mcp）必须装 stdout/stderr EPIPE 守卫，review 检查单固定项** → 处置：M4 修复清单执行中；已计入 claude-reviewer 对抗口径的沿用实践。
- [T-20260718-01/-03] yaml `document.toJS()` 未守卫抛裸异常 ×2（M1 registry.ts、M3 doctor.ts——第二处还把异常误分类成基建警告 fail-open）→ 同类问题达 2 次，触发规范修订：**凡调用 yaml 库 toJS()/toJSON() 一律经守卫包装并按调用语境显式分类（关口命令→degrade；健康命令→配置错误非零）**，review 检查单加此项 → 处置：已写入 claude-reviewer 对抗清单口径（哨兵/异构输入项已覆盖），M3 R2 修复中；后续新 YAML 调用点 review 时按此执行。
- [M0 补遗] 调度者裁阵容时砍掉了 grok-coder/grok-reviewer，被用户指出——跨厂商第三视角是防同源盲区的结构性设计，不是可选项；且降级链（codex 挂 → grok 顶上）依赖它 → 移植参照系阵容时，"裁剪"须逐项给出理由并向用户确认，默认全量移植 → 处置：已补 grok 双角色 + CLAUDE.md 分派表与降级链修订。
- [T-20260718-05] fixture 依赖不可提交路径（嵌套 .git/、被 .gitignore 排除的 node_modules/）——工作树全绿但 fresh clone 必挂；三路 review 全漏（都只看工作树）→ review 与验收都应含"git ls-files 对照测试依赖"的可移植性检查；不可提交形态的 fixture 一律测试运行时构造 → 处置：已派修；若同类再现，写入 claude-reviewer 检查单。
- [T-20260718-04] codex companion 假僵死第 3 型实证（status 卡 running + pid 已亡 + result 报 No job found + 日志仅存空 findings 占位消息）：包装代理按规程正确拒信占位输出、返回 CODEX_UNAVAILABLE，降级链（grok 顶第二路）首次实战成立 → 占位性 assistant message（findings 空、未覆盖 focus 要求）不满足"完整自洽终态"标准，任何轮次都不得采信 → 处置：降级已执行，补审入遗留债；假僵死处置规程在角色文件中已足够，无需修订。
- [T-20260718-01/-02] codex-reviewer 包装代理两次挂后台 Bash 跑 review 后空手返回（后台 Bash 一挂起子代理回合即结束，"等通知"变成无 VERDICT 交付）→ 子代理内不得用 run_in_background 跑必须收割的命令，改前台 --wait timeout 拉满 + 超时后单次 status 前台轮询 → 处置：已修订 .claude/agents/codex-reviewer.md（执行步骤第 2 步）。
- [T-20260718-01/-02] opus 档后台 review 子代理 ×3 异常返回（零工具调用、秒回、输出与任务无关的样板文本；T-01 R1/R2 各一次、T-02 R2 一次）→ 后台子代理产出必须先验真再采信：凡 review 结论不以 VERDICT 开头或工具调用数为 0，一律视为无效返回，SendMessage 续场督促（3/3 实测有效）绝不计入闭环 → 处置：已升级为强制规程——所有 opus 档 review 派工提示必须写明「首个动作必须是 Read 角色文件」（第 3 次起已执行）；续场督促作为标准恢复手段。
