# M5 任务包：init 委托版（T-20260718-05）

原则：**确定性三明治**——CLI 做扫描与验证（零模型），中间起草委托 pi-subagents 角色。

## 范围

- `src/init/scan.ts` — 扫描清单生成（纯确定性）：输入 repo 本地路径列表，输出候选信号清单 JSON：
  - 共享 schema 文件（*.schema.json、openapi*.y?ml、*.proto、*.graphql）
  - CI 配置（.github/workflows/**、含 image/tag 行摘录）
  - 跨 repo 重复出现的常量线索（HTTP header 名 `X-[A-Za-z-]+`、URL 路径前缀、env var 名——正则抽取 + 跨 repo 交集，出现于 ≥2 repo 才列入）
  - manifest/发布文件（package.json、*.manifest.*、deploy 清单）
  - 每项带：repo、路径、命中行摘录（≤3 行）、信号类型
- `src/init/brief.ts` — 任务简报生成：把扫描清单 + SPEC 摘要 + contracts YAML 模板渲染成一份给 registry-drafter 角色的 markdown 简报（含明确输出要求：每契约一 YAML、level 只能用 policy 中已有值、glob 相对 repo 根）
- `src/commands/init.ts` — `gatekeeper init --repos <path>... --out <dir>`：跑 scan → 写 `init-brief.md` + `scan.json` 到 out 目录 → 打印下一步指引（"在 pi 中运行 /gatekeeper-init 或将简报交给任意 agent 起草，完成后 gatekeeper validate 收口"）
- `tests/init-scan.test.ts` — 对 fixture 目录树断言信号抽取（含 ≥2 repo 交集规则、dot 目录、摘录截断）

## 明确不做

不调模型、不写网络代码；起草质量不承诺（简报中写明"候选清单预期中等召回，人工必须审"）；不解析语言级 AST。

## 验收

`cd /Users/sean/dev_projects/gatekeeper && npm run typecheck && npm test && npx biome check src tests`
