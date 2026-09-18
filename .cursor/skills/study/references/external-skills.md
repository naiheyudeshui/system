# 外部学习 Skill 参考

本文件汇总联网调研结果，供 Agent 设计导入/复习流程时参考。**不整包引入**下列项目。

## Learning OS

- 仓库：https://github.com/husamhindustani/learning-os
- 用途：PDF/EPUB 目录提取、`create-course-from-book`、章节教学与测验
- 借鉴点：先提取目录与章节文本，再映射为课程/章节树；用户确认大纲后再写文件
- 不采用：其独立目录布局与 progress 文件格式

## Skill-Anything

- 站点：https://syuan03.github.io/Skill-Anything/
- 用途：素材 → notes / flashcards.yaml / quiz
- 借鉴点：`flashcards.yaml` 可作为 `cardize.py` 的中间格式

## adaptcard

- 仓库：https://github.com/fkx816/adaptcard
- 用途：SQLite + 嵌套 deck + knowledge point + FSRS API
- 借鉴点：`study_node` 树 + `study_card` + FSRS 状态表分离 + 复习历史

## agent-skill-learn

- 仓库：https://github.com/Swader/agent-skill-learn
- 用途：Agent 从文档抽卡、去重、SQLite deck、`due` 复习
- 借鉴点：一次一卡复习循环；`check-json` / dry-run 预检

## magic-memory

- 仓库：https://github.com/rox1694125-bit/magic-memory
- 用途：可移植 SKILL.md + 复习协议
- 借鉴点：主动回忆先于揭示答案

## ZKMemo / awesome-fsrs

- ZKMemo：https://zkmemo.com/
- FSRS 生态：https://github.com/open-spaced-repetition/awesome-fsrs
- 借鉴点：树状知识 + FSRS-4.5/6 调度；本地优先

## 在本仓库中的落地

| 外部能力 | 本仓库对应 |
| --- | --- |
| 目录/章节提取 | `import_outline.py` + Agent 确认 |
| 卡片生成 | `cardize.py` + JSON 草稿 |
| FSRS 调度 | `tools/study_fsrs.py` |
| 数据宿主 | 3dworkbench SQLite + record-contract |
| 操作协议 | `skills/study/SKILL.md` |
