# M1 任务包：引擎核心（T-20260718-01）

调度者产出的实现规格。实现方遵此实现；对规格有异议先回报，不自行改设计。

## 范围

创建（全部为纯函数区，禁止 I/O/网络/env/随机/时钟）：

- `src/engine/types.ts` — 核心类型
- `src/engine/schema.ts` — zod schema（对外标准面）
- `src/engine/registry.ts` — 注册表解析与校验（唯一例外：由 caller 传入原始文本，本模块仍不做文件 I/O）
- `src/engine/match.ts` — 匹配器
- `src/engine/verdict.ts` — 判定与溯源
- `fixtures/cases/*.yaml` — 表驱动语料（见下）
- `tests/engine-cases.test.ts` — 语料驱动测试 harness
- `tests/schema-errors.test.ts` — schema 错误信息快照

## 核心类型（精确定义）

```ts
type ChangeStatus = "A" | "M" | "D" | "R" | "C"; // added/modified/deleted/renamed/copied

interface ChangedFile {
  path: string;          // 现路径（delete 时为被删路径）
  status: ChangeStatus;
  oldPath?: string;      // R/C 时的旧路径
  patch?: string;        // unified diff hunk 文本；binary/超大时 undefined
}

interface EngineInput {
  repo: string;          // "org/name"
  actor?: string;        // PR author login 或本地 git user；mirror-frozen 判定用
  changedFiles: ChangedFile[];
  registry: Registry;    // registry.ts 的解析产物
}
```

## 注册表 schema（对外标准面——zod 定义即规范）

契约文件（`contracts/*.yaml`，一文件一契约）：

```yaml
apiVersion: gatekeeper/v1        # 字面量校验，不匹配报结构化错误
name: artifact-manifest          # ^[a-z0-9][a-z0-9-]*$
description: …                   # 可选
level: breaking-review-required  # 外键 → policy.levels，registry 层校验存在性
authority:
  repo: org/schemas
  paths: ["manifest/schema.json"]   # 非空数组
  exclude: ["**/fixtures/**"]       # 可选
  if_content: "image-tag:\\s*v\\d+" # 可选，正则字符串，registry 层预编译校验合法性
consumers:                       # 可选数组（纯通知型契约可无消费方）
  - repo: org/deploy
    paths: ["reader/**"]
    exclude: []                  # 可选
    verify: "make verify"        # 可选，MVP 只展示不执行
    role: consumer               # consumer(默认) | producer | mirror-frozen
    allow_actors: ["deploy-bot[bot]"]  # 仅 mirror-frozen 有意义；schema 层允许、语义层告警
    if_content: …                # 可选
```

策略文件（`policy.yaml`）：

```yaml
apiVersion: gatekeeper/v1
lanes:                           # M1 只做 schema 校验，lane 求值属 M3
  human: { type: human-approval, min: 1, fresh: true }
  coderabbit: { type: review, author: "coderabbit*[bot]", pass: { state: APPROVED } }
levels:
  breaking-review-required:
    enforcement: block           # block | warn
    require: { m: 2, lanes: [human, coderabbit] }   # lanes 外键校验；m ≤ lanes 数
  notify-only:
    enforcement: warn
    require: {}                  # 空 = 无 lane 要求
adoption:
  enforcement_override: warn     # 可选；warn = 全局降档
overrides:
  label: "gatekeeper:override"   # 可选，默认此值
```

未知键处理：顶层与各嵌套对象 **strict**（未知键报错，错误信息给出最近似合法键），但保留 `x-` 前缀命名空间 passthrough（扩展点）。zod 错误必须转成人读得懂的结构化错误：`文件名 + YAML 路径 + 期望/实际 + 提示`。

## 匹配语义（v1 完整集，不得增删）

1. picomatch，**`dot: true`**（`.github/**` 必须可匹配）。
2. 命中 = 任一 include glob 匹配 **且** 无 exclude 匹配。
3. 路径集合：对每个 ChangedFile 同时用 `path` 和 `oldPath`（存在时）做匹配；任一命中即该文件命中，溯源记录实际命中的是哪条路径、哪个 glob。
4. `if_content`：仅当 binding 声明了它才启用。对 `patch` 文本中以 `+`/`-` 开头的行（剔除 `+++`/`---` 文件头）逐行做正则 `test`。**patch 为 undefined（binary/超大/provider 不给）时 fail-open 视为命中**，溯源标记 `contentCheck: "skipped-no-patch"`；有 patch 且不匹配则该文件对此 binding 不命中（`contentCheck: "no-match"`）；匹配则 `contentCheck: "matched"`。
5. `mirror-frozen`：binding 命中且 `actor` 不在 `allow_actors`（大小写敏感，actor 为 undefined 视为不在）→ 产生 `forbidden-edit` finding，**无条件升级为 block**（不受 level enforcement 与 enforcement_override 降档影响——这是唯一凌驾 adoption 降档的判定，理由：冻结镜像被手改的破坏是确定的，不存在误报噪音期）。
6. 同 repo 可同时命中 authority 与多个 consumer binding；每个 binding 独立产生溯源，verdict 层不去重 binding、只在文件列表内去重。
7. registry 中 repo 与 EngineInput.repo 的比较：精确字符串相等（大小写敏感）。

## Verdict 结构（对外标准面——JSON 可序列化）

```ts
interface Verdict {
  decision: "pass" | "warn" | "block";
  repo: string;
  touched: ContractHit[];        // 命中的契约，无命中时空数组
  forbiddenEdits: ForbiddenEdit[];
  effectivePolicy: {
    enforcementOverride: "warn" | null;  // adoption 降档是否生效
  };
}

interface ContractHit {
  contract: string;              // 契约名
  level: string;
  enforcement: "block" | "warn";          // level 声明值
  effectiveEnforcement: "block" | "warn"; // 应用 enforcement_override 后
  requires: { m: number; lanes: string[] } | null;
  bindings: BindingHit[];
  consumers: ConsumerSummary[];  // 该契约全部消费方（含未命中的），供评论渲染"波及面"
}

interface BindingHit {
  kind: "authority" | "consumer";
  role: "consumer" | "producer" | "mirror-frozen" | null; // authority 为 null
  repo: string;
  verify: string | null;
  files: FileMatch[];
}

interface FileMatch {
  path: string;
  status: ChangeStatus;
  matchedPath: string;           // 实际命中的 path 或 oldPath
  matchedGlob: string;
  contentCheck: "not-configured" | "matched" | "no-match" | "skipped-no-patch";
}

interface ForbiddenEdit {
  contract: string;
  repo: string;
  actor: string | null;
  allowActors: string[];
  files: FileMatch[];
}

interface ConsumerSummary { repo: string; role: string; verify: string | null; }
```

decision 合成：有 forbiddenEdits → `block`；否则取各命中契约 effectiveEnforcement 的最强（block > warn）；无命中 → `pass`。**contentCheck 为 no-match 的文件不计入命中**（binding 无其余命中文件时整个 binding 不算 hit）。

## Fixture 语料（`fixtures/cases/*.yaml`）

格式：

```yaml
name: rename-authority-out-of-glob
registry:
  policy: { …内联 policy… }
  contracts: [ …内联契约数组… ]
input:
  repo: org/schemas
  actor: alice
  changedFiles: [{ path: "new/loc.json", status: R, oldPath: "manifest/schema.json" }]
expected:
  decision: block
  touched: [artifact-manifest]      # 契约名列表
  forbiddenEdits: []                # 契约名列表
  fileChecks:                       # 可选，抽查关键溯源字段
    - { contract: artifact-manifest, path: "new/loc.json", matchedPath: "manifest/schema.json", contentCheck: not-configured }
```

必备案例（≥14 条）：
1. `ci-image-tag`（真实案例：`.github/workflows/**` glob + `if_content` 匹配镜像 tag 行；含 dot 目录）——命中与"改了 workflow 但没动 tag 行"不命中两条。
2. `slink-headers`（真实案例：同 repo 同时是 authority 和 consumer；`if_content: "X-Slink-(Client-ID|Alias)"`）。
3. `artifact-manifest`（真实案例：三 producer 一 consumer，producer role 溯源正确）。
4. `manuals-sync`（真实案例：mirror-frozen + allow_actors；允许 actor 通过 / 人类 actor 被 forbidden-edit 两条）。
5. rename 把权威文件移出 glob（oldPath 命中）。
6. delete 权威文件（status D 命中且溯源可见）。
7. binary/无 patch 的 if_content fail-open（contentCheck: skipped-no-patch，仍命中）。
8. exclude 优先于 include。
9. 零命中 → decision pass、touched 空。
10. enforcement_override: warn 把 block 级降为 warn；同案例中 forbidden-edit 不受降档。
11. notify-only 契约命中 → warn。
12. actor undefined 触发 mirror-frozen forbidden-edit。

## 验收命令

```
cd /Users/sean/dev_projects/gatekeeper && npm run typecheck && npm test && npx biome check src tests
```

## 禁止

- 不引入规格之外的依赖；不建 `src/engine` 之外的源码目录；不写 CLI/文件 I/O（M2 的活）。
- registry.ts 接口形态：`parseRegistry(files: { path: string; content: string }[]): Registry`（含 policy.yaml 与 contracts/*.yaml 的原始文本），返回值含结构化错误列表或抛结构化异常——选定一种并在报告中说明理由。
