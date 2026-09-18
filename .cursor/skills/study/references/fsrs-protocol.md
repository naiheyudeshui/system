# FSRS 复习协议

实现：`study-kb/tools/study_fsrs.py`（FSRS-4.5 默认参数，stdlib only）

## 评分

| rating | 含义 | 典型场景 |
| ---: | --- | --- |
| 1 | Again | 不会或答错 |
| 2 | Hard | 勉强想起 |
| 3 | Good | 正常回忆 |
| 4 | Easy | 非常轻松 |

## CLI

```bash
python study-kb/tools/study_review.py due [--scope SCOPE] [--limit N]
python study-kb/tools/study_review.py grade CARD_ID RATING
```

## Agent 交互规则

1. 只展示 `front`，等待用户回答
2. 用户表示「不会」时，rating 记 1，并给简短 memory hook
3. 每次只处理一张卡
