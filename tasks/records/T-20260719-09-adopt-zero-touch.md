# T-20260719-09 adopt 零接触化 + 用户级 controls 索引反向发现

## 背景

用户裁定（连说两遍强调）：adopt 不得在目标仓写 `.gatekeeper.yml`，登记信息只进总控仓，对原项目零修改。既有 6 个真实 Syncify 仓的 `.gatekeeper.yml` 污染由调度者即时清除。

## 交付

- adopt 零接触：仅重叠校验 + repos.yaml upsert + 用户级 controls 索引登记（`~/.config/gatekeeper/controls.yaml`，`GATEKEEPER_CONFIG_DIR` 可注入）；测试断言 adopt 后目标仓 `git status` 干净。
- 发现链第五级：`discoverConfigWithControlsIndex` 反向发现（仓根 realpath → 索引 → 各 control 的 repos.yaml / control 自匹配），`.gatekeeper.yml` 显式配置仍优先；9 命令全接入并统一 env 线程化。
- 加固：saveRepos/saveControlsIndex 原子写（临时文件+rename）+ 同目录锁文件串行化（丢失更新防护，含反向验证：摘锁 12 并发只存 1）；adopt 故障矩阵三格封闭（任何失败 exit 2 且不留损坏残留态）。
- fail 方向：GitDiffError 分 `not-a-worktree`（跳层）/`infra`（gate degrade、工具 fail-loud）；gate 模式 stale-control 无匹配 → 响亮 degrade 而非静默 exit 2。

## 闭环过程（编码 sonnet-coder，4 轮）

- R1：codex FAIL 4（hub 自发现缺口、re-adopt 同 path 双行、adopt 部分完成态、env 注入漏点）+ claude(opus) FAIL 1（realpath 裸抛 → gate fail-closed，方向反）+ grok PASS 3 NB 采纳。三路 8 项零重叠。
- R2：claude PASS；codex FAIL 3（triage/stats 回退缺口、adopt 原子性）。
- 调度者预防性补项：saveControlsIndex 同款原子写（编码者自评风险升格）。
- R3（上限轮）：claude PASS；codex FAIL 4 条新 finding（GitDiffError 混同、stale-control 静默、丢失更新、action env 不对称）。
- **仲裁（铁律 1 超限条款）**：4 条全部成立采纳，授权范围收紧补充轮（C1-C4，调度者扩展 repos.yaml 同型锁）；codex 报的 npm test 失败经调度者本机 566/566 全绿证伪（沙箱 EPERM 噪音 ×3 → 修订 codex-reviewer 角色文件）。终核由调度者执行：验收命令全绿（581 测试）+ C1-C4 逻辑抽查 + diff 控制字节零。

## 验收（调度者，2026-07-20）

typecheck ✅ 581/581 ✅ biome ✅ build ✅ check:governance ✅ diff 无控制字节 ✅

## 备注

- 同批合入：T-08 补写 record（R2 红线）、T-10 设计文档、codex-reviewer 角色修订。
- 遗留：真实 Syncify 生态换新机制复验（提交后执行）；rename 失败残留 .tmp-* 文件（推测性，non-blocker 记录在案）。
