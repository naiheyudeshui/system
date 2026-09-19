# Study Knowledge Base

> **当前完整使用入口（2026-09-19）**：[给人：system README](../README.md#知识交互完整使用指南) · [给 Agent：资料归纳与增量入库手册](../.cursor/skills/study/SKILL.md) · [study skill](../.cursor/skills/study/SKILL.md)。下文保留早期界面说明；插件位置、SQL 方案和单卡导入边界以以上手册及 [升级说明](docs/WORKBENCH-UPGRADE.md) 为准。

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

- 从顶栏打开 **表格复习**，插件替换中间表格区；切回“表格”不会丢失复习进度。
- 选择已保存方案（默认“章节卡片”“今日到期”），选择章节范围，然后 **预览 / 开始新一轮**。
- **管理方案**在插件内部打开，可新建、编辑、复制、删除 SQL 方案；点击“返回”回到原进度。
- SQL 返回 `card_id / question / answer`，用 `WHERE / ORDER BY` 定义集合与顺序，节点参数绑定而非拼接。
- 默认方案也可编辑和删除；只有显式“恢复默认模板”才恢复，不会自动复活。
- 方案存储在数据库，跨浏览器共享，通过方案设置新增或编辑。
- **预览**不修改调度；**开始新一轮**固定记录、内容和顺序，每条复习一次。左侧视图切换不会打断本轮。
- 显示答案后评分 1–4；默认更新完整 FSRS 状态与日志，各模块共享下次复习时间。不重置既有学习历史。
- 自定义数据可选择“评分间隔”，配置目标表、唯一键、时间列及四档间隔；仅更新已评分记录的时间。
- 刷新后恢复当前浏览器最近集合。重复提交同一评分不会重复更新。

**复习整章：**选择“章节卡片” → 搜索并选择章节 → 预览 → 开始。

### 顶栏与下栏插件

顶栏 **插件管理** 有“顶栏启用 / 下栏启用 / 未启用”三个区域。区内拖拽排序，跨区拖拽移动或启停；同一个插件只在一个位置。
官方插件也可禁用。插件图标来自 manifest，可省略；二维码和打印保持自身业务，不强制使用 SQL 方案。
全局搜索栏已移除，表格筛选与节点搜索保留。升级说明见 [WORKBENCH-UPGRADE.md](docs/WORKBENCH-UPGRADE.md)。

注意：`v_study_due_cards` 本身只包含到期行，即使选择“全部”也不能读取它隐藏的未到期卡。
详细配置、集合边界与 API 见 [通用复习说明](docs/REVIEW.md)。

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
| `GET /api/study/review/catalog` | 可选视图、字段、节点与自定义回写目标 |
| `POST /api/study/review/preview` | 预览配置匹配数量与样例 |
| `POST /api/study/review/session` | 创建固定集合 |
| `GET /api/study/review/session/:id` | 恢复集合及进度 |
| `POST /api/study/review/session-grade` | 幂等评分并返回下一条 |

---

## 其他命令

```powershell
# 单元测试
python -m unittest discover -s study-kb/tests -v

# 界面交互测试（Node.js 18+，首次运行先安装测试依赖）
npm --prefix study-kb/tests ci
npm --prefix study-kb/tests test

# 从旧 ops.sqlite 迁移
python study-kb/tools/migrate_from_studio.py

# Datasette 纯 SQL 浏览（8022）
python study-kb/tools/serve_ui.py
```

---

## Agent 辅助

在 Cursor 中可用 **study 技能**（`.cursor/skills/study/SKILL.md`）让 Agent 从教材/OCR/笔记生成章节树与复习卡。

详细流程见 **[docs/AGENT.md](../.cursor/skills/study/SKILL.md)**。

### 2026-09-19 插件界面修正

插件管理仅在下栏进入；三区通过拖拽启停、定位和排序。顶栏使用扁平图标标签，打印/触发器自适应面板宽度。SQL 指标保留固定区域及原设置，不纳入插件。详见 `docs/WORKBENCH-UPGRADE.md`（docs 内为同级文件）。
