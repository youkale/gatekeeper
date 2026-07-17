# M2 任务包：本地 CLI（T-20260718-02，待 M1 验收后派工）

## 范围

- `src/providers/gitdiff.ts` — 本地 git 数据提供者（唯一允许 child_process 的 provider 层）
- `src/providers/fsregistry.ts` — 从目录读注册表文件文本，喂给 `parseRegistry`（I/O 在 provider 层，引擎保持纯）
- `src/render/explain.ts` — verdict → 人读文本（--explain）与 JSON 输出
- `src/commands/check.ts`、`src/commands/validate.ts`
- `src/cli.ts` — commander 装配
- `tests/e2e-cli.test.ts` — 临时 git repo e2e

## gitdiff provider 规格

- 命令：`git -C <repo> diff --name-status -M -z <base>...<head>`（三点=merge-base；默认 base=main/master 自动探测，head=HEAD；支持 `--staged`/working-tree 模式：`git diff --name-status -M -z` + `--cached`）。
- `-z` 分隔解析（路径含空格/中文安全）；status 解析含 `R100`/`C75` 相似度后缀 → 归一为 R/C，旧路径新路径按 -z 顺序读取。
- patch 获取：对命中初筛（任一契约 include glob 命中 path/oldPath）的文件才跑 `git diff -U0 <range> -- <path>`，避免大 diff 全量拉取；binary 探测（git 输出 `Binary files ... differ`）→ patch undefined。
- repo 身份：`--repo org/name` 显式传入，缺省从 `git remote get-url origin` 解析（支持 ssh/https 两种形态）；解析失败且未显式传 → 结构化报错退出码 2。
- actor：`--actor` 显式传入，缺省 `git config user.name`。

## CLI 行为契约

- `gatekeeper check --registry <dir> [--repo] [--base] [--staged] [--json] [--explain] [--actor] [--strict-infra]`
  - 退出码（review 第 1 轮修订，fail-open 铁律的 CLI 形态）：**0 = pass / warn / 基础设施或配置故障**；**1 = block（仅判定）**；**2 = 仅参数级用法错误**（commander 解析失败：未知 flag、缺参数值）。
  - 注册表加载失败、git 命令失败、repo 身份解析失败等一律 **fail-open**：exit 0 + stderr 显著警告（`GATEKEEPER DEGRADED: <原因>`）+ `--json` 时输出 `{"degraded": true, "reason": …}`——CI 里直接用裸 CLI 也不会把故障变成合并阻塞。注册表坏损的强拦截职责在注册表仓库自身 CI 的 `validate`（那里非零是正确行为）。
  - `--strict-infra`（本地调试用）：上述故障改为 exit 2。
  - `--json`：stdout 输出 Verdict JSON（单行）；人读输出走 stderr。
  - `--explain`：文件 → glob → 契约 → policy 条款的溯源逐行渲染。
- `gatekeeper validate --registry <dir>`
  - schema 校验 + glob lint（裸 `**` 告警、正则编译失败报错、level/lane 外键、mirror-frozen 无 allow_actors 告警）。
  - 退出码：0 合法（告警也 0，`--strict` 时告警变 1）；2 非法。
- 版本/帮助常规。

## e2e 测试规格

`tests/e2e-cli.test.ts`：在 `fs.mkdtemp` 目录里 `git init` → 写文件 → commit main → branch → 修改命中 fixture 契约（复用 fixtures/cases 里的 ci-image-tag 案例注册表）→ 用 `tsx src/cli.ts` 跑 check，断言退出码、--json 输出关键字段、--explain 含溯源行。含一条 rename 案例（`git mv`）。临时目录测试后清理；git 命令全部 `git -C`。

## 验收

`cd /Users/sean/dev_projects/gatekeeper && npm run typecheck && npm test && npx biome check src tests`

## 禁止

不动 `src/engine/**` 既有语义（发现引擎 bug 回报调度者，不顺手改）；不引新依赖；不做 GitHub API（M3）。
