---
name: study
description: 学习知识库与间隔复习：从书本/OCR/笔记汇集章节树与背诵卡片，写入 system 仓库 study-kb SQLite，用 FSRS 调度复习；用户要求整理背诵卡片、拆分知识点、查看今日到期、开始复习或设定章节学习根视角时使用。
metadata:
  scope: system
  tags: study, flashcard, fsrs, spaced-repetition, knowledge-base
---

# Study Knowledge Base

学习数据存放在 **本仓库 `study-kb/`** 的 SQLite 中。3dStudio / 3dworkbench 仅作为可选 UI 宿主复用，业务 schema 归 system 仓库所有。

## 前置

1. 数据库默认路径：`study-kb/data/study.sqlite`
2. 表结构由 `study-kb/tools/db.py` 迁移
3. 参考文档：
   - [`references/external-skills.md`](references/external-skills.md)
   - [`references/fsrs-protocol.md`](references/fsrs-protocol.md)
   - [`references/workbench-api.md`](references/workbench-api.md)
   - [`references/mindmap-markdown.md`](references/mindmap-markdown.md)

## 标准工作流

### 1. 定 scope（学习根视角）

- 一本书或某一章/节都可以作为 `study_scope.anchor_node_id`
- 同一棵树可有多个 scope；切换 scope 只改变可见子树，不移动节点

### 2. 建树（章节层级）

**推荐：Agent Markdown 大纲**（见 [`references/mindmap-markdown.md`](references/mindmap-markdown.md)）

```bash
python .cursor/skills/study/scripts/import_outline_md.py \
  --book "系统分析师教程第二版" \
  --markdown path/to/outline.md \
  --source-ref "系统分析师-第二版(OCR).pdf"
```

或 JSON 大纲（支持 `role` / `answer_md` / 嵌套 `children`）：

```bash
python .cursor/skills/study/scripts/import_outline.py \
  --book "系统分析师教程第二版" \
  --outline .cursor/skills/study/records/imports/sample-outline.json \
  --source-ref "系统分析师-第二版(OCR).pdf"
```

Agent 必须先展示提议的树结构，用户确认后再写入。

#### 双角色节点

| `role` | 含义 | FSRS |
| --- | --- | --- |
| `outline` | 纯目录，仅标题 | 无卡片 |
| `topic` | 标题≈问题，`answer_md` 为 Markdown 答案 | 自动 1:1 同步 `study_card` |

Workbench「章节树图」用 markmap 径向展示标题；点击节点渲染 `answer_md`。

### 3. 卡片化

```bash
python .cursor/skills/study/scripts/cardize.py \
  --node <node_id> \
  --input .cursor/skills/study/records/imports/sample-cards-ch1.json
```

### 4. 复习循环

```bash
python study-kb/tools/study_review.py due
python study-kb/tools/study_review.py grade <card_id> 3
```

或通过包装脚本：

```bash
python .cursor/skills/study/scripts/review_session.py due
python .cursor/skills/study/scripts/review_session.py grade <card_id> 3
```

### 5. 审计记录

每次导入完成后更新 `records/imports/` 与 `records/index.json`。

## 数据模型速查

| 表 | 用途 |
| --- | --- |
| `study_node` | 书 / 章 / 节 / 主题树；`role`=`outline|topic`，`answer_md` |
| `study_scope` | 可切换的学习根视角 |
| `study_card` | 单条背诵卡片 |
| `study_card_fsrs` | FSRS 调度状态 |
| `study_review_log` | 复习历史 |

## 与 3dStudio 的关系

- `3dStudio/` 软链接保留，用于打开 workbench UI 或 record-contract 集成
- 学习数据不再写入 `ops.sqlite`；需要时在 workbench 中打开 `study-kb/data/study.sqlite`

## 约束

- Agent 生成卡片须「提议 → 用户确认 → 写入」
- `archived` 卡片不参与 due 查询
