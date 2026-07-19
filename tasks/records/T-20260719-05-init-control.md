# T-20260719-05 init-control：总控仓一键初始化

- **需求**：用户问"总控初始化根据什么初始化角色"暴露缺口——角色卡/roles-policy 躺在安装目录无物化入口。
- **交付**：`gatekeeper init-control <path> [--force]`——registry 骨架（最小 policy/示例契约模板 .txt/repos.yaml）+ governance/roles/ 四角色卡副本（定制头）+ 根 roles-policy.yaml 副本；全幂等 + 自动 validate 收口；resolveRoleCardPath 控制仓副本优先、包内回落（逐卡独立）；init/triage 简报引用接线；docs/roles 入 npm files（pack 实证）。
- **R1**：claude FAIL 1（--force 用空数组重置 repos.yaml——adopt 状态数据被当模板覆盖，登记仓队蒸发，活体复现）；grok PASS 6 nb（采 4：basename 启发式在根目录名恰为 registry 时误判→改双候选存在性探测；CLI 文案例外说明；测试标题；模板注释 *.yml）。
- **修复**：repos.yaml 恒久排除出 --force（独立 writeReposArtifact + skipped-stateful 专属 action 类型，状态/模板边界钉死在类型层）；双候选 decoy 反证测试。
- **R2**：claude PASS——数据丢失场景逐字节存活、三布局解析亲测、fail 方向与标准面零违规。
- **验收**：typecheck / 456 测试 / biome / build / check:governance 全绿。终态：验收提交。
