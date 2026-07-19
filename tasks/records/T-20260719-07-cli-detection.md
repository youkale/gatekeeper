# T-20260719-07 CLI 探测与角色自动选配

- **需求**：init-control 时探测本机 coding CLI（claude/codex/grok/kimi/pi）并按 roles-policy 规则自动选配角色。
- **交付**：src/agent/{detect,assign,agentsFile,resolve}.ts——PATH 探测（仅绝对段，安全裁决偏离 POSIX）+ 短超时 version 探测（进程组清理）+ 严格厂商序选配（reviewer 跨厂商、prefer 外不兜底）+ governance/agents.yaml（模板类，--force 重探测）+ 三级解析链（flag/env > .gatekeeper.yml > agents.yaml）+ doctor 健康检查。本机冒烟：探出 4 CLI 并正确选配。
- **三轮闭环要点**：R1 codex 抓进程组课题在新 spawn 点复发（守卫同步规范升格为两族）、选配误读包内 roles-policy、X_OK 目录误判；claude 抓超时上限在新层被丢、tier-3 静默吞损坏配置（其"fall-through 终点本就是 exit 2"的裁定修正了 codex 的方向定性）。R2 codex 对自己 R1 的空段 cwd 处方反转——仲裁安全优先（不可信 checkout 内 cwd 解析=仓内伪装 CLI 可被执行），只认绝对段；另抓 --no-detect 分支绕过与裸 binary spawn 残余面。R3 三项全确认；新条（vitest 线程池 chdir）经包装层独立复核为沙箱强制 --pool threads 的误判（Vitest 2 默认 forks，npm test 511/511 实测），仲裁驳回，chdir-free 硬化记低优债。
- **验收**：typecheck / 511 测试 / biome / build / check:governance 全绿。终态：验收提交。
