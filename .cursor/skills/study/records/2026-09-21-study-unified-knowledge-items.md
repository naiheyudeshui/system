# 统一知识图节点与卡片关系迁移

- ID: `plan.study-unified-knowledge-items-20260921`
- 来源: 用户确认“章节、知识点、卡片都是同类节点”并要求按 Rsim_helper skills 执行
- 仓库: `D:/system`
- 创建日期: `2026-09-21`
- 负责: `agent`
- 状态: `in-progress`

## 目标与边界

- 目标状态：知识图使用统一节点关系表；章节、主题、卡片均拥有正式父节点和排序；旧卡片 ID、FSRS、评分日志、旧 API 和 SQL 方案继续可用。
- 约束：旧表只保留为迁移历史快照，不参与最终运行时读写；不重置复习进度；不把真实库用于实验；不保留旧投影格式兼容分支。
- 成功指标：统一节点迁移可重复；新旧节点数量与卡片数量一致；卡片可混合父子与同级排序；循环、孤儿、重复排序被拒绝；全量 Python/JS 回归通过。

## 背景与证据

- 当前 `v_study_knowledge_nodes` 是 `study_node` 与 `study_card` 的只读联合视图，卡片没有自己的 `parent_id/sort_order`。
- `study_node_parent_card` 只能表达“主题挂在卡片下”，因此卡片排序时报“卡片投影暂不支持同级排序”。
- 复习状态独立存于 `study_card_fsrs`，历史存于 `study_review_log`，可与图关系解耦。

## 决策

- 新增 `study_knowledge_item` 作为统一节点和内容表；`item_type` 区分 chapter/topic/card，`study_knowledge_schedule` 与 `study_knowledge_review_log` 作为新的复习事实表。旧表仅归档。
- 迁移采用备份、只读审计、事务导入、兼容视图、统一写入适配器的顺序；不直接删除旧表或旧 API。
- 卡片内容和复习调度仍分别写 `study_card` 与 `study_card_fsrs`；图移动/排序只写统一关系表并同步旧章节关系所需字段。

## 工作项

| ID | Action | Depends on | Artifacts | Acceptance | Rollback | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | 读取正式库并生成节点/卡片/关系/排序基线 | - | 审计 JSON、SQLite 备份 | 只读统计、完整性检查、备份可打开 | 删除审计产物，不触碰正式库 | in-progress |
| T2 | 增加统一节点表、索引和幂等迁移 | T1 | `schema/knowledge_items.sql`, `tools/knowledge_items.py` | 临时副本迁移两次结果一致，数量/ID/FSRS 哈希不变 | 删除新表或恢复备份，不删除旧表 | pending |
| T3 | 建立新结构读取视图和统一树写入适配器 | T2 | 视图、`study_knowledge_edit.py`、测试 | 卡片/章节混合排序、移动、防环、删除策略通过；不读旧表 | 恢复备份并撤回新结构版本 | pending |
| T4 | 更新 skill、README 与审计索引 | T2 | `SKILL.md`、`docs/AGENT.md`、中央副本 | 明确统一节点合同与迁移验收 | 恢复文档上一版本 | pending |
| T5 | 回归、服务探针和闭环记录 | T3,T4 | 测试报告、计划历史 | Python/JS 回归及真实只读 HTTP 验收通过 | 停止服务写入，保留备份 | pending |

## Closure Gates

- `PRAGMA integrity_check` 为 ok，`PRAGMA foreign_key_check` 无新增错误。
- active 卡、FSRS、review log、review session 数量与迁移前基线一致。
- 统一视图不重复展示节点；每个 active 卡恰有一个统一节点。
- 旧复习预览/评分接口和新树移动接口均通过测试。

## 风险与阻塞

- 既有用户自定义树 SQL 不能自动获得写权限；仅默认知识树方案切换到统一 provider。
- 若审计发现一个节点存在多个卡片父级，先保留异常并阻止自动迁移，不猜测业务含义。

## 历史

- (Agent 2026-09-21) 创建计划；决定采用统一关系表和新复习事实表，旧实体表只归档。
- (Agent 2026-09-21) T1 completed；正式库备份为 `study-before-unified-items-20260921.sqlite`，基线为 17 节点、14 active 卡、15 调度行、19 日志、4 会话；发现旧表 1 条历史外键异常，未由迁移产生。
- (Agent 2026-09-21) T2/T3 in-progress；已建立 `study_knowledge_item`、`study_knowledge_schedule`、`study_knowledge_review_log`、`study_knowledge_scope`，迁移副本验收为 31 节点、14 active 卡、14 调度、19 日志、1 scope；新视图与服务已重启。
