"""
运行时设置解析。

先从数据库读取后台可配项，不存在时回退到环境变量。
当前主要服务于 AI / Embedding 配置。
"""
from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.core.config import settings
from app.core.database import async_session
from app.models.settings import Setting
from app.services.settings_security import decrypt_setting_value

_cache_lock = asyncio.Lock()
_cache_ttl_seconds = 15
_cache_expires_at = 0.0
_settings_cache: dict[str, Any] = {}
DEFAULT_DIAGNOSTIC_RULE_WEIGHTS = {
    "schema": 30.0,
    "content": 30.0,
    "meta": 20.0,
    "citation": 20.0,
}
DEFAULT_SOLUTION_TEMPLATES = {
    "system_prompt": (
        "你是 GEOrank 平台的 AI 问答顾问，专注于解释 GEO（生成式引擎优化）、"
        "AI 搜索可见性、内容结构、品牌引用和增长策略。根据用户问题、诊断上下文"
        "和公司知识库，给出清晰、可信、可执行的回答。"
    ),
    "response_instruction": (
        "请优先回答用户问题本身。需要科普时先解释概念，需要执行时再给步骤；"
        "如果公司知识库能提供帮助，可推荐 1-3 家相关公司并说明匹配原因。"
    ),
    "streaming_system_prompt": "你是 GEOrank AI 问答顾问，基于 GEO 知识、诊断上下文和公司知识库回答用户问题。",
}
DEFAULT_SOLUTION_CHANNELS = {
    "default_channel_key": "geo-basics",
    "channels": [
        {
            "key": "geo-basics",
            "name": "GEO 入门科普",
            "description": "解释 GEO、AI 搜索、生成式答案引擎和品牌可见性的基础概念。",
            "icon": "school",
            "enabled": True,
            "system_hint": "用通俗语言解释概念，先给结论，再给例子，避免过度技术化。",
            "sample_questions": [
                "GEO 和 SEO 到底有什么区别？",
                "为什么 AI 搜索会影响品牌获客？",
                "一个新品牌应该先做哪些 GEO 基础动作？",
            ],
        },
        {
            "key": "diagnostic-explain",
            "name": "诊断报告解读",
            "description": "把 GEO 诊断分数、Schema、内容结构、Meta 和引用问题解释成可理解的行动建议。",
            "icon": "monitoring",
            "enabled": True,
            "system_hint": "围绕诊断上下文解释问题原因、影响和优先级，输出清晰的下一步动作。",
            "sample_questions": [
                "帮我解释这份 GEO 诊断报告里最重要的三个问题。",
                "Schema 分低会怎样影响 AI 引用？",
                "如果只能先修一个问题，应该先修什么？",
            ],
        },
        {
            "key": "content-structure",
            "name": "内容结构优化",
            "description": "围绕官网页面、教程、FAQ、案例和结构化答案，生成适合 AI 读取的内容建议。",
            "icon": "article",
            "enabled": True,
            "system_hint": "从标题层级、首段直答、FAQ、案例、引用和 Schema 角度给建议。",
            "sample_questions": [
                "一个 SaaS 官网首页怎样写更容易被 AI 摘要？",
                "帮我设计一组适合 AI 搜索的 FAQ。",
                "产品页应该如何增加可被引用的内容块？",
            ],
        },
        {
            "key": "brand-visibility",
            "name": "品牌可见性问答",
            "description": "回答品牌在 ChatGPT、Perplexity、Gemini 等 AI 答案中被理解、引用和推荐的问题。",
            "icon": "travel_explore",
            "enabled": True,
            "system_hint": "把品牌实体、第三方引用、权威背书、官网资料和行业语境联系起来回答。",
            "sample_questions": [
                "AI 为什么没有推荐我的品牌？",
                "如何让 AI 更准确理解我们的公司定位？",
                "品牌引用和第三方提及应该怎么建设？",
            ],
        },
        {
            "key": "action-plan",
            "name": "行动方案拆解",
            "description": "把问答结论进一步拆成 30/60/90 天计划、任务优先级和团队分工。",
            "icon": "checklist",
            "enabled": True,
            "system_hint": "输出可执行计划，按阶段、负责人、交付物和衡量指标组织。",
            "sample_questions": [
                "给我一份 30/60/90 天 GEO 执行计划。",
                "市场团队和内容团队应该如何分工做 GEO？",
                "把上面的建议拆成下周可以开始做的任务。",
            ],
        },
    ],
}
DEFAULT_AI_USAGE_POLICY = {
    "access_mode": "platform_unlimited",
    "daily_token_limit": 20000,
    "quota_reset_timezone": "Asia/Shanghai",
    "allow_anonymous_ai_usage": True,
    "allow_user_byok": True,
    "byok_transport_mode": "proxy_transient",
    "allowed_byok_providers": [
        {
            "key": "deepseek",
            "name": "DeepSeek",
            "base_url": "https://api.deepseek.com/v1",
            "default_model": "deepseek-chat",
        },
        {
            "key": "openai",
            "name": "OpenAI",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-4o-mini",
        },
        {
            "key": "custom",
            "name": "OpenAI-compatible",
            "base_url": "",
            "default_model": "",
        },
    ],
    "metered_modules": ["solutions", "keywords", "diagnostics", "companies", "tools"],
}
DEFAULT_LLM_PROVIDER_CONFIG = {
    "strategy": "failover",
    "providers": [],
}
DEFAULT_FRONTEND_MODULES = {
    "default_module": "companies",
    "modules": [
        {
            "key": "companies",
            "name": "公司",
            "path": "/",
            "description": "公司列表、详情和提交公司入口",
            "enabled": True,
            "protected_paths": ["/", "/company", "/companies", "/c", "/submit-company"],
        },
        {
            "key": "diagnostic",
            "name": "诊断",
            "path": "/diagnostic",
            "description": "GEO 诊断和诊断报告访问",
            "enabled": True,
            "protected_paths": ["/diagnostic"],
        },
        {
            "key": "solutions",
            "name": "问答",
            "path": "/solutions",
            "description": "GEO AI 问答和会话页",
            "enabled": True,
            "protected_paths": ["/solutions"],
        },
        {
            "key": "plans",
            "name": "方案",
            "path": "/plans",
            "description": "GEO 方案生成器",
            "enabled": True,
            "protected_paths": ["/plans"],
        },
        {
            "key": "keywords",
            "name": "拓词",
            "path": "/keywords",
            "description": "GEO 拓词工具",
            "enabled": True,
            "protected_paths": ["/keywords"],
        },
        {
            "key": "tools",
            "name": "工具",
            "path": "/tools",
            "description": "JSON-LD、llms.txt、标题和知识库等小工具",
            "enabled": True,
            "protected_paths": ["/tools"],
        },
        {
            "key": "experts",
            "name": "专家",
            "path": "/experts",
            "description": "GEO 专家人物频道",
            "enabled": True,
            "protected_paths": ["/experts"],
        },
        {
            "key": "tutorial",
            "name": "教程",
            "path": "/tutorial",
            "description": "教程内容和详情页",
            "enabled": True,
            "protected_paths": ["/tutorial"],
        },
    ],
}
DEFAULT_HOMEPAGE_RUNTIME = {
    "mode": "custom",
    "active_release_id": "f7e16e7c-e1aa-4e39-951b-4c274dd05175",
    "fallback_enabled": True,
    "company_list_path": "/companies",
    "updated_at": None,
    "updated_by": None,
}
DEFAULT_HOMEPAGE_RELEASE_ID = DEFAULT_HOMEPAGE_RUNTIME["active_release_id"]
DEFAULT_HOMEPAGE_RELEASE_TITLE = "首页 8 模块工作台入口 2026-06-16"
VALID_AI_ACCESS_MODES = {
    "platform_unlimited",
    "daily_quota",
    "quota_with_byok",
    "byok_required",
}
VALID_LLM_PROVIDER_STRATEGIES = {"failover", "round_robin"}


def get_default_solution_template_config() -> dict[str, str]:
    return dict(DEFAULT_SOLUTION_TEMPLATES)


def get_default_solution_channel_config() -> dict[str, Any]:
    return {
        "default_channel_key": DEFAULT_SOLUTION_CHANNELS["default_channel_key"],
        "channels": [dict(channel) for channel in DEFAULT_SOLUTION_CHANNELS["channels"]],
    }


def get_default_ai_usage_policy_config() -> dict[str, Any]:
    return {
        **DEFAULT_AI_USAGE_POLICY,
        "allowed_byok_providers": [
            dict(item) for item in DEFAULT_AI_USAGE_POLICY["allowed_byok_providers"]
        ],
        "metered_modules": list(DEFAULT_AI_USAGE_POLICY["metered_modules"]),
    }


def get_default_llm_provider_config() -> dict[str, Any]:
    return {
        "strategy": DEFAULT_LLM_PROVIDER_CONFIG["strategy"],
        "providers": [],
    }


def get_default_frontend_module_config() -> dict[str, Any]:
    return {
        "default_module": DEFAULT_FRONTEND_MODULES["default_module"],
        "modules": [dict(module) for module in DEFAULT_FRONTEND_MODULES["modules"]],
    }


def get_default_homepage_runtime_config() -> dict[str, Any]:
    return dict(DEFAULT_HOMEPAGE_RUNTIME)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def invalidate_runtime_settings_cache() -> None:
    global _cache_expires_at, _settings_cache
    async with _cache_lock:
        _settings_cache = {}
        _cache_expires_at = 0.0


async def _load_runtime_settings() -> dict[str, Any]:
    global _cache_expires_at, _settings_cache

    now = time.monotonic()
    if _settings_cache and now < _cache_expires_at:
        return dict(_settings_cache)

    async with _cache_lock:
        now = time.monotonic()
        if _settings_cache and now < _cache_expires_at:
            return dict(_settings_cache)

        async with async_session() as db:
            result = await db.execute(select(Setting))
            items = result.scalars().all()

        _settings_cache = {
            item.key: decrypt_setting_value(item.value, item.key, item.category)
            for item in items
        }
        _cache_expires_at = time.monotonic() + _cache_ttl_seconds
        return dict(_settings_cache)


def _pick_string(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _pick_int(*values: Any, default: int) -> int:
    for value in values:
        if value is None or value == "":
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return default


def _pick_float(value: Any, default: float) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _pick_bool(value: Any, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "enabled"}:
            return True
        if normalized in {"0", "false", "no", "off", "disabled"}:
            return False
    return bool(value)


def _normalize_provider_id(value: Any, index: int) -> str:
    raw = _pick_string(value).lower()
    normalized = re.sub(r"[^a-z0-9_-]+", "-", raw).strip("-_")
    if not normalized:
        normalized = f"provider-{index + 1}"
    return normalized[:50]


def _normalize_llm_provider(raw: Any, keys: dict[str, Any], index: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    provider_id = _normalize_provider_id(raw.get("id") or raw.get("key"), index)
    api_key = _pick_string(raw.get("api_key"), keys.get(provider_id))
    return {
        "id": provider_id,
        "name": (_pick_string(raw.get("name")) or f"API {index + 1}")[:80],
        "base_url": _pick_string(raw.get("base_url"), raw.get("api_base_url"))[:240],
        "model": _pick_string(raw.get("model"), raw.get("default_model"))[:120],
        "enabled": _pick_bool(raw.get("enabled"), True),
        "priority": _pick_int(raw.get("priority"), index + 1, default=index + 1),
        "api_key": api_key,
        "has_api_key": bool(api_key),
    }


def _build_llm_provider_config(values: dict[str, Any]) -> dict[str, Any]:
    raw = values.get("llm_providers")
    if not isinstance(raw, dict):
        return get_default_llm_provider_config()

    strategy = _pick_string(raw.get("strategy"), DEFAULT_LLM_PROVIDER_CONFIG["strategy"])
    if strategy not in VALID_LLM_PROVIDER_STRATEGIES:
        strategy = DEFAULT_LLM_PROVIDER_CONFIG["strategy"]

    raw_keys = values.get("llm_provider_keys")
    if not isinstance(raw_keys, dict):
        raw_keys = {}

    providers: list[dict[str, Any]] = []
    seen: set[str] = set()
    raw_providers = raw.get("providers")
    if isinstance(raw_providers, list):
        for index, item in enumerate(raw_providers[:12]):
            provider = _normalize_llm_provider(item, raw_keys, index)
            if not provider or provider["id"] in seen:
                continue
            seen.add(provider["id"])
            if not (
                provider["enabled"]
                and provider["api_key"]
                and provider["base_url"]
                and provider["model"]
            ):
                continue
            providers.append(provider)

    providers.sort(key=lambda item: (int(item.get("priority") or 999), item["id"]))
    return {
        "strategy": strategy,
        "providers": providers,
    }


def _build_ai_runtime_config(values: dict[str, Any]) -> dict[str, Any]:
    llm_api_key = _pick_string(
        values.get("llm_api_key"),
        values.get("openai_api_key"),
        settings.LLM_API_KEY,
        settings.OPENAI_API_KEY,
    )
    config = {
        "llm_api_key": llm_api_key,
        "llm_base_url": _pick_string(values.get("llm_base_url"), settings.LLM_BASE_URL),
        "llm_model": _pick_string(values.get("llm_model"), settings.LLM_MODEL, settings.OPENAI_MODEL),
        "llm_fallback_model": _pick_string(
            values.get("llm_fallback_model"),
            values.get("codex_model"),
            settings.LLM_FALLBACK_MODEL,
            settings.CODEX_MODEL,
        ),
        "embedding_api_key": _pick_string(
            values.get("embedding_api_key"),
            values.get("openai_api_key"),
            settings.EMBEDDING_API_KEY,
        ),
        "embedding_base_url": _pick_string(values.get("embedding_base_url"), settings.EMBEDDING_BASE_URL),
        "embedding_model": _pick_string(values.get("embedding_model"), settings.EMBEDDING_MODEL),
        "embedding_dimensions": _pick_int(
            values.get("embedding_dimensions"),
            settings.EMBEDDING_DIMENSIONS,
            default=settings.EMBEDDING_DIMENSIONS,
        ),
        "codex_api_key": _pick_string(
            values.get("codex_api_key"),
            settings.CODEX_API_KEY,
            llm_api_key,
        ),
        "codex_base_url": _pick_string(
            values.get("codex_base_url"),
            settings.CODEX_BASE_URL,
            values.get("llm_base_url"),
            settings.LLM_BASE_URL,
        ),
        "codex_model": _pick_string(
            values.get("codex_model"),
            settings.CODEX_MODEL,
        ),
    }
    provider_config = _build_llm_provider_config(values)
    config["llm_provider_strategy"] = provider_config["strategy"]
    config["llm_providers"] = provider_config["providers"]
    return config


def _build_diagnostic_rule_config(values: dict[str, Any]) -> dict[str, Any]:
    raw = values.get("diagnostic_rule_weights")
    if not isinstance(raw, dict):
        raw = {}

    weights = {
        key: max(0.0, _pick_float(raw.get(key), default))
        for key, default in DEFAULT_DIAGNOSTIC_RULE_WEIGHTS.items()
    }
    total = round(sum(weights.values()), 2)
    if total <= 0:
        weights = dict(DEFAULT_DIAGNOSTIC_RULE_WEIGHTS)
        total = round(sum(weights.values()), 2)

    normalized_weights = {
        key: round(value / total, 4)
        for key, value in weights.items()
    }

    return {
        "weights": {key: round(value, 2) for key, value in weights.items()},
        "normalized_weights": normalized_weights,
        "total": total,
    }


def _build_solution_template_config(values: dict[str, Any]) -> dict[str, Any]:
    raw = values.get("solution_templates")
    if not isinstance(raw, dict):
        raw = {}

    config = {}
    for key, default in DEFAULT_SOLUTION_TEMPLATES.items():
        config[key] = _pick_string(raw.get(key), default) or default
    return config


def _normalize_solution_channel(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    key = _pick_string(raw.get("key"))
    name = _pick_string(raw.get("name"))
    if not key or not name:
        return None

    sample_questions = raw.get("sample_questions")
    if not isinstance(sample_questions, list):
        sample_questions = []
    cleaned_questions = [
        str(item).strip()[:160]
        for item in sample_questions
        if str(item or "").strip()
    ][:6]

    return {
        "key": key[:60],
        "name": name[:80],
        "description": _pick_string(raw.get("description"))[:240],
        "icon": (_pick_string(raw.get("icon")) or "forum")[:40],
        "enabled": bool(raw.get("enabled", True)),
        "system_hint": _pick_string(raw.get("system_hint"))[:500],
        "sample_questions": cleaned_questions,
    }


def _build_solution_channel_config(values: dict[str, Any]) -> dict[str, Any]:
    defaults = get_default_solution_channel_config()
    raw = values.get("solution_channels")
    if not isinstance(raw, dict):
        raw = {}

    raw_channels = raw.get("channels")
    channels: list[dict[str, Any]] = []
    seen: set[str] = set()
    if isinstance(raw_channels, list):
        for item in raw_channels:
            channel = _normalize_solution_channel(item)
            if not channel or channel["key"] in seen:
                continue
            channels.append(channel)
            seen.add(channel["key"])

    if not channels:
        channels = defaults["channels"]

    enabled_keys = [channel["key"] for channel in channels if channel.get("enabled", True)]
    default_channel_key = _pick_string(raw.get("default_channel_key"), defaults["default_channel_key"])
    if default_channel_key not in enabled_keys:
        default_channel_key = enabled_keys[0] if enabled_keys else channels[0]["key"]

    return {
        "default_channel_key": default_channel_key,
        "channels": channels,
    }


def _build_frontend_module_config(values: dict[str, Any]) -> dict[str, Any]:
    defaults = get_default_frontend_module_config()
    raw = values.get("frontend_modules")
    if not isinstance(raw, dict):
        raw = {}

    raw_by_key = {
        str(item.get("key", "")).strip().lower(): item
        for item in raw.get("modules") or []
        if isinstance(item, dict) and str(item.get("key", "")).strip()
    }

    modules: list[dict[str, Any]] = []
    for default_module in defaults["modules"]:
        key = default_module["key"]
        override = raw_by_key.get(key) or {}
        modules.append(
            {
                **default_module,
                "enabled": _pick_bool(override.get("enabled"), default_module["enabled"]),
            }
        )

    if not any(module["enabled"] for module in modules):
        for module in modules:
            module["enabled"] = module["key"] == defaults["default_module"]

    enabled_keys = [module["key"] for module in modules if module["enabled"]]
    default_module_key = _pick_string(raw.get("default_module"), defaults["default_module"]).lower()
    if default_module_key not in enabled_keys:
        default_module_key = enabled_keys[0]

    return {
        "default_module": default_module_key,
        "modules": modules,
    }


def _build_homepage_runtime_config(values: dict[str, Any]) -> dict[str, Any]:
    raw = values.get("homepage_runtime")
    if not isinstance(raw, dict):
        raw = {}
    raw = {**DEFAULT_HOMEPAGE_RUNTIME, **raw}

    mode = _pick_string(raw.get("mode"), DEFAULT_HOMEPAGE_RUNTIME["mode"])
    if mode not in {"default", "custom"}:
        mode = "default"
    active_release_id = raw.get("active_release_id")
    if active_release_id is not None:
        active_release_id = _pick_string(active_release_id)
    if not active_release_id:
        active_release_id = None
        if mode == "custom":
            mode = "default"

    company_list_path = _pick_string(raw.get("company_list_path"), DEFAULT_HOMEPAGE_RUNTIME["company_list_path"])
    if not company_list_path.startswith("/"):
        company_list_path = f"/{company_list_path}"
    if company_list_path == "/":
        company_list_path = "/companies"

    updated_at = raw.get("updated_at")
    if updated_at is not None:
        updated_at = _pick_string(updated_at)
    updated_by = raw.get("updated_by")
    if updated_by is not None:
        updated_by = _pick_string(updated_by)

    return {
        "mode": mode,
        "active_release_id": active_release_id,
        "fallback_enabled": _pick_bool(raw.get("fallback_enabled"), True),
        "company_list_path": company_list_path,
        "updated_at": updated_at,
        "updated_by": updated_by,
    }


def normalize_homepage_runtime_payload(payload: dict[str, Any], current: dict[str, Any] | None = None) -> dict[str, Any]:
    base = current if isinstance(current, dict) else get_default_homepage_runtime_config()
    raw = {**base, **(payload or {})}
    if raw.get("updated_at") is None:
        raw["updated_at"] = _utc_now_iso()
    return _build_homepage_runtime_config({"homepage_runtime": raw})


def normalize_frontend_module_payload(payload: dict[str, Any], current: dict[str, Any] | None = None) -> dict[str, Any]:
    base = current if isinstance(current, dict) else get_default_frontend_module_config()
    raw_modules_by_key = {
        str(item.get("key", "")).strip().lower(): dict(item)
        for item in base.get("modules") or []
        if isinstance(item, dict) and str(item.get("key", "")).strip()
    }
    if isinstance(payload.get("modules"), list):
        for item in payload["modules"]:
            if not isinstance(item, dict):
                continue
            key = str(item.get("key", "")).strip().lower()
            if not key:
                continue
            raw_modules_by_key[key] = {**raw_modules_by_key.get(key, {}), **item}

    raw = {
        "default_module": payload.get("default_module", base.get("default_module")),
        "modules": list(raw_modules_by_key.values()),
    }
    return _build_frontend_module_config({"frontend_modules": raw})


def _normalize_byok_provider(raw: Any) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    key = _pick_string(raw.get("key")).lower()
    name = _pick_string(raw.get("name"))
    if not key:
        return None
    return {
        "key": key[:50],
        "name": (name or key)[:80],
        "base_url": _pick_string(raw.get("base_url"))[:240],
        "default_model": _pick_string(raw.get("default_model"))[:100],
    }


def _build_ai_usage_policy_config(values: dict[str, Any]) -> dict[str, Any]:
    defaults = get_default_ai_usage_policy_config()
    raw = values.get("api_usage_policy")
    if not isinstance(raw, dict):
        raw = {}

    access_mode = _pick_string(raw.get("access_mode"), defaults["access_mode"])
    if access_mode not in VALID_AI_ACCESS_MODES:
        access_mode = defaults["access_mode"]

    providers = []
    seen_providers: set[str] = set()
    raw_providers = raw.get("allowed_byok_providers")
    if not isinstance(raw_providers, list):
        raw_providers = defaults["allowed_byok_providers"]
    for item in raw_providers:
        provider = _normalize_byok_provider(item)
        if not provider or provider["key"] in seen_providers:
            continue
        providers.append(provider)
        seen_providers.add(provider["key"])
    if not providers:
        providers = defaults["allowed_byok_providers"]

    modules = raw.get("metered_modules")
    if not isinstance(modules, list):
        modules = defaults["metered_modules"]
    modules = [
        str(item).strip().lower()
        for item in modules
        if str(item or "").strip()
    ]
    if not modules:
        modules = defaults["metered_modules"]

    return {
        "access_mode": access_mode,
        "daily_token_limit": max(
            0,
            _pick_int(raw.get("daily_token_limit"), defaults["daily_token_limit"], default=defaults["daily_token_limit"]),
        ),
        "quota_reset_timezone": _pick_string(raw.get("quota_reset_timezone"), defaults["quota_reset_timezone"]),
        "allow_anonymous_ai_usage": _pick_bool(
            raw.get("allow_anonymous_ai_usage"),
            defaults["allow_anonymous_ai_usage"],
        ),
        "allow_user_byok": _pick_bool(raw.get("allow_user_byok"), defaults["allow_user_byok"]),
        "byok_transport_mode": (
            "browser_direct"
            if raw.get("byok_transport_mode") == "browser_direct"
            else "proxy_transient"
        ),
        "allowed_byok_providers": providers,
        "metered_modules": modules,
    }


async def get_ai_runtime_config(force_refresh: bool = False) -> dict[str, Any]:
    if force_refresh:
        await invalidate_runtime_settings_cache()
    values = await _load_runtime_settings()
    return _build_ai_runtime_config(values)


async def get_diagnostic_rule_config(force_refresh: bool = False) -> dict[str, Any]:
    if force_refresh:
        await invalidate_runtime_settings_cache()
    values = await _load_runtime_settings()
    return _build_diagnostic_rule_config(values)


async def get_solution_template_config(force_refresh: bool = False) -> dict[str, Any]:
    if force_refresh:
        await invalidate_runtime_settings_cache()
    values = await _load_runtime_settings()
    return _build_solution_template_config(values)


async def get_solution_channel_config(force_refresh: bool = False) -> dict[str, Any]:
    if force_refresh:
        await invalidate_runtime_settings_cache()
    values = await _load_runtime_settings()
    return _build_solution_channel_config(values)


async def get_frontend_module_config(force_refresh: bool = False) -> dict[str, Any]:
    if force_refresh:
        await invalidate_runtime_settings_cache()
    values = await _load_runtime_settings()
    return _build_frontend_module_config(values)


async def get_homepage_runtime_config(force_refresh: bool = False) -> dict[str, Any]:
    if force_refresh:
        await invalidate_runtime_settings_cache()
    values = await _load_runtime_settings()
    return _build_homepage_runtime_config(values)


async def get_ai_usage_policy_config(force_refresh: bool = False) -> dict[str, Any]:
    if force_refresh:
        await invalidate_runtime_settings_cache()
    values = await _load_runtime_settings()
    return _build_ai_usage_policy_config(values)
