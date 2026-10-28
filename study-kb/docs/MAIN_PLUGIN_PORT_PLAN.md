# main 插件修正移植计划（2026-10-28）

## 基线和范围

- 源：`D:/system`，main `407fbc8`，包含尚未提交的插件修正。
- 目标：`D:/worktrees/system-workbench-contract-v2`，`feat/workbench-contract-v2`，`7c81df6`。
- 共同基线：`f40bbbb`。采用功能级移植；不执行整分支 merge/rebase，不覆盖 BSP 启动壳或工厂协议。
- 保留源仓库所有改动。保留目标既有数据库改动、日志、BSP 多实例和共享表格组件。
- 排除：SQLite 镜像、论文/学习导入记录、Android 正式版配置、旧四区域宿主和旧插件清单。

## 分批实施

1. [x] 审计提交、源未提交改动、目标状态及插件依赖。
2. [x] 移植 Markdown：数学符号、分数/根式/上下标、列宽分配，保持 DOMPurify 清理。
3. [x] 补齐 Markdown 样式：覆盖共享表格截断规则；测试长列宽、源码切换和净化。
4. [x] 移植计时器项目选择控件及测试；保留目标 pane container query、短条形态和既有历史编辑。
5. [x] 移植树适配器：历史栈、乐观移动/排序、保存后的局部更新和后台校验、笔记编辑器及状态提示。
6. [x] 移植树历史所需后端（history_delta、冲突检查、撤销新建时归档）及临时库回归。保留目标统一节点回归修正。
7. [x] 树适配：保留 presentationMode、大纲模式、帮助标记和通用 VM 模块装载器；清理源中不可达旧代码，补齐卸载后异步响应保护。
8. [x] 样式适配：仅移植功能相关规则；新增响应式规则使用 `@container wb-pane`，避免带回 viewport 高度/旧四区域选择器。
9. [x] 回归：全套 Study Node 测试、知识编辑 Python 测试、宿主工厂和窗格测试；单独报告环境/原有失败。
10. [x] 运行验证：更新完整缓存依赖链，重启当前 worktree 服务；核对健康、入口和实际插件清单；浏览器验收与自动化验收分开记录。

## 差异处理原则

- `app.js` / `index.html` / `studyPlugins.mjs`：保留 BSP 入口和 renderer registry，仅更新必要资源版本。
- 插件 manifests：保留目标 compact/outline/strip 及 transfer 声明。main 的旧默认声明不作为升级覆盖。
- `test_plugin_workspace.mjs`：保留目标 BSP 测试、递归 VM linker 和当前行为断言，单独迁移新功能测试。
- `studyTreeWorkspace.mjs`：不能直接覆盖；main 笔记编辑器需要配套 CSS，main 未提交测试仍断言旧 input，须按真实交互修正。
- 历史回放后端与 UI 同批交付，避免只有撤销按钮而服务不支持。
- 不提交、不推送；最终交付可审查工作区 diff 和测试结果。

## 初始验证与待查项

- 第一批 Node：67/67 通过（此时尚未移植树与计时器新控件）。
- Study Python：64 项中 63 通过；外部来源鉴权 HTTP 用例出现 WinError 10053，须用未修改基线验证归属。
- 宿主 Python：36 通过，2 项因默认解释器缺 jsonschema 未装载；优先使用已有 `.contract-venv`。
- 当前公式单测通过不代表视觉通过；CSS 与浏览器检查仍需完成。

## 来源与落点

| main 来源 | 迁入内容 | 目标落点及冲突处理 |
| --- | --- | --- |
| `f570153` | 撤销/重做、历史差量和表格换行 | `study_knowledge_edit.py` 与树适配器一起迁入；不改 schema、不覆盖复习记录 |
| `6e06e2c`、`57f0edb` | 树移动/排序的乐观更新、保存后局部显示和后台校验 | 保留 BSP viewer 状态、当前筛选；为迟到响应及卸载增加保护 |
| `6be63db` | 常用公式、数学符号和 Markdown 表格 | `studyMarkdown.mjs`、`styles.css`；保留净化，使用 Markdown lexer 避免误处理代码块和转义美元符号 |
| `1efdab1` | 列宽平衡、笔记式编辑器、计时项目选择 | 保留目标短条阈值 `maxRows:8`；补齐编辑器 CSS 和下拉浮层适配 |
| 源未提交插件补充 | 希腊字母、命令边界、编辑状态提示 | 按功能移植；源中的过期 input 断言和删除的编辑器 CSS 不照搬 |

没有把 main 的 `app.js`、旧 manifest 或测试装载器覆盖到 BSP 分支。入口只更新缓存版本 `20261028-main-port1`，依赖链覆盖 CSS、app、renderer registry、树/计时器/复习及 Markdown。

下拉菜单经真实浏览器检查发现会被 BSP `overflow:hidden` 裁剪，改为打开时挂到 body 的浮层，关闭时收回，卸载时移除及清理监听；菜单定位只使用视口边界避让，插件的形态选择仍使用窗格尺寸。新增键盘选择、Escape 和卸载检查。

## 最终验收（2026-10-28）

- Study Node：`cd study-kb/tests; npm test`，**73/73 通过**。包括真实 history 请求链、请求丢失后同 ID 重试、历史写入成功但刷新失败、默认大纲、卸载弹窗/迟到校验、项目选择和源码/净化测试。
- Study Python：`py -3 -m unittest discover -v -s study-kb/tests -p 'test_*.py'`，**68/68 通过**。所有写入用例使用临时库。
- 宿主 Python：`.contract-venv/Scripts/python.exe -m unittest discover -s tests -v`，86 项中 **85 通过、1 跳过**（可选 qrcode 依赖）。
- 宿主窗格静态合同：`node --test tests/test_pane_contract.mjs`，**1/1 通过**；`node tests/contracts/schema-parity.mjs`，**5 schemas / 28 fixtures 通过**。
- 新增 `study-kb/tests/browser_main_port_smoke.mjs`，真实 Chrome、模拟插件数据、无知识数据写入：固定浏览器 1280px，仅将窗格在 1000/380px 来回切换，Markdown 表格不横溢，窗格高度始终 600px，笔记标题字号随窗格为 28/22px；120px 高窗格中的项目菜单可实际命中和选择。
- 宿主既有 `tests/browser/paneCheck.mjs http://127.0.0.1:8033/ --edge <Chrome路径>`：实际工作台渲染、内容不裁剪、目录→网格、窗格样式、固定窗格改变浏览器宽度、分隔尺寸变化和 10 次缩放回程全部通过；控制台错误为 0。行→命令目标在当前布局不存在，已跳过；新增记录仅检查锁定对话框，未保存记录。
- 页面首次装载出现 2 个已有窗格，全部加载新版本依赖，无运行时异常。
- 服务以目标 worktree 的 `py -3 study-kb/tools/serve_workbench.py --port 8033 --no-open` 重启，PID **33408**；`/` 和 `/api/health` 返回 200，插件清单 **10 个且 ID 唯一**。保留本机监听及原鉴权模式。
- `git diff --check` 通过。源 `D:/system` 保持只读；原有 SQLite 和日志改动留在原处，没有用 main 数据覆盖目标库。没有 commit、push 或合并整个 main。

### 已确认的环境偶发项

初次全套 HTTP 测试在外部请求返回 403 时发生 Windows `WinError 10053`。在由未修改 HEAD 导出的独立临时源码快照中复现同样错误（其余运行可通过）；目标版本独立连续 3 次通过，最终全套 68/68。未通过放宽鉴权或屏蔽测试来处理此现象。

### 人工验收范围

自动化已覆盖上述桌面 Chrome 场景；真实手机 WebView 触摸体验和用户其他保存布局仍需人工试用。常用 TeX 渲染是轻量子集，未引入完整 LaTeX 引擎。

### 重跑浏览器迁移检查

启动隔离的 Chrome：`chrome.exe --headless=new --disable-gpu --no-first-run --remote-debugging-port=19283 --user-data-dir=<独立临时目录> about:blank`，在 `study-kb/tests` 运行 `node browser_main_port_smoke.mjs`。默认取 `http://127.0.0.1:8033`；可通过 `STUDY_SMOKE_URL` 指向其他测试服务。
