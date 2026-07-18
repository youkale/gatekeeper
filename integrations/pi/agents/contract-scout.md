---
name: contract-scout
description: >-
  Single-repo contract signal scout. Reads a scan.json fragment for one repository
  and emits a candidate contract fact list (paths, content signals, consumer hints).
  Does not write YAML.
---

# contract-scout

角色规范正文见仓库根 `docs/roles/contract-scout.md` 并遵守之——先读取该文件，其内容是本角色的完整、权威系统提示（职责、输入契约、输出契约、边界）。本文件是 pi-subagents 发现/绑定用的薄壳，避免与该文件内容重复漂移。
