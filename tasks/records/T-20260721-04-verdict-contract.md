# T-20260721-04 review B 包：VERDICT.json 契约 + 证据门（准标准面）

## 交付（codex，20 分钟）

- src/review/verdict.ts：strict zod 契约（apiVersion/verdict/run_token/round/blockers/non_blockers/out_of_scope），superRefine 互锁（fail⇔blockers≥1，pass⇔空）；id/ref regex `^B-r[1-9]\d*-L[1-9]\d*-(?:0[1-9]|[1-9]\d)$`；generateRunToken（rv1_+32 字节 hex，生成一处比较一处的单一纽带）。
- src/review/evidence.ts：证据门三段优先级（监督器自证 > VERDICT 结构+token+round > 只读指纹），全 INVALID reason 矩阵；hostile 输入不可抛（抛错 getter/Proxy/深嵌套/巨串/原型注入全 fail-closed）。
- schema/review-verdict.schema.json：Draft 2020-12 双表示，互锁以 allOf+if/then 表达（经双审证真等价）；一致性测试从 zod _def 反推（fail-loud 非快照）。
- 测试 76 条。

## 闭环

codex 内审 2 轮（R1 自抓 hostile-reader blocker）；外审 claude(opus) PASS（fail 方向穷举无 VALID 泄漏、四象限亲验、__proto__ 补测、10 万字符 0ms）+ grok PASS（双表示逐字段 diff、密度对照 dispatch 先例达标；其一处 $ 换行论据被包装代理实测纠偏——保真度范例）。偏离项两处（out_of_scope=string[]、reason 无 READ_ERROR 归 CORRUPT）均裁合理。non-blocker 记档：字段无 maxLength（C 包 reader 字节上限吸收）、顶层 number/boolean 用例补强、untracked 排序契约注释显式化。

## 验收（调度者，2026-07-21）

typecheck ✅ 948/948 ✅ biome ✅ build ✅ governance ✅ 字节零 → 验收提交。
