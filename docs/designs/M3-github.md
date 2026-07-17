# M3 任务包：GitHub 侧（T-20260718-03，待 M2 验收后派工）

## 范围

- `src/providers/github.ts` — GitHub REST 数据提供者（内置 fetch，自管分页与二级限流退避）
- `src/gate/lanes.ts` — 4 种 lane 原语求值 + M-of-N 合成（纯函数：输入 lane 配置 + 录制 payload 形态的数据）
- `src/gate/presets.ts` — lanes.d/ 预设加载与用户 policy 合并（用户显式定义同名 lane 优先）
- `lanes.d/*.yaml` — human / coderabbit / copilot / greptile 预设（数据文件）
- `src/render/comment.ts` — sticky comment 渲染（marker + 台账 fenced JSON 块）+ upsert 逻辑（纯函数出 body，provider 执行）
- `src/commands/gate.ts`、`src/commands/doctor.ts`
- `tests/lanes.test.ts`（录制 payload fixture 驱动）、`tests/comment.test.ts`（markdown 快照 + marker 碰撞）

## GitHub provider 规格

- 认证：`GITHUB_TOKEN` env；API base 可覆写（GHE 不承诺但别写死）。
- 需要的读取端点：PR files（含 `patch`、`previous_filename`，分页 100/页，上限 3000 文件防御）、PR reviews、PR 头部 SHA 与 base、issue comments、check-runs for ref、commit statuses、PR labels、branch protection required checks（doctor 用，404/403 时降级为"无法校验"警告而非失败）。
- 写入端点：创建/更新 issue comment（sticky upsert：按 marker `<!-- gatekeeper:verdict -->` 找既有评论，找到则 PATCH，多条命中取最早一条并警告）。
- 所有网络错误/非 2xx → 结构化 `InfraError`，**永不**转化为 block 判定（fail-open 铁律）；命令层捕获后 exit 0 + stderr 警告（gate/check 在 CI 语境）。

## Lane 求值规格（纯函数）

输入：`{ lanes: LaneConfig[], data: { reviews, checkRuns, statuses, comments, headSha, headPushedAt } }`。
每 lane 输出：`{ lane, state: "pass" | "fail" | "pending", evidence: string }`。

- `human-approval`：非 bot（login 不含 `[bot]`）用户的 review 按用户聚合取**最新一条**；APPROVED 计数 ≥ min 且无未解除的 CHANGES_REQUESTED → pass；有 CHANGES_REQUESTED → fail；否则 pending。`fresh: true` 时仅计 `commit_id == headSha` 的 review。
- `review`：author glob 匹配 login；state 与可选 `body_matches`（正则，大小写不敏感可配）均满足该作者**最新一条** review → pass；作者有 review 但不满足 → fail；无 review → pending。
- `check-run`：name glob 匹配；conclusion ∈ pass 集合（默认 `["success"]`）→ pass；`["failure","timed_out","cancelled","action_required"]` → fail；进行中/排队/缺席 → pending。statuses 以 `context` 匹配同理折叠进本原语（selector 变体，不是第五种）。
- `comment-scan`：author glob + body 正则匹配任一 issue comment → pass；无匹配 → pending（**永不 fail**——文本扫描缺席不可作失败证据）；评论渲染时标注 "(text-matched)"。
- M-of-N 合成：pass 数 ≥ m → gate pass；pass 数 + pending 数 < m → fail（数学上已不可能凑齐）；否则 pending。**pending 与 fail 必须区分**（评论渲染"等待中 lane"列表）。

## gate 命令行为

`gatekeeper gate --pr <n> --registry <dir> [--repo] [--json]`：
1. 读 PR 文件列表 → 引擎 evaluate → 无契约命中：exit 0，不发评论（若存在旧 sticky comment 则更新为"已不再命中"简短态）。
2. 命中：查 override label（policy.overrides.label，默认 `gatekeeper:override`）——有则 exit 0，评论记录 override 者。
3. 按命中契约合并 lane 要求（多契约取并集、m 取最大）→ lane 求值 → 合成。
4. sticky comment upsert：判定表（契约/消费方/要求）、lane 状态表（pass/fail/pending 分明）、`--explain` 级溯源折叠块、台账 JSON 块（fenced `json gatekeeper-ledger`，含 schema_version、pr、issue 回链（解析 PR body 的 Closes/Fixes #N 与 `gatekeeper:issue=N`）、verdict 摘要、lanes、override、时间戳由 caller 传入）。
5. 退出码：block 且 lane 未达标 → 1；warn/pass/pending-only-soft → 0；InfraError → 0 + 警告。enforcement 为 warn 的契约永不产生非 0。

## doctor 命令

- 校验 workflow 中 gate job 的 check 名是否列入 branch protection required checks（拿不到权限 → 警告"无法校验"）。
- 校验注册表可加载、lanes 外键、lane 预设与用户定义冲突。
- （M6 追加 provider 能力检查，此处留接口。）

## 测试

- 录制 payload fixture：`fixtures/github/*.json`——手工构造但形态严格对齐 REST v3 响应（reviews 数组含 CodeRabbit bot APPROVED、Copilot COMMENTED + 摘要文本、人类 APPROVED 带 commit_id；check-runs 数组含 in_progress 与 success；comments 含 sticky marker 碰撞样本）。lane 求值与合成全部表驱动。
- comment 渲染 markdown 快照；upsert 对 fake 评论列表测：无既有/一条既有/多条 marker 碰撞。
- 禁止真实网络调用进测试。

## 验收

`cd /Users/sean/dev_projects/gatekeeper && npm run typecheck && npm test && npx biome check src tests`

## 禁止

不改 `src/engine/**` 语义；lane 求值不得依赖网络（纯函数 + provider 分离）；不实现 stats/audit（M4）。
