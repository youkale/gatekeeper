# LESSONS

任务终结微复盘的沉淀。同类问题出现 ≥2 次必须发起规范修订（改 CLAUDE.md / agent 定义），并在此标注修订链接。

条目格式：`- [T-ID] 现象 → 教训 → 处置（无/已修订 <文件>）`

- [T-20260718-01/-02] codex-reviewer 包装代理两次挂后台 Bash 跑 review 后空手返回（后台 Bash 一挂起子代理回合即结束，"等通知"变成无 VERDICT 交付）→ 子代理内不得用 run_in_background 跑必须收割的命令，改前台 --wait timeout 拉满 + 超时后单次 status 前台轮询 → 处置：已修订 .claude/agents/codex-reviewer.md（执行步骤第 2 步）。
- [T-20260718-01/-02] opus 档后台 review 子代理 ×3 异常返回（零工具调用、秒回、输出与任务无关的样板文本；T-01 R1/R2 各一次、T-02 R2 一次）→ 后台子代理产出必须先验真再采信：凡 review 结论不以 VERDICT 开头或工具调用数为 0，一律视为无效返回，SendMessage 续场督促（3/3 实测有效）绝不计入闭环 → 处置：已升级为强制规程——所有 opus 档 review 派工提示必须写明「首个动作必须是 Read 角色文件」（第 3 次起已执行）；续场督促作为标准恢复手段。
