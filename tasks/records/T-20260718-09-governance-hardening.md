# T-20260718-09 治理硬化（用户四缺口之 ③④）

- **需求**：用户复盘提出四缺口——①计划不可移植 ②缺 AGENTS.md ③未用真实 PR 流程自治 ④流程约束无机器检查。①②由调度者直落（db8af5c）；③④本任务。
- **编码**：sonnet-coder（终案轮因 API 403 中断，剩余两处 README 文档由调度者按处方收尾）
- **交付**：governance/registry/（自身 5 契约）、.github/workflows/{ci,gatekeeper-selfgate}.yml、scripts/check-governance.mjs（R1-R5）+ 23 测试、gate 模板安全修订、README/PLAN/M4 设计勘误

## Review 历程（5 轮，含 deep-reasoner 仲裁——本项目最深闭环）

- **R1（三路全 FAIL）**：三路同点浅克隆致 R1 空转（claude 浅克隆实证）；codex 独家信任边界（PR 可改裁决自己的注册表）+ R2 表头脆弱 + R5 扩展名缺口 + schema/** 零命中；grok 独家 isControlByte 漏 VT/FF。检查器首跑即在 T-05 record 抓到残留 NUL（Write 缺陷第 5 次实证）。
- **R2**：codex 抓 pull_request_review 事件 ref 语义（GITHUB_REF=refs/pull/N/merge）+ R2 前置表误判；claude 独立同点确认（官方文档现场解码）。修：显式受信 ref + 断言。
- **R3 终审冲突 → deep-reasoner 仲裁**：codex 换层论证（workflow **定义本身**取自 PR merge commit，checkout 修复无效）vs claude PASS。deep-reasoner 官方文档双源取证裁定 **codex 成立**——同仓 PR 全面沦陷；推翻 M3 以来"必须监听 pull_request_review"设计，波及已发布 gate 模板。修：移除该触发器全波及面 + schedule 兜底。
- **R4 终确认（双 FAIL）**：codex 再进一层——**按名匹配的 required check 本身可伪造**（任意 PR 新增同名 job；required checks 不区分产出 workflow）+ README stale-pass 断言不成立（绿后 dismiss 不重算）；claude 抓 gh pr list 默认 30 条静默截断 + T-05 字节修复语义（恢复字面 NUL 的建议被调度者驳回，改可读转义文本）。
- **终案**：ci 拆独立文件、selfgate 移除一切 PR 定义加载事件、部署模型改 **ruleset "Require workflows to pass"（锁文件）**、README 诚实披露 stale-pass 窗口与补偿控制并列为升 hard 前置、--limit 500。

## 验收（调度者，2026-07-18）

- typecheck ✅ 321/321 ✅ biome（43 文件）✅ build ✅ validate（5 契约 0 警告）✅ check:governance（0/0）✅
- 触发器终态核验：ci.yml=[pull_request]；selfgate=[pull_request_target, check_suite, schedule]；gate 模板=[pull_request_target, check_suite] ✅
- **终态：验收提交。**沉淀的规范（进 LESSONS/SPEC 候选）：required check 只能由受信定义 workflow 产出且须 ruleset 锁文件；gate 类 workflow 审查先问"定义从哪加载"。遗留债：doctor 触发器 lint、受信 review 中继（升 hard 前置）、schedule job 真实 runner 联调。
