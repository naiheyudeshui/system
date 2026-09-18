# Agent Markdown 大纲约定

Study 知识库的主交换格式是 **嵌套 Markdown 标题**。标题深度对应 `study_node` 父子层级；行尾 HTML 注释标记节点角色。

## 角色

| 角色 | 注释 | 含义 |
| --- | --- | --- |
| `outline` | `<!-- outline: chapter -->` | 纯目录，仅标题，可继续展开 |
| `topic` | `<!-- topic -->` | 标题≈问题；紧跟的非标题段落写入 `answer_md` 并自动同步 FSRS 卡片 |

若 `outline` 节点后紧跟正文段落，导入器会自动将其升级为 `topic`。

## 示例

```markdown
# 系统分析师教程第二版 <!-- outline: book -->
## 第1章 信息化基础 <!-- outline: chapter -->
### 1.3 软件工程与架构 <!-- outline: section -->
#### 基于架构的软件开发 ABSD 是什么？ <!-- topic -->
基于架构的软件开发：架构设计、文档、实现、演化。
##### 四个核心活动 <!-- outline -->
- 架构需求
- 架构设计
```

## 导入

```bash
python .cursor/skills/study/scripts/import_outline_md.py \
  --book "系统分析师教程第二版" \
  --markdown path/to/outline.md \
  --source-ref "系统分析师-第二版(OCR).pdf"
```

## 预览

Workbench 插件「章节树图」通过 `/api/study/markmap` 获取仅标题层级的 Markdown，用 markmap 径向渲染；点击节点后在详情面板渲染 `answer_md`。
