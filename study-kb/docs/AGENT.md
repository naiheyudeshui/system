# Agent 辅助生成学习知识库

本文说明如何让 Cursor Agent（study 技能）帮用户从教材、OCR、笔记构建 **study-kb** 知识库。

## 技能入口

- 技能文件：`.cursor/skills/study/SKILL.md`
- Markdown 格式约定：`.cursor/skills/study/references/mindmap-markdown.md`
- Workbench API：`.cursor/skills/study/references/workbench-api.md`

在 Cursor 对话中可直接说：

> 把第 1 章整理成 study-kb 大纲和复习卡  
> 导入系统分析师教程第 1.3 节的知识点  
> 查看今日到期卡片

---

## 标准工作流（Agent 必须遵守）

```
用户材料 → Agent 提议结构 → 用户确认 → 写入 SQLite → 用户在 workbench 复习
```

**禁止**未经确认直接批量写入数据库。

---

## 第一步：定 scope（学习视角）

一本书或某一章/节可作为 `study_scope.anchor_node_id`。同一棵树可有多个 scope，切换 scope 只改变可见子树。

Agent 应询问用户：整本书还是某一章作为当前学习根。

---

## 第二步：建树（推荐 Markdown 大纲）

Agent 主交换格式是 **嵌套 Markdown 标题**。`#` 深度 = 树深度；行尾注释标记角色。

```markdown
# 系统分析师教程第二版 <!-- outline: book -->
## 第1章 信息化基础 <!-- outline: chapter -->
### 1.3 软件工程与架构 <!-- outline: section -->
#### B/S 架构的三个主要缺点？ <!-- topic -->
动态页面支持有限；安全性难控制；查询响应速度通常慢于 C/S。
##### 与 C/S 的对比 <!-- outline -->
```

### 角色说明

| 角色 | 注释 | 行为 |
| --- | --- | --- |
| `outline` | `<!-- outline: chapter -->` | 纯目录，可继续展开 |
| `topic` | `<!-- topic -->` | 标题=问题；紧跟段落= `answer_md`；自动同步 1 张 FSRS 卡 |

若 `outline` 节点后紧跟正文，导入器会自动升级为 `topic`。

### 导入命令

```powershell
python .cursor/skills/study/scripts/import_outline_md.py `
  --book "系统分析师教程第二版" `
  --markdown path/to/outline.md `
  --source-ref "系统分析师-第二版(OCR).pdf"
```

JSON 大纲（支持 `role` / `answer_md` / `children`）：

```powershell
python .cursor/skills/study/scripts/import_outline.py `
  --book "系统分析师教程第二版" `
  --outline .cursor/skills/study/records/imports/sample-outline.json `
  --source-ref "系统分析师-第二版(OCR).pdf"
```

---

## 第三步：卡片化

### 方式 A：Markdown 内嵌 topic（推荐）

每个 `topic` 节点自动生成 1 张 FSRS 卡，无需单独 cardize。

### 方式 B：批量 JSON 卡片

适合一节下有多张独立 flashcard：

```powershell
python .cursor/skills/study/scripts/cardize.py `
  --node <node_id> `
  --input .cursor/skills/study/records/imports/sample-cards-ch1.json
```

- **单卡 JSON**：自动把节点设为 `topic`，`answer_md` = 该卡 back
- **多卡 JSON**：在节点下创建多张 `study_card`（markmap 会在 topic 节点下展示各卡问题）

### 方式 C：深层目录（而非多卡）

若希望 markmap 显示**目录层级**而非卡列表，应用 Markdown 嵌套 topic/outline，而不是把知识点都 cardize 到同一节点。

---

## 第四步：用户复习

### 网页

```powershell
python study-kb/tools/serve_workbench.py --port 8033
```

- **章节树图**：浏览结构、点击节点/卡片看 Markdown 答案
- **表格复习**：FSRS 到期队列，逐张打分

### 命令行

```powershell
python study-kb/tools/study_review.py due
python study-kb/tools/study_review.py grade <card_id> 3
```

或：

```powershell
python .cursor/skills/study/scripts/review_session.py due
```

---

## Agent 输出模板（提议阶段）

Agent 在写入前应向用户展示类似结构：

```markdown
## 提议：第1章 1.3 节

### 目录树（将写入 study_node）
- 1.3 软件工程与架构 [outline]
  - B/S 架构缺点 [topic]
  - ABSD 四活动 [topic]
  ...

### 复习卡（将写入 study_card 或 topic.answer_md）
| 问题 | 答案摘要 |
| --- | --- |
| B/S 三个主要缺点？ | 动态页、安全、速度 |
| ... | ... |

确认后我将执行 import_outline_md.py / cardize.py。
```

---

## 审计记录

每次导入后更新：

- `.cursor/skills/study/records/imports/` — 导入审计 JSON
- `.cursor/skills/study/records/index.json` — 索引

---

## 常见问题（Agent 须知）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| markmap 加载失败 JSON 错误 | workbench 未重启，旧进程无新 API | 重启 `serve_workbench.py` |
| 1.3 无法展开子目录 | 子内容是**复习卡**而非**子节点** | 用嵌套 Markdown 建树，或接受卡列表展开 |
| 表格复习答案相同 | 应用了节点 `answer_md` 而非卡 `back` | 已修复：优先 `back` |
| topic 节点多张卡 | cardize 多卡到同一节点 | 正常；markmap 显示卡子叶，复习按卡 back |

---

## 示例对话

**用户**：帮我把系统分析师教程第 1 章第 3 节做成知识库。

**Agent**：

1. 阅读 OCR/PDF 或现有笔记
2. 生成 Markdown 大纲（outline + topic 混合）
3. 展示提议树与卡片表，等待确认
4. 运行 `import_outline_md.py`
5. 若需额外 flashcard，运行 `cardize.py`
6. 提示用户打开 http://127.0.0.1:8033 复习
