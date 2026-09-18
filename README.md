# system

系统分析师学习与备考资料仓库。

## 学习知识库（study-kb）

本仓库专用间隔重复 / 背诵系统，数据在 `study-kb/data/study.sqlite`（本地，不入 git）。

### 启动

```powershell
python study-kb/tools/serve_workbench.py --port 8033
# 浏览器 http://127.0.0.1:8033
```

### 命令行复习

```powershell
python study-kb/tools/study_review.py due
python study-kb/tools/study_review.py grade <card_id> 3
```

### 文档

| 文档 | 说明 |
| --- | --- |
| [study-kb/README.md](study-kb/README.md) | 用户使用指南（界面、插件、API） |
| [study-kb/docs/AGENT.md](study-kb/docs/AGENT.md) | Agent 辅助生成知识库流程 |
| [.cursor/skills/study/SKILL.md](.cursor/skills/study/SKILL.md) | Cursor Agent 技能定义 |

### 目录

| 路径 | 说明 |
| --- | --- |
| `study-kb/schema/` | SQL 表与视图 |
| `study-kb/tools/` | Python 工具与 FSRS |
| `study-kb/web/` | Workbench 前端 |
| `study-kb/plugins/` | 章节树图、表格复习插件 |
| `study-kb/tests/` | 单元测试 |
| `.cursor/skills/study/` | Agent 导入脚本与格式约定 |

### 3dStudio 软链接

`3dStudio/` 指向 Rsim_helper，仅用于复用 workbench UI；学习数据不再写入 `ops.sqlite`。
