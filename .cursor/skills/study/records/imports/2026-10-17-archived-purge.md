# 归档知识节点物理清理

- 批次：archived-purge-20261017；主库：http://192.168.31.20:8033。
- 授权范围：用户要求将“敏捷方法与 RUP”旧卡直接删除，其他与当前树图无关的归档内容也可删除。
- 写入前 probe：reachable/readable/writable 均为 true，errors 为空；先从手机导出一致性快照，盘点 52 个 archived 节点（45 card、6 chapter、1 topic）。它们均无活动子节点或 scope 锚点。
- 清理：物理删除全部 52 个归档节点，包含 `card:card_dc81bf3f5613423f802c09498e`；删除其中 6 张卡的 7 条正式复习日志；归档卡的调度随外键级联删除。历史会话快照及编辑审计未清除。
- 执行：`study-kb/tools/purge_archived_http.py --apply` 对主库导出副本校验并清理，上传前再次核对主库字节一致，然后通过 `library/import` 替换手机主库。该接口自动保留手机备份 `study-20261017-214312.sqlite`。
- 本地删除前备份：`study-kb/data/backups/study-before-archived-purge-20261017-214310.sqlite`。同步后镜像：`study-kb/data/study.sqlite`；同步导出：`study-kb/data/backups/study-server-20261017-214319.sqlite`。
- 验收：主库镜像 archived=0、目标旧卡不存在、活动节点仍为 702；活动节点、其调度与评分日志的逐行摘要和删除前完全一致。doctor：完整性 ok、外键错误 0、活动卡缺调度 0、重复兄弟标题 0。未做浏览器视觉验收。
