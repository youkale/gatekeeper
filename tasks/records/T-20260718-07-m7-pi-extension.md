# T-20260718-07 M7 pi extension + 角色包

- **规格**：docs/designs/M7-pi-extension.md
- **编码**：grok-coder（编码通道首战；范围纪律满分——仅动 pi-extension/ 与 tests/pi-extension.test.ts，包装层以 git 地面事实独立核验）

## Review 第 1 轮（双路，均 FAIL）

- **codex：FAIL 3**：npm 形态不可发现不自包含（无 pi 清单、tarball 缺 ../src）；preset lane 误拒（调度者预设攻击点坐实）；自声明类型未对真实接口校验且 scope 已迁移（@mariozechner 停更 0.73.1 → @earendil-works 0.80.10，调度者 npm 独立核实）。
- **claude：FAIL 3**：同 preset 误拒（实证 CLI 接受/扩展拒绝同一注册表）；**isError 死字段**——对照 pi-mono agent-loop.ts 源码证实宿主只在 execute 抛异常时置 isError，resolve 值的 isError 永不被读，全部失败被宿主当成功（本项目最硬核的单条发现之一）；pi 包管理器资源发现机制核实（RESOURCE_TYPES + readPiManifest）。

## 仲裁

合并 4 项派回 grok-coder：loadRegistryWithLanePresets 统一加载；错误改 throw；pi 清单键；MVP 口径（npm 发布标注规划中 + @earendil-works 类型导入）。

## Review 第 2 轮（增量，双 PASS）

- **claude：PASS**——4 项全实证（含手动 probe lane-preset 读取失败路径；pi 清单值与真实示例 bit-for-bit 对照；AJV 运行时校验分析证明类型强转 fail-closed）。non-blocker：lane-preset 读失败缺显式测试用例。
- **codex：PASS**（job review-mrpy2248-r9gl6j；首个 job 假僵死按规程拒信、cancel、收窄 focus 重试成功——node_modules 递归遍历疑似诱因）。

## 验收（调度者，2026-07-18）

- pi-extension 定向 8/8 ✅ typecheck ✅ biome（范围内）✅
- **终态：2 轮闭环，验收提交 236c82f。**遗留债（记 LEDGER）：npm 自包含发布、真实 pi 运行时联调。
