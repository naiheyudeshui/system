# Agent Markdown 大纲约定

> 实际行为核对：2026-09-19。完整流程见 [Agent 手册](../SKILL.md)，用户操作见 [system README](../../../../README.md#知识交互完整使用指南)。

## 先区分结构与正文

大纲格式用于**新建章节树**：嵌套标题决定 study_node 父子关系；标题后的正文存 answer_md。它不是完整 Markdown 文档的无损导入，也不支持按标题更新已有树。

| 角色 | 写法 | 行为 |
| --- | --- | --- |
| 纯目录 | `## 某章 <!-- outline: chapter -->` | 仅标题，不放正文，不主动建卡 |
| 原子知识点 | `#### 一个可独立回答的问题？ <!-- topic -->` | 标题为节点问题，正文为答案，经 helper 自动建立一张卡与调度 |

outline 下有非空正文会自动升级 topic。不要在“纯目录”下面放解释段落，否则也会变成知识卡。

## 安全示例

以下仅为教学示例，不是教材事实：

```markdown
# 学习系统演示 <!-- outline: book -->
## 知识组织 <!-- outline: chapter -->
### 目录与提醒 <!-- outline: section -->
#### 目录和提醒各解决什么问题？ <!-- topic -->
**结论**：目录解决位置问题，提醒解决时间问题。
- 在目录中找到所属章节。
- 在复习里按安排进行问答。
**来源**：自编操作示例。
```

格式限制：

1. 只解析 `#` 到 `######` 标题，深度不要随意跳级。
2. 内部小标题也可能创建新节点；正文优先用 `**小结**` 而非 `### 小结`。
3. 代码围栏没有独立解析状态；代码里的 `# ` 也可能误建节点。
4. 空行丢弃，复杂段落排版不保证无损。需要完整 Markdown 用 JSON answer_md 或 helper 存正文。
5. 普通列表属于当前节点答案，不会自动变子节点。要可展开的子知识点，就写新的结构标题。
6. 注释支持 outline/topic 和 kind 提示，不是通用 metadata 协议。逐节点来源请显式存 source_ref。

## 导入及边界

先创建并审核示例路径对应的 UTF-8 文件，再运行；从 system 根执行：

```powershell
python .cursor/skills/study/scripts/import_outline_md.py `
  --markdown path/to/confirmed-outline.md `
  --source-ref "材料文件、版本、章节范围" `
  --db study-kb/data/study.sqlite `
  --record .cursor/skills/study/records/imports/unique-batch-result.json
```

- CLI 无 dry-run、父节点追加和 update 参数；先解析或导入临时数据库验证。
- 每次执行都新建根与 scope；重复执行会重复入库。既有树维护必须使用已确认 ID 的增量流程。
- Markdown 根上的 source_ref 不自动复制到所有后代/卡；JSON 节点可带独立 source_ref，自动卡的来源也应检查并补齐。
- scope 不复制树；Markdown 导入新增 scope 默认 is_default=False。

## 图上看什么

markmap 的 Markdown 是**标题展示投影**，不是可以安全反向导入的完整资料文件。点击知识节点看 answer_md；点击卡片叶看该卡 back。默认树仅在无子节点的 topic 下追加 active 卡片叶，存在卡不保证图上永远展开显示。

新 topic 通常同步一张卡，但一个节点允许多卡；sync_topic_card 更新最早 active 卡，不清理其他卡。树与卡的双向内容编辑并非自动同步，详见 Agent 手册。
