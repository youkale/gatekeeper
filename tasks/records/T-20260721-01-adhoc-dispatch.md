# T-20260721-01 dispatch start 免 issue 发起（ad-hoc 模式）

## 缘起

用户需求："需要不通过issue也能发起任务"——临时任务、实验性工作、GitLab 生态（issue 源未接）都不该被 --issue 必填卡住。首个生产 dogfood（syncify-hub CHANGELOG）当时即靠 --issue 1 占位绕行。

## 交付（sonnet-coder）

- --issue 可选化，三模式：仅 issue（现状）/ 仅 brief = ad-hoc（零 GitHub 调用、零 triage 查找、模板包装注入 RESULT.json 契约文本——dogfood 手写契约段经验的产品化）/ 两者（现状：brief 原文优先）；两者皆缺 exit 2。
- ad-hoc 关联键 org/repo@adhoc-<12位hex>：与 issue 键语法互斥可辨；associationKeySchema 纯超集放宽（历史键全兼容，探针验证）；全消费面键不透明无 # 拆分。
- 顺带清欠：父级 dispatch --help 退出码不精确表述修正（与 DISPATCH.md §1.3 逐字对齐）。
- 文档：DISPATCH.md §1.5 双键模式 + README 同步。

## 闭环

外审 claude(opus) PASS + grok PASS 零 blocker。non-blocker 记债：详情视图 issue: 标签未随双模式更新、PENDING cancel 文案只提 --issue、resume 用例断言偏薄、schema 接受集宽于生成集（理论边界）——入一行级清理批次。

## 验收（调度者，2026-07-21）

typecheck ✅ 831/831 ✅ biome ✅ build ✅ check:governance ✅ 字节零 → 验收提交。
