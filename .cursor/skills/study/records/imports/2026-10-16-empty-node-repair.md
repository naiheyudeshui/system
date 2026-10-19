# 2026-10-16 第 1～9 章及全库空节点修复

- 主库：`http://192.168.31.20:8033`
- 范围：主知识树 `node:node_ce4ef92c44b04e5a90a8c1efce`
- 操作前备份：`study-kb/data/backups/study-server-20261016-081921.sqlite`
- 原问题：活动树有 137 个 `item_type=chapter` 节点正文为空；其中 11 个是无子节点空叶子，其余为有子节点但没有导航说明的目录节点。
- 修复：
  - 为 137 个空章节原位补充 Markdown；不改变节点 ID、父子关系、排序、卡片 ID、FSRS 或复习日志。
  - 11 个空叶子补充定义、分类/机制、应用与复习提示；其余目录节点补充本节覆盖范围和学习方法。
  - 没有删除或重新导入整书数据。
- 同步镜像：`study-kb/data/study.sqlite`，归档备份 `study-kb/data/backups/study-server-20261016-082013.sqlite`。
- 验收：`active_items=668`；`PRAGMA integrity_check=ok`；`foreign_key_check` 为空；活动卡片缺 FSRS 为 0；活动空正文节点为 0。
- 后续：对正文过短但已有内容的卡片按教材逐章复核，优先处理定义、分类、过程、公式和对比缺失，不以长度机械扩写。
