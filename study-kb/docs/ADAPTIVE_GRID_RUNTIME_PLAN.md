# 方格自适应构件运行时实施计划

- ID: `plan.study-adaptive-grid-runtime`
- 仓库: `D:/system`、`D:/system/3dStudio`
- 创建日期: `2026-09-30`
- 状态: `completed`

## 目标与边界

- 用构件自身容器的实际宽高换算方格，而不是由顶栏、上栏、下栏硬编码尺寸等级。
- 插件声明不同方格范围下的呈现变体；没有专用变体时使用默认呈现，不因位置拒绝放置。
- 上栏仍是单槽，顶栏和下栏仍保留现有导航与生命周期语义。
- 核心顶栏和表格区域使用同一响应式原则；本轮重点完成手机顶栏和插件宿主，表格内部后续可继续注册更多变体。

## 方格规范

- 参考单元: `72 × 30 CSS px`。
- 列数: `max(1, floor(width / 72))`。
- 行数: `max(1, floor(height / 30))`。
- 宿主同时传递像素、方格、横纵方向和宽高等级。
- 用 `ResizeObserver` 监听构件容器；只有选中的变体发生变化才重挂载，普通尺寸变化只更新上下文和 CSS 数据属性。

## 清单契约

```json
{
  "presentations": [
    {
      "id": "timer",
      "label": "番茄钟",
      "renderer": "timer",
      "default": true,
      "variants": [
        {"id": "micro", "mode": "micro", "when": {"maxCols": 5, "maxRows": 4}, "priority": 40},
        {"id": "strip", "mode": "compact", "when": {"minCols": 6, "maxRows": 4}, "priority": 30},
        {"id": "phone", "mode": "phone", "when": {"maxCols": 7, "minRows": 5}, "priority": 20},
        {"id": "full", "mode": "full", "when": {"minCols": 8, "minRows": 5}, "priority": 10}
      ]
    }
  ]
}
```

- `default` 指定无变体匹配时的默认构件。
- `variants.when` 支持 `minCols`、`maxCols`、`minRows`、`maxRows`、`orientation`。
- `priority` 从高到低选择；相同优先级按声明顺序。
- 旧 `slots` 与 `sizeClasses` 继续读取，规范化为变体；新清单不依赖位置。

## 工作项

| ID | Action | Depends on | Artifacts | Acceptance | Rollback | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | 增加方格换算、条件匹配和清单校验 | - | `plugin_host.py`、`pluginWorkspace.mjs` | 指定像素可稳定得到格数并选中预期变体 | 保留旧 `presentationFor` | completed |
| T2 | 用 `ResizeObserver` 驱动构件重协商 | T1 | `pluginWorkspace.mjs`、测试 | 容器跨边界时切换模式，同一边界内不重挂载 | 关闭观察器，回退位置映射 | completed |
| T3 | 迁移学习插件并提供默认回退 | T1 | `study.* /plugin.json`、`app.js` | 所有插件可放任意启用区；缺少窄版时显示默认界面 | 恢复 slots 限制 | completed |
| T4 | 为计时器增加 micro、strip、phone、full | T2,T3 | `studyTimers.mjs`、`styles.css` | 手机、上栏和桌面分别显示合适布局 | 只保留 compact/full | completed |
| T5 | 重构手机顶栏为品牌工具行和滚动导航行 | - | `workbench.css`、`index.html` | KB、精简标题、主题/语言/刷新同排；功能导航可横向滚动 | 恢复纵向顶栏 | completed |
| T6 | 执行自动化和手机浏览器回归 | T2-T5 | Node/Python 测试、截图 | 390px、860px、桌面宽度无页面横向溢出且功能可达 | 逐项撤销未通过变体 | completed |

## Closure Gates

- 上栏、顶栏、下栏不再决定构件模式，只决定放置和交互位置。
- 浏览器缩放、手机横竖屏和工作区尺寸变化会重新选择构件变体。
- 未提供窄版的表格复习、章节树等仍可放入上栏，并使用默认界面和容器内部滚动。
- 手机顶栏高度显著降低，品牌工具同排，功能导航独立横向滚动。
- 自动化测试通过，桌面现有交互不回退。

## 历史

- (User 2026-09-30) 确认执行方格自适应机制，并要求同时修复手机顶栏。
- (Agent 2026-09-30) 创建实施计划，开始 T1。
- (Agent 2026-09-30) T1-T6 completed；8 个 Python、5 个方格宿主、4 个计时前端测试通过。浏览器连接不可用，手机验收由 360×600 方格模拟、动态 ResizeObserver 边界测试及静态溢出审查完成。
