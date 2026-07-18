# M4 任务包：GitHub Action 与工作流（T-20260718-04，待 M3 验收后派工）

## 范围

- `src/action.ts` — Action 入口（读 Actions env/inputs → 调 check/gate 逻辑 → sticky comment + job summary + exit code）
- `action.yml` — 复合定义（runs.using: node20, main: dist/action.js）
- `tsup.config.ts` — 双入口打包：dist/cli.js（bin）+ dist/action.js（noExternal 全打包，Action 环境无 node_modules）
- `src/commands/audit.ts` — 注册表漂移检查（对本地 checkout 的各 repo 树验证每个 glob 仍匹配 ≥1 文件；MVP 接受"逐 repo 本地路径映射"配置，不做远端 API 遍历）
- `src/commands/stats.ts` — 台账聚合：来源 1 = GitHub 已合并 PR 的 sticky comment 台账 JSON 块收割（分页、按 marker 过滤）；来源 2 = 本地 `.gatekeeper/ledger.jsonl`。输出总量/按契约/按级别/按 issue 关联键聚合
- `examples/workflows/gatekeeper-check.yml`、`examples/workflows/gatekeeper-gate.yml` — 参考工作流
- `tests/action-env.test.ts`、`tests/stats.test.ts`

## Action 行为契约

- inputs：`mode`（check|gate）、`registry-path`（已 checkout 的注册表目录）、`enforce`（hard|soft，soft 时 block 判定也 exit 0 只评论）、`github-token`。
- 判定 block 且 enforce=hard → core fail（exit 1）；一切基建故障 → exit 0 + warning annotation（`::warning::GATEKEEPER DEGRADED …`）+ 评论降级标注。**此不变量在 action.ts 顶层 try/catch 强制，任何未捕获异常都不得让 job 失败**（除 block 判定路径）。
- 事件数据从 `GITHUB_EVENT_PATH` JSON 读取；PR 号兼容 pull_request / pull_request_target / pull_request_review / check_suite（后两者需从 payload 反查关联 PR，check_suite 取 pull_requests[0]，为空则跳过 exit 0）。
- job summary（GITHUB_STEP_SUMMARY）写判定表。

## 参考 workflow 要点（模板即文档）

- gate workflow 触发：`pull_request_target: [opened, synchronize, reopened, labeled, unlabeled]` + `pull_request_review: [submitted, dismissed]` + `check_suite: [completed]`；并发组 per-PR cancel-in-progress。**[2026-07-18 勘误]** `pull_request_review` 的 workflow 定义本身取自 PR merge commit（非受信 base ref），job 内任何 checkout 加固都无法补救；该触发器已从参考 workflow 移除，改用 `pull_request_target`（push/label）+ `check_suite: completed` + `schedule` cron 兜底重算的受信重触发模式。`src/action.ts` 中 `pull_request_review` payload 的反查分支保留不删（见 `tests/action-env.test.ts`），仅不再出现在受信 workflow 的触发器列表中。详见 `tasks/LESSONS.md` 与 `examples/workflows/gatekeeper-gate.yml` 的安全说明注释。
- 注释中写明三条铁律：此 workflow 永不 checkout PR 头部代码（pull_request_target 安全不变量）；仅 checkout 注册表 repo（actions/checkout with repository/token/path）；required check 名必须与 branch protection 一致（gatekeeper doctor 校验）。
- override label（`gatekeeper:override`）说明与 labeled/unlabeled 重触发。
- check workflow（软提示模式）：普通 `pull_request` + enforce=soft。

## stats 输出

`gatekeeper stats [--source github --repo org/x --token …|--source local --file …] [--json]`：
- 总 PR 数、命中率、按契约 top、block/warn/override 计数、按 issue 关联（`org/repo#N` → PR 列表、轮次合计）。
- GitHub 收割：REST 列 merged PR（分页，`--since` 限界）→ 各 PR comments 找 marker → 解析 fenced JSON 块（容错：解析失败计入 `unparsable` 并列出，不中断）。

## 测试

- action-env：伪造 GITHUB_EVENT_PATH 各事件 payload fixture（pull_request / review / check_suite / 无 PR 的 check_suite），断言 PR 号解析与降级路径 exit code；顶层 catch 不变量测试（注入抛异常的 provider stub，断言 exit 0）。
- stats：伪造 comment 列表（含合法块/损坏块/无 marker），断言聚合与 unparsable 容错。
- 打包冒烟：`npm run build` 后 `node dist/cli.js --help` 退出 0（进 package.json scripts，不进 vitest）。

## 验收

`cd /Users/sean/dev_projects/gatekeeper && npm run typecheck && npm test && npx biome check src tests && npm run build && node dist/cli.js --help`

## 禁止

不改引擎/gate 语义；action.ts 不引 @actions/core 等新依赖（env/stdout 协议手写，保持零依赖面）；不做 SaaS 上报。
