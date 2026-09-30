# 响应式插件多呈现升级计划

- ID: `plan.study-responsive-plugin-presentations`
- 仓库: `D:/system`、`D:/system/3dStudio`
- 创建日期: `2026-09-30`
- 负责: `agent`
- 状态: `completed`

## 目标与边界

- 目标状态: 用户只管理“插件”，不再看到“轻量插件/普通插件”分类；同一插件可以为顶栏、上栏、下栏声明不同呈现，宿主依据放置位置和实际尺寸选择适配界面。
- 布局边界: 本轮保留现有顶栏、上栏、下栏和未启用四个位置；上栏仍为单槽，不立即改造成可自由缩放的多组件网格。
- 身份边界: 一个插件在布局中仍只能出现一次，业务数据和配置不因位置切换而复制。
- 兼容边界: 旧 `contributes.panels` 清单可读取并迁移，但保存和新增清单统一使用 `contributes.presentations`；不把旧的 `location: upper` 当作插件类别。
- 数据边界: 计时历史继续保留；新增项目采用规范化项目表，旧会话允许项目为空。
- 成功指标: 番茄钟和计时器均可在上栏显示紧凑控制器、在顶栏显示统计与项目完整视图；插件管理器只按放置位置分区，并能阻止不兼容放置。

## 背景与证据

- 当前宿主通过 `_upper_plugin()` 和 `isUpperPlugin()` 把插件永久划为轻量/非轻量两类，导致番茄钟只能使用窄条界面。
- Windows Widget 建议同一组件支持 small、medium、large，尺寸增大时保持目的不变并逐步增加信息。
- Android Widget 建议用少量覆盖尺寸范围的响应式布局，并声明网格占位约束。
- Apple WidgetFamily 由组件声明支持的尺寸族，宿主把当前尺寸传给组件，组件选择对应内容。
- 飞书工作台同时存在固定高度自适应宽度与自定义大小的小组件，说明“容器约束”和“应用身份”应分离。

## 决策

### 统一概念

- `plugin`: 应用及业务身份，例如 `study.pomodoro`。
- `slot`: 宿主位置，当前为 `top`、`upper`、`bottom`。
- `presentation`: 插件为某些位置和尺寸提供的界面变体。
- `sizeClass`: 宿主提供的空间等级，首版为 `compact`、`medium`、`large`。
- `renderer`: 插件内部渲染入口名称；同一渲染模块可按 `presentationId` 复用状态和服务。

### 清单契约

```json
{
  "contributes": {
    "presentations": [
      {
        "id": "compact",
        "label": "番茄钟",
        "slots": ["upper"],
        "sizeClasses": ["compact"],
        "renderer": "timer"
      },
      {
        "id": "full",
        "label": "番茄钟",
        "slots": ["top"],
        "sizeClasses": ["medium", "large"],
        "renderer": "timer"
      }
    ]
  }
}
```

- `id` 在单个插件内唯一。
- `slots` 非空且只能使用宿主支持的位置。
- `sizeClasses` 可省略；省略表示该位置的所有尺寸均可用。
- `renderer` 可省略并默认使用 `id`，由插件加载器解释，不由通用宿主硬编码业务。
- 同一位置存在多个候选时，宿主按实际 `sizeClass` 精确匹配，再按清单顺序回退。
- 没有兼容呈现时拒绝拖放，并显示“此插件尚未提供上栏/顶栏/下栏界面”。

### 迁移规则

- 旧 `panels.location=upper` 映射为 `slots=[upper]`、`sizeClasses=[compact]`。
- 旧 `panels.location=inspector` 映射为 `slots=[top,bottom]`，以兼容当前章节树和表格复习的实际使用方式。
- 旧 `panels.location=management` 仅作为插件内部管理面板，不参与工作区放置。
- 内置插件清单直接升级为新格式；兼容转换只服务仍未迁移的第三方插件。

### 计时插件完整视图

- 紧凑呈现: 当前任务、项目、计时数字、开始/暂停/继续/完成/放弃。
- 完整呈现: 紧凑控制区、今日总时长、完成次数、放弃次数、最近七日趋势、项目时长占比、最近记录、项目管理。
- 移动端: 统计卡片单列，图表和记录表在自身容器内响应式换行或滚动，不产生页面级横向滚动。
- 番茄钟和计时器复用同一个计时视图组件、项目服务和统计组件，仅状态机和默认时长不同。

### 项目数据模型

- `study_time_project`: `id`、`name`、`color`、`status`、`created_at`、`updated_at`。
- `study_time_session.project_id`: 可空外键；已有会话迁移后保持为空。
- 项目删除采用归档，不删除历史会话；名称同级唯一并支持重新启用。
- 统计接口以服务端聚合为准，浏览器只负责展示。

## 工作项

| ID | Action | Depends on | Artifacts | Acceptance | Rollback | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | 定义并校验 `presentations` 清单，提供旧 `panels` 只读迁移 | - | `3dStudio/tools/plugin_host.py`、契约测试 | 新旧清单均可发现；非法位置、重复 ID 和空 slots 被拒绝 | 保留旧校验分支并移除新字段解析 | completed |
| T2 | 用位置兼容性替换轻量插件分类和拖放限制 | T1 | `workbench_plugins.py`、`pluginWorkspace.mjs`、布局测试 | 任意声明 upper 的插件可进入上栏；不兼容拖放明确失败；单槽替换保持原子性 | 恢复 `_upper_plugin` 和旧前端判断 | completed |
| T3 | 向插件加载器传递位置、呈现 ID 与尺寸等级 | T1 | `pluginWorkspace.mjs`、`study-kb/web/app.js` | 同一插件切换位置后卸载旧呈现并挂载正确呈现，状态数据不丢失 | 回退为单一 panel 参数 | completed |
| T4 | 升级现有学习插件清单并移除“轻量”文案 | T1,T2 | 五个 `study.*` 插件清单、管理器 UI | 管理器仅显示位置概念；章节树、复习、指标和计时插件兼容位置准确 | 恢复旧清单并由兼容层读取 | completed |
| T5 | 新增计时项目模型、迁移和聚合接口 | T1 | `study_time.sql`、`study_time_service.py`、HTTP 路由与测试 | 旧会话完整保留；项目可增改归档；今日、七日和项目统计正确 | 使用迁移前数据库备份；移除新增表和可空列仅限测试库 | completed |
| T6 | 实现番茄钟与计时器 compact/full 响应式呈现 | T3,T5 | `studyTimers.mjs`、样式、前端测试 | 上栏控制器可操作；顶栏可看统计、项目和记录；桌面与手机无页面横向溢出 | 保留 compact 渲染路径并关闭 full 清单 | completed |
| T7 | 执行契约、布局、服务、HTTP 和前端回归 | T2-T6 | Python/Node 测试报告、计划历史 | 聚焦测试全绿；真实库不新增测试会话；现有布局自动迁移且顺序不变 | 恢复备份并逐任务撤销未通过改动 | completed |

## Closure Gates

- 插件管理页面不再出现“轻量插件”分类或限制文案。
- `study.pomodoro` 与 `study.stopwatch` 均可在上栏和顶栏之间拖动，且一次只占一个位置。
- 上栏仍只允许一个插件，新插件进入时旧插件自动进入未启用。
- 顶栏完整计时视图包含项目、今日统计、七日趋势和历史记录。
- 现有章节树、表格复习、指标及下栏插件行为不回退。
- 自动化测试通过，生产库原有计时和学习数据不被测试污染。

## 风险与缓解

- 清单双轨导致语义分叉: 发现阶段统一规范化为 `presentations`，后续代码只读取规范化结果。
- 切换位置时旧 DOM/定时器残留: 每个呈现必须返回销毁钩子，宿主在重挂载前调用。
- 完整视图范围膨胀: 首版项目只含名称、颜色和归档；任务系统不在本轮引入。
- 图表依赖增加: 首版使用原生 SVG/CSS，不引入大型图表库。
- 工作区存在未提交修改: 只修改本计划列出的文件，不重置、不覆盖、不提交无关文件。

## 历史

- (User 2026-09-30) 明确不接受轻量插件与其他插件分离，希望同一插件按空间展示不同能力。
- (Agent 2026-09-30) 参考飞书、Android、Windows、Apple 小组件模型，选定“一个插件、多呈现、宿主协商”的实现路线。
- (Agent 2026-09-30) T1-T7 completed；8 个 Python 聚焦测试、3 个计时前端测试、2 个工作区呈现测试通过，旧库迁移验证通过。
- (Agent 2026-09-30) 生产库迁移前备份至 `study-kb/data/backups/study-before-responsive-plugins-20260930-130506.sqlite`；原有 1 条计时会话保留。
