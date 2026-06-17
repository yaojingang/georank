"""
结构化日志工具
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any


class JsonFormatter(logging.Formatter):
    """将日志格式化为单行 JSON，便于容器日志采集与检索。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        event = getattr(record, "event", None)
        if event:
            payload["event"] = event

        context = getattr(record, "context", None)
        if isinstance(context, dict):
            payload.update(context)

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(debug: bool = False) -> None:
    """配置根日志为 JSON 输出。重复调用时保持幂等。"""
    root = logging.getLogger()
    formatter = JsonFormatter()

    if root.handlers:
        for handler in root.handlers:
            handler.setFormatter(formatter)
        root.setLevel(logging.DEBUG if debug else logging.INFO)
        return

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    root.addHandler(handler)
    root.setLevel(logging.DEBUG if debug else logging.INFO)


def log_event(logger: logging.Logger, level: int, event: str, **context: Any) -> None:
    """记录结构化事件日志。"""
    logger.log(level, event, extra={"event": event, "context": context})
