# Study 产品结构与跨平台复用说明

更新：2026-10-30。本文面向维护者和 Agent，说明代码应该由谁拥有、现有目录怎样对应这些责任，以及本轮已经落地的可移植构建基础。用户学习操作仍从 [system README](../../README.md) 和 [Study 入口](../README.md) 开始。

## 1. 一个产品，多个平台壳

Study 是学习产品，3dStudio 是公共工作台。Android 是运行该产品的一种壳；未来 iOS 是另一种壳。更换壳不应要求重写树图、表格、帮助文档或评分规则。

以“打开树图的完整帮助”为例：插件声明当前 target；宿主定位文档章节；文档服务读取包内正文；平台只在用户选择导出或分享文件时参与。插件不用分别实现 Android 帮助和 iOS 帮助。

以“恢复番茄钟”为例：计时业务保存开始/截止/暂停状态；前端据此显示剩余时间；平台只负责已获权限的通知和生命周期事件。后台 tick 次数不能成为业务时间的事实来源。

## 2. 五个层次与当前落点

| 层次 | 当前主源 | 负责什么 | 不能承担什么 |
| --- | --- | --- | --- |
| 公共宿主/合同 | 3dStudio 的 `3dworkbench/`、`packages/contracts/` | BSP、pane 尺寸、插件生命周期、主题、帮助、数据/配置能力 | Study 数据规则、Android Java 类、真实学习库 |
| 产品组合与前端 | system 的 `study-kb/web/`、`plugins/`，新增 `tooling/product.json` | 选择插件、产品入口、复习/树/计时展示、产品文档登记 | 私自打开 SQLite、按 OS 复制整套业务 |
| 产品业务服务 | `study-kb/tools/`、`schema/` | 知识、评分/幂等、会话、计时、迁移和库互换 | 依赖某台电脑的盘符、Java 对象或固定资源目录 |
| 平台适配器 | Android 现有桥；未来独立桥接实现 | 文件、分享、通知、生命周期、安全区、诊断导出 | 绕过业务校验直接改评分或任意执行脚本 |
| 平台壳与发布 | `study-kb/android/`；未来 iOS 工程 | 启动运行时、资源与可写目录、签名、平台安装 | 维护另一份手工复制的插件/帮助源码 |

这是责任划分，不代表已把现有代码移动成五个新目录。本轮保留 `web/tools/schema/plugins/android` 路径，避免在运行中的业务修复期间批量搬文件。后续抽取以独立接口、测试和发布边界为条件，不只为目录看起来整齐。

依赖方向应为：产品组合→公共宿主，产品前端→产品 API，平台壳→公共运行资源。共享宿主不得反向 import Study。跨层写入通过明确接口，不能让“帮助注册”同时拥有数据写权限。

## 3. 为什么现在不容易直接搬到另一台机器

本轮核对的现状：

| 证据 | 现状 | 本轮处理 |
| --- | --- | --- |
| `tools/serve_workbench.py` | 默认通过仓库内 `3dStudio/` 寻找共享主源，要求数据库存在 | 暂不改运行入口；新增显式依赖路径的产品组装入口 |
| `tools/assemble_android_assets.py` | Android 专用输出、删除重建、自动打包本地 SQLite | 新命令输出到全新目录、默认排除全部数据库；旧 Gradle 入口未切换 |
| `web/app.js`、`studyPlugins.mjs` | 产品入口已接宿主，但当前仍存在正在修复的业务 WIP | 本轮不重写这些文件 |
| `android/.../MainActivity.java`、`bootstrap.py` | Android WebView 和 Python 服务有专用启动/主题桥 | 保留；不冒称已经具备通用 NativeBridge 或 iOS |
| `.gitignore` 与 Git 跟踪状态 | 学习镜像曾被跟踪，历史 README 有不一致说明 | 不自动删库/改历史；新 stage 明确不把学习库当资源 |

现有全部跨平台要求及 iOS 延后决定仍以 [跨平台准备说明](CROSS-PLATFORM-READINESS.md) 为准。这里落实的是产品结构和资源基础，不另复制签名、账号或真机准备计划。

## 4. 本轮新增的实际工程入口

```text
system/
  tooling/
    product.json                 产品身份、平台状态、资源映射、文档来源
    dependencies.lock.json       共享宿主仓库与完整 commit
    build.py                     doctor / stage / verify
  study-kb/
    web/ tools/ schema/ plugins/  现有业务主源，保持位置
    docs/manual/                 产品说明作者源
    android/                     现有 Android 壳
```

`product.json` 是当前 runtime 资源组装的事实来源；公共宿主的 `products/study/product.json` 是早期工厂样例描述，不自动与本文件同步。后续工厂/Android 接线应消费本产品发布描述，不再维护第三套复制列表。

依赖锁只有仓库地址与完整 commit，不保存某人的绝对路径。选择宿主路径的优先顺序为 `--studio-root`→`STUDY_STUDIO_ROOT`→开发环境现有 `3dStudio/`。前两种不要求创建 Junction；路径改变不改变产物身份。

本轮锁定的宿主 commit 是已存在的代码基准。新规范/合同仍在本次未提交 diff 中，因此只能通过 `--allow-dirty` 作开发验证；从该 commit 的干净旧检出尚不具备新合同，不能当作已可复建发布版。待本批变更获得提交授权并保存后，按实际新宿主 commit 更新锁并验证干净构建。禁止为了让检查通过把旧锁静默改成 HEAD。

## 5. 三个命令怎样用

从 system 根目录执行，Python 环境需安装共享宿主的 contract 依赖；Node/Android SDK 不是资源 doctor 的前置。下面 `../3dstudio-workbench-contract-v2` 只是一个相邻检出的示例，可替换为任意显式路径。

```text
python tooling/build.py doctor --studio-root ../3dstudio-workbench-contract-v2 --allow-dirty
python tooling/build.py stage --studio-root ../3dstudio-workbench-contract-v2 --platform web --allow-dirty --output build/study-runtime-dev-01
python tooling/build.py verify --output build/study-runtime-dev-01
```

doctor 校验产品/锁合同、宿主准确 commit、平台是否已支持、资源/入口是否存在以及目标冲突。它只读，不安装、不启用插件、不执行数据迁移。

stage 将选定代码资源放入一个必须不存在的新目录，生成 JSON 文件清单、文本清单和 SHA-256 总戳。每项记录 bytes、SHA-256、owner 和拥有者仓库相对 source；不记录本机路径。它不删除、覆盖旧产物。

verify 只需 Python 标准库与产物目录，可在没有宿主检出的另一台机器执行；校验每个文件、额外/缺失文件和总戳。它证明资源与清单一致，不证明作者可信，也不证明业务已运行。

`--allow-dirty` 只允许未提交开发输入，始终标记 `development:true`；它不能绕过错误宿主 commit。默认模式拒绝脏输入。`--platform ios` 当前明确失败，不创建看起来成功的 iOS 包。`--platform android` 只选择 Android 对应的共享资源 stage，不调用 Gradle、不生成 APK。

注意：stage 保留 runtime 内的 `study-kb/` 与 `3dStudio/` 相对布局，便于服务加载；它是生成物。文档生成与发布现已接线，doctor 验证已部署文档是否齐全，但自身不执行构建，因此字段 `manualPublicationsBuilt:false` 表示“本次 doctor 未构建”，不表示部署物不存在。

## 6. 数据和配置怎样专业化

| 状态 | owner | 迁移策略 |
| --- | --- | --- |
| 知识、FSRS、评分、复习会话、计时历史 | Study 业务 SQLite | 复用既有整库导出/受控导入；未来补兼容和失败恢复验收 |
| 插件实例与 SQL/字段关系 | 公共工作台配置服务及产品库 | 保存逻辑数据源/实例关系，不写进通用插件代码或文档 |
| 展开/筛选/阅读位置 | 相应插件实例 | 按 workspace/plugin/instance 隔离；是否互换由产品明确定义 |
| 主题图片、浏览器偏好、最近入口 | 当前浏览器/设备 | 不是天然随 SQLite 导出，不能承诺已互换 |
| 系统通知标识和文件句柄 | 平台适配器 | 不跨设备照搬；从业务状态在接收端重新建立 |
| 代码、文档、图标、合同 | 产品资源发布物 | 使用版本、依赖锁和逐文件 hash 重建，不包含用户库 |

新组装器会排除数据库、日志、secret/签名、data/backups、Git 和依赖缓存，不访问真实主库。已有 Android 组装仍有旧 seed 行为，切换之前必须作为单独迁移任务验收，不能因新入口存在就认为旧流程已经安全替换。

插件 ZIP 内保存“配置的格式和默认值”；实际选择哪张表、哪些字段以及当前实例设置，由工作台配置服务管理并存入对应产品运行数据。默认值不是已安装实例的备份，重新安装插件也不能隐式覆盖用户绑定。产品构建清单仅选择代码资源，不替代这个配置服务。

排查多实例问题时必须区分四种身份：`pluginId` 是插件种类/包，`instanceId` 是一次打开的插件，`workspaceId` 是工作区，数据绑定 ID 是该实例请求的数据关系。展开状态、筛选和帮助阅读历史按实例隔离；静态文档资源按插件版本共享。不能用一个 pluginId 同时保存所有实例的展开和布局状态。

运行时可写目录应由壳提供，不能写在应用只读资源里。当前服务可用显式 `--db` 指向独立测试库；首次无库初始化和正式平台目录协商仍需后续任务，不通过创建空文件假装已解决。

## 7. 文档如何接进这套结构

产品描述中的 `documents` 记录产品/宿主文档源与发布位置。stage 要求声明的发布物及清单内全部资源存在并匹配 hash，缺失时明确失败。插件说明仍随插件 ZIP；公共安装说明归宿主；Study 特有流程归本仓。

作者按统一 `docs/manual.json` 合同组织正文。构建器生成网页、软件内阅读数据、全文搜索和 Agent Markdown；平台壳只携带资源，不重写正文。作者源见[产品说明](manual/docs/index.md)、[帮助操作](manual/docs/user/help.md)、[插件操作](manual/docs/user/plugins.md)和[配置字段](manual/docs/user/configuration.md)。

系统帮助已接入完整阅读器与全文检索；平台/产品通过 `/api/manuals` 登记发布物，插件通过受信任启用包的资产路由登记，查阅无需挂载插件。产品的 `tooling/manuals.py` 从三类作者源重建并可部署到固定发布根，旧版本作为 previous 保存。具体命令见[构建操作说明](../../tooling/README.md)。

Android 组装器现在支持显式 `--output`、`--studio-root`、`--allow-dirty`，委托同一产品 stage 生成不含数据库的新 runtime。无参数旧 Gradle 组装入口仍有原 seed 行为，此次没有替换或运行。Android 原生保存桥可请求下载已校验的本机手册 Markdown；没有桥的 WebView 明确显示不可用。runtime 浏览器测试与原生设备验收分别记录，本轮不生成 APK、不宣称真机已验收。

## 8. 下一步迁移顺序

1. 按规范补正文与证据，完成作者/发布合同门禁。
2. 统一构建器生成手册阅读数据；帮助中心按真实版本注册和阅读。
3. 将完整文档和选定插件发布包接入产品资源清单。
4. Android 旧组装器改成薄适配器，消费同一 stage，显式处理 seed/可写目录；删除旧复制逻辑前做资源及业务对照。
5. 抽取平台能力接口，逐项验证文件/通知/生命周期能力；不在业务插件内部增加 OS 分支。
6. 满足跨平台准备说明中的成熟门槛且用户恢复 iOS 后，再做本地运行时和原生壳原型。

上述顺序与融合计划 N0/T1/S1/T2–T9 对应；不在本文件另维护一套任务状态。

## 9. 已验证范围与源码导航

本轮新增测试使用虚构文件验证无 Junction 搬迁、相同内容得到相同戳、路径/链接/目标冲突拒绝、禁止覆盖、私有数据排除和资源篡改检测。实际完整资源 stage 的测试报告在共享宿主 `reports/manual-product-foundation.md`，尚未执行的业务/移动端范围会单列。

| 要改什么 | 先读哪里 |
| --- | --- |
| 产品选哪些资源 | `tooling/product.json`、`tooling/build.py:inventory` |
| 更新共享宿主版本 | `dependencies.lock.json`、`build.py:context`，检查实际兼容报告 |
| 检查已生成产物 | `build.py:verify` 与 runtime 清单 |
| 软件内详细说明 | 宿主 `manual_contracts.py`、文档合同与 `systemTools/helpPanel.mjs` |
| 当前 Android 源组装 | `tools/assemble_android_assets.py`、`android/app/build.gradle.kts` |
| 业务与真实数据 | 原 Study skill 与业务 API，不通过构建脚本操作 |

本轮不声明 macOS/Linux、APK、WKWebView、iPhone/iPad 或 SQLite 往返已通过。源文件可搬迁测试只证明路径和资源基础；平台发行仍须真实工具链与设备验证。

进入平台发布阶段前，还要锁定 Python/JS/原生运行依赖与插件发布包版本，验证无开发路径启动、独立可写目录、平台能力拒绝/取消、数据库兼容和完整帮助离线读取。目前 `dependencies.lock.json` 只锁定共享宿主 commit，不涵盖这些发行依赖；本次源码 stage 不代替可安装产品包。
