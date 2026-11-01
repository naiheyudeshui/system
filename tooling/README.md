# Study 资源与说明书构建操作

此目录是产品组合入口。`product.json` 选择资源，`dependencies.lock.json` 锁定共享宿主准确 commit；`build.py` 组装/校验，`manuals.py` 重建并可部署说明书。新输出目录必须不存在。以下从 system 根执行，`<host>` 替换成实际 3dStudio 检出路径；使用已安装宿主 `tooling/build-manual/requirements-lock.txt` 的 Python 环境。

```powershell
python tooling/manuals.py --studio-root <host> --output build/manual-release-new --deploy
python tooling/build.py doctor --studio-root <host> --allow-dirty
python tooling/build.py stage --studio-root <host> --platform web --allow-dirty --output build/runtime-web-new
python study-kb/tools/assemble_android_assets.py --studio-root <host> --allow-dirty --output build/runtime-android-new
python -S tooling/build.py verify --output build/runtime-web-new
python -S tooling/build.py verify --output build/runtime-android-new
```

第一条顺序构建公共手册、带锁定公共快照的树插件包、Study 产品手册。输出 `release.json` 记录身份/revision和树插件 ZIP SHA-256。`--deploy` 仅替换生成的三处目录，并将已有版本保存在同级 `*.previous-*`，不删除历史生成物：

| 内容 | 部署根 | 产品 runtime 内位置 |
| --- | --- | --- |
| 公共说明 | host `3dworkbench/manual-publications/workbench` | `3dStudio/3dworkbench/manual-publications/workbench` |
| Study 说明 | system `study-kb/manual-publications/study` | 同名产品路径 |
| 树参考完整包 | host `plugin-publications/official.tree-view` | `3dStudio/plugin-publications/official.tree-view` |

树参考包被携带用于离线发布/验收，不会自动安装、启用或替换 Study 章节树插件。当前交付插件的说明分别由公共与产品手册覆盖。生成目录已被 Git 忽略，迁移机器需要重建，不能只复制源码后假定发布物存在。

公共 Markdown 改动后先单独构建公共手册，审阅新 revision，并更新树插件 `docs/manual.json` 中的依赖锁，再执行完整构建。锁不匹配会失败；脚本不自动更改作者锁。构建器、合同与依赖环境来自明确的可信宿主检出，不在安装插件时执行。

`--allow-dirty` 明确标记开发输入。当前共享工作树有多个任务的未提交改动，故这些产物为 `development:true`。正式发布需先保存获授权变更、更新准确宿主 commit 锁并通过干净构建；这里不替用户提交或推送。iOS 仍为 planned。

文档更新后的服务须重启，才能替换启动时校验的发布快照。保留原 `--db` 等运行参数，不把重建文档当作迁移数据库。浏览器刷新载入新前端；缓存的旧插件全文在升级/停用时由宿主撤下。

验收命令在 host 根执行：

```powershell
python tests/browser/unified_manual_check.py --runtime <system>/build/runtime-web-new --report reports/manual-web-new.json --inventory reports/coverage-new.json
python tests/browser/unified_manual_check.py --runtime <system>/build/runtime-android-new --report reports/manual-android-new.json
python tests/browser/manual_lifecycle_check.py --report reports/manual-lifecycle-new.json
python tests/browser/manual_check.py --package <system>/build/manual-release-new/tree/package --screenshot reports/manual-site-new.png
```

验收使用真实前端/宿主资源、内存布局与虚构数据；生命周期测试使用临时 SQLite，不打开真实学习库。Web/Android 两份 runtime 应逐文件相同，平台字段不同导致总戳不同。资源组装与浏览器触屏模拟不能代替 APK/原生下载/通知/真实设备测试。

人从软件内问号或网页 `manual/index.html` 阅读；Agent 从同一 manifest 的规范目录读取 `llms.txt`、`llms-full.md` 与 sources。维护规则见 host 的 `manual-standard.md`、`manual-api.md` 和构建工具 README，避免另写一套长期失配的正文。
