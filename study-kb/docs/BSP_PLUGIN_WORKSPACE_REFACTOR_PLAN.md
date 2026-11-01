> 历史记录：从本地 main 补回（2026-11-01）。本文保留当时的设计与验收信息；当前实现以插件框架、现行测试及 MAIN_PARITY_REPAIRS.md 为准，不据此恢复旧运行库或旧布局。

# 插件窗格 BSP 重构计划（评审稿）

- 状态：`draft`
- 日期：2026-10-22
- 范围：`study-kb` 学习工作台与共享 `3dStudio/3dworkbench` 宿主
- 目标：把当前固定的 `top/upper/bottom/disabled` 插件布局，重构为可拖拽、可分割、可持久化的 BSP（Binary Space Partitioning）窗格树
- 本轮边界：只形成可评审的需求基线、技术选型、迁移与验收方案；用户确认前不修改实现代码、不迁移真实数据库布局

## 1. 需求基线

### 1.1 用户可见行为

1. 所有可用插件（包括“表格”这个内置插件）默认出现在最顶部的插件栏/应用栏。顶部栏是启动器和拖拽源，不是一个内容窗格。
2. 点击顶部栏插件：若插件已有窗格，则聚焦该窗格；若尚未打开，则在主工作区创建一个叶子窗格。
3. 从顶部栏或已有窗格拖拽插件，在目标窗格的上、下、左、右四个区域释放时，分别在该叶子位置创建水平或垂直分割：
   - 上/下：水平分割；
   - 左/右：垂直分割；
   - 中心是明确的替换区，必须显示覆盖预览，避免误拖替换正在编辑的内容。
4. 拖拽过程中显示四区命中高亮和虚线/半透明预览，预览位置代表释放后新窗格的实际位置。
5. 每个相邻窗格之间只有一条 splitter。拖动 splitter 只改变该分割节点的比例，不改变其他分支的尺寸。
6. 关闭窗格后，删除对应叶子并提升唯一兄弟节点；不能留下空白区域、双重边界线或失去可见高度的嵌套容器。
7. 插件可以在任意深度重复分割；同一插件允许多个实例，每个叶子使用稳定的 `instanceId`，实例之间各自保存上下文和业务状态。
8. 移动端使用 Pointer Events：拖拽、触摸滚动、splitter 调整和点击聚焦不可互相抢占；不依赖 HTML5 drag-and-drop 才能完成核心操作。
9. 布局、激活叶子、每个 splitter 的比例、顶部 Dock 的隐藏状态和版本写入宿主后端；浏览器 localStorage 只作为短期草稿/崩溃恢复，不作为唯一真相。
10. 顶部 Dock 可以自动隐藏；鼠标靠近顶部边缘或手指从顶部边缘滑入时显示，点击/拖拽后短暂保持可见，离开后延迟收起。触摸设备必须提供边缘触摸唤出区域。

### 1.2 非目标

- 本期不把现有学习数据、复习会话、FSRS 评分或 SQL 内容迁移为另一套数据模型。
- 不把 `ops.sqlite` 当作学习主库。
- 不同时重写章节树、表格复习和 Markdown 渲染业务；它们只实现宿主规定的挂载/销毁/尺寸变化接口。
- 不直接引入 React/React Mosaic 重写现有 vanilla JS 工作台。

## 2. 当前代码事实与问题

| 位置 | 当前事实 | 重构影响 |
| --- | --- | --- |
| `3dStudio/3dworkbench/web/pluginWorkspace.mjs` | `layout.groups.top/upper/bottom/disabled` 平面数组；上栏单槽；插件按 slot 挂载 | 需要改为递归布局树和统一叶子生命周期 |
| `3dStudio/3dworkbench/web/workbenchPlatform.mjs` | 有固定左侧折叠、指标区、右下检查器和单层 splitter | 宿主应只负责外壳、Dock 和 BSP 渲染，不再把窗格语义写死在平台工具中 |
| `study-kb/web/index.html` | `data-pane`、`metric-area`、`inspector-pane` 等固定 DOM 区域 | 保留顶栏和根工作区容器，固定上下/左右内容区改为 BSP mount point |
| `study-kb/web/app.js` | `createPluginWorkspace` 与表格/指标/检查器耦合 | 迁移为 `pluginHost` + `layoutStore` + 业务插件 renderer |
| `study-kb/tools` / `3dStudio/3dworkbench/python` | 已有插件清单、布局 revision 和 API | 复用 revision/冲突检查，扩展布局树 schema 与校验 |
| `study-kb/tests/test_plugin_workspace.mjs` | 测试断言三/四组布局和 zone drop | 先增加树模型测试，再迁移 DOM/E2E 测试，旧断言不能直接删除 |

## 3. 开源方案调查（2026-10-22）

| 项目 | 许可证/形态 | 已确认能力 | 与当前工作台的适配判断 |
| --- | --- | --- | --- |
| [Golden Layout](https://github.com/golden-layout/golden-layout) | MIT，原生 JavaScript | 多窗格、拖放重排、触摸、保存/加载布局、主题化、响应式 | 最接近需求，可作为交互和序列化参考；直接替换会引入其组件/标签模型，需改造现有 vanilla 插件生命周期 |
| [FlexLayout](https://github.com/caplin/FlexLayout) | MIT，React | row/tabset/tab 树、边缘 docking、拖放、移动端、布局 JSON | 能力完整，但当前仓库不是 React，整站迁移成本过高；只参考 JSON 节点和边缘 drop 语义 |
| [react-mosaic](https://github.com/nomcopter/react-mosaic) | Apache-2.0，React | tiling 树、拖拽调整、拖拽重排、触摸、受控树模型 | BSP/树模型清晰，但 React 绑定与现有宿主不兼容；参考其 split tree 与路径操作 |
| [Dockview](https://github.com/mathuo/dockview) | 核心包 MIT；企业包另有商业许可 | split/grid、tab/group docking、触摸、序列化、浮动窗格 | 功能强但模型更偏 IDE 标签组；需严格区分核心包与 enterprise 许可，不作为首版依赖 |
| [Split.js](https://github.com/nathancahill/split) | MIT，原生 JavaScript | 轻量 splitter、Flex/Grid 尺寸计算 | 只能解决尺寸调整，不能解决拖拽分割、插件树或生命周期；可作为局部实现参考，不解决总体问题 |

### 结论

首版采用“**自有轻量 BSP 树 + Pointer Events + CSS Grid/Flex**”，算法和交互参考 Golden Layout、react-mosaic；不引入 React，也不把 Golden Layout 整体嵌入宿主。理由是现有宿主已经是 vanilla JS，插件 renderer、SQL 方案和复习会话都依赖当前 `loadPanel`/`dispose` 约定；保留宿主 API 能把风险限制在布局层。若 POC 证明拖放可访问性和移动端行为不足，再以 Golden Layout 做隔离式 A/B 原型，而不是直接替换生产宿主。

## 4. 目标架构

### 4.1 数据模型

```json
{
  "schema": "workbench.layout.bsp/v1",
  "revision": 12,
  "activeLeaf": "leaf-review-2",
  "dock": { "visible": false, "autoHide": true, "revealEdgePx": 18, "hideDelayMs": 1200 },
  "root": {
    "kind": "split",
    "orientation": "horizontal",
    "ratio": 0.62,
    "first": { "kind": "leaf", "id": "leaf-table", "pluginId": "official.table", "instanceId": "official.table#1" },
    "second": {
      "kind": "split",
      "orientation": "vertical",
      "ratio": 0.55,
      "first": { "kind": "leaf", "id": "leaf-tree", "pluginId": "study.node-tree", "instanceId": "study.node-tree#1" },
      "second": { "kind": "leaf", "id": "leaf-review-2", "pluginId": "study.review-table", "instanceId": "study.review-table#2" }
    }
  }
}
```

- `split.orientation=horizontal`：上/下两个子区域。
- `split.orientation=vertical`：左/右两个子区域。
- `ratio` 始终限制在 `0.15..0.85`，并结合子树最小尺寸进行二次裁剪。
- 只有 `leaf` 持有插件实例；`split` 只持有方向、比例和子节点。
- 顶部插件栏保存的是插件清单和顺序，不是布局树中的第三种窗格。
- `pluginId` 是插件身份；`instanceId` 是业务实例身份；`leaf.id` 是布局叶子的稳定标识，便于 focus、日志和迁移。
- 同一个 `pluginId` 可以有多个 `instanceId`；实例化时由宿主生成，不允许用插件名称作为唯一 DOM id。

### 4.2 核心纯函数

新建无 DOM 的 `bspLayout.mjs`，至少提供：

- `createLeaf(pluginId)`
- `splitLeaf(root, leafId, direction, pluginId, instanceId)`
- `replaceLeaf(root, leafId, pluginId, instanceId)`
- `removeLeaf(root, leafId)`（删除后提升兄弟）
- `moveLeaf(root, sourceLeafId, targetLeafId, direction)`
- `updateRatio(root, splitId, ratio)`
- `findLeaf(root, leafId)`、`walkLeaves(root)`、`validateLayout(root, registry)`
- `normalizeLayout(root)`（清理空 split、重复插件和超界比例）

这些函数必须是纯函数、可序列化、可单元测试；DOM 事件层只把命中结果转换成树操作。

### 4.3 宿主生命周期

插件 renderer 统一接收：

```js
{
  pluginId, leafId, host, context,
  size: { width, height, cols, rows },
  onFocus, onClose, onRequestRefresh
}
```

宿主在叶子创建、替换、尺寸跨变体边界和删除时调用对应 mount/update/dispose。现有 `ResizeObserver` 继续保留，但观察对象改为叶子容器，不再观察固定 `top/upper/bottom` 区域。

### 4.4 拖拽命中与预览

1. 拖拽开始时登记 `sourcePluginId/sourceLeafId`，给所有可接收叶子创建 overlay。
2. 根据目标叶子的 `getBoundingClientRect()` 计算局部坐标：边缘 25% 为四个 split zone，中间 50% 为 replace zone。
3. `pointermove` 只更新一个预览层，不改数据库、不重挂载插件。
4. `pointerup` 才提交 `moveLeaf`/`splitLeaf`/`replaceLeaf`，服务端成功后再替换树；失败则保留原树并显示错误。
5. `Escape`、pointercancel、离开窗口和触摸滚动取消预览。
6. 键盘可通过“移动到上/下/左/右”命令完成同样的树操作，避免只支持鼠标。

## 5. 迁移策略

### 5.1 兼容读取

服务端继续读取旧的 `groups`：

- `top` 按原顺序转换成根树的初始叶子序列；
- `upper` 和 `bottom` 作为迁移时的相邻叶子；
- `disabled` 只保留在顶部插件栏的“未打开”状态，不自动创建叶子；
- 同一插件重复出现时生成不同 `instanceId`，并记录迁移警告。

迁移结果写入 `schema=workbench.layout.bsp/v1`，原 JSON 作为 `legacyGroups` 备份字段或单独审计记录，便于回滚。

### 5.2 API 基线

- `GET /api/plugin/layout`：返回 `{schema, revision, root, activeLeaf}`。
- `POST /api/plugin/layout`：带 `revision` 的整棵树原子提交；冲突返回 `409`，不覆盖服务端新版本。
- `POST /api/plugin/layout/command`：可选的命令接口，命令为 `open/split/replace/move/close/resize/focus`，服务端先校验插件权限和树不变量，再生成新 revision。
- 旧客户端在迁移窗口内仍可读取 `groups` 投影；新客户端只写 BSP，不再写平面数组。

### 5.3 回滚

- 服务端保留上一版布局快照和 `legacyGroups`。
- 迁移失败时继续返回旧 groups，前端保持旧布局渲染。
- 新宿主功能通过 feature flag 开启；关闭 flag 不删除新数据，只切回兼容投影。
- 不回滚学习卡片、复习会话、评分和 SQL 配置。

## 6. 分阶段实施任务与验收

| ID | Action | Depends on | Artifacts | Acceptance | Rollback | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T0 | 冻结需求基线、确认顶栏是启动器、确认四区 drop 语义和中心区行为 | - | 本计划评审记录 | 用户确认中心替换、多实例和 Dock 自动隐藏；未确认不改实现 | 保持当前旧布局 | completed |
| T1 | 建立 `bspLayout.mjs` 纯树模型和 schema 校验 | T0 | `3dStudio/3dworkbench/web/bspLayout.mjs`、`study-kb/tests/test_bsp_layout.mjs` | split/move/replace/remove/ratio/normalize 和四区命中测试通过 | 不接宿主，旧逻辑继续使用 | completed |
| T2 | 增加服务端 BSP schema、revision 冲突和旧 groups 兼容投影 | T1 | `workbench_plugins.py`、API/schema、Python 测试 | 旧数据可读；新树原子保存；并发旧 revision 返回 409；备份可恢复 | feature flag 关闭读旧 groups | pending |
| T3 | 把顶部栏改为插件 Dock/拖拽源，表格注册为内置插件 | T1,T2 | `index.html`、`pluginWorkspace.mjs`、CSS、插件 manifest | 所有可用插件有图标/文本/无图标回退；点击聚焦或创建叶子；禁用数据不受影响 | 恢复旧导航与 groups 投影 | pending |
| T4 | 实现 BSP renderer、四区 drop overlay 和 Pointer Events | T1,T3 | `pluginBspHost.mjs`、`pluginWorkspace.css` | 上下左右释放生成正确方向；拖拽预览不重挂载；触摸/取消/键盘路径可用 | 仅显示旧固定布局，不写新树 | pending |
| T5 | 实现 splitter、最小尺寸、关闭提升兄弟和响应式变体 | T4 | 宿主 CSS/resize 逻辑、布局持久化 | 单条边界；相邻窗格互不挤压；ratio 限制；手机无双滚动条 | 回退固定三列/两行 CSS | pending |
| T6 | 迁移表格、章节树、复习、指标、计时器和官方插件 renderer | T4,T5 | `study-kb/web/app.js`、插件适配器 | 插件业务功能与复习会话、SQL、Markdown、刷新和语言切换不回归 | 逐插件切回旧 `loadPanel` | pending |
| T7 | 自动化回归和 A/B 对照 | T2-T6 | Node/Python/Playwright tests、截图证据 | 见第 7 节全部门禁通过；桌面/平板/手机尺寸均无空白或溢出 | feature flag 关闭，保留证据 | pending |
| T8 | 灰度启用、用户验收、文档和提交 | T7 | `study-kb/docs/REVIEW.md`、发布记录 | 用户完成拖拽四向、调整比例、关闭/恢复、刷新/重启验证 | 恢复旧布局 flag 和快照 | pending |

## 7. A/B 与回归验证

### A 版本（当前实现）

- 记录旧的 `groups` JSON、插件顺序、当前激活页和各区域尺寸。
- 覆盖表格、章节树、复习表、计时器、插件管理、SQL 方案和刷新。

### B 版本（BSP 实现）

自动化必须验证：

1. 迁移后插件集合和顺序不丢失；旧 groups 可逆投影。
2. 对任意叶子执行上/下/左/右分割，方向、比例和叶子顺序正确。
3. 连续分割 4、8、16 个叶子后，所有叶子均有可见矩形，任何矩形宽高不小于最小尺寸。
4. 拖动某条 splitter 时，只有同一 split 的两个子树尺寸变化；其他分支 rect 不被修改。
5. 删除叶子后自动提升兄弟；最后一个叶子关闭时显示空工作区和顶部 Dock，不生成空 split。
6. 拖拽预览阶段不调用 `loadPanel`/SQL；释放成功只发生一次布局提交。
7. 页面刷新、服务端重启、revision 冲突、网络失败后，布局和插件业务状态可恢复。
8. 375×812、768×1024、1280×800、1920×1080 下无横向溢出、无双重滚动条、顶部 Dock 可横向滚动。
9. 键盘焦点、ARIA separator、按钮名称、Escape 取消和无障碍对比度通过。
10. 复习会话、评分、SQL 配置、树图根节点/缩放/滚动位置不因布局操作被重置。

建议命令（以仓库实际脚本为准）：

```powershell
$env:PYTHONPATH = "$PWD/study-kb/tools"
python -m unittest discover -s study-kb/tests -v
npm --prefix study-kb/tests test
npm --prefix study-kb/tests run test:e2e -- --grep "BSP|plugin|workspace"
```

## 8. 性能、可靠性和安全约束

- 拖动 splitter 使用 `requestAnimationFrame` 合并布局更新，pointermove 不触发服务端请求。
- 只有 pointerup/键盘命令提交布局；提交使用 revision，不能静默覆盖并发修改。
- 每次插件挂载必须有 dispose；移除叶子后 ResizeObserver、事件监听和定时器全部释放。
- 插件内容仍通过现有 manifest、权限和宿主 API 加载；布局树不能授权插件访问任意 DOM 或数据库。
- 服务端校验最大叶子数、最大深度、ratio 范围、插件存在性和唯一性，拒绝恶意深树/超大 payload。
- SQL、复习、评分和知识树写入继续走既有命令/审计接口，布局提交不能携带任意 SQL。

## 9. 待用户评审的决策点

1. 中间 50% 释放执行替换；替换前显示目标叶子和插件名称，必要时要求确认。
2. 同一插件允许多实例；每个实例持有独立 `instanceId`，实例级状态由插件声明哪些字段可复制。
3. 顶部 Dock 允许自动隐藏；鼠标边缘唤出和触摸边缘唤出都必须支持，隐藏不等于禁用插件。
4. 继续采用自有 BSP 树，不把 Golden Layout/FlexLayout 作为首版运行时依赖。

## 10. 研究来源

- Golden Layout README：<https://github.com/golden-layout/golden-layout>
- FlexLayout README：<https://github.com/caplin/FlexLayout>
- react-mosaic README：<https://github.com/nomcopter/react-mosaic>
- Dockview README：<https://github.com/mathuo/dockview>
- Split.js README：<https://github.com/nathancahill/split.js>

以上来源用于确认能力、许可证和模型思路；不代表本计划直接复制其代码或引入其全部依赖。
