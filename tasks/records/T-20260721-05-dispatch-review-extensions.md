# T-20260721-05 review F 包：dispatch 续分支与 review busy scan

## 交付

- `src/dispatch/workspace.ts`：为 workspace prepare/activate 增加可选 `reuseBranch`；仅接受既存 `gatekeeper/dispatch/*` 本地分支，仍先执行原 dirty-worktree 检查与 `assertSafeDispatchBaseRef`，并在切换前证明当前 HEAD、冻结 base OID 均可从目标分支到达。未传参数时保留原命令序列、返回值与错误路径。
- `src/dispatch/supervisor.ts`：向 prepare 及所有后续 activate 调用透传可选续分支；既有 dispatch-order busy scan 完成后只读调用 `listCycles`，仅在同 realpath、非终态 review cycle 的 supervisor PID 存活时拒绝启动并报告 cycle id。缺失/空 review store 沿 `listCycles` 既有 `[]` 语义无操作。
- `src/commands/dispatch.ts`：start 的内部 options seam 只透传可选 `reuseBranch`，未增加 CLI flag。
- 新增测试覆盖：续原分支 + WIP snapshot、分支缺失/unsafe ref、dirty tree、HEAD 不可达、默认 workspace 命令逐项等价；review active/terminal/missing store 三分支；supervisor 与 start wiring。

## 闭环

- 编码者内审自报通过（其预写的'三路 PASS'表述系时序违规，已由调度者更正——见下方外部审查节）。

## 验收（调度者，2026-07-21）

- `npm run typecheck`：PASS。
- `npm test`：50 files / 985 tests 全量 PASS。
- `npx biome check src tests`：PASS。
- focused dispatch workspace/supervisor/CLI：105/105 PASS；workspace 默认命令 transcript 与 review-store-missing no-op 用例显式 PASS。
- `npm run check:governance`：PASS。
- `git diff --check`、文本完整性与保护路径检查：PASS；`src/review/{types,store,machine,lock,verdict,evidence}.ts`、`src/engine/`、`action.yml`、`docs/DISPATCH.md` 均未改。
- 未引入任何新 spawn；因此无新增 process-group-kill 语义需要接线。
- 按用户硬约束未执行 commit/push，交付保留为 unstaged/uncommitted working-tree changes。

## 延后

- 新可选参数的 `docs/DISPATCH.md` / review 用户文档说明留给 package G；本包不改状态语义文档。

## 风险自评补写（调度者代录，源自 grok 外审独立清单——原报告缺此节，流程瑕疵记 LESSONS）

- reuseBranch 无 CLI 暴露但依赖调用方传对分支；corrupt review store 会 fail-loud 挡住同 config 全部 dispatch busy 检查（与 order 侧同构，未测 corrupt 场景）；review 判活仅 PID+锁无世代校验（与既有 peer lock 同窗口）；**FIXING 态互斥与 review-fix 编排的死锁风险——C 包接线必须设计豁免通道**；detached/超前 HEAD 走 BRANCH_HEAD_MISMATCH（有意 fail-closed）；测试缝隙（reuse 的 BASE_MISMATCH 专测、corrupt store、逐次 activate 断言）；错误码命名（reuse switch 失败报 BRANCH_CREATE_FAILED）；跨包耦合（dispatch 启动路径现依赖 review store 布局）。

## 外部审查（调度者发起，2026-07-21）

- claude(opus) PASS 零 blocker：缺省路径逐参等价（git 命令序列 toEqual 全量）、fork 安全三重前置 + 12 例活体探测、busy 判活与锁协议逐句同构、既有测试 numstat 0 删除核实。non-blocker：损坏 cycle 阻塞扫描（与 order 侧同构既有特性）。
- grok PASS 零 blocker：diff 最小性逐 hunk 审计、listCycles 只读核实、字节零污染；5 条 NB（错误码命名、测试 fixture 盲区等）记档；独立发现 record 预写外审结论的时序违规（本节即更正）。
- 调度者验收：全套命令全绿 → 验收提交。
