# Study KB 与 3dworkbench 集成

## 数据宿主（本仓库）

- 数据库：`study-kb/data/study.sqlite`
- Python API：`study-kb/tools/study_kb.py`

## 可选 UI（复用 3dStudio）

- 软链接：`3dStudio/` → Rsim_helper 的 3dStudio
- 在 workbench 中打开 `study-kb/data/study.sqlite` 浏览 `v_study_*` 视图
- 若需 HTTP record-contract，可临时将 study DB 设为 workbench 数据源（只读浏览）

## 业务表

- `study_node`, `study_scope`, `study_card`, `study_card_fsrs`, `study_review_log`

## 视图

- `v_study_scope_tree`（含 `role`, `answer_md`, `child_count`）
- `v_study_mindmap_nodes`
- `v_study_due_cards`, `v_study_node_cards`, `v_study_review_stats`

## Study 插件 HTTP API（8033 workbench）

| 路径 | 说明 |
| --- | --- |
| `GET /api/study/tree?scope=` | 章节树 JSON（含 `role` / `answer_md`） |
| `GET /api/study/markmap?scope=` | markmap 用 Markdown 标题串 |
| `GET /api/study/node/:id` | 单节点详情 + 子节点列表 |
| `GET /api/study/review/next?view=&scope=` | 下一张到期卡（含 `answer_md`） |
| `POST /api/study/review/grade` | FSRS 打分 |

启动：`python study-kb/tools/serve_workbench.py --port 8033`
