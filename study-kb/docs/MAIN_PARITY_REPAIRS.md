# 本地 main 遗漏修复（2026-11-01）

比较基线为 Study 本地 main `407fbc8`、宿主本地 main `5b96e2d` 与交接分支。云端 main 是较旧基线，不能用“已是祖先”推断全部迁移完成。

| 遗漏 | 本次处理 | 验收 |
| --- | --- | --- |
| Android 局域网地址只在启动时计算 | 网络回调、15秒兜底、后台通知与 Activity 同步、销毁清理 | Gradle 构建；真机换网需人工验收 |
| 关闭诊断后应用内没有地址 | 顶部常驻且点击复制；诊断按钮继续单独控制 | 无诊断构建；主题明暗文字适配 |
| Agent 本地配置沿用旧网段/8033 | 增只读身份接口、identity 和验证后 configure；校验产品/运行类型/实际监听端口 | 正确保存，错误身份、端口、URL 保留原配置 |
| 树大纲与重绘丢原生滚动 | 序列化/恢复大纲 scrollTop，重绘保留图画布原生滚动 | 初始240、重绘320、模式切换、重新挂载及销毁回归 |
| 树搜索栏挤画布 | 绝对定位覆盖于标题/提示下，窗格 resize 时重算位置 | 浮层样式及逻辑相机/原生滚动不变 |
| 公共宿主详情表格缺保护 | 详情 min-width/max-width、长文换行和表格内滚动 | 宿主与 Study Node 回归 |
| 学习技能正文少70行 | 补回卡片五步法、候选树、十段式论文；补新连接说明并同步发现副本 | 文本与 main 逐段核对、中央 mesh 校验 |
| main 历史资料未保留 | 补31导入记录、13索引条目、4历史计划及HSIM文稿 | Git路径核对；不重放导入 |

旧3份 Study VM 测试不原样恢复：BSP/传输合同现由宿主正式测试负责。新增的树视口和连接测试进入正式套件。现有 BSP、多实例、文件上传下载、插件框架继续保留。

Android 第二版升级为 `2.0.3-contract-v2`（versionCode 9），继续使用 `local.studykb.contractv2` 和18033，不自动替换正式版数据。安装更新保留已安装的私有数据；新安装使用完整可移植库包初始化。APK源/构建信息见生成 runtime manifest 和交付记录。

使用者在手机切换WiFi或热点后，检查顶部与通知地址一致，并从电脑打开当前地址。点击复制后在 system 根运行：

```powershell
python .cursor/skills/study/scripts/study_server.py configure --url http://<实际手机IP>:18033 --profile contract-v2
python .cursor/skills/study/scripts/study_server.py identity
```

没有手机当前地址时保留现有配置，不猜IP、不自动将电脑服务登记为手机主库。当前电脑学习库及附件不纳入本次源码提交。

## 验证与交付结果

- 宿主提交 `999f4be`：Node 191/191；Study 消费者 Node 105/105。
- Study 连接提交 `a1ea3d7`，技能及历史资料提交 `d0110aa`；最终 Python 147/147。
- Gradle `assembleDebug -PcontractV2=true -PshowContractDiagnostics=false` 成功，包含744个运行资源；Java编译通过。
- APK：`android/app/build/outputs/apk/debug/study-kb-contract-v2-2.0.3-debug.apk`。
- SHA-256：`E4A1916591511A9B8E365AEEDAD23612994D9DE0E4C69378BC62E5BA175702F1`。
- 构建运行信息记录 Study `d0110aa2c886aaaab56437fc9f306eb5c63996f0`、宿主 `999f4be6038e7142a6b6d41f4e46f874564f3881`；后续集成提交仅更新锁和交付说明。
- 本机服务已重启；`/api/health` 正常，`/api/study/connection` 返回 `desktop`/8033，CLI `--profile desktop identity` 通过。局域网入口为 `http://192.168.5.87:8033`（地址可能随网络变化）。
- 只读逐表比较交接后的快照和当前库：`quick_check=ok`，仅 `workbench_plugin` 登记信息变化，学习内容、调度和评分不变。
- 旧APK、完整可移植库ZIP、旧连接配置及测试生成的两个零字节文件保存在 `D:/system-handoff-archive/20261101-main-parity`；两个空文件已移出源码目录，修正测试fixture后不再产生。

中央主工作树的 mesh build/validate 被既有 `Supersedes` 关系类型阻止；中央 feature 工作树被既有 workboard 符号链接的文本占位阻止。技能正文已同步，生成图未手工改写，不能称全图校验通过。保留这些无关工作树修改。手机WiFi/热点切换、断网重连和真实浏览器几何效果待人工验收；本轮没有安装到手机或推送云端。
