# T-20260718-08 M8 最终验收：Syncify 生态真实注册表

**执行者**：调度者本人（真实世界验收属验收职责）。注册表构建依据 Explore 收集的真实仓库事实（4 契约、真实路径、真实 commit）。

## 注册表（4 契约，validate OK）

- `ci-image-tag`：authority pipe/ci-images（.gitlab-ci.yml + images/** + scripts/**，if_content "IMAGE_TAG|syncify-ci"）；消费方 syncify/syncify-hub/slink 的 .gitlab-ci.yml（if_content "syncify-ci:v"）
- `slink-headers`：authority youkale/slink（config.go/httpproxy.go/openapi.yaml，if_content "X-Slink-(Client-ID|Alias)"）；消费方 syncify-hub（proxy.clj/config.clj/config.edn + verify 命令）、syncify（cli http.clj）
- `artifact-manifest`：authority pipe/deploy（schema + validate + check-upstream-contracts）；三上游 .gitlab-ci.yml 为 producer（if_content "artifact-manifest|manifests/"）
- `manuals-sync`：authority pipe/syncify docs/manuals/**；syncify-agent manuals/** 为 **mirror-frozen**（allow_actors: deploy-bot）；deploy 的 syncify-manuals.yml

**现实修正**：Syncify 生态用 GitLab CI 而非 GitHub Actions——本地 `check` 与 CI 平台无关，注册表照常生效（gate/Action 是 GitHub 专属层）。

## 验收矩阵（对真实历史 commit 回放，detached worktree 精确单 commit diff）

| 场景 | 命令要点 | 结果 | 判定 |
|------|----------|------|------|
| slink 0189a71（header 协议变更） | worktree @ commit，--base ~1 | 仅命中 slink-headers；block exit 1；消费方 [syncify-hub, syncify] 正确 | ✅ |
| syncify-agent 人类强推 manuals（--staged --actor sean） | git add -f 后 staged 检查 | forbidden-edit(actor=sean, allow=[deploy-bot])；**block exit 1 凌驾 notify-only** | ✅ |
| 同改动 --actor deploy-bot | 同上 | warn exit 0（白名单放行，仍通知） | ✅ |
| ci-images 1f57670（发布 v0.0.3） | authority 侧回放 | ci-image-tag 命中；3 个消费方全列出 | ✅ |
| syncify 615246ec | 消费侧回放 | **同一 .gitlab-ci.yml 上 if_content 区分出 artifact-manifest（命中）与 ci-image-tag（未命中）**——内容级判定正确分流 | ✅ |
| 反例：.gitlab-ci.yml 追加无关注释行 | --working-tree | **PASS 零命中**（if_content 噪音抑制，week-1 信任保卫核心特性实证） | ✅ |
| 基建故障（错误 ref） | 早期误操作意外覆盖 | GATEKEEPER DEGRADED + exit 0（fail-open 铁律） | ✅ |

**附带发现**：manuals 部署副本在 syncify-agent 已 gitignore + untrack——第一层防线（进不了 diff 就进不了 PR）与 mirror-frozen 第二层防线（强行 add -f 即被拦）分层成立，验证了"diff 是关口"的产品假设。

**验收结论**：核心引擎在真实多仓库生态上判定正确、可解释、噪音受控。产品可用。
