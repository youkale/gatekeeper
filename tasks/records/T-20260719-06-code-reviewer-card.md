# T-20260719-06 code-reviewer 角色卡蒸馏

- **交付**：docs/roles/code-reviewer.md（英文厂商中立第五卡）——对抗清单骨架、六条 LESSONS 判例律条（全部溯源核实无编造）、VERDICT 输出契约、增量复审纪律、lanes 回流衔接；ROLE_CARD_NAMES 单一事实源自动物化；triage 派工输出引用卡路径；蒸馏映射表随交付。
- **R1**：grok PASS（判例溯源逐条对上、体例/引用/four→five 全核）；claude FAIL 1——--post 评论嵌本机绝对路径：同机 stdout 语境安全的解析模式被复用到跨机器持久化评论，**正中卡内第一条判例「先例复用不豁免安全假设」**（律条判别力自证首例，入 LESSONS）。
- **修复**：路径改可移植表示（包内→字面量；控制仓覆盖→相对 registryDir）。编码者对处方的偏离（不反推控制仓根，避免重造已证伪的 basename 启发式）经 R2 正式裁定**接受**。
- **R2**：claude PASS——全链路复现、隔离副本 mutation 证断言真实拦截（还原缺陷 2 用例变红且精确显示泄漏路径）、目标仓零残留证据。
- **验收**：typecheck / 459 测试 / biome / build / check:governance 全绿。终态：验收提交。
