---
name: study
description: 将书本、OCR、笔记或对话归纳为通俗可背诵的知识卡，维护 system/study-kb 已有章节树并安全入库；用户要求整理资料、插入或修改卡片、调整知识树、阅读 Markdown 节点详情、按章节复习或查看今日到期时使用。
metadata:
  scope: system
  tags: study, flashcard, fsrs, spaced-repetition, knowledge-base
---

# Agent 手册：从资料到知识树、Markdown 答案和背诵卡

## 统一节点写入规则

新知识点必须使用统一 card 节点：`create_node(role="topic")` 直接创建一个 `item_type=card` 节点并创建 FSRS 调度。禁止先创建 topic/章节节点，再在其下调用 `create_card` 生成同标题同步卡片；这会产生重复实体。纯目录才使用 `role="outline"`。旧库中的 topic+子 card 只允许通过一次性迁移合并，不得作为新数据格式继续写入。

> 适用 system 仓库；源码核对日期：2026-09-19。本文同时是完整 skill 和 Agent 操作手册，不需再打开另一份 AGENT.md。人类指南在 system 根 README.md。

## 文档主源与跨仓库使用

- 唯一编辑主源：`D:/system/.cursor/skills/study/SKILL.md`。
- 中央发现副本：`D:/Rsim_helper/readme/skills/study/SKILL.md`，与主源内容完全相同；修改主源后同步副本并运行中央 mesh build/validate，不分别维护两套规则。
- **从中央 skill 进入也必须先定位 system 根目录**（当前 `D:/system`），再执行本文命令。所有 system 根相对路径不能相对 Rsim_helper 或当前 skill 目录解释；若仓库移动，先确认真实位置，禁止在错误目录创建学习库。
- 脚本、补充参考与审计仍位于 system 的 `.cursor/skills/study/`，此副本不另带一套脚本或数据库。本文正文已包含主要操作合同。
- system 根 `AGENTS.md` 只负责发现路由；旧 `study-kb/docs/AGENT.md` 只保留兼容指引，不再保存第二份正文。
- 外部文档引用：`D:/system/README.md`（用户操作）、`D:/system/study-kb/docs/WORKBENCH-UPGRADE.md`（SQL 方案）、`D:/system/.cursor/skills/study/references/`（大纲与接口）。

## 1. 先懂目标，再调用工具

用户说“把这段内容整理进去”，目标不是复制文字到数据库，而是：

1. 找到资料在已有知识树中的位置，维护有意义的父子关系。
2. 把内容变成能理解、能独立回忆、能判断对错的问答。
3. 将 Markdown 详情、卡片及调度一起保存，前端能浏览与复习。
4. 保留来源、既有节点 ID 和学习历史，使后续修订不会反复生成重复卡。

本轮只要求文档时，不代替用户整理或插入真实学习资料。执行具体入库请求时采用“提议 → 确认 → 写入”；用户已经确认具体草稿、父节点及改动范围后，不要求重复确认。

### 任务路由

| 意图 | 应读/应做 | 不该做 |
| --- | --- | --- |
| 从 OCR/PDF/笔记整理 | 读原材料、列范围与疑点、查已有树、提问答草稿 | 将模糊 OCR 猜成事实，直接整页复制入库 |
| 新增一本书 | Markdown/JSON 整书导入，在临时库验证后执行 | 用同一文件重复导入当更新 |
| 追加到已有章节 | 明确父 ID，调用 create_node/create_card | 按书名重建整棵树 |
| 改写旧知识卡 | 查节点/卡 ID、来源、状态和历史，再原位更新 | 为改措辞删除并重建卡 |
| 移动/拆分/合并树 | 计划逐个 ID 的归属和学习视角，验无环 | 直接删父节点或级联清理 |
| 开始复习 | 选择已有方案与范围，用户回答后评分 | 为检查入库成功给正式卡评分 |

## 2. 事实来源和目录边界

所有命令从 **system 仓库根目录** 执行，示例环境为 `D:\system`。

| 资产 | 路径 | 责任 |
| --- | --- | --- |
| 真实学习数据 | `study-kb/data/study.sqlite` | 章节、卡片、scope、FSRS、日志、方案 |
| 学习业务 helper | `study-kb/tools/study_kb.py` | 建节点/卡、同步 topic、导入、评分 |
| 迁移与视图 | `study-kb/tools/db.py`、`study-kb/schema/` | 数据结构和查询投影 |
| 前端 | `study-kb/web/` | 树详情、Markdown、SQL 复习 |
| Agent 工具 | `.cursor/skills/study/scripts/` | 大纲和卡片导入包装 |
| 审计 | `.cursor/skills/study/records/` | 记录批次、来源、ID 与验收 |
| 共享 UI | `3dStudio/` | 指向 Rsim_helper，不在 ops.sqlite 存学习数据 |
| 中央文档池 | `readme/` | 指向 Rsim_helper；本项目人的手册放根 README.md |

只读盘点用 `sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)`。不要用 `study_kb.open_db` 冒充只读：它调用迁移，可能补字段、更新视图或回填节点角色。先确认文件存在，防止错误路径产生空库。

## 3. 知识树、卡片与图之间的真实关系

```text
study_scope.anchor_node_id ───────────> study_node.id（选择观看起点）
study_node.parent_id ────────────────> study_node.id（目录父子关系）
study_card.node_id ──────────────────> study_node.id（卡片归属）
study_card_fsrs.card_id ─────────────> study_card.id（每卡一个调度状态）
study_review_log.card_id ────────────> study_card.id（每卡多条评分历史）
```

- **知识图不是第二套独立数据**：章节树前端主要从 `study_node`/树查询生成；卡片列表或图上的卡片叶来自 `study_card`。一个节点可挂零张、一张或多张卡。
- `kind` 表示层级类别（book/chapter/section/topic/group）；`role` 表示内容角色（outline/topic），不能混为一个字段。
- `outline` 表达目录；`topic` 表达可学习知识，`title` 建议直接写问题，`answer_md` 存节点答案。
- 推荐新内容一知识点一 topic、一 topic 一张卡，便于图与问答同步；这是建模惯例，不是数据库唯一约束。
- `create_node(role="topic")` 调用 `sync_topic_card`，后者取最早创建的 active 卡改为节点标题/答案；没有 active 卡才新增。不移除额外卡，也不自动恢复 archived/suspended 卡。
- 同步 helper 只在被调用时工作，不是“改任意表都会双向同步”的数据库触发器。修改节点后需显式同步；单独改卡不自动修改节点。
- `create_card` 会建立初始 FSRS 状态；原位更新卡正文不会重新调度。多卡节点的每张 `back` 各自独立，复习优先取卡 back，再回退节点答案。
- `scope` 是同一棵树的观看起点；不移动或复制节点。同名 scope/书可能已经存在，必须使用 ID，不靠标题认定唯一对象。
- `v_study_mindmap_nodes` 看节点；`v_study_scope_tree` 按 scope 展开子树；`v_study_node_cards` 看 active 卡与调度；`v_study_due_cards` 再加到期限制。同一节点可在多个 scope 出现，计数必须注意去重。

### 图上“展开”与“详情”不是同一种数据

旧 markmap 接口（非当前工作区）绘制标题层级。点节点看 `answer_md`，点卡片叶看该卡 `back`。当前默认生成器只在**没有子节点的 topic** 下追加 active 卡片叶；有子目录的节点不会同时显示所有直属卡片叶。它们仍可存在于卡片表和复习集合中。

因此要让每个知识点都能在树上发现，优先建立独立 topic 子节点，不要把所有卡塞进仍有子目录的父节点。当前标题输出最多六级，更深层级可能压平；选较近 scope，或让树结构更清楚，不承诺无限深图展示。

## 4. 从资料提炼成“人能背出来”的卡

### 4.1 先提取事实，再写卡

建立草稿清单：`来源/定位 → 原意 → 核心概念 → 适用条件 → 问题 → 答案 → 目标树路径`。

- 确认资料版本、章节、页码；扫描件页码与印刷页码不一致时分别标注。
- 用户未提供材料且本地没有时，先询问来源；不能假装已经读过文件。
- OCR 的数字、否定词、公式、术语易出错：疑点单列，回原页核对，未核实内容不写成确定答案。
- 原文结论、你的白话解释和记忆提示要区分。不能用例子替换正式定义，也不能为了“好背”删掉条件或例外。
- 对同义词合并表述，对近义但边界不同的概念保留比较卡；不同版本矛盾记录来源后让用户选择口径。

### 4.2 分树而不是分段复制

先按“书 → 章 → 节 → 知识点”归档。目录标题用于找路；卡标题用于提问。

| 材料形态 | 建议 |
| --- | --- |
| 一个定义 | 一张定义卡：是什么/解决什么问题 |
| 一个流程 | 总览卡问步骤，再给重要步骤建细卡 |
| 多个易混概念 | 各自定义 + 一张比较卡，按维度而非长段落比较 |
| 一个公式 | 公式含义、符号、适用条件；必要时另拆应用例 |
| 长案例 | 提炼可迁移规则，案例留答案的例子部分 |
| 一组孤立枚举 | 保留总览卡；若每项有独立考点，再拆子卡 |

不强制每段一张、不强制双向、不随意按句子切碎。`card_type` 的 basic/reverse/cloze 是可存标签；当前前端并不因此自动生成反向题或遮挡填空，需要自行写完整可用的 front/back。

### 4.3 好卡的质量门槛

- 问题离开上下文仍能回答：避免“它的特点是什么”“以上包括什么”。
- 一个主要检索目标，答案对错能判断。背诵长度按用户目标调整，优先短答、必要的枚举和一个白话例子。
- 推荐答案顺序：**一句话结论 → 要点 → 通俗例子 → 易错边界 → 来源**；简单卡可省无用部分。
- 提示不泄露完整答案；答案不是问题的同义复述。
- 同义改写不再新增一张重复卡；细化确有不同检索目标才拆卡。
- 标题尽量单行。来源保留材料定位，不把杜撰页码写入 source_ref。

以下仅为说明卡片结构的自编示例，不是待导入教材结论：

**差的卡**：问题“图书馆”；答案整段操作手册。

**好的卡**：问题“在这个示例中，图书目录和借阅提醒各解决什么问题？”

```markdown
**一句话**：目录帮你找书；提醒告诉你什么时候还书。
- 目录：按分类定位书的位置。
- 提醒：按到期时间提示归还。
**例子**：先按“计算机”找到书，再看借阅单上的归还日。
**易错点**：调整分类不等于重置归还日。
**来源**：教学示例；非教材事实。
```

## 5. Markdown：正文渲染与大纲导入分开理解

前端 `studyMarkdown.mjs` 使用 marked 的 GFM 模式，经 DOMPurify 清理再显示，支持常用强调、列表、引用、代码块、表格和普通链接。源码/渲染切换是查看方式，不是保存编辑。不要承诺 LaTeX、Mermaid、任意 HTML/脚本或本地图片路径必然可用；没有专用数学/图形渲染保证，图片还需可访问的资源地址。

**数据库内完整 Markdown** 可以直接保存到 `answer_md`/`back`，包含小标题和代码块。**大纲导入器** 当前是简化行解析器：

- `#` 到 `######` 的标题均用于建节点，答案里的 `### 小结` 也可能被当作子节点。
- 不识别代码围栏上下文；代码块中以 `# ` 开头的行也可能误建树。
- 空行会被丢弃，正文段落分隔不保证完整保留。
- `outline` 下只要有非空正文，就自动升级为 topic，并生成卡；纯目录下面不要写说明段。
- 标题注释只解释 outline/topic 及 kind 提示；不能把任意来源注释当作已实现的导入元数据。

简单导入答案用 `**小结**`、列表等，不用内部 `#` 标题。需要保留复杂 Markdown 时用 JSON `answer_md` 或 helper 直接存正文。JSON 可逐节点传 source_ref；Markdown CLI 的 `--source-ref` 主要落在新根节点，不能假设自动复制到每张卡，需要明确记录/补齐细粒度来源。

### 新整书的最小大纲

下面外层代码块只是文档展示；实际文件只保存内部内容：

```markdown
# 学习系统演示 <!-- outline: book -->
## 资料组织 <!-- outline: chapter -->
### 目录与提醒 <!-- outline: section -->
#### 目录和提醒各解决什么问题？ <!-- topic -->
**一句话**：目录用于定位，提醒用于安排复习时间。
- 目录关系决定内容挂在哪里。
- 到期状态决定卡片什么时候再出现。
**来源**：自编系统操作示例。
```

保存到确认的 UTF-8 文件后执行；命令会**新建根节点和 scope**，不是按标题匹配更新：

```powershell
python .cursor/skills/study/scripts/import_outline_md.py `
  --markdown .cursor/skills/study/records/imports/demo-outline.md `
  --source-ref "自编系统操作示例" `
  --db study-kb/data/study.sqlite `
  --record .cursor/skills/study/records/imports/demo-import-result.json
```

示例文件名只是模板，先创建并预览内容；正式批次用唯一文件名。Markdown 导入没有 dry-run，也没有父节点追加参数；不得杜撰 `--parent/--update/--dry-run`。JSON 整书导入会设新 scope 为默认；Markdown 整书导入不设为默认。

## 6. 写已有数据库：可执行范式与危险边界

### 6.1 盘点与备份

先只读查询真实父 ID、role、已有直属子节点、active 卡和 scope。按完整路径与 ID 向用户展示拟挂载位置；标题相同不是同一个节点。

正式写入前使用 SQLite backup API 生成一致性副本；不只复制正在写入的 `.sqlite` 主文件而漏 WAL。备份应在库外唯一目录，不覆盖已有文件。停止写入/恢复备份前还需确认用户的服务和并发活动；不能用旧备份覆盖其间新增的复习记录。

### 6.2 在已确认父节点下新增一个原子 topic

下面是 **Python 脚本模板**，不是直接在 PowerShell 提示符逐行执行的命令。保存为已审阅脚本，从 system 根运行。先把 db_path 指向临时副本，替换父 ID 与已确认内容；验证通过后再对确认的正式路径执行。

```python
from pathlib import Path
import sys

sys.path.insert(0, str(Path("study-kb/tools").resolve()))
from study_kb import create_node, get_node, open_db

db_path = Path("study-kb/data/study.sqlite")
parent_id = "REPLACE_WITH_CONFIRMED_PARENT_ID"
question = "目录和提醒各解决什么问题？"
answer = "**一句话**：目录用于定位，提醒用于安排复习时间。"
source = "自编系统操作示例；非教材事实"
if not db_path.is_file():
    raise ValueError("请先核对目标数据库，禁止误建空库")
connection = open_db(db_path)
try:
    connection.execute("BEGIN IMMEDIATE")
    get_node(connection, parent_id)
    duplicate = connection.execute(
        "SELECT id FROM study_node WHERE parent_id=? AND title=?",
        (parent_id, question),
    ).fetchone()
    if duplicate:
        raise ValueError("同级存在同标题：请复用/修改已有 ID，不重复新增")
    order = connection.execute(
        "SELECT COALESCE(MAX(sort_order),-1)+1 FROM study_node WHERE parent_id=?",
        (parent_id,),
    ).fetchone()[0]
    node = create_node(
        connection, parent_id=parent_id, kind="topic", role="topic",
        title=question, answer_md=answer, source_ref=source, sort_order=order,
    )
    connection.execute(
        "UPDATE study_card SET source_ref=? WHERE node_id=?", (source, node["id"]),
    )
    cards = connection.execute(
        "SELECT id FROM study_card WHERE node_id=? AND status='active'", (node["id"],),
    ).fetchall()
    if len(cards) != 1:
        raise ValueError("新增原子 topic 应只有一张 active 卡")
    card_id = cards[0]["id"]
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("外键校验失败")
    connection.commit()
    print({"node_id": node["id"], "card_id": card_id, "parent_id": parent_id})
except Exception:
    connection.rollback()
    raise
finally:
    connection.close()
```

该脚本仅对“相同父 ID + 完全相同标题”做阻止重复；不能代替语义去重，也不是通用同步器。运行成功后必须保存输出 ID；中途失去输出先查库确认，不能盲目重试。`open_db` 的迁移发生在业务 BEGIN 前，因此整套行为也应先在副本验证。

### 6.3 更新旧内容、移动、拆分

- **单卡 topic 改措辞**：先查 active 卡列表且确认恰好一张，以及它就是目标卡；事务内按 node ID 更新 title/answer_md/source_ref/updated_at，再调用 `sync_topic_card`。需要卡来源同步时按 card ID 更新 source_ref。验证卡 ID、FSRS 状态和历史未变。
- **多卡节点改一张卡**：按 card ID 参数化 UPDATE front/back/hint/source_ref，不调用 sync_topic_card 覆盖第一张卡；节点总说明是否修改由用户需求决定。先断言该卡 node_id 属于确认的目标。
- **往现有节点额外加卡**：调用 `create_card(con, node_id=..., front=..., back=..., hint=..., source_ref=...)`，它会建立 FSRS。若希望每个问题在树上单独可见，优先新增 topic 子节点。
- **移动节点**：只改已确认 ID 的 parent_id/sort_order。新父不能是自己或任何后代；外键不能防止祖先环，需递归查询校验。卡仍跟随同一 node_id，scope 指向同一 ID；移动后不同 scope 可见范围可能变化，需验收。
- **重排**：明确兄弟 sort_order；相同值会按标题等排序，不保证原来顺序。
- **大幅更换知识含义**：不能悄悄复用旧记忆状态。提出新卡与旧卡归档方案，请用户确认；不要自己把 reps、日志清零。
- **删除/合并**：父节点删除有级联风险，会影响子节点、scope、卡、FSRS 和日志。优先提出迁移归属和旧卡 archived 方案；不是为了去重直接 DELETE。
- `status` 为 active/suspended/archived，非 active 不进常规复习集合；保留旧卡 ID 和历史比删除更安全。

### 6.4 cardize.py 的实际行为（不可忽略）

| 输入 | 实际行为 | 使用限制 |
| --- | --- | --- |
| `--dry-run` | 读取 JSON，打印数量/内容 | 不连接目标库，不验证 node ID，不去重 |
| 1 张卡 | 将父节点改 topic，answer_md=back，再同步其最早 active 卡 | 输入 front 不替换节点标题，hint/type/source_ref 未写入；可能改掉已有卡 |
| 多张卡 | 逐张 create_card，追加新卡与调度 | 无去重，重复执行会重复追加；不主动更新节点 role/answer_md |

迁移包含“已有 active 卡的 outline 升级 topic”回填，可能在后续连接生效；不要依赖它维护图结构。通用单卡新增优先 helper，不使用有副作用差异的单卡 cardize。脚本差异属于现状说明，本手册没有声称已修复它们。

## 7. 每次写入的验收、审计与恢复

### 写入前

- 确认 DB 存在、父 ID/完整路径、来源与提议范围；查重；备份；副本演练。
- 记录原节点/卡、scope、FSRS 和日志摘要，特别是会被修改的 ID。
- 等待用户确认新增/修改/移动/归档清单；别把“可以参考”当“可以删除”。

### 写入后（先数据库，再界面）

以下均为只读 SQL，数量需和本次增量及事前基线比较，不把历史问题当本次导入造成：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
SELECT c.id FROM study_card c
LEFT JOIN study_card_fsrs f ON f.card_id=c.id
WHERE c.status='active' AND f.card_id IS NULL;
SELECT parent_id,title,COUNT(*) AS count FROM study_node
GROUP BY parent_id,title HAVING COUNT(*)>1;
SELECT node_id,front,COUNT(*) AS count FROM study_card
WHERE status='active' GROUP BY node_id,front HAVING COUNT(*)>1;
```

预期完整性为 ok、无新增外键错误、无本批 active 卡缺少调度、无意外重复。重复查询只提示候选，不自动合并。还需确认未引入树环、scope 能看到目标节点；编辑旧卡时 FSRS/日志不因编辑而变化。

前端验收：启动学习库 → 章节树图选正确学习视角 → 刷新 → 展开新增 topic → 点节点与卡片检查各自 Markdown → 表格复习选“章节卡片”并定位章节 → 预览能找到新卡。不要用真实评分验证入库。不能操作浏览器时如实说仅完成数据库/静态验收。

正式失败处理：业务事务异常 rollback；若已提交后发现问题，先停止进一步写入，按批次 ID 评估最小纠正。恢复整库会覆盖之后的学习活动，须单独确认，不自动恢复旧备份。

### 审计约定

每批保存草稿及唯一审计文件到 `.cursor/skills/study/records/imports/`，索引登记到 `records/index.json`。记录至少：

- batch id、时间、真实 DB 路径、来源文件/版本/页码、确认范围。
- 复用父 ID、新增/修改/移动/归档的 node/card ID 与数量。
- 执行命令/脚本位置、备份路径、数据库/前端验收结果、未完成项。
- 旧卡历史保留策略、疑点与后续待补内容。

`import_outline_md.py --record` 只输出简单数量和根/scope 信息，内部 id 还是 latest；应补充批次唯一 id 和节点/卡 ID，不能把它当完整增量审计。不要把本地数据库备份提交进 Git；审计不必复制整段私人原文。

### 对人的交付模板

> 已将【材料/范围】整理到【书/章/节，父 ID】。新增节点 N、卡 M，修改 K；未重置复习历史。来源与疑点为……。打开“章节树图 → 学习视角 → 路径”，点击节点看 Markdown；“表格复习 → 章节卡片 → 章节参数 → 预览/开始”背诵。数据库验收……；前端验收……；审计文件……。

如果只有草稿，就说“待确认，未入库”。如果新增知识树但未建卡，就不能说“已可以 FSRS 复习”。

## 8. 前端与源码查证路线

| 要核对什么 | 事实来源 |
| --- | --- |
| 主外键、级联、状态 | `schema/study_kb.sql`、`tools/db.py`、`schema/study_node_roles.sql` |
| topic 同步和追加导入 | `tools/study_kb.py:create_node/sync_topic_card/import_outline_markdown` |
| 简化 Markdown 解析 | `tools/study_outline_md.py:parse_outline_markdown` |
| 单卡/多卡导入差别 | `.cursor/skills/study/scripts/cardize.py`（仓库根下） |
| 图标题、卡片叶和详情 | `tools/study_kb.py:build_markmap_markdown`、`tools/study_api.py`、`web/studyPlugins.mjs` |
| Markdown 安全显示 | `web/studyMarkdown.mjs:renderMarkdown` |
| 现行 SQL 复习方案 | `tools/study_sql_configs.py`、`web/studySqlReview.mjs`、`docs/WORKBENCH-UPGRADE.md` |
| 复习协议和旧兼容 API | `docs/REVIEW.md`、skill references/workbench-api.md |
| 行为测试 | `tests/test_import_outline_md.py`、`tests/test_study_kb.py`、`tests/test_study_api.py`、`tests/test_review_http.py` |

路径除特别标注外相对 `study-kb/`。未提供通用知识内容新增 HTTP API 的承诺；Agent 写知识走 helper/导入工具，不能杜撰 POST /api/study/node。SQL 方案管理编辑的是查询，不是自动创建知识内容。

回归命令（临时数据库测试，不对正式卡评分）：

```powershell
$env:PYTHONPATH = (Resolve-Path study-kb/tools).Path
python -m unittest discover -s study-kb/tests -v
npm --prefix study-kb/tests test
```

这些测试验证已有业务行为，不能替代逐批内容正确性和真实浏览器的视觉验收。

## 9. Agent 快捷接口（只读盘点与草稿验证）

为减少 Agent 手写 SQL，提供 scripts/study_agent.py。它默认使用 study-kb/data/study.sqlite，通过 SQLite mode=ro 连接，不执行迁移、不写入知识库、不评分。所有输出均为 UTF-8 JSON。

从 system 根目录调用：

    python .cursor/skills/study/scripts/study_agent.py doctor
    python .cursor/skills/study/scripts/study_agent.py inspect --node <study_node_id>
    python .cursor/skills/study/scripts/study_agent.py validate-draft --parent <study_node_id> --input draft.json
    python .cursor/skills/study/scripts/study_agent.py coverage --root <study_node_id>

- doctor 返回 integrity、外键、active 卡缺失 FSRS、同级重复标题。
- inspect 返回节点完整路径、子节点、卡片及调度状态、scope 和最近评分历史。
- validate-draft 检查标题/答案、同级标题重复、上下文依赖问题和来源缺失，并返回规范化草稿与 hash；它只验证，不创建节点或卡片。
- coverage 统计范围内 topic、没有 active 卡的 topic，以及没有来源的 active 卡。

这些命令不能替代“提议 → 确认 → 写入”。正式写入仍应使用已确认的父 ID、SQLite backup、事务、helper/知识编辑接口和批次审计；不要把 node:<id> 或 card:<id> 投影 ID 当作原表外键。cardize.py 仍保留兼容用途，但不作为已有章节增量写入的默认入口。

### 本次文档核验记录（2026-09-19）

- 已只读核对现有学习库的视图、树/卡/scope 关系；未写入或评分真实学习内容。
- 在临时 SQLite 执行本文增量新增模板：成功生成 topic、卡和调度；重复标题被拒绝，未重复新增。
- 在临时库验证原位修改保留 card ID 与 FSRS，多卡仍为合法关系；验证示例大纲生成四节点、一卡，以及正文小标题/空行的解析限制。
- study-kb Python 回归 32 项通过；文档本地链接与 UTF-8 检查通过。这里没有把浏览器视觉验收声明为已完成。

## 2026-09-19 合并记录

按用户要求，将原 study skill 的入口与 study-kb/docs/AGENT.md 完整操作说明合并到本文；旧文档改为兼容指引，system 根入口直接指向本 skill。将本文同步到 Rsim_helper 中央 skills/study，保留 system 为编辑主源；未移动脚本、审计或学习数据。

## 2026-09-19 复习 UI 补充

表格复习现以指标式方框选择已有方案；选中卡片的预览/开启新一轮按钮均先进入完整候选表格。章节参数先限制子树，预览列头再复用工作台筛选弹窗按列应用条件；分页只影响展示，不缩小候选。最后在预览页确认“开始新一轮”才进入学习；零条禁用，方案或候选变化需重新预览。设置按钮显示“编辑已有方案”与“新增方案”两张操作卡；继续历史会话用显式“继续上次复习”，不自动混入当前方案。Agent 演示/验收使用临时库，不评分正式数据。

2026-09-19 后续调整：使用页已取消“章节范围（含后代）”及章节搜索/目录加载，统一在预览表格按列筛选。方案卡按钮改为“预览并筛选”“开始一轮学习”；预览页确认按钮同名“开始一轮学习”。已保存 SQL 的默认参数继续传入，不修改已有方案或复习历史。此条覆盖前述旧界面操作描述。

## 2026-09-19 通用树工作区（覆盖旧 markmap 布局说明）

当前入口为方案卡 → 结构校验与表格预览筛选 → 指定根 → 整页树图。新增/编辑 SQL 方案可映射节点 ID、父 ID、标题，并增删最多 16 个 Markdown/纯文本详情模块；查询可来自任意合法只读表/视图。树数据由共享 tree_model.py 校验全量结果，拒绝重复/空 ID、空标题、环；缺父默认报错，显式提升为根才继续并警告。森林允许，5000 节点/256 层为上限。

“学习知识树”保留 scope，通过统一节点视图让章节和所有直属活跃卡片都成为节点；小箭头原位展开 Markdown 内容，标题进入详情子页。“大纲”替换整页图，“返回树页面”恢复浏览状态；指定临时根只改当前视角，不写 parent_id 或 scope。全页指中间工作区，未强制隐藏指标和下栏。

前端图改为共享原生 SVG，不再通过六级 Markdown 标题生成；旧 markmap HTTP 接口/大纲导入解析规则仍保留兼容，不能混为新版图限制。节点标签按文本绘制；详情 Markdown 继续经过安全渲染。预览筛选会补齐命中节点的祖先并计数，刷新重新应用列条件；方案编辑不等于源表正文编辑。

实现与用户流程详见 system 的 study-kb/docs/WORKBENCH-UPGRADE.md“通用树方案与整页浏览”。Agent 仍按本文事务流程修改知识，不能将方案设置当作知识增删接口。


## 统一节点合同（2026-09-21，新结构唯一事实来源）

用户确认章节、知识点、卡片在图与筛选中都是同类节点。优先查询 `v_study_knowledge_nodes`，不再只查 study_node 并把卡片藏在附属详情里。

| 统一字段 | 章节/知识点来源 | 卡片来源 |
| --- | --- | --- |
| node_id | `node:` + study_node.id | `card:` + study_card.id |
| parent_id | `node:` + parent_id；根为 NULL | `node:` + node_id |
| title | title | front |
| content_md | answer_md，可空 | back，可空，严格不回退成章节答案 |
| source_type/source_id | node / 原节点 ID | card / 原卡 ID |
| owner_node_id | 原节点 ID | 所属章节原 ID |

- 最终运行时不再使用“卡片投影”模型。章节、主题、卡片都是真实的 `study_knowledge_item` 行，统一拥有 `id/parent_id/sort_order/title/content_md/status`；`item_type='card'` 表示具备复习能力的知识节点。旧拆分表已从正式数据库删除；复习状态使用 `study_knowledge_schedule`，评分历史使用 `study_knowledge_review_log`，会话使用 `study_knowledge_review_session*`。
- 所有 active 卡片都参与预览，不以“归属节点是否叶子”为条件；停用/归档卡默认不参与。scope 按 owner_node_id 限定章节子树。筛中卡片时自动补祖先，正文展开不等于子树展开。
- 不为图上可见而创建重复 study_node，不自动合并同标题、相同正文或旧同步过的 topic/card，不清理旧回填 answer_md。空正文合法，无内容时箭头禁用。
- 通用 SQL 树保留全部结果列用于筛选，自动识别 content_md、answer_md、back（按此顺序）；显式配置的详情模块优先。内容使用已有安全 Markdown 渲染，不自行拼未净化 HTML。
- 默认未经修改的旧内置树 SQL 精确升级；用户已改过的方案不覆盖。旧 `/api/study/tree` 保留兼容，工作区使用 `?model=knowledge`。
- 验证真实库变更前用 SQLite backup 保留一致性副本；只升级视图/必要内置配置并核对所有学习表逐行哈希、外键与卡片数量。恢复备份前确认没有新评分，不用整库回滚抹掉后续学习。


### 节点卡片交互更新（2026-09-19）

图上标题完整换行，不再截断。节点默认收起子树；右侧框内＋/−控制子节点，点击标题只选中节点并显示正文下拉按钮，再点下拉才展开 Markdown。需要原详情子页时使用工具栏“节点详情”；大纲标题仍进入详情。正文与子树开关各自独立，叶节点没有可用的子树开关。此条覆盖前述“点击图标题直接进入详情”的旧说明，不影响数据或复习合同。


### 2026-09-19 数据库快捷编辑合同

系统学习树和未改写的默认统一SQL方案返回 `editing.provider=study-knowledge/v1` 才启用图编辑；任意自定义SQL仍只读。共享组件只发 onEdit 意图，不写SQL。选中图节点 Tab/Enter/Shift+Enter 分别打开子主题/同级/正文编辑页，显式保存才写库。

- `POST /api/study/knowledge/read` 输入 `{node_id}`，返回真实统一节点和内容/关系指纹 version；`POST /api/study/knowledge/save` 输入 `{node_id,version,request_id,operation:child|sibling|content,title,content_md}`。外部调用遵循服务令牌鉴权；不把任意SQL结果的计算ID当作可写源。
- 写入使用 BEGIN IMMEDIATE：查真实父级、校验必填标题≤500字符和正文≤200000字符、创建后校验整图5000节点/256层；失败回滚。version冲突返回409，不盲目重试覆盖。请求ID相同且内容相同返回首次结果，不重复创建；不同内容拒绝复用ID。
- 新主题 `kind=topic, role=outline`，有正文也不调用 sync_topic_card，不自动生成卡片。节点正文直接改 answer_md，卡片正文只改 back；保留卡ID、FSRS及评分日志，禁止借编辑自动评分或覆盖节点最早卡。
- 卡片下新增子主题时，study_node.parent_id仍为卡片所属章节；`study_node_parent_card(node_id,parent_card_id)`表达图中真实卡父级。后续同级以联合视图真实parent_id为准，不使用当前临时根。卡停用/归档时统一视图将子主题回退为章节子节点；重新激活恢复卡父级。卡存在子主题时FK RESTRICT阻止直接删除卡。
- `study_knowledge_edit` 保存 request_id、请求哈希、操作、before_json/result_json作为审计及幂等回执。勿删除审计以“解除冲突”；应重新读节点并使用新请求ID。
- 保存后优先保留筛选和相机状态，目标不命中时临时显示目标与祖先并提示。网络状态不明确时保留原请求重试；确认已保存但刷新失败时仅重载，不重新写入。
- 本次真实库只升级空关系/审计表与视图，备份 `study-kb/data/backups/study-before-knowledge-edit-20260919-162329.sqlite`；没有写测试主题或正式评分。旧资料记录不可通过重放备份覆盖后续用户编辑。
