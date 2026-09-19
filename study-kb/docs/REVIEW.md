# 通用表格复习

## 2026-09-19 升级：SQL 方案工作区

当前界面已经改为“选择方案 → 可选章节参数 → 预览/开始”，不再直接展开旧字段映射表单。
配置通过插件内部“管理方案”编辑并保存到 SQLite；包括两个默认方案在内均可编辑、删除，恢复需显式操作。
顶栏插件替换中间表格区域，位置通过三区插件管理调整。最新操作、SQL 示例与边界见 `WORKBENCH-UPGRADE.md`。
下文保留为旧字段映射引擎/API 的兼容说明；旧会话继续使用其快照，相关旧界面行为不再作为新入口。

## 设计与实现

复习不再绑定左侧当前视图或固定的 front/back 字段，而是显式定义：

1. **数据源**：数据库中已有的视图。
2. **字段映射**：问题、答案两个展示字段；另需记录关联键，负责定位回写记录。
3. **集合**：到期/全部、可选节点子树、AND 条件、排序或随机、数量上限。
4. **会话**：开始时保存记录及内容快照，按固定顺序逐条复习。
5. **回写**：FSRS 或自定义间隔策略；评分与进度更新在同一事务内完成。

实现位于 `tools/study_review_engine.py`、`web/studyReview.mjs`；旧 next/grade API 保留兼容。

## 使用步骤

打开“表格复习”插件，展开“复习方案”。

顶部 **选择复习方案（内置 / 我的方案）** 下拉框分为两组：

- **内置方案**：章节卡片、今日到期，每个浏览器都自动提供，不能删除或覆盖，可修改后另存副本。
- **我的方案（当前浏览器）**：此前通过“保存方案”保存的配置，仍保留在当前浏览器本地。

“章节卡片”使用 `v_study_node_cards`、全部匹配、按节点标题排序，默认不限制章节，可再搜索选择节点。
“今日到期”使用 `v_study_due_cards`，包含截至当前到期的卡片（含逾期），按 `due_at` 升序。
两者默认使用 FSRS，单轮上限 5000 条。选择方案只加载配置，不自动开始或改变现有复习进度；点击“开始新一轮”才应用于新集合。

### 学习卡：全章复习

- 来源视图：`v_study_node_cards`。
- 关联键：`card_id`；问题：`front`；答案：`back`；节点字段：`node_id`。
- 集合模式：全部匹配；搜索标题或路径后，从节点列表选择章节。
- 可设置按问题、到期时间等字段的升降序，多条规则按界面从上到下优先。
- 选择 FSRS，预览数量和问题样例后开始。

仅到期模式读取调度表当前复习时间；全部模式可提前复习未到期记录。节点选择包含节点自身和所有后代。
评分基于该卡现有 FSRS 状态重新计算下次时间，不清空稳定性、次数或历史。
同一节点多卡优先使用各卡 back；默认学习视图仅在 back 为空时回退到节点 answer_md。

### 任意视图：自定义回写

例如已有视图 `v_vocabulary` 提供 `word_id / question / explanation`，另有表
`vocabulary_schedule(id PRIMARY KEY, next_review TEXT)`：

- 关联键选 `word_id`，问题选 `question`，答案选 `explanation`。
- 回写策略选“自定义表 · 评分间隔”。
- 目标表选 `vocabulary_schedule`，唯一键选 `id`，时间列选 `next_review`。
- 四档间隔填写 `0.01, 1, 3, 7`，分别对应重来、困难、良好、简单，单位为天，允许小数。
- 评分后只更新当前记录的 `next_review`，不维护 FSRS；会话项保存评分结果。

目标表必须有单列主键或非部分单列唯一索引；时间列须为 TEXT/CHAR/DATE/TIME 类型。
系统表（study_/workbench_/studio_/sqlite_ 前缀及 app_setting、schema_doc）不能作为自定义目标。
学习库调度只能使用 FSRS 策略，以免只写 due_at 破坏状态一致性。
时间采用服务器本地时间，写入格式为 `YYYY-MM-DD HH:MM:SS`；不自动创建目标记录。

## 集合与安全边界

- 来源只能是已有视图；字段、排序方向、运算符均校验，条件值参数化，不支持直接输入 SQL 条件。
- 条件支持等于、不等于、包含、大小比较、为空、非空；最多 20 条，全部 AND。更复杂的 OR/连接逻辑放在来源视图中。
- 多级排序最多 5 条，末尾以关联键稳定排序。随机模式开始时打乱候选记录，再取上限，恢复时不重新随机。
- 单轮上限 1–5000 条；超过 50000 个去重候选时要求缩小范围。
- 只纳入能关联到目标调度记录的行；FSRS 还要求卡片 active。关联键为空、无调度记录的行不纳入。
- 相同目标键去重，只复习一次；视图最好保证每个键唯一，避免相同键展示不同问答。
- “全部”不会绕过视图自身 WHERE。整章复习不要使用本身只包含到期卡的视图。
- 本轮问题、答案和顺序固定；新增记录、条件或内容变更需开始新一轮。
- 评分采用当时最新的调度状态。一次会话中即使“重来”也不插回队列；开始新一轮可再次选入。
- 只更新已评分记录，不批量改动整章的时间；预览、开始、显示答案和中途离开都不更新复习时间。
- 会话 ID + 位置用于幂等；网络重试、双击或同一会话多标签重复提交，只回写一次。
- 删除/停用卡片、删除自定义目标或改变目标结构会拒绝评分，保留进度，需重新建立集合。
- 会话快照保存在 SQLite 的 study_review_session / study_review_session_item，刷新与服务重启可恢复；不自动清理历史集合。
- 命名方案及最近会话指针保存在当前浏览器，不跨浏览器同步；清除浏览器数据后不再自动恢复指针。
- 新增 POST 路由沿用宿主外部写入鉴权；本机可直接使用，远端 API 调用需 Bearer token。
- 各模块读取同一调度表；已打开的其他模块可能需要刷新才能显示新时间。

## API

`GET /api/study/review/catalog` 返回 `views`（含 columns）、`nodes`、`targets`。

`POST /api/study/review/preview` 和 `POST /api/study/review/session` 接收：

```json
{
  "config": {
    "view": "v_study_node_cards",
    "mapping": {"key": "card_id", "front": "front", "back": "back", "node": "node_id", "hint": "hint"},
    "mode": "all",
    "root_id": null,
    "limit": 100,
    "random": false,
    "filters": [{"field": "front", "op": "contains", "value": "架构"}],
    "order": [{"field": "due_at", "direction": "asc"}],
    "scheduler": {"kind": "fsrs"}
  }
}
```

预览返回 `matched / selected / sample`。创建返回 `session_id / config / total / completed / position / card`；
`GET /api/study/review/session/:id` 返回同样结构，完成时 card 与 position 为 null。

`POST /api/study/review/session-grade` 接收：

```json
{"session_id": "会话ID", "position": 0, "rating": 3, "elapsed_ms": 2500}
```

返回 `graded / next`；重复提交额外返回 `replayed: true`，不会再次评分。

自定义策略示例：

```json
{"kind": "interval", "table": "vocabulary_schedule", "key": "id", "due": "next_review", "days": [0.01, 1, 3, 7]}
```

## 验证与启动

```powershell
$env:PYTHONPATH = "$PWD/study-kb/tools"
python -m unittest discover -s study-kb/tests -v
npm --prefix study-kb/tests ci
npm --prefix study-kb/tests test
python study-kb/tools/serve_workbench.py --port 8033
```

重启 workbench 后 Ctrl+F5。新增会话表由原有数据库初始化流程自动建立，不修改已有卡片的复习进度。
后端测试用临时 SQLite；HTTP 测试用独立子进程与临时数据库；界面测试用 jsdom 和模拟 API，不访问真实学习数据。
界面测试验证配置、字段映射、集合预览、揭示答案、评分完成、恢复、保存方案、失败重试和重复点击；不替代真实浏览器视觉检查。
