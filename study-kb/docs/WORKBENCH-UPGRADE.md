# 插件工作区与 SQL 方案升级

## 使用

重启 `python study-kb/tools/serve_workbench.py --port 8033`，浏览器 Ctrl+F5。

- 顶栏“表格 / 章节树图 / 表格复习”以图标、文字和激活下划线切换中间区域；左侧、指标和右下栏保留。插件管理只有下栏一个入口，打开不切换中间工作区。
- 插件管理左上为顶栏启用，右上为下栏启用，底部为未启用。所有启停、位置和排序均通过拖拽完成，不提供位置下拉框或前移按钮。
- 每个插件只在一个位置。移动和切换保留实例；禁用不删除方案、复习会话或已创建的数据库触发器。
- 官方插件不再有启停特权。二维码和打印继续用自己的界面，不要求配置 SQL。
- 章节树默认仍提供原学习视角和卡片详情，也可以选择 SQL 树方案并在内部管理。
- 表格复习以方框卡片显示已有方案：“章节卡片”（含未到期）和“今日到期”（含逾期）。选中卡片才显示预览并筛选/开始一轮学习；两者先进入候选预览，最后确认才进入学习。
- 复习右上设置按钮显示顶部的管理方格，左右各半分别为“编辑已有方案”和“新增方案”；编辑直接打开当前方案，新增打开空白名称与适用 SQL 模板。“返回”恢复参数；旧会话通过“继续上次复习”进入，不混在方案选择页面。未保存修改会提示。
- 新方案存在当前工作台 SQLite，所有浏览器共享；最近会话指针仍在当前浏览器。会话本身保存在 SQLite。

## 复习 SQL

问题和答案可以来自任何已有表/视图，但结果列使用明确别名；`card_id` 是回写调度的关联键：

```sql
SELECT card_id,
       front AS question,
       COALESCE(NULLIF(back, ''), answer_md) AS answer,
       hint,
       node_id
FROM v_study_node_cards
ORDER BY node_title, card_id
```

必需 `card_id/question/answer`，可选 `hint/node_id`。筛选写在 WHERE，排序写在 ORDER BY。
默认章节方案内置递归子树 SQL，默认参数为 `{"node_id": null}`；使用页自动提供章节搜索和选择。
其他默认参数按名称显示输入框，数字默认值以数字绑定，空值绑定 NULL。

模块设置示例：

```json
{"limit": 5000, "random": false, "scheduler": {"kind": "fsrs"}}
```

自定义调度仍可使用：

```json
{"limit": 100, "scheduler": {"kind": "interval", "table": "vocabulary_schedule", "key": "id", "due": "next_review", "days": [0.01, 1, 3, 7]}}
```

自定义目标须是非系统表，有单列唯一键及文本/时间列；只回写时间，不维护 FSRS。
FSRS 策略关联 active 学习卡的完整调度和日志。仅已评分记录更新，提前复习重新安排时间，不清空学习历史。
开始时记录方案 revision、SQL、参数和题目快照，编辑/删除方案不影响旧会话。重复评分提交只更新一次。
预览展示匹配、本轮数量、重复键和缺少调度记录数量。候选键去重，无调度记录排除；最大候选 50000，单轮上限 5000。

## 其他模块合同

- SQL 指标不属于插件：保留固定指标栏及原有设置、预览、SQL 编辑交互。旧版 official.metrics 的插件登记与布局自动移除，不删除指标定义。通用 scalar-number 契约仍可供其他插件选择使用。
- 章节树：`node_id/parent_id/title`，可选 `answer_md/sort_order`。拒绝重复 ID 和循环；最多 5000 节点。
- SQLite trigger：保存为草稿，不会执行；“应用已保存方案”需确认。替换对象需 `settings.replace_name`。系统触发器不能通过此通用入口覆盖。
- 删除方案不删除其已应用的数据库触发器；数据库对象继续由各自业务界面管理。

## 公共能力

开发主源：`3dStudio/3dworkbench/python/workbench_plugins.py`、`web/pluginWorkspace.mjs`、`web/pluginConfigManager.mjs`。
Studio 数据库/HTTP 适配：`3dStudio/tools/plugin_workspace.py`；学习模块适配：`study-kb/tools/study_sql_configs.py`。

`plugin.json` 可声明 `icon: "icon.svg"` 与可选模块：

```json
{"contributes": {"sqlModules": [{"id": "reviews", "label": "复习方案", "contract": "review-cards/v1"}]}}
```

零 SQL 模块完全合法。插件可自行调用共享管理组件/API，但业务布局不由宿主强制。
允许的契约为 `scalar-number/v1`、`review-cards/v1`、`tree-nodes/v1`、`sqlite-trigger/v1`；trigger 模块要求 `trigger.manage` 权限。
图标限插件相对路径 PNG/WebP/SVG，最大 256 KiB；路径不可逃逸，SVG 以 img 加载并返回 sandbox CSP，缺失时回退文字。

接口：

- `GET/POST /api/plugin/layout`：revision 和 top/bottom/disabled 完整布局；同一插件只出现一次，冲突 409。
- `GET /api/plugin/configs?plugin_id=...&module_id=...`：模块合同及已有方案。
- `POST /api/plugin/config/preview|save|delete|restore|apply`：作用域带 plugin_id/module_id；修改/删除/应用带配置 id/revision。
- `POST /api/study/review/sql-preview|sql-session`：`{"config_id":"...","parameters":{"node_id":null}}`。
- 原复习 next/grade/session API 继续保留；新旧会话共用幂等评分。

只读 SQL 使用 SQLite authorizer + query_only，参数绑定和单语句执行，拒绝 DDL/DML/PRAGMA/ATTACH/扩展加载。
通用预览限制 2 秒、200 行、1 MiB（超行显示截断）；复习候选查询限制 5 秒、50000 行、16 MiB，关联处理另限 5 秒。
trigger 使用独立验证/应用路径。外部写请求沿用宿主 Bearer 鉴权。
默认方案播种一次；删除保留 tombstone，刷新不会复活。“恢复默认模板”显式重置默认，不影响自建方案。

## 数据与回滚

新增 `workbench_plugin_layout`、`workbench_plugin_config`，只增迁移；不改真实学习卡/调度/日志。
旧 dashboard.plugin_order 用于首次迁移排序；学习树与复习首次在顶栏，其他启用插件在下栏。
开始前已使用 SQLite backup 生成独立一致性副本，完整性检查为 ok；位置见本次中央计划记录。
回退代码时保留新增平台表与会话记录，不用旧整库覆盖新增学习进度。共享发布副本未自动更新。

## 验证

```powershell
$env:PYTHONPATH = "$PWD/study-kb/tools"
python -m unittest discover -s study-kb/tests -v
npm --prefix study-kb/tests test
```

另在 3dStudio 工作树运行插件/record-contract 回归。测试使用临时 SQLite 或备份副本，不在真实数据库评分。
浏览器连接不可用时只能完成 HTTP/DOM 验证；人工验收需检查：双主题、1280/1920 宽度、三区拖拽、地图缩放、打印/二维码、插件内部返回和刷新恢复。

## 2026-09-19 复习预览与筛选

- 候选预览返回全部有效、去重且有关联调度的查询行，不再只给五条 sample。保留 SQL 返回列，补到期时间；包含 node_id 时补章节路径，便于按树归属筛选。
- 表格每页 50 行，可以浏览所有候选；列头复用工作台筛选弹窗，支持文本搜索或候选值选择并应用，多列为 AND。清空列筛选恢复全量，分页不改变集合。
- 已移除复习使用页的“章节范围（含后代）”专用输入与章节目录请求，章节范围统一通过预览列筛选；已保存 SQL 条件及默认参数仍然生效。显示“全部候选、筛选数量、本轮上限”，零条禁用开轮。
- 只有预览页“开始一轮学习”才请求创建会话。POST sql-session 增加 selected_keys 与 preview_hash；服务端重新查询并校验摘要/选中 ID，方案版本或数据改变会拒绝并提示重新预览；不接受客户端自行提交答案作为可信数据。
- 筛选后再按方案随机设置与数量上限形成会话。候选上限 50000、SQL 结果大小/时间限制保留；超限报错，不把截断结果伪装全量。旧无 selected_keys 的 API 保持兼容。
- 共用代码：tablePreview.mjs 调用 workbenchPlatform.mjs 的列描述/筛选弹窗；rowMatchesFilter 同时由 Study、Studio 主表和复习预览使用。方案卡复用 metric-card/metric-management-card 样式，不复用指标业务逻辑。
- 打印露字修复：收起检查器时，其插件容器的 ID flex 规则曾覆盖通用隐藏规则；新增同 ID 的收起隐藏约束，保留展开后的插件状态。

2026-09-19：方案卡按钮统一为“预览并筛选”和“开始一轮学习”，两者进入预览准备页；预览页最终确认按钮也为“开始一轮学习”。移除独立章节搜索/选择，保留其他自定义 SQL 参数输入。

2026-09-19 布局微调：“继续上次复习”移至标题右侧、设置按钮旁；设置展开的管理方格排在方案网格首位，编辑与新增各占一半，共用指标栏的齿轮/加号图标、居中文字和淡背景。“开始一轮学习”使用主按钮外观，“预览并筛选”使用次按钮；开轮前预览确认逻辑不变。

## 2026-09-19 通用树方案与整页浏览

### 操作路径

1. 章节树图 → 选方案卡。“学习知识树”保留原 scope 和关联卡；其他卡是数据库中可编辑的 SQL 树方案。
2. “预览并筛选”执行完整结构校验；结果显示树/森林、根数、最大深度和缺失父引用警告。超过 5000 节点、256 层或查询资源限制报错，不使用截断结果冒充完整树。
3. 预览列头复用表格筛选；命中节点的祖先会保留并计数。根选择器可搜索任一保留节点，选择后打开树。
4. 树图占满中间工作区，用原生 SVG 而非 Markdown 标题生成，不受六级标题限制。右上刷新、缩放、适应画布、大纲；大纲完全替换图。
5. 点击节点进入内部详情子页面，返回保留树/大纲状态；以该节点为临时根不修改数据库。详情模块可为多个 Markdown/纯文本列。系统学习树额外列出直属卡片正文。
6. 刷新重新加载方案与数据，重新应用预览的列条件；保留浏览根（若仍存在）和图/大纲模式。刷新失败明确提示，保留已加载快照；不会将失败显示为已刷新。

### 通用表格如何成为树

邻接表结构：每行一个节点，唯一 ID，一个父 ID，非空标题；父值 NULL 或空字符串表示根。多根允许，报告为森林。多父关系需要用户先明确选择单父，不自动猜测。

无需按固定英文列名写 SQL，可直接查询原列，再在管理器的“树关系与详情模块”指定列名：

```sql
SELECT id AS code, parent_id AS owner, title AS label,
       answer_md AS explanation, source_ref AS source
FROM study_node
ORDER BY sort_order, title, id
```

对应设置（可用可视化控件编辑，不必手写）：

```json
{
  "tree": {
    "id": "code",
    "parent": "owner",
    "title": "label",
    "orphans": "error",
    "details": [
      {"column": "explanation", "label": "知识说明", "format": "markdown"},
      {"column": "source", "label": "材料来源", "format": "text"}
    ]
  }
}
```

默认映射是 node_id/parent_id/title，answer_md 存在时自动作为详情。详情最多 16 个。节点 ID 接受非空文本/有限数字并规范为文本，1 与 "1" 判为重复；重复 ID、空标题、自引用与环均拒绝。缺失父节点默认报错；显式 orphans=root 时提升为根并给警告，适合明知 SQL 已截取子树的查询。

SQL ORDER BY 决定节点和同级展示顺序。SQL 默认参数继续在方案管理器里配置；表头筛选不回写方案或源表。原学习树是系统只读来源，不支持在方案编辑器覆盖；需要自定义请新增 SQL 方案。

### 共用代码与验证

- `3dStudio/3dworkbench/python/tree_model.py`：完整查询结果的映射、结构校验与规范输出。配置 preview/save 和 Study 树加载共用，不再保存时只校验前 200 行。
- `3dStudio/3dworkbench/web/treeMapping.mjs`：关系字段和可增删详情模块，嵌入公共 SQL 管理器。
- `3dStudio/3dworkbench/web/treeWorkspace.mjs`：无 Study 表依赖的 SVG/大纲/详情子页面、根切换、筛选保留祖先。
- `study-kb/web/studyTreeWorkspace.mjs`：学习方案、scope 和原卡片详情适配；studyPlugins.mjs 只保留导出入口。
- 预览继续共用 tablePreview.mjs 的分页和列筛选，刷新可恢复筛选条件。

源码、HTTP 和 DOM 自动化验证完成不等同于真实浏览器视觉验收；实际布局需刷新后核对。


### 统一节点与正文展开（2026-09-19 修正）

章节和卡片通过 `v_study_knowledge_nodes` 成为相同的 title/content_md 节点，不再只在章节详情显示卡片。预览保留全部 SQL 列，支持筛选卡片问题与答案；卡片自动保留章节祖先。有子章节的父节点也显示直属卡片。默认 SQL 与系统学习树均使用新视图，原实体表、卡主键、调度和复习日志保持不变。仅精确升级未经编辑的内置旧 SQL，自定义 SQL 需主动选择新视图。

节点小箭头展开配置的正文模块（Markdown 沿用安全渲染）；无内容禁用。＋/− 单独控制子树，标题仍进入可返回的详情页面。图布局预留正文高度、长正文内部滚动，大纲也支持正文展开。空白自由平移不限于滚动条范围，“适应画布”重置位移。保留 scope 和可选临时根。

真实库更新前已创建 data/backups/study-before-unified-nodes-20260919-144535.sqlite，更新后统一视图为 15 个章节/知识点 + 10 张活跃卡片，其中 1.3 下有 10 张卡片；所有学习表原内容哈希保持一致，11 条评分历史未改变。


### 知识节点写入与快捷键

选中画布节点后Tab新增子主题，Enter新增同级，Shift+Enter编辑正文；工具栏也提供同名按钮。调用方必须通过 `editing.provider=study-knowledge/v1` 明确启用，共享树只产生 onEdit 回调，自定义SQL默认只读。编辑页面保存后才写库，保留Markdown预览、取消、并发冲突草稿及网络重试。

接口 `/api/study/knowledge/read` 和 `/api/study/knowledge/save` 都为POST并复用写鉴权；写入版本指纹、请求ID幂等、事务、树限制及审计在 study_knowledge_edit.py 实现。内容更新不修改FSRS、评分或其他卡。卡片子主题用 study_node_parent_card 关系维护，原章节关系用于scope兼容；无自动新增复习卡、无删除和任意移动操作。

正文foreignObject去掉内缩，使用透明底色继承选中背景且裁切到底部圆角。编辑成功后保持相机状态与筛选，并显式显示保存的目标。
