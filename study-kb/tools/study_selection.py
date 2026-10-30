"""One deterministic post-query selection policy for every review entry point."""
import copy
import hashlib
import json
import random
import math
from datetime import datetime, timezone
from functools import cmp_to_key

FIELDS = {"learning_enabled", "mastery_score", "review_count", "lapse_count", "created_at", "last_reviewed_at", "due_at"}
ORDERS = {"source", "priority", "created_asc", "created_desc", "weakest", "least_recent", "most_lapses", "random", "legacy_reps_due"}
TIME_FIELDS = {'created_at', 'last_reviewed_at', 'due_at'}


def timestamp(value):
    if value is None or value == '':
        return None
    try:
        # Old SQLite timestamps were local wall time; new values carry UTC offsets.
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc).timestamp()
    except (ValueError, TypeError, OverflowError):
        return None


def normalize(policy=None, *, legacy_random=False, limit=5000):
    policy = copy.deepcopy(policy or {})
    if not isinstance(policy, dict):
        raise ValueError("复习策略必须是对象")
    policy.setdefault("version", "selection/v1")
    policy.setdefault("order", "random" if legacy_random else "source")
    policy.setdefault("limit", limit)
    policy.setdefault("filters", [])
    if policy["version"] != "selection/v1" or policy["order"] not in ORDERS:
        raise ValueError("未知的复习排序方式")
    if type(policy["limit"]) is not int or not 1 <= policy["limit"] <= 5000:
        raise ValueError("本轮数量必须为 1–5000")
    if not isinstance(policy["filters"], list) or len(policy["filters"]) > 20:
        raise ValueError("二次筛选最多 20 项")
    for rule in policy["filters"]:
        if not isinstance(rule, dict) or rule.get("field") not in FIELDS or rule.get("op") not in {"eq", "ne", "lt", "lte", "gt", "gte", "empty", "not_empty"}:
            raise ValueError("无效的学习状态筛选条件")
        if not isinstance(rule.get("value"), (str, int, float, bool, type(None))):
            raise ValueError("无效的筛选值")
        if isinstance(rule.get('value'), float) and not math.isfinite(rule['value']):
            raise ValueError('筛选值必须是有限数值')
    rules = policy.get('rules', [])
    if not isinstance(rules, list) or len(rules) > 8:
        raise ValueError('多级排序最多 8 项')
    for rule in rules:
        if not isinstance(rule, dict) or rule.get('field') not in FIELDS or rule.get('direction') not in {'asc', 'desc'} or rule.get('nulls', 'first') not in {'first', 'last'}:
            raise ValueError('无效的多级排序规则')
    return policy


def _matches(item, rule):
    left, right = item.get(rule["field"]), rule.get("value")
    if rule['field'] in TIME_FIELDS:
        left, right = timestamp(left), timestamp(right)
    op = rule["op"]
    if op == "empty": return left is None or left == ""
    if op == "not_empty": return left is not None and left != ""
    if op == "eq": return left == right
    if op == "ne": return left != right
    if left is None or right is None: return False
    try:
        return {"lt": lambda: left < right, "lte": lambda: left <= right, "gt": lambda: left > right, "gte": lambda: left >= right}[op]()
    except TypeError:
        return False


def select(items, policy, seed):
    items = [copy.deepcopy(item) for item in items if all(_matches(item, rule) for rule in policy["filters"])]
    matched = len(items)
    order = policy["order"]
    now = datetime.now(timezone.utc).timestamp()
    if order == "random":
        # Canonical ID input makes random order independent of SQLite execution plans.
        items.sort(key=lambda i: str(i["key"]))
        random.Random(str(seed)).shuffle(items)
    elif order != "source" or policy.get('rules'):
        def compare(a, b):
            if policy.get('rules'):
                rules = policy['rules']
            elif order == "priority":
                first = [(int(a.get("review_count", 0) > 0), int(b.get("review_count", 0) > 0)),
                         (int((timestamp(a.get('due_at')) or 0) > now), int((timestamp(b.get('due_at')) or 0) > now))]
                for left, right in first:
                    if left != right:
                        return (left > right) - (left < right)
                rules = [{'field': name, 'direction': 'asc', 'nulls': 'last' if name == 'created_at' else 'first'} for name in ('mastery_score', 'due_at', 'created_at')]
            elif order == 'legacy_reps_due':
                rules = [{'field': name, 'direction': 'asc', 'nulls': 'first'} for name in ('review_count', 'due_at')]
            else:
                name, desc = {"created_asc": ("created_at", False), "created_desc": ("created_at", True), "weakest": ("mastery_score", False), "least_recent": ("last_reviewed_at", False), "most_lapses": ("lapse_count", True)}[order]
                rules = [{'field': name, 'direction': 'desc' if desc else 'asc', 'nulls': 'first' if order in {'weakest', 'least_recent'} else 'last'}]
            for rule in rules:
                name = rule['field']
                left, right = a.get(name), b.get(name)
                if name in TIME_FIELDS:
                    left, right = timestamp(left), timestamp(right)
                if left == right: continue
                # Unknown mastery/review time first; unknown creation date last.
                if left is None or right is None:
                    unknown_first = rule.get('nulls', 'first') == 'first'
                    return (-1 if left is None else 1) * (1 if unknown_first else -1)
                comparison = (left > right) - (left < right)
                if comparison: return -comparison if rule['direction'] == 'desc' else comparison
            return (str(a["key"]) > str(b["key"])) - (str(a["key"]) < str(b["key"]))
        items.sort(key=cmp_to_key(compare))
    return items[:policy["limit"]], matched


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
