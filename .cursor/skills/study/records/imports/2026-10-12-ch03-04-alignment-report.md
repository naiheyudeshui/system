# 第三、四章教材对齐批次

- 主库：`http://10.0.0.102:8033`
- 来源：`系统分析师-一本通精华知识点-第二版(OCR).pdf`
- 第三章：补充数据库系统组成、体系结构、三级模式、设计阶段、E-R 属性与转换、关系代数扩展、SQL 子句、函数依赖、Armstrong 公理、分解判定、ACID、并发异常、恢复、安全、数据仓库与 OLAP。
- 第四章：按教材重排为 1–9 小节，补充网络工程、分布式系统、Web 服务、云计算，并移动 WSDL/UDDI 卡到 Web 服务。
- 重复处理：第三章语义重复卡归档，保留历史记录；未物理删除。
- 编码修复：发现一次 PowerShell 管道中文转 `?`，已按原卡 ID 原位修复，后续批次使用 UTF-8 JSON 文件提交。
- 验收：`probe` 可读可写；SQLite `integrity_check=ok`；`foreign_key_check` 为空；活动卡缺少 FSRS 为 0；活动标题/正文问号扫描为 0。
- 镜像：已执行 `sync-mirror`，本地 `study-kb/data/study.sqlite` 与主库同步。
