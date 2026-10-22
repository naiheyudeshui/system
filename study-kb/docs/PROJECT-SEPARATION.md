# Study Knowledge Base 与 3dStudio 的边界

## 启动入口

Study Knowledge Base 必须使用：

```powershell
py -3 study-kb/tools/serve_workbench.py --host 0.0.0.0 --port 8033 --no-open --trusted-lan-write
```

它加载 `study-kb/web`、`study-kb/data/study.sqlite` 和 study 插件注册表。

`3dStudio/tools/ops.py serve-workbench` 是通用 3dStudio 工作台入口，默认面向 `ops.sqlite`，不能作为 Study Knowledge Base 的启动命令。

## SQL 与插件

两者属于不同层次：

| 内容 | 归属 | 作用 |
|---|---|---|
| 学习树、知识卡片、复习会话、SQL 视图 | `study.sqlite` | 业务数据与查询结果 |
| `core.table` | BSP 内置组件 | 承载 SQL 表格、导航、字段检查器和表格操作 |
| `core.metrics` | BSP 内置组件 | 承载学习指标 |
| `study.node-tree`、`study.review-table`、计时器、库同步等 | 插件 | 业务功能面板 |
| `official.*` | 官方插件 | 通用打印、触发器、二维码等功能 |

插件布局只保存 BSP `tree`。`pluginId` 表示插件能力，`instanceId` 表示一次显示实例；同一插件可以在树中出现多个实例。

## 运行时规则

- SQL 数据不通过插件布局复制；表格数据由 `core.table` 从 study API 读取。
- 插件不直接拥有学习数据库表，必须通过宿主命令和数据接口访问。
- 旧 `groups` 只用于服务端一次性迁移和兼容读取，浏览器运行时不再根据 `top/upper/bottom/left/right` 渲染。
- Dock 是插件启动器和拖拽源；拖到叶子四周 25% 创建分割，拖到中央替换叶子。
- Study UI 的页面标题、静态资源版本和服务日志都明确标识 Study Knowledge Base，避免与通用 3dStudio 工作台混淆。
