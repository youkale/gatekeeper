# T-20260721-12 证据门 stdout 通道框架宽容提取

## 缘起
dogfood run2：T-11 契约修复在指令层生效（grok 产出结构+token 全对的 VERDICT.json），但其 CLI 流式叙述前缀混入 stdout 直录 → 严格 parse 失败。提示词管不住 CLI 自身行为 → 运输层承认现实。

## 交付（sonnet-coder）
框架宽容、语义严格：单遍线性平衡扫描（字符串/转义状态机）提取含 apiVersion 的顶层 JSON 候选，取最后一个过完整 schema 者；token/round/互锁/指纹校验零改动；1MB 扫描上限（仅挡提取路径）；fail 方向全闭（漏判→CORRUPT，误选→TOKEN_MISMATCH 兜底）。15 条新测试含真实物证同形态用例。docs §3 例外授权段 + §9 债务记录。

## 闭环
claude(opus) PASS——对抗探针全过（999KB 恶意输入 5.8ms、误 PASS 唯一条件被 token nonce 锚死、真实物证字节级端到端复原 VALID）；grok PASS——形态审计确认真 O(n)、1MB 算术核实、文档一致。NB 记债：计时断言上界、1MB 字面量引用常量、§3 表述精度。

## 验收（调度者，2026-07-21）：1083/1083 全绿 → 验收提交。
