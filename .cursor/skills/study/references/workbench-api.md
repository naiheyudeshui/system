# Study KB 接口与源码地图

> 2026-09-19 核对。以实际源码为准；完整入库流程见 [Agent 手册](../SKILL.md)。

## 正确宿主

从 system 根运行 `python study-kb/tools/serve_workbench.py --port 8033`。包装宿主复用 3dStudio，但业务数据在 `study-kb/data/study.sqlite`。不要直接开普通 Studio 后假定它已切换到学习库，也不要往 ops.sqlite 插学习卡。

内容写入走 `study-kb/tools/study_kb.py` helper 或 skill 导入脚本；下面的读树接口不等于知识编辑 API。没有已承诺的通用 `POST /api/study/node`。

## 数据关系

- study_node.parent_id → study_node.id：树；scope.anchor_node_id：观看起点。
- study_card.node_id → study_node.id：多卡可归属同一节点。
- study_card_fsrs.card_id → study_card.id：每卡调度；study_review_log：评分历史。
- v_study_mindmap_nodes、v_study_scope_tree：节点/子树投影。
- v_study_node_cards、v_study_due_cards：active 卡，以及其中到期卡。

## 学习 HTTP 接口

| 方法与路径 | 实际用途 |
| --- | --- |
| GET /api/study/tree?scope= | 默认章节树、scopes、节点与卡片数据 |
| GET /api/study/tree?config_id= | 保存的 SQL 树配置查询结果 |
| GET /api/study/markmap?scope= | 默认树的标题层级 Markdown 投影 |
| GET /api/study/node/:id | 节点详情和子节点 |
| GET /api/study/card/:id | 独立卡片详情，答案优先该卡 back |
| GET /api/study/review/catalog | 可用视图、节点等复习配置素材 |
| POST /api/study/review/sql-preview | 用保存 SQL 方案与参数预览，不评分 |
| POST /api/study/review/sql-session | 固定本轮题目、参数和方案版本 |
| GET /api/study/review/session/:id | 读取已保存会话状态 |
| POST /api/study/review/session-grade | 本轮逐项评分；字段和幂等语义见 REVIEW.md |
| GET /api/study/review/next?view=&scope= | 旧兼容逐卡接口 |
| POST /api/study/review/grade | 旧兼容 FSRS 评分接口 |
| POST /api/study/review/preview、/session | 旧字段映射配置兼容入口 |

保存方案的预览/开始请求示例：

```json
{"config_id":"study.review.chapters.v1","parameters":{"node_id":null}}
```

其中 node_id 取确认的真实节点 ID；null 表示不限定章节。只在正式评分时写学习历史，不能为文档验收向正式库发 grade 请求。

## 共享方案和插件接口

| 方法与路径 | 用途 |
| --- | --- |
| GET /api/plugins | 当前插件元数据 |
| GET、POST /api/plugin/layout | revision + top/bottom/disabled 完整布局 |
| GET /api/plugin/configs?plugin_id=study.review-table&module_id=reviews | 已有复习方案与模块定义 |
| GET /api/plugin/configs?plugin_id=study.node-tree&module_id=trees | 树查询方案 |
| POST /api/plugin/config/preview、/save、/delete、/restore、/apply | 可选 SQL 模块能力；apply 不是所有业务模块都支持 |

SQL 复习输出须含 card_id/question/answer，card_id 用于关联真实调度；树输出须含 node_id/parent_id/title。知识创建和 SQL 查询配置是两件事。SQL 指标保留固定区域和原接口，不是 official.metrics 插件。

细节与示例：[WORKBENCH-UPGRADE.md](../../../../study-kb/docs/WORKBENCH-UPGRADE.md)、[REVIEW.md](../../../../study-kb/docs/REVIEW.md)。

## 维护时从哪里查

- 路由：study-kb/tools/study_workbench_patch.py；共享插件路由：3dStudio/tools/workbench_server.py。
- 树/卡详情：study-kb/tools/study_api.py。
- 资料导入/同步/调度：study-kb/tools/study_kb.py。
- 默认 SQL 与查询会话：study-kb/tools/study_sql_configs.py。
- 实际交互：study-kb/web/studyPlugins.mjs、studySqlReview.mjs、studyMarkdown.mjs。

脚本支持项需读 argparse 或 `--help`，不要从文档标题推断参数。文档给出已有能力，不把前端浏览页当成通用可写 REST 服务。

2026-09-19 树方案补充：GET /api/study/tree?config_id= 返回 validation、rows、columns、detail_fields 和规范 roots；设置可通过 tree.id/parent/title/details 映射原 SQL 列。保存与预览执行完整树校验，缺父默认报错，tree.orphans=root 可显式提升并警告。浏览根、表格筛选和节点详情子页面均不修改源表。
