# Study Knowledge Base

system 仓库专用学习/背诵知识库：**章节树 + 间隔复习（FSRS）+ 径向思维导图 + Markdown 渲染**。

## 快速开始

### 1. 前置条件

- Python 3.10+
- `3dStudio/` 软链接指向 Rsim_helper（workbench UI 宿主）
- 本地数据库：`study-kb/data/study.sqlite`（首次运行自动迁移，不入 git）

### 2. 启动网页

```powershell
python study-kb/tools/serve_workbench.py --port 8033
# 或双击 study-kb/打开学习库.bat
```

浏览器打开 **http://127.0.0.1:8033**

> 修改代码或 API 后需重启 workbench；浏览器 Ctrl+F5 强制刷新。

### 3. 命令行复习

```powershell
cd study-kb/tools
python study_review.py due
python study_review.py grade <card_id> 3
```

打分：1=重来 · 2=困难 · 3=良好 · 4=简单

---

## 界面使用

### 四区布局

| 区域 | 用途 |
| --- | --- |
| 左侧 | 切换**外观视图**（如到期卡、章节卡、章节树） |
| 中间 | 表格数据浏览 |
| 右上 | 指标卡片 |
| 右下「插件」 | **章节树图**、**表格复习** |

### 推荐视图

- `v_study_due_cards` — 今日到期卡片
- `v_study_node_cards` — 按章节浏览全部卡
- `v_study_scope_tree` — 章节树 + 到期计数

### 插件：章节树图

- **径向思维导图**（markmap）展示章节标题层级
- 点击节点旁 **「+」** 展开子分支
- 右侧详情面板渲染 Markdown 答案
- **topic 节点**若无子节点但有复习卡，会自动把每张卡的问题显示为子叶；点击卡片查看该卡答案
- 可切换「学习视角」（scope）与「大纲」侧栏

### 插件：表格复习

- 按**当前左侧视图**顺序，取 `due_at` 最早的一张到期卡
- 显示**卡片问题**（front）→ 点击「显示答案」→ 显示**该卡 back**（支持 Markdown）
- 打分 1–4 后 FSRS 更新，自动跳下一张
- 每张卡的答案独立，不会混用节点级 `answer_md`

---

## 数据模型

| 表 / 字段 | 含义 |
| --- | --- |
| `study_node` | 书 / 章 / 节 / 知识点树 |
| `study_node.role` | `outline`（纯目录）或 `topic`（标题≈问题） |
| `study_node.answer_md` | topic 节点的 Markdown 答案（与首张同步卡 1:1） |
| `study_scope` | 学习根视角（一本书或某一章） |
| `study_card` | 单条复习卡（front / back / hint） |
| `study_card_fsrs` | FSRS 调度（due_at、stability 等） |

**两种内容组织方式：**

1. **树节点**：嵌套目录 / 知识点（markmap 可展开）
2. **复习卡**：挂在节点下的 flashcard（表格复习、FSRS）

同一节点可有多张卡；此时 markmap 在 topic 节点下展示卡列表，表格复习按每张卡的 `back` 显示答案。

---

## 目录结构

```
study-kb/
├── schema/           # SQL 表、视图、迁移
├── tools/            # db.py, study_kb.py, study_api.py, serve_workbench.py
├── web/              # workbench 前端（app.js, studyPlugins.mjs）
├── plugins/          # 章节树图、表格复习插件
├── tests/
├── docs/
│   └── AGENT.md      # Agent 辅助生成知识库指南
└── data/
    └── study.sqlite  # 本地数据（gitignore）
```

---

## HTTP API（workbench 8033）

| 路径 | 说明 |
| --- | --- |
| `GET /api/study/tree?scope=` | 章节树 JSON |
| `GET /api/study/markmap?scope=` | markmap 用 Markdown |
| `GET /api/study/node/:id` | 节点详情 |
| `GET /api/study/card/:id` | 单卡详情 |
| `GET /api/study/review/next?view=` | 下一张到期卡 |
| `POST /api/study/review/grade` | FSRS 打分 |

---

## 其他命令

```powershell
# 单元测试
python -m unittest discover -s study-kb/tests -v

# 从旧 ops.sqlite 迁移
python study-kb/tools/migrate_from_studio.py

# Datasette 纯 SQL 浏览（8022）
python study-kb/tools/serve_ui.py
```

---

## Agent 辅助

在 Cursor 中可用 **study 技能**（`.cursor/skills/study/SKILL.md`）让 Agent 从教材/OCR/笔记生成章节树与复习卡。

详细流程见 **[docs/AGENT.md](docs/AGENT.md)**。
