# 第七章敏捷方法：XP、DSDM、Scrum 子卡

- 批次：ch07-agile-xp-dsdm-scrum-20261017；主库：http://192.168.31.20:8033。
- 用户确认范围：在敏捷开发下新增 XP、DSDM、Scrum 三张子卡；材料为本轮用户提供的文字。
- 写入前 probe：reachable/readable/writable 均 true，errors 为空；已核对目标父卡 active 且原无子卡。
- 父卡：`card:card_60d74e0153c94da88dd10e527a`（敏捷方法是什么？如何开展敏捷开发？）。
- 新增子卡：XP `card:card_b0fff3587f5f4f60bd8b580512`；DSDM `card:card_1f4e4c83b47448c1b6ddf8a75b`；Scrum `card:card_d8c574e0e0844dc29ece33bf15`。
- 编写处理：保留 XP 四项经典价值观、TDD 等工程实践；把“近螺旋式”改为与螺旋模型的区别。DSDM 的“二八”作优先级启发而非定量保证；可逆变更不作绝对承诺。Scrum 的 2～4 周标为常见实践而非固定规则，自组织表述为有职责边界的自管理。
- 执行脚本：`study-kb/tools/add_agile_methods_http.py`，通过手机知识 HTTP 接口新建。未修改父卡与旧卡，也未写正式复习评分。
- 同步镜像：`study-kb/data/study.sqlite`；主库导出备份：`study-kb/data/backups/study-server-20261017-214651.sqlite`，旧镜像备份：`study-kb/data/backups/study-before-mirror-20261017-214651.sqlite`。
- 验收：三张卡均 active，父节点正确，正文非空，FSRS 初始调度 reps=0；doctor 的完整性 ok，外键、缺调度、同级重名均为 0。未做浏览器视觉验收。
