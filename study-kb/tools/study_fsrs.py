"""Minimal FSRS-4.5 scheduler for study cards (stdlib only)."""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any


Rating = int  # 1=Again, 2=Hard, 3=Good, 4=Easy


@dataclass
class FsrsState:
    stability: float = 0.0
    difficulty: float = 0.0
    reps: int = 0
    lapses: int = 0
    due_at: str = ""
    elapsed_days: float = 0.0
    scheduled_days: float = 0.0
    state: int = 0  # 0=New, 1=Learning, 2=Review, 3=Relearning
    last_review: str | None = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> FsrsState:
        if not raw or raw == "{}":
            return cls()
        data = json.loads(raw)
        return cls(
            stability=float(data.get("stability", 0.0)),
            difficulty=float(data.get("difficulty", 0.0)),
            reps=int(data.get("reps", 0)),
            lapses=int(data.get("lapses", 0)),
            due_at=str(data.get("due_at", "")),
            elapsed_days=float(data.get("elapsed_days", 0.0)),
            scheduled_days=float(data.get("scheduled_days", 0.0)),
            state=int(data.get("state", 0)),
            last_review=data.get("last_review"),
        )


# FSRS-4.5 default weights (open-spaced-repetition)
_W = [
    0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61,
]
_DECAY = -0.5
_FACTOR = 19 / 81


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _retrievability(elapsed_days: float, stability: float) -> float:
    if stability <= 0:
        return 0.0
    return math.pow(1 + _FACTOR * elapsed_days / stability, _DECAY)


def _init_difficulty(rating: Rating) -> float:
    return _clamp(_W[4] - _W[5] * (rating - 3), 1, 10)


def _init_stability(rating: Rating) -> float:
    return max(0.1, _W[rating - 1])


def _next_difficulty(difficulty: float, rating: Rating) -> float:
    delta = -_W[6] * (rating - 3)
    mean_reversion = _W[7] * (_init_difficulty(3) - difficulty)
    return _clamp(difficulty + delta + mean_reversion, 1, 10)


def _next_recall_stability(
    difficulty: float,
    stability: float,
    retrievability: float,
    rating: Rating,
) -> float:
    hard_penalty = _W[15] if rating == 2 else 1.0
    easy_bonus = _W[16] if rating == 4 else 1.0
    return (
        stability
        * (
            1
            + math.exp(_W[8])
            * (11 - difficulty)
            * math.pow(stability, -_W[9])
            * (math.exp((1 - retrievability) * _W[10]) - 1)
            * hard_penalty
            * easy_bonus
        )
    )


def _next_forget_stability(difficulty: float, stability: float, retrievability: float) -> float:
    return (
        _W[11]
        * math.pow(difficulty, -_W[12])
        * (math.pow(stability + 1, _W[13]) - 1)
        * math.exp((1 - retrievability) * _W[14])
    )


def _interval_days(stability: float) -> float:
    return max(1.0, round(stability))


def _now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat(sep=" ")


def _parse_iso(value: str | None) -> datetime:
    if not value:
        return datetime.now()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now()


def _add_days(base: datetime, days: float) -> str:
    return (base + timedelta(days=days)).replace(microsecond=0).isoformat(sep=" ")


def new_card_state(*, due_at: str | None = None) -> FsrsState:
    return FsrsState(
        stability=0.0,
        difficulty=0.0,
        reps=0,
        lapses=0,
        due_at=due_at or _now_iso(),
        state=0,
    )


def review(state: FsrsState, rating: Rating, *, reviewed_at: str | None = None) -> FsrsState:
    if rating not in (1, 2, 3, 4):
        raise ValueError("rating must be 1..4")

    now = _parse_iso(reviewed_at or _now_iso())
    last = _parse_iso(state.last_review) if state.last_review else now
    elapsed_days = max(0.0, (now - last).total_seconds() / 86400.0)

    next_state = FsrsState(
        stability=state.stability,
        difficulty=state.difficulty,
        reps=state.reps,
        lapses=state.lapses,
        elapsed_days=elapsed_days,
        last_review=now.replace(microsecond=0).isoformat(sep=" "),
    )

    if state.state == 0:
        next_state.difficulty = _init_difficulty(rating)
        next_state.stability = _init_stability(rating)
        next_state.reps = 1
        if rating == 1:
            next_state.lapses = 1
            next_state.state = 1
            next_state.scheduled_days = 0.0
            next_state.due_at = _add_days(now, 0.0)
        else:
            next_state.state = 2 if rating >= 3 else 1
            next_state.scheduled_days = 1.0 if rating == 2 else _interval_days(next_state.stability)
            next_state.due_at = _add_days(now, next_state.scheduled_days)
        return next_state

    retrievability = _retrievability(elapsed_days, state.stability)
    next_state.difficulty = _next_difficulty(state.difficulty, rating)

    if rating == 1:
        next_state.lapses = state.lapses + 1
        next_state.stability = _next_forget_stability(state.difficulty, state.stability, retrievability)
        next_state.state = 3
        next_state.scheduled_days = 0.0
        next_state.due_at = _add_days(now, 0.0)
    else:
        next_state.reps = state.reps + 1
        next_state.stability = _next_recall_stability(
            state.difficulty, state.stability, retrievability, rating
        )
        next_state.state = 2
        next_state.scheduled_days = _interval_days(next_state.stability)
        next_state.due_at = _add_days(now, next_state.scheduled_days)

    return next_state


def state_summary(state: FsrsState) -> dict[str, Any]:
    return asdict(state)
