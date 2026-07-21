# T-20260721-11 review brief 输出契约修复（首个真实 dogfood 战果）

## 缘起
真实 dogfood run1：grok 审查质量好但输出旧版 markdown VERDICT 被证据门拒——brief 内嵌角色卡自带旧输出契约与 VERDICT.json 契约冲突 + stdout 直录通道无"只输出纯 JSON"指令。

## 交付（sonnet-coder）
角色卡输出节改"格式由驱动方指定"（markdown 模板保留标注为人工调度默认）；brief 加 ROLE_CARD_OUTPUT_OVERRIDE_NOTICE 仲裁句；detectReviewResultChannel 纯函数按命令模板判定 file/stdout 通道（BYO 通用），stdout 模式强约束措辞；supervisor 逐 lane 传通道。dogfood run2 验证：grok 产出结构与 token 全对的 VERDICT.json（残余运输层叙述前缀问题 → T-12）。

## 闭环
合并外审双 PASS（同 T-10 record）。验收（调度者，2026-07-21）：1068/1068 → 验收提交。
