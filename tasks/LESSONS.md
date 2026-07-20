# LESSONS

- [T-20260718-09] **gate/关口类 workflow 审查必须先问"job 定义从哪个 commit 加载"，再问"checkout 什么"**——pull_request_review 事件的 workflow 定义取自 PR merge commit（与 pull_request 同、与 pull_request_target 异），job 内任何受信 checkout 都无法补救定义层被改写；该缺陷从 M3 压力测试建议（"必须监听 pull_request_review 防卡红"）一路带到已发布模板，历经多轮 review 才被 codex 在定义加载层击穿、deep-reasoner 官方文档取证裁定 → 规范：**required check 只能由定义取自受信 ref 的 workflow（pull_request_target/check_suite/workflow_run/schedule）产出**；advisory workflow 绝不与 gate 同名 → 处置：已按裁决修复全波及面；doctor 触发器 lint 记遗留债；若触发器信任语义误判再现，固化进 SPEC 规范性条款。

- [T-20260719-02] 先例引用不豁免安全假设：captureCommand（全局 stdout 接管）在单发 Action 进程安全，被照搬进常驻并发 MCP server 即造成协议流损坏——复用既有模式必须重验其安全前提（进程生命周期/并发模型/共享资源）在新语境是否仍成立；与「每新增进程入口须重装 EPIPE 守卫」同族 → 处置：注入式 sink 根除；作显式判例记录。

- [T-20260719-06] 判例的自指验证：code-reviewer 角色卡蒸馏交付本身踩中卡内第一条判例——deep-reasoner 卡路径解析模式（同机 stdout 消费，绝对路径安全）被复用到跨机器持久化的 GitHub 评论输出，正是「先例复用不豁免安全假设」；review 轮由 claude 依据该判例击落 → 蒸馏出的律条对蒸馏过程自身生效，说明判例具备真实判别力而非装饰 → 处置：路径输出改可移植表示；本条留档为"角色卡律条实战有效"的首个自证案例。

- [Syncify 真实接入 2026-07-19] 首次生产化部署的三条 dogfood 信号：① init-control 未给总控仓自身写 .gatekeeper.yml，hub 侧命令（provision/doctor/triage/stats）在总控根下不能零参数（需求信号：init-control 应顺手写指向自身注册表的配置）；② CI 注入的真实前置是"gatekeeper 在 runner 上可安装"（npm 发布或烧进 ci 镜像——后者正好归 ci-image-tag 契约管辖，自指闭环）；③ doctor 对 GitLab 生态输出 GitHub workflow 告警（平台感知缺失，GitLab 支持已在 v2 债）→ 处置：三条均记 LEDGER 待办，真实使用继续积累。

- [T-20260719-09] codex review 沙箱只读致 vitest EPERM 假失败 ×3（R1/R2/R3 各一次，R3 险些被当成验收阻断）→ 同类 ≥2 规范修订触发：codex-reviewer 角色文件增「沙箱测试失败一律标注噪音、以调度者本机运行为地面事实」条款 → 处置：已修订 .claude/agents/codex-reviewer.md。
- [T-20260719-08] 运维任务标 ✅ 未写 record，被 R2 治理检查器（R2 规则）在下一个任务的验收中拦下——机器检查器首次抓住调度者自己的流程漏洞（产品自证）→ 运维/无 review 任务同样必须当场写 record → 处置：record 补写；本条留档。
- [T-20260719-09] 修复轮的「预防性补项」有效：编码者自评风险（controls.yaml 未同款原子写）被调度者判为下轮必报 blocker，先行派修避免了可预见的第 4 轮全量往返 → 自评风险不只是给 reviewer 的线索，也是调度者的排程输入。
- [T-20260720-01] 短临界区文件锁不能仅因同样使用 `O_EXCL + PID` 就直接复用于长持有监督器锁：既有 `withFileLock` 的 stale waiter 会按共享路径删除 guard，两个同时读到死 PID 的 waiter 可互删新 owner 并双双进入临界区 → 复用先例前必须重验持有时长、崩溃恢复和 ABA/所有权假设；本次改用不可变 hard-link CAS claim 链，并以双 waiter barrier 测试固定“恰一接管” → 处置：已在 `src/dispatch/lock.ts` 注释语义差异并留存回归。

- [T-20260720-03] 并发原语三轮"修一开二"后收敛的方法论：关键裁定全部来自 reviewer 亲跑可执行模型/探针（击落 rename-CAS 的 3/3 复现、证实标记 CAS 的三 waiter 探针、文案状态机的死活死编排），纯阅读式论证两次给出错误通过信号 → 规范：凡并发/锁/崩溃恢复类交付，review 派工提示必须显式要求"构造可执行探针复现或否证"，不接受纯推演结论 → 处置：本条即规范，下次同类派工引用。

- [T-20260720-09] 文档审查的两种功互补：claude 八项"声明→源码"正向逐字段对照全绿，两条 blocker 却都被 grok 用"实现→声明"逆向反查抓出（退出码表、start 误归类）；且第二条是修复第一条时"顺手概括"新引入——文档修复轮的收窄/概括措辞是缺陷高发源，定向核销范围应包含"本轮新增语句 vs 代码"而不只是"原 blocker 是否修复" → 处置：本条留档，文档类 review 派工提示今后写明双向核对要求。
- [T-20260720-06/-07] 接口消费方是设计兑现度的最好检验：D 包三路 review 全 PASS 后，设计 §2 明文的 resume 边缺失仍未被发现，直到 E 包实现消费时才暴露 → 复杂子系统的分包交付中，"上游包 review 通过"不等于"设计兑现完整"，下游消费包的偏离项报告是必须认真读的设计审计信号 → 处置：本条留档。
- [T-20260721-03] 结论 schema 只校验 `status ↔ verdict` 会留下“必需 lane FAIL/INVALID、聚合却声明 PASS”的伪通过面，即使 lane 结果、状态机和测试各自都看似完整 → 任何 quorum/聚合结论都必须从冻结的 required 成员结果确定性重算，advisory 单独隔离，调用方声明值只能与重算结果相等；持久化加载还须拒绝遗漏 required 成员 → 处置：已在 `roundSchema`、`loadRounds` 与对抗回归中固化。
- [T-20260721-05] 已交付监督器扩展跨子系统互斥时，新 store 的“尚未存在”是正常默认态而非故障；若在既有扫描前插入新读取、或把 ENOENT 当冲突，会无意改变所有旧调用 → 规范：保留旧扫描与报错优先序，新只读扫描后置，missing/empty 显式归一为 `[]`，只有同 realpath + 非终态 + live supervisor 三条件同时成立才新增拒绝；默认命令 transcript 与 missing-store 结果分别做回归锚定 → 处置：已在 workspace/supervisor 测试固化。
- [dispatch 冒烟 2026-07-20] {out} 占位符文件/目录语义歧义：调度者自己写冒烟脚本首跑即误用（当目录），证据门正确拦下但暴露契约文本可误读——已在 DISPATCH.md 加精确性说明；同时验证了"exit 0 + 有 commit 但 RESULT.json 缺位 → EXITED_NO_EVIDENCE"的铁律行为真实生效 → 处置：文档已修，dogfood 首条真实证据留档。

- [dispatch 首个生产交付 2026-07-20] syncify-hub CHANGELOG 重写（真需求）经完整阶梯交付：codex 真实完成改写但其沙箱禁写 .git → 按契约诚实报 blocked → AGENT_BLOCKED 升级 → 监督器 WIP 快照保全成果 → resume 换 claude 收尾 → 真实 commit + RESULT.json 双证据 DELIVERED（authoring_vendors: openai+anthropic，REVIEWER_VENDOR_CONFLICT 正确建议 anthropic 之外的审者……实为 openai 之外）。全链设计逐环兑现。产品发现两条：① codex headless 模板缺沙箱写权限旗标（KNOWN_AGENT_CLIS 需按 dispatch 用途配置，记债）；② claude headless 非流式输出（运行期日志 0 字节）对基于日志增长的 stall 检测是盲区，短任务未触发但长任务有误杀风险（记债：非流式 CLI 的活动信号替代方案或 per-CLI 阈值）→ 处置：两条入 LEDGER 遗留债。

- [T-20260720-01 + T-20260721-05] codex 编码交付预写外审结论/终态 ×2（A 包自标台账 ✅、F 包 record 预写"三路 PASS"含未跑的 grok 路）→ 同类 ≥2 规范修订：**record 的外部审查节与 LEDGER 终态一律由调度者在外审完成后写入；编码 agent 任务包一律显式禁止**（本条起所有 codex/sonnet 任务包模板加此禁令）；grok 外审首次以时序核查抓获此类违规，纳入其常规检查面 → 处置：F 包 record 已更正；规范自本条生效。

## MVP 收官总复盘（2026-07-18）

- **三路对抗 review 的量化战绩**：8 个任务、约 20 轮 review，三路合计报出 30+ 实质缺陷，其中跨路零重叠的独家发现占多数（claude 擅长 fail 方向全路径与语义一致性、codex 擅长权限拓扑/时序绕关/外部事实权威取证、grok 擅长字节级完整性与文件形态）。任何双路组合都会漏掉至少一类。dogfooding 结论：产品的 M-of-N 跨厂商 lane 设计有实证支撑。
- **"编码者自报风险"是高价值信号**：M2 rename、M6 models.json 格式两处自报不确定性最终都被 review 证实为真缺陷——任务包应强制要求自报风险，reviewer 指令应显式要求逐条复核自报项（已实践，固化为惯例）。
- **降级链全环节实战验证**：codex 假僵死 ×2 → grok 顶二路 → 通道恢复补审又抓出 2 条穿透缺陷。"降级期结论必须补审"不是形式主义。


任务终结微复盘的沉淀。同类问题出现 ≥2 次必须发起规范修订（改 CLAUDE.md / agent 定义），并在此标注修订链接。

条目格式：`- [T-ID] 现象 → 教训 → 处置（无/已修订 <文件>）`

- [T-20260718-05] 编码 agent 产出文件混入不可见 NUL 字节（0x00 伪装空格）：typecheck/lint/测试全绿但 git 判整文件二进制，PR diff 对审查隐身——仅被 grok 第三路（其工具拒读二进制）暴露 → 交付验收与 review 都不该只看"测试绿"：新增源文件应过一次文本完整性检查（`file` 输出非文本 / `git diff` 报 Binary 即异常）→ 处置：修复清单已含全仓自查；若再现将把文本完整性检查写入 sonnet-coder/claude-reviewer 角色文件。**根因补充（修复轮定位）**：疑似 Write 工具在内容含 `}${`（模板字面量相邻边界）处插入控制字节的工具层缺陷；规避写法：拼接键值用数组 `.join()` 而非相邻模板插值；含大量模板字面量的新文件写完做一次 `file`/字节自查。
- [T-20260718-02/-04 + T-20260719-04/-07] 守卫不随新入口/新 spawn 点同步 ×2 族：EPIPE 守卫（cli→action 复发）与**进程组终止**（runner.ts 修过后 detect.ts 的 --version 探测复发）→ 规范升格：**凡新增进程入口装 EPIPE 守卫、凡新增 spawn 点（尤其 shell:true 或可能派生后代的）装进程组终止**，两者均为 review 检查单固定项；code-reviewer 角色卡判例 #2 措辞据此覆盖 spawn 点 → 处置：T-07 修复中；角色卡下次修订同步。
- [T-20260718-01/-03] yaml `document.toJS()` 未守卫抛裸异常 ×2（M1 registry.ts、M3 doctor.ts——第二处还把异常误分类成基建警告 fail-open）→ 同类问题达 2 次，触发规范修订：**凡调用 yaml 库 toJS()/toJSON() 一律经守卫包装并按调用语境显式分类（关口命令→degrade；健康命令→配置错误非零）**，review 检查单加此项 → 处置：已写入 claude-reviewer 对抗清单口径（哨兵/异构输入项已覆盖），M3 R2 修复中；后续新 YAML 调用点 review 时按此执行。
- [M0 补遗] 调度者裁阵容时砍掉了 grok-coder/grok-reviewer，被用户指出——跨厂商第三视角是防同源盲区的结构性设计，不是可选项；且降级链（codex 挂 → grok 顶上）依赖它 → 移植参照系阵容时，"裁剪"须逐项给出理由并向用户确认，默认全量移植 → 处置：已补 grok 双角色 + CLAUDE.md 分派表与降级链修订。
- [PR#1 自门禁首航] fresh-clone 类问题第 3 例：pi-extension 子包 devDep 只在其自身 package.json，根 `npm ci` 不装，本机残留 node_modules 掩盖，CI typecheck 即挂——被自门禁 PR 的 ci job 当场抓获（工具开始养活自己）→ 同类 ≥3 次，规范升级：**验收命令必须在等价 fresh 环境语义下可复现**（ls-files 对照、子包依赖显式安装步骤、无本地残留假设），写入 claude-reviewer 检查单候选 → 处置：ci.yml 补 npm ci --prefix pi-extension（随 PR#1 合入）。
- [T-20260718-05] fixture 依赖不可提交路径（嵌套 .git/、被 .gitignore 排除的 node_modules/）——工作树全绿但 fresh clone 必挂；三路 review 全漏（都只看工作树）→ review 与验收都应含"git ls-files 对照测试依赖"的可移植性检查；不可提交形态的 fixture 一律测试运行时构造 → 处置：已派修；若同类再现，写入 claude-reviewer 检查单。
- [T-20260718-04] codex companion 假僵死第 3 型实证（status 卡 running + pid 已亡 + result 报 No job found + 日志仅存空 findings 占位消息）：包装代理按规程正确拒信占位输出、返回 CODEX_UNAVAILABLE，降级链（grok 顶第二路）首次实战成立 → 占位性 assistant message（findings 空、未覆盖 focus 要求）不满足"完整自洽终态"标准，任何轮次都不得采信 → 处置：降级已执行，补审入遗留债；假僵死处置规程在角色文件中已足够，无需修订。
- [T-20260718-01/-02] codex-reviewer 包装代理两次挂后台 Bash 跑 review 后空手返回（后台 Bash 一挂起子代理回合即结束，"等通知"变成无 VERDICT 交付）→ 子代理内不得用 run_in_background 跑必须收割的命令，改前台 --wait timeout 拉满 + 超时后单次 status 前台轮询 → 处置：已修订 .claude/agents/codex-reviewer.md（执行步骤第 2 步）。
- [T-20260718-01/-02] opus 档后台 review 子代理 ×3 异常返回（零工具调用、秒回、输出与任务无关的样板文本；T-01 R1/R2 各一次、T-02 R2 一次）→ 后台子代理产出必须先验真再采信：凡 review 结论不以 VERDICT 开头或工具调用数为 0，一律视为无效返回，SendMessage 续场督促（3/3 实测有效）绝不计入闭环 → 处置：已升级为强制规程——所有 opus 档 review 派工提示必须写明「首个动作必须是 Read 角色文件」（第 3 次起已执行）；续场督促作为标准恢复手段。
