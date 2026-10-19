# 第七章：敏捷方法与 RUP 拆分

- 批次：ch07-agile-rup-split-20261017；主库：http://192.168.31.20:8033
- 来源：原“敏捷方法与RUP”卡；补充敏捷宣言和 RUP 通行定义。用户确认拆为两个知识点并扩充。
- 写入前 probe：reachable/readable/writable 均为 true，errors 为空。
- 父节点：`card:card_a63db318876d486cb9371b243a`（如何选择软件开发过程模型？）。
- 新增卡：`card:card_60d74e0153c94da88dd10e527a`（敏捷方法）；`card:card_749b57d3e49141bfbf0f87e848`（RUP）。两张卡均为 active，已建立初始调度，reps=0。
- 旧卡：`card:card_dc81bf3f5613423f802c09498e` 已归档，保留原 ID、调度和日志；本次无复习评分。
- 执行：`study-kb/tools/split_agile_rup_http.py` 经知识 HTTP 接口写入；`study_server.py sync-mirror` 同步本地镜像。
- 备份：`study-kb/data/backups/study-server-20261017-214028.sqlite`；旧镜像：`study-kb/data/backups/study-before-mirror-20261017-214028.sqlite`。
- 验收：两张新卡均位于预期父节点，旧卡 archived；doctor 的 integrity_check=ok，外键、缺调度卡与重复兄弟标题均为空。未做浏览器视觉验收。
