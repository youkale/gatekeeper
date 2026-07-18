# T-20260719-01 agent 绑定纠偏 A（用户决策修正）

- **背景**：用户裁定"绑定 pi 是错误决策，产品应任何 coding agent 可用"。纠偏成本低的根因：委托从设计起就是文件/CLI 契约（简报进、verdict 出），模型调用从未进产品本体——pi 只是适配层。
- **编码**：sonnet-coder。交付：pi-extension→integrations/pi（git mv 保历史）；docs/roles/ 四张厂商中立角色卡（可直接作 Claude Code subagent / pi agent / 任意系统提示）；RuntimeAvailability/RuntimeAvailabilityProvider 可插拔接口（pi 读取降为默认实现）；CLAUDE/AGENTS 不变量 #2、README「Agent integrations」总章、init/triage 指引、governance 契约 glob、ci.yml 全面中立化。
- **关键判断（编码者，验收认可）**：deep-reasoner 的 pi 副本保留全量内联——judgment 模式无文件读取能力，隔离约束必须随身；其余三角色薄壳指针。
- **Review R1**：claude PASS（迁移全 R 无删建、21 契约 glob 全命中、独立 tsc/lockfile 干净、fresh-clone 语义核验）+ grok PASS（文件完整性/交叉引用/YAML 一致性）。共 6 条 non-blocker，4 项调度者验收时落实（PLAN 目录树行、deep-reasoner 漂移句对齐、双 README 例外说明）。
- **验收**：typecheck ✅ 334/334 ✅ check:governance ✅。终态：验收提交。后续 B 任务：integrations/mcp（MCP server，通用接入正主）。
