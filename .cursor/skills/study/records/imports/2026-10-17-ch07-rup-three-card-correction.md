# RUP 更正为三张卡

- 批次：ch07-rup-three-card-correction-20261017；主库：http://192.168.31.20:8033。
- 用户澄清：RUP 总共三张卡，分别概括 9 个工作流、4 个阶段、3 个特点；不是把每一项做成一张卡。
- 写入前 probe：reachable/readable/writable 均为 true，errors 为空；手机导出备份 `study-kb/data/backups/study-server-20261017-232019.sqlite`。
- 修正前误建：原 RUP 总览卡下 3 个目录及 16 张细卡。已逐项确认该子树无正式评分、无 scope 锚点，需删除的节点未被现有复习会话引用。
- 修正后复用原卡 ID `card:card_749b57d3e49141bfbf0f87e848` 作为“RUP 的九个工作流分别做什么？”；复用 `card:card_f0408f528de74da3b8a4203d34` 作为“四个阶段”卡；复用 `card:card_189dd0d37411498a8ba2a58429` 作为“三个核心特点”卡。三张均位于原 RUP 的父节点 `card:card_a63db318876d486cb9371b243a` 下，并列展示。
- 物理移除误建的其余 17 个节点（14 细卡、3 目录）；不留多余 RUP 总览卡，也不归档。原 RUP 卡 ID 与初始调度保留，未写正式复习评分。
- 执行：`study-kb/tools/correct_rup_to_three_cards_http.py --apply` 在主库导出副本中验证后修改，上传前再次核对手机主库未变化，再经 `library/import` 写回。手机自动备份：`study-20261017-232112.sqlite`；本地删除前备份：`study-kb/data/backups/study-before-rup-three-card-correction-20261017-232109.sqlite`。
- 同步镜像：`study-kb/data/study.sqlite`；同步导出：`study-kb/data/backups/study-server-20261017-232118.sqlite`。
- 验收：三张卡同级、无子节点、各有调度；RUP 外的活动节点、调度与评分日志逐行完全不变。活动节点 724→707；doctor：完整性 ok、外键错误 0、活动卡缺调度 0、同级重名 0。未做浏览器视觉验收。
