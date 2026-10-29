# 跨平台对接要求与 iOS 后续适配说明

更新日期：2026-10-29。当前决定：先完善 Web/Android 和插件体系，软件成熟后再启动 iPhone/iPad 原生适配。本文件规定后续开发应保留的对接边界，不表示本轮已实现这些接口，也不要求现在准备 Mac 或付费账号。

入口：[system README](../../README.md) · [Study README](../README.md)。中央实施计划 ID 为 `plan.2026-10-28-X-standardize-cross-platform-study-builds`，保存在 rsimhelper 的 `readme/skills/plan/records/2026-10-28-X-standardize-cross-platform-study-builds.md`。本文件记录工程约束和验收要求；任务、依赖及决策历史由原计划维护，不另复制一套计划。

## 1. 当前范围与未来目标

当前只补齐文档；已有功能按现有工作流继续完善。后续修改相关模块时按本文检查接口与状态归属，不因写入要求就批量重构、迁移真实数据或开启云构建。

未来 iOS 目标是一个安装后能独立、离线使用的 Universal App，覆盖 iPhone 和 iPad。与 Android 共享前端插件、宿主契约、Python 业务规则和 SQLite 数据模型，平台壳分别实现。Mac 只用于构建/调试，不作为安装后业务运行的常驻依赖。

| 信息 | 已知条件 | 当前处理 |
| --- | --- | --- |
| iPad | iPad Pro，销售型号 MY252CH/A，iPadOS 18.2.1 | 保留为真机目标；未核定硬件 Axxxx 编号，不凭销售编号推断代际/容量 |
| iPhone | 希望支持，尚未指定真机 | 未来先用模拟器，真机验收时再落实设备 |
| Mac | 暂无 | 当前无需购买/租用；恢复适配前落实构建环境 |
| Apple Account | 普通账号，未加入付费 Developer Program | 记录免费测试限制，暂不创建签名资产 |
| 数据互换 | 希望沿用数据库导出 | 默认 SQLite 整库快照，不要求逐插件导出或强制 .studybundle |

下文“必须”是相应功能实现或发行前的要求；“拟定”是未来接口约束；“现状”仅指已核对源码。本文没有完成 WebKit/iOS 实机验证，也没有可安装 IPA。

## 2. 已核对的实现与缺口

| 代码入口 | 当前事实 | 以后对接需处理的内容 |
| --- | --- | --- |
| [studyPlugins.mjs](../web/studyPlugins.mjs) | 将 api、postApi、presentationMode、pane 等上下文传给渲染器 | 保持统一宿主入口，不给每种 OS 复制插件逻辑 |
| [studyTimers.mjs](../web/studyTimers.mjs) | 使用 presentationMode；下拉菜单为避免窗格裁剪挂在 body，按 viewport 定位 | 区分插件形态与弹层定位；不能把所有 window 尺寸读取都当错误，也不能据此让插件形态回退到浏览器宽度 |
| [study_library_sync.py](../tools/study_library_sync.py) | SQLite backup 导出整库；导入检查文件头、128 MB 上限和学习表，先备份再写 live 库 | 现有检查不足以证明跨版本兼容；补隔离迁移、版本拒绝、连接协调及失败恢复 |
| [studyLibrarySync.mjs](../web/studyLibrarySync.mjs) | GET /api/study/library/export；POST /api/study/library/import，上传原始数据库文件；用户确认替换 | 浏览器下载链接不等于原生 Files/分享表单；未来需要文件桥和可核对的导入预览 |
| [app.js](../web/app.js)、[studySqlReview.mjs](../web/studySqlReview.mjs) | 主题及最近复习会话入口使用 localStorage | SQLite 导出不会自动包含这些键；区分会话业务记录与“最近入口”指针，盘点需互换的状态 |
| [MainActivity.java](../android/app/src/main/java/local/studykb/MainActivity.java) | Java WebView，StudyNative.onThemeChanged、原生系统栏/安全区处理，服务 READY 后加载页面 | 现有 StudyNative 是 Android 专用主题桥，不是完整 NativeBridge/v1；启动竞态、恢复和未来统一桥仍需验收 |
| [app/build.gradle.kts](../android/app/build.gradle.kts) | Android/Chaquopy 17、Python 3.14，Android 专用资源组装 | Chaquopy 不能直接用于 iOS；Python/原生扩展需独立 iOS 原型 |
| [db.py](../tools/db.py) | 业务库路径默认相对 study-kb/data，初始化会执行 schema | 移动端应由壳提供可写数据目录；不能让包内只读资源目录承担写入 |
| [studyMarkdown.mjs](../web/studyMarkdown.mjs) | Markdown/清理器从 web/vendor 本地导入 | 这一处本地化不代表所有运行资源已离线；打包时仍需核查完整资源清单 |

共享 BSP/transfer/通用组件主源属于 `naiheyudeshui/3dStudio`；Study 产品与平台壳属于 `naiheyudeshui/system`。本机链接是否可用不应决定发行版能否构建；未来以依赖锁和明确输入获取主源。

## 3. 软件分层与责任

| 层次 | 职责 | 允许依赖 | 必须保持的边界 |
| --- | --- | --- | --- |
| 共享宿主/SDK（3dStudio） | BSP、pane 测量、插件生命周期、主题上下文、传输和通用组件 | Web 标准与共享契约 | 不导入 Study 数据库或 Android/iOS 产品代码 |
| Study 插件/产品前端（system） | 表格、复习、树、计时等交互与业务展示 | 宿主 context、产品 API、受控能力适配器 | 不自行判断 OS 后分叉整套业务；不直接持有数据库连接 |
| 共享业务后端（system） | SQL/FSRS、评分幂等、会话、计时状态、迁移/库互换 | Python、兼容 SQLite 与可验证依赖 | 不把 Android service、Java 类、Mac 路径或 CLI 子进程当通用业务前提 |
| 平台适配器 | 文件、通知、主题、安全区、生命周期、诊断导出 | Android 原生 / 未来 Swift；Web 有界回退 | 显式报告能力是否可用，权限拒绝不得伪报成功 |
| 平台壳与构建 | 运行时启动、资源和数据目录、签名、版本/依赖清单 | 对应平台 SDK | 平台差异集中在此；资源和业务数据分开 |

现在修改某一能力时，先检查是否已有共享实现，避免在 system 和 3dStudio 各修一份。同一算法与资源清单必须有权威源；源码归属不能用复制后手工保持一致来替代。

## 4. 宿主与插件接口要求

### 4.1 尺寸、布局和实例

插件使用宿主传入的 pane 内容区 CSS 像素宽高、presentationMode 和实例身份。宿主监听实际 pane 容器；浏览器缩放/旋转/分屏只有改变该 pane 时，才导致其形态重新协商。CSS 可以使用容器条件表达插件局部布局；页面框架、安全区和全屏弹层可使用 viewport，不能借此改变未变化 pane 的插件形态。

每个插件实例以 pluginId 与 instanceId 隔离状态、传输目标、观察器、定时器和存储键。模块级共享业务服务可以共享，但某实例的展开、筛选、刷新和布局不得改变另一实例。保持当前宿主生命周期，普通 resize 尽量更新尺寸；确需重挂载时先保存状态并释放旧资源，不能重复注册事件或提交评分。

尺寸测量需满足：

- flex/grid 子项允许收缩，必要处使用 min-width: 0 / min-height: 0；内容溢出进入明确的局部滚动区，不反向撑大祖先。
- 隐藏或尚未布局时得到的零尺寸不是正常可用空间；等待下一次有效测量，避免除零、负高度和持续自增。
- 一轮测量读取输入，统一调度写入，避免 ResizeObserver 中读写递归；缓存未变化结果，不累加上次计算的 margin/padding。
- 分区高度基于当前 pane 可用 H，先扣除真实标题、工具栏、间距和安全区，再分配展开内容；有子内容的展开模块保留至少一个可用内容单元。超出时按既定公平分配和局部滚动处理；若连最小单元都放不下，提供可访问的整体滚动/收起策略，不遮挡标题或伪造额外空间。
- 字体、主题或内容加载改变尺寸时重新测量；不能用固定“手机宽度”修复表格，或通过不断增加总高度消除溢出。

验收：固定 pane 宽高改变浏览器宽度，插件形态不误切；只拖动 BSP 分隔条即可触发正确切换；反复扩大/缩小至少 20 次后无高度增长、标题消失或残留背景占位；两个表格实例交替展开/关闭互不影响，计时器遵守相同尺寸入口。

### 4.2 交互、刷新和启动

主要操作同时可由触摸和鼠标完成；不把 hover、右键或桌面 HTML 拖放当唯一入口。拖放提供可选择目标/移动的替代操作，弹层可关闭，软键盘出现后焦点字段可见，触摸命中区保持可操作。

启动流程拟定为 runtime 启动 → 健康/版本确认 → 加载页面 → 挂载插件；错误可见且有界重试，恢复时先取消旧请求/订阅。onPageFinished 仅表明页面完成事件，不能替代业务就绪。首次进入、恢复和切换无需用户再点击一轮刷新。

刷新遵循宿主协调，不为多个插件重复跑同一轮后台同步；评分/写命令具备明确的请求身份或幂等保障，重试不增加评分历史。刷新应保留展开、草稿、当前会话和树位置，不用反复销毁全部插件作为常规刷新方式。

## 5. 平台能力对接要求

### 5.1 拟定 NativeBridge/v1

未来统一平台适配器对前端暴露异步能力调用。下面是待实现的消息约束，不是当前可直接调用的 API；方法的具体映射在实现任务中固化，避免先在插件中自行创建多个原生全局对象。

请求包含 version、requestId、method、params；响应携带相同 requestId，以及 result 或 error（code/message）。版本不支持、方法未知、权限拒绝、取消和超时有明确错误；所有请求需有超时及清理，页面销毁后不继续回调旧实例。原生事件带类型、会话身份和必要数据，不和请求响应混用。

| 能力 | 所需输入/输出 | Web/Android/未来 iOS 的共同语义 |
| --- | --- | --- |
| 能力和版本查询 | runtime/bridge 版本、支持能力、权限状态 | 未实现能力显式不可用，插件保留可解释的回退 |
| 主题同步 | 主题 token/背景、明暗样式 | 网页与容器一致；iOS 状态栏背景由容器安全区视图承担，不照抄 Android API |
| 文件选择与导出 | 允许类型、建议文件名、用户选择结果/取消 | 使用系统文件选择/分享；大文件走受控文件句柄/流，不默认复制为巨大 Base64 消息 |
| 通知调度与取消 | 逻辑会话 ID、截止时间、本地调度结果 | 可检查授权；重复调度去重，拒绝权限可继续前台计时但明确不保证提醒 |
| 生命周期事件 | 前台、后台、恢复及运行时状态 | 恢复重新对时/读取权威业务状态，不重复启动服务或通知 |
| 诊断导出 | 有界日志/CSV、版本和脱敏字段 | 经用户操作写入文件，返回可用结果；不等同于后台自动收集所有 console |

桥仅接收受控本地页面/主 frame 和允许的方法，校验版本、大小和参数。不得暴露任意文件读写、eval、shell 或下载后执行任意脚本的入口。业务 API 与原生能力分开，不能把文件桥做成绕过业务校验的数据库写入口。

### 5.2 生命周期、计时和安全区

Android 前台服务机制不能直接照搬到 iOS。业务必须保存计时开始/截止时间、暂停累计值、运行状态和逻辑会话 ID；前台 tick 仅用于显示。恢复时根据持久状态重算，不按“后台应执行了多少次 setInterval”累计。

未来 iOS 用已获授权的本地通知承接到时提醒，不能依赖后台 JS/Python 常驻。导入整库或切换会话后，取消接收端旧通知，再从导入后的逻辑状态重建本机调度；设备通知标识不跨设备照搬。系统权限/专注模式等可能影响提醒，应展示实际能力状态。

安全区、浏览器 viewport 和键盘可用空间各有 owner，原生与 CSS 不能重复扣 inset。去掉调试黑边应隐藏诊断 UI、统一背景及外边距，不能删除系统安全区或让内容进入不可操作区域。

## 6. 数据与数据库互换合同

### 6.1 一个数据库能覆盖什么

默认文件仍是 `study-YYYYMMDD-HHMMSS.sqlite`。同一业务库中的表、视图和记录随整库快照导出，插件无需独立导出器。完整库至少核查知识关系、正文、卡片、FSRS 参数/状态和 due、评分历史、可恢复会话、计时项目/历史、SQL 方案及插件业务配置。

| 状态类别 | 归属要求 | 导出/恢复要求 |
| --- | --- | --- |
| 学习内容与历史 | 共享 SQLite，保留稳定 ID | 必须进入互换快照，不因换平台重建或重置 |
| 布局/插件业务配置 | 明确库表或共享设置服务 | 需要互换的逻辑树/比例/实例配置进入共享存储；屏幕像素到接收端重测 |
| localStorage/浏览器入口状态 | 每个键登记用途、实例范围和 owner | 最近入口/主题可保留本地；若产品要求互换，迁至共享存储或明确补充流程，不能声称已经随 DB 导出 |
| 图片/附件 | 先确认有无库外文件和相对引用 | 库内 BLOB 自然随 DB 导出；库外文件必须另纳入完整方案并核查引用 |
| 证书/token/权限/设备通知 ID | 平台或 secret store | 不作为通用业务状态迁移；导出时核查是否混存，不泄漏敏感值 |
| 缓存/日志/临时文件 | 可重建的本地存储 | 不进入学习库备份，诊断由单独导出功能处理 |

只有确认库外附件存在，才补充数据库和附件共同携带的方案；`.studybundle` 是此前讨论的可选容器名字，不是首版必需格式。库外状态未盘点完时，应准确说明导出范围。

### 6.2 版本、时间与兼容性

先核查已有版本/迁移机制，再选择统一的库内版本记录；必要时用共享 metadata 表或 user_version，不同时维护互相矛盾的版本来源。保留现有无版本标记导出的结构识别路径。较新的、不受支持的 schema 拒绝导入并提示更新；不能先覆盖现库再检查。

SQLite 文件可跨平台，但 JSON/FTS、外键、扩展、自定义函数/排序规则和迁移 SQL 必须在两端共同支持。Python 原生扩展也必须分别满足目标 SDK/ABI；不能把 Windows .pyd 或 Android .so 复制给 iOS。

现有代码包含 localtime 时间表达式。盘点每个业务字段的 UTC/本地时间/日期语义，记录迁移规则，不将旧本地时间直接当 UTC，也不批量覆盖用户历史时间。往返比较稳定 ID、父子关系、正文、历史唯一性和 FSRS 值；时间按统一语义、浮点按明确容差比较，不以数据库二进制完全相同作为验收。

### 6.3 整库导入流程

后续完善流程为：选择文件 → 隔离临时库检查大小/文件头/完整性/外键/必要结构/版本 → 临时库迁移并复验 → 显示记录数量与整库替换范围 → 用户确认 → 暂停并协调全部业务写入 → 备份现库 → 关闭连接并安装已验证库 → 重开校验 → 恢复业务和本地通知。

预览至确认期间现库变化时重新预览。处理 WAL/SHM 和仍持有旧连接的服务；单个导入模块内的锁不等于所有业务写者都已暂停。安装/迁移/磁盘不足等失败均可恢复到接收端可用库。旧版程序不能未经兼容检查就打开升级后的新库。

该流程是未来改造要求，当前 import_library 尚未完成全部环节。导入是用户确认的整库替换，不是合并，也不是后台自动同步。禁止用真实学习主库执行破坏性回归。

## 7. 运行时、依赖和构建要求

资源按只读安装资源、可写业务数据、缓存/临时文件和日志分离。Android 使用自身沙盒；未来 iOS 数据放 Application Support，临时/缓存按用途清理。不得写入 App bundle，不依赖 cwd、Windows 盘符、Junction 或个人数据库。升级资源不能覆盖已有业务库；干净安装按 schema 建空库，演示数据必须显式选择。

当前分支的 study-kb/data/study.sqlite 实际仍被 Git 跟踪，早期 README 中“不入 git”的描述不能作为现状依据。数据清理应在确认归属、备份校验后单独处理，取消跟踪时保留用户工作文件，不改写历史；本轮没有执行清理，也不能把这个数据库自动作为未来跨平台发行 seed。

未来优先验证 Swift + WKWebView + 嵌入 CPython + SQLite，并以受控 loopback 服务同源提供资源与 API。服务就绪后才加载页面，端口/origin 由运行时提供；不把 Android 的 18033 或局域网写入策略直接复制为 iOS 默认值。默认仅本机访问，按受控 origin/session 校验请求；不以全局放开 Web 安全或任意网络加载解决兼容问题。

新增 Python 依赖需记录版本、许可证、纯 Python/原生扩展、是否依赖 subprocess/外部二进制、目标平台可获得的构建方式。业务核心不依赖 CLI 子进程；命令行工具与可嵌入业务函数分开。CPython iOS 官方支持嵌入模式，但当前项目全部依赖尚未验证，不能据此承诺整个后端即插即用。

离线所需 JS/MJS、CSS、字体、图标、Markdown 渲染和插件清单随包提供，具有来源、版本与哈希。文件名大小写、路径分隔符、Unicode 文件名和正确 MIME 均需验证；Windows 文件系统上的成功不代表其他平台路径正确。第一版使用随包受信任插件，运行时下载可执行插件另行设计。

| 构建能力 | 当前状态 | 未来要求 |
| --- | --- | --- |
| Android 分支构建 | 已有 build-contract-v2.ps1、Gradle 和 Android 资源组装 | 继续现有入口，改革时先锁依赖与资源清单，保留可回退旧入口 |
| 共享宿主依赖 | 当前依赖本机共享主源/链接 | 双仓不合并，按完整 commit 锁定；干净克隆可获取，不依赖 rsimhelper 计划文件 |
| tooling/bootstrap.py、tooling/build.py | 拟建，当前不可按文档当现成命令执行 | doctor/build/verify 统一调度；Mac 缺失时 iOS 预检明确失败，不默默跳过 |
| iOS Xcode 工程/产物 | 尚未建立 | 恢复适配后先 Simulator，再 device archive/签名；Simulator .app 不能装真机 |
| CI、发布、Secrets | 本轮不启用或配置 | 固定工具链和来源 commit；构建与上传分开，签名材料不入源码 |

每个发行产物保留产品/平台/profile、App 与 build 版本、system/3dStudio commit、dirty 状态、依赖/工具链、资源/插件哈希及测试报告。版本号与数据 schema 分开管理。签名时间戳使二进制可能不同，资源一致性按清单验证。

## 8. 诊断要求

沿用接口日志、模块日志、运行采样三层，相关事件用同一 traceId/instanceId 串联。

| 层次 | 应记录 | 输出位置/方式 |
| --- | --- | --- |
| 宿主/插件/原生接口 | 挂载、销毁、尺寸通知、形态切换、刷新、拖放/调用结果、耗时与失败 | 开发时 console；平台日志适配器接 Android Logcat / 未来 iOS 原生日志，并保留可导出的有界日志 |
| 模块内部 | 展开状态、可用 H、标题/内容测量、空间分配、筛选/加载结果 | 有界结构化日志；高频 debug/trace 可关闭 |
| 运行数值 | pane/插件宽高、分区高度、scroll/client 范围、变化原因与版本 | 可开关的数值采样，经用户操作导出 CSV |

等级为 trace/debug/info/warn/error。构建 profile 与运行时开关控制细节；release 默认隐藏诊断栏，关闭高频采样，保留有界的必要错误/信息。调试 UI 开关不等于关闭全部日志。

console 不是后台自动可见的通道；若需远端诊断，必须明确桥接/采集和用户操作。普通 JS 对象/数组日志缓冲通常在进程内存中，刷新或进程终止可能丢失；只有落入平台日志、持久缓冲或经文件导出后才有对应记录。设置容量、保留期及清理策略，不记录卡片全文、SQL 结果、token 或凭据。以上完整三层导出是要求，不能把现有 console 输出当成全部已完成。

## 9. 何时重新启动 iOS 适配

“软件成熟”按以下门槛检查，而不是仅看 APK 能编译。当前没有在本文宣称门槛全部通过；后续提供实际版本和报告。

| 门槛 | 应具备的证据 |
| --- | --- |
| M1 数据可靠 | Android 备份/恢复和升级保留数据；评分重试幂等；坏文件/不兼容库导入失败时原库仍可用 |
| M2 插件与布局稳定 | 表格/番茄钟遵守 pane 契约；多实例隔离；20 次 resize、横竖屏及触摸无增长、遮挡或标题消失 |
| M3 现有业务稳定 | 实际 Android 离线冷启动、复习/编辑/计时、退出/恢复通过；首次进入不需手工再刷新 |
| M4 源码与状态可追溯 | 插件/宿主/业务边界清晰；依赖版本、数据归属与库外资源清单齐全；构建不以个人库或机器绝对路径为必选输入 |
| M5 可诊断 | 用户操作能定位到实例和布局计算；必要日志可提取，诊断可关闭，release 无调试专用占位/敏感内容 |
| M6 恢复条件 | 用户决定重新启动 iOS 阶段；落实 Mac/Xcode/Simulator 和真实设备签名路径，再复核最新平台要求 |

现阶段不以缺 Mac 或未加入付费会员阻塞 Web/Android 完善。门槛达到后，先做最小壳、模拟器与嵌入 Python/SQLite 原型，原型验证后再接完整业务；真机证据不能由 Chromium 或模拟器代替。

## 10. 恢复适配时再准备的工具和安装条件

Windows 可继续编辑/测试共享代码；真正 iOS 构建需要支持目标 Xcode 的 macOS 和完整 Xcode/iOS SDK。可借用实体 Mac、使用远程 Apple Mac 或 macOS CI。iOS Simulator 是 Mac 上的模拟设备，不是在 Windows 上安装一个普通手机模拟器；Linux Docker 和 Windows 普通 macOS VM 不作为标准交付路径。

若届时需要购置设备，可参考 Apple silicon、16 GB 内存、80–120 GB 可用空间作为工程建议，并按当时 Xcode/runtime 实际要求调整；这不是当前采购要求或 Apple 最低配置。无需额外建立 macOS VM；若以后使用 VM，先核对 Apple 硬件、许可及 Simulator 支持。

目前只保留 iPadOS 18.2.1 目标，部署下限 iOS/iPadOS 16 为此前草案，尚未验证。恢复时按实际 API/CSS、Python 和 SDK/设备兼容表固定版本，不能把旧文档中的版本当长期承诺，也不要求用户现在升级系统。

| 安装方式 | 恢复时需要的条件 | 使用限制 |
| --- | --- | --- |
| Xcode Personal Team 免费测试 | 能连接 iPad 的 Mac、普通 Apple Account、设备信任和按要求开启开发者模式 | 免费 provisioning 7 天到期，需重新签名安装；适合原型，不作为长期交付 |
| TestFlight 持续测试 | 发布方有 Developer Program/App Store Connect 权限、签名构建和上传；测试者普通账号 | 构建最长 90 天；外部测试可能需 Beta Review；需要持续更新 |
| Ad Hoc / App Store | 对应付费发布身份、设备登记或正式上架材料 | 后续独立选择渠道与授权，不等于分享任意 IPA 即可安装 |

Developer Program 通常每会员年 99 USD 或当地币种价格，按届时地区/资格核查。测试者不需要为接收 TestFlight 邀请购买会员；若用户自己持有本项目发布身份，才需落实自己的会员。远程 Mac/CI 编译成功不会自动安装到本地 iPad，未签名 IPA 也不构成可安装交付。即使业务完全离线，签名/测试构建到期仍可能影响启动。

未来验收覆盖 iPhone/iPad、横竖屏、iPad 分屏、键盘/触摸、安全区/主题、权限拒绝、锁屏/杀进程恢复，以及 Android → iOS → Android 和反向 SQLite 往返。每项记录通过/失败/未执行及原因，未执行不能计入通过。

## 11. 相关改动的检查清单

每次修改插件、存储或平台能力，review 时确认：输入是否来自 pane/共享服务；多实例是否隔离；生命周期资源能否释放；状态属于库内还是设备；是否引入 OS 对象、CDN、子进程或绝对路径；旧数据/协议是否兼容；失败是否可恢复；诊断是否可用且有界。只核查本次变更涉及项，不因本文要求每次重跑所有平台。

当前已有基准命令（在 system 根执行，使用隔离 fixture，不能为测试改写主库）：

```powershell
npm --prefix study-kb/tests ci
npm --prefix study-kb/tests test
py -3 -m unittest discover -v -s study-kb/tests -p test_*.py
```

这些命令只证明实际运行覆盖到的范围，不等于浏览器触摸/Android 真机或 iOS 已通过。共享宿主另跑该仓声明的 pane/契约/浏览器检查；未来再补 Xcode Simulator 与真实设备验证。本轮只完成文档校验，没有运行应用验收。

## 12. 官方参考与维护

以下是恢复适配时应复核的官方入口，账号限制已在 2026-10-29 调研中核对；价格、工具链与发布规则以实施时为准：

- [Apple 账号与免费测试限制](https://developer.apple.com/support/compare-memberships/)
- [Developer Program 注册与费用](https://developer.apple.com/programs/enroll/)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Xcode/macOS/SDK 支持](https://developer.apple.com/support/xcode/)
- [CPython iOS 嵌入支持](https://docs.python.org/3.14/using/ios.html)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple 软件许可](https://www.apple.com/legal/sla/)

后续实现某项要求时，在原计划关联实际 commit、测试报告和未通过项，并更新本文的“现状”；不能只把未来要求改成“已支持”。当前 Web/Android 的数据和日志保持原样，本轮没有开始 iOS 适配。
