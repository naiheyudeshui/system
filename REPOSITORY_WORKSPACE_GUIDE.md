# Study 与公共宿主交接说明

整理日期：2026-11-01。日常工作入口为 `D:\system`；`D:\system\3dStudio` 是重新克隆的独立宿主仓库。两处均有完整的 `.git` 目录，使用 `feat/workbench-contract-v2`，分别推送到 `naiheyudeshui/system` 与 `naiheyudeshui/3dStudio`；运行不依赖旧宿主工作树。旧 worktrees 保留作回退，其中 Study 工作树现为 detached HEAD；`D:\system\.git` 仍管理已有 Study worktrees，不得手动删除。

## 内容分类

| 内容 | 位置 | 用途与处理 |
| --- | --- | --- |
| Study 前端与业务插件 | study-kb/web、study-kb/plugins | 正常运行源码，保留 |
| Study API、数据规则与结构 | study-kb/tools、study-kb/schema | 正常运行、迁移和备份入口，保留 |
| 公共工作台 | 3dStudio/3dworkbench、packages、plugins、tools、web | 独立仓库维护，由 Study 组合使用 |
| Android 壳与构建 | study-kb/android、tooling | 保留源码、锁文件和构建脚本；build、生成 runtime 不上传 |
| 正式自动测试 | study-kb/tests、3dStudio/tests | 保留 unittest/Node/合同测试、CI 浏览器脚本及其 fixture；不是临时垃圾 |
| 用户/开发说明 | README、study-kb/docs、插件 docs | 保留手册源；已部署 manual-publications 是运行时阅读资源，不误删 |
| 当前本地资料 | study-kb/data/study.sqlite、study.files | 使用当前分支库；附件随本地数据交付，不作为源码提交；不得删除或与 ops.sqlite 混用 |
| 学习原始资料与文稿 | 根目录 PDF/Word、论文、.cursor/skills/study/records | 保留，不能因“测试”字样而删除 |
| 临时验收内容 | 会话 browser_tree_plans 场景、截图/JSON/日志、旧 build、空的嵌套 study-kb/study-kb | 从源码目录移出，已归档，可恢复 |

## 启动与验证

在 `D:\system` 使用宿主环境执行：

```powershell
.\3dStudio\.contract-venv\Scripts\python.exe study-kb/tools/serve_workbench.py --port 8033 --no-open
```

浏览器打开 `http://127.0.0.1:8033/`。该环境是本机依赖，不随 Git 上传。新机器先创建 Python 虚拟环境并安装 `3dStudio/requirements.txt`；构建说明书还需 `3dStudio/tooling/build-manual/requirements-lock.txt`。发布手册缺失时使用 `tooling/manuals.py --studio-root 3dStudio --output <全新目录> --deploy` 重建。

本次交付服务从此目录监听 `0.0.0.0:8033`，沿用可信局域网写入模式。运行日志在外部归档的 `service.stdout.log` / `service.stderr.log`。插件目录查询会更新数据库中的安装路径和登记时间，因此运行期间 `study-kb/data/study.sqlite` 出现 Git 修改状态属于运行数据变化；本次逐表核对只有 `workbench_plugin` 变化，知识、评分及其他数据不变。不要为清空 Git 状态回滚正在使用的数据库。

```powershell
npm ci --prefix study-kb/tests
npm test --prefix study-kb/tests
.\3dStudio\.contract-venv\Scripts\python.exe -m unittest discover -s study-kb/tests
npm test --prefix 3dStudio/tests
.\3dStudio\.contract-venv\Scripts\python.exe -m unittest discover -s 3dStudio/tests
```

测试仅使用临时数据库。不要以真实 8033 运行修改数据的验收脚本。Android 自测所需的正式测试和 fixture 保留；本轮未重新生成 APK。

`tooling/dependencies.lock.json` 锁定本次推送的宿主 commit。两仓分别执行 Git 操作；父仓库忽略 3dStudio 工作树，不将宿主源码重复提交。

## 备份和恢复

本轮外部归档为 `D:\system-handoff-archive\20261101-131549`：`previous-system` 保存旧 D:\system 的源码、文稿和本地数据（不复制 .git、依赖、可重建构建缓存或外链）；`current-data` 保存当前两库与附件；`temporary-manifest.csv` 逐条记录移出的路径。旧 D:\system 未提交内容另保存在本地 `backup/pre-handoff-main-wip-20261101` 分支，没有混入产品分支。

`runtime-transfer.csv` 记录本机运行资源的迁入位置。`current-data/study-after-startup.sqlite` 是启动验证后的 SQLite 一致性副本；分支中保留用户选择的启动前快照。迁移后的测试日志以 `final-` 开头，717 个资源的验证输出在 `final-web-runtime`，均放在仓外。

用户已明确选择继续使用当前分支学习库，未合并旧库或覆盖手机主库。旧库、旧评分和原始资料仍可从归档恢复。恢复时停止服务，按中央备份接口恢复整库及附件；不能只拿旧 SQLite 覆盖新库而漏掉附件。

后续截图、运行日志和临时组装输出写到仓外或已忽略的 build/reports；需要长期保存的结论写成正式文档。不要使用 `git clean -fdx` 清理，因为它会删除附件、环境、资料与本地构建。
