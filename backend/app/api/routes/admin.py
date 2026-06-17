"""
后台管理 API — 公司审核 / 内容管理 / 用户管理 / 系统设置
所有接口需要 admin 角色
"""
from datetime import datetime, timezone
import time
import re
import secrets
import shutil
import string
import uuid
from typing import Any, Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import String, cast, delete, select, func, update, or_, case

from app.api.routes.auth import _hash_password, _normalize_phone
from app.core.deps import DbSession, AdminUser
from app.models.company import Company, PublishStatus, PipelineStatus
from app.services.company_profile import company_profile_needs_hydration, ensure_company_profile
from app.models.content import Content, ContentStatus, ContentType
from app.models.diagnostic import DiagnosticReport, DiagnosticStatus
from app.models.conversation import Conversation, Message, MessageRole
from app.models.keyword import KeywordItem, KeywordPack
from app.models.expert import ExpertProfile
from app.models.homepage import HomepageRelease, HomepageReleaseStatus, HomepageSourceType
from app.models.user import User, UserRole
from app.models.settings import Setting
from app.models.vote import CompanyVote
from app.api.routes.experts import serialize_expert
from app.services.keyword_expansion import expand_keywords
from app.services.settings_security import (
    decrypt_setting_value, encrypt_setting_value, infer_setting_category, is_sensitive_setting,
    mask_setting_value,
)
from app.services.runtime_settings import (
    DEFAULT_HOMEPAGE_RELEASE_ID,
    get_diagnostic_rule_config,
    get_ai_usage_policy_config,
    get_ai_runtime_config,
    get_default_solution_channel_config,
    get_default_solution_template_config,
    get_frontend_module_config,
    get_homepage_runtime_config,
    get_solution_channel_config,
    get_solution_template_config,
    invalidate_runtime_settings_cache,
    normalize_homepage_runtime_payload,
    normalize_frontend_module_payload,
)
from app.services.homepage_assets import (
    HomepageAssetError,
    apply_analytics_to_active_homepage,
    activate_homepage_release,
    build_single_html_release,
    build_zip_homepage_release,
    homepage_root,
    public_release_path,
    reset_active_homepage,
    source_release_path,
)
from app.services.ai_usage import (
    admin_usage_summary,
    normalize_policy_payload,
    public_policy_payload,
    resolve_async_ai_access,
    store_policy_setting,
)
from app.services.ai_client import ai_client
from app.services.content_render import render_markdown

router = APIRouter()
DIAGNOSTIC_RULES_SETTING_KEY = "diagnostic_rule_weights"
SOLUTION_TEMPLATES_SETTING_KEY = "solution_templates"
SOLUTION_CHANNELS_SETTING_KEY = "solution_channels"
LLM_PROVIDERS_SETTING_KEY = "llm_providers"
LLM_PROVIDER_KEYS_SETTING_KEY = "llm_provider_keys"
FRONTEND_MODULES_SETTING_KEY = "frontend_modules"
HOMEPAGE_RUNTIME_SETTING_KEY = "homepage_runtime"
ANALYTICS_TRACKING_CODE_SETTING_KEY = "analytics_tracking_code"
CONTENT_PATH_KEY_ALPHABET = string.ascii_lowercase
CONTENT_PATH_KEY_LENGTH = 5
MASKED_SECRET_TEXT = "••••••••••••••••"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def _generate_unique_content_path_key(db: DbSession) -> str:
    while True:
        candidate = "".join(
            secrets.choice(CONTENT_PATH_KEY_ALPHABET)
            for _ in range(CONTENT_PATH_KEY_LENGTH)
        )
        result = await db.execute(select(Content.id).where(Content.path_key == candidate))
        if result.scalar_one_or_none() is None:
            return candidate


def _normalize_recommended_companies(value) -> list[dict]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("items"), list):
        return value["items"]
    return []


def _serialize_solution_template_payload(
    config: dict,
    setting: Setting | None,
    updated_by_user: User | None = None,
) -> dict:
    defaults = get_default_solution_template_config()
    customized_fields = [
        key for key, default in defaults.items()
        if config.get(key) != default
    ]
    return {
        **config,
        "updated_at": setting.updated_at.isoformat() if setting and setting.updated_at else None,
        "updated_by_username": updated_by_user.username if updated_by_user else None,
        "uses_default": not customized_fields,
        "customized_fields": customized_fields,
        "customized_field_count": len(customized_fields),
        "template_field_total": len(defaults),
        "field_sources": {
            key: ("custom" if key in customized_fields else "default")
            for key in defaults
        },
    }


def _serialize_solution_channel_payload(
    config: dict,
    setting: Setting | None,
    updated_by_user: User | None = None,
) -> dict:
    defaults = get_default_solution_channel_config()
    channels = config.get("channels") or []
    default_channels = defaults.get("channels") or []
    uses_default = (
        config.get("default_channel_key") == defaults.get("default_channel_key")
        and channels == default_channels
    )
    enabled_count = sum(1 for channel in channels if channel.get("enabled", True))
    return {
        "default_channel_key": config.get("default_channel_key"),
        "channels": channels,
        "channel_count": len(channels),
        "enabled_channel_count": enabled_count,
        "uses_default": uses_default,
        "updated_at": setting.updated_at.isoformat() if setting and setting.updated_at else None,
        "updated_by_username": updated_by_user.username if updated_by_user else None,
    }


def _serialize_frontend_module_payload(
    config: dict,
    setting: Setting | None,
    updated_by_user: User | None = None,
) -> dict:
    modules = config.get("modules") or []
    default_module = config.get("default_module")
    return {
        "default_module": default_module,
        "modules": [
            {
                **module,
                "is_default": module.get("key") == default_module,
            }
            for module in modules
        ],
        "module_count": len(modules),
        "enabled_module_count": sum(1 for module in modules if module.get("enabled", True)),
        "updated_at": setting.updated_at.isoformat() if setting and setting.updated_at else None,
        "updated_by_username": updated_by_user.username if updated_by_user else None,
    }


async def _load_user_for_usage(db: DbSession, user_id: uuid.UUID | None) -> User | None:
    if not user_id:
        return None
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()


# ===== 仪表盘 =====

@router.get("/dashboard")
async def dashboard_stats(db: DbSession, _: AdminUser):
    """后台仪表盘统计数据"""
    from datetime import date, timedelta
    today = date.today()
    trend_start = today - timedelta(days=13)

    total_companies = await db.scalar(select(func.count(Company.id)))
    total_solutions = await db.scalar(select(func.count(Conversation.id)))
    total_users = await db.scalar(select(func.count(User.id)))
    total_diagnostics = await db.scalar(select(func.count(DiagnosticReport.id)))
    total_contents = await db.scalar(select(func.count(Content.id)).where(Content.status == ContentStatus.PUBLISHED))
    total_keyword_packs = await db.scalar(select(func.count(KeywordPack.id)))
    total_keyword_items = await db.scalar(select(func.count(KeywordItem.id)))

    # 用户统计
    active_users = await db.scalar(select(func.count(User.id)).where(User.is_active == True))
    admin_users = await db.scalar(select(func.count(User.id)).where(User.role == "admin"))
    from sqlalchemy import cast, Date
    new_today = await db.scalar(
        select(func.count(User.id)).where(cast(User.created_at, Date) == today)
    )

    # 流水线各状态计数
    pipeline_counts = {}
    for s in PipelineStatus:
        cnt = await db.scalar(select(func.count(Company.id)).where(Company.pipeline_status == s))
        pipeline_counts[s.value] = cnt

    pending_review = await db.scalar(
        select(func.count(Company.id)).where(Company.publish_status == PublishStatus.PENDING_REVIEW)
    )
    failed_companies = await db.scalar(
        select(func.count(Company.id)).where(Company.pipeline_status == PipelineStatus.FAILED)
    )
    failed_diagnostics = await db.scalar(
        select(func.count(DiagnosticReport.id)).where(DiagnosticReport.status == DiagnosticStatus.FAILED)
    )
    completed_diagnostics = await db.scalar(
        select(func.count(DiagnosticReport.id)).where(DiagnosticReport.status == DiagnosticStatus.COMPLETED)
    )
    published_companies = await db.scalar(
        select(func.count(Company.id)).where(Company.publish_status == PublishStatus.PUBLISHED)
    )
    draft_contents = await db.scalar(
        select(func.count(Content.id)).where(Content.status == ContentStatus.DRAFT)
    )
    published_contents = await db.scalar(
        select(func.count(Content.id)).where(Content.status == ContentStatus.PUBLISHED)
    )

    # GEO 评分分布（仅已有评分的公司）
    scored = await db.execute(
        select(Company.geo_score).where(
            Company.geo_score.isnot(None),
            Company.publish_status == PublishStatus.PUBLISHED,
        )
    )
    scores = [row[0] for row in scored.fetchall()]
    total_scored = len(scores)
    def pct(count): return round(count / total_scored * 100) if total_scored else 0
    geo_distribution = {
        "excellent": pct(sum(1 for s in scores if s >= 80)),
        "good": pct(sum(1 for s in scores if 60 <= s < 80)),
        "average": pct(sum(1 for s in scores if 40 <= s < 60)),
        "poor": pct(sum(1 for s in scores if s < 40)),
        "total_scored": total_scored,
    }
    average_geo_score = round(sum(scores) / total_scored, 1) if total_scored else None

    async def count_by_day(model, timestamp_column, extra_filter=None) -> dict[str, int]:
        day_col = cast(timestamp_column, Date)
        stmt = (
            select(day_col.label("day"), func.count(model.id))
            .where(day_col >= trend_start)
            .group_by(day_col)
            .order_by(day_col)
        )
        if extra_filter is not None:
            stmt = stmt.where(extra_filter)
        rows = await db.execute(stmt)
        return {row[0].isoformat(): int(row[1] or 0) for row in rows.fetchall()}

    trend_series = {
        "companies": await count_by_day(Company, Company.created_at),
        "diagnostics": await count_by_day(DiagnosticReport, DiagnosticReport.created_at),
        "conversations": await count_by_day(Conversation, Conversation.created_at),
        "keyword_packs": await count_by_day(KeywordPack, KeywordPack.created_at),
        "contents": await count_by_day(Content, Content.created_at),
    }
    trend = [
        {
            "date": (trend_start + timedelta(days=offset)).isoformat(),
            "label": (trend_start + timedelta(days=offset)).strftime("%m-%d"),
            "companies": trend_series["companies"].get((trend_start + timedelta(days=offset)).isoformat(), 0),
            "diagnostics": trend_series["diagnostics"].get((trend_start + timedelta(days=offset)).isoformat(), 0),
            "conversations": trend_series["conversations"].get((trend_start + timedelta(days=offset)).isoformat(), 0),
            "keyword_packs": trend_series["keyword_packs"].get((trend_start + timedelta(days=offset)).isoformat(), 0),
            "contents": trend_series["contents"].get((trend_start + timedelta(days=offset)).isoformat(), 0),
        }
        for offset in range(14)
    ]
    usage_summary = await admin_usage_summary(db)

    return {
        "total_companies": total_companies,
        "total_solutions": total_solutions,
        "total_users": total_users,
        "total_diagnostics": total_diagnostics,
        "total_contents": total_contents,
        "total_keyword_packs": total_keyword_packs,
        "total_keyword_items": total_keyword_items,
        "user_stats": {
            "total": total_users,
            "active": active_users,
            "admin": admin_users,
            "new_today": new_today,
        },
        "pipeline_stats": {**pipeline_counts, "pending_review": pending_review},
        "failure_stats": {
            "failed_companies": failed_companies,
            "failed_diagnostics": failed_diagnostics,
        },
        "geo_distribution": geo_distribution,
        "average_geo_score": average_geo_score,
        "trend": trend,
        "usage_summary": usage_summary,
        "async_usage": {
            "total_tokens": usage_summary.get("async_total_tokens", 0),
            "total_requests": usage_summary.get("async_total_requests", 0),
            "modules": usage_summary.get("async_modules", []),
        },
        "module_health": {
            "companies": {
                "total": total_companies,
                "done": published_companies,
                "attention": pending_review + failed_companies,
            },
            "diagnostics": {
                "total": total_diagnostics,
                "done": completed_diagnostics,
                "attention": failed_diagnostics,
            },
            "qa": {
                "total": total_solutions,
                "done": total_solutions,
                "attention": 0,
            },
            "keywords": {
                "total": total_keyword_packs,
                "done": total_keyword_packs,
                "attention": 0,
            },
            "content": {
                "total": published_contents + draft_contents,
                "done": published_contents,
                "attention": draft_contents,
            },
        },
    }


@router.get("/ops/recent-failures")
async def recent_failures(db: DbSession, _: AdminUser, limit: int = 10):
    """返回最近失败的入库任务和诊断任务，便于后台排障。"""
    safe_limit = max(1, min(limit, 50))

    company_result = await db.execute(
        select(Company)
        .where(Company.pipeline_status == PipelineStatus.FAILED)
        .order_by(Company.updated_at.desc())
        .limit(safe_limit)
    )
    diagnostic_result = await db.execute(
        select(DiagnosticReport)
        .where(DiagnosticReport.status == DiagnosticStatus.FAILED)
        .order_by(DiagnosticReport.created_at.desc())
        .limit(safe_limit)
    )

    companies = company_result.scalars().all()
    diagnostics = diagnostic_result.scalars().all()

    return {
        "companies": [
            {
                "id": str(company.id),
                "name": company.name,
                "url": company.url,
                "pipeline_status": company.pipeline_status.value,
                "pipeline_error": company.pipeline_error,
                "updated_at": company.updated_at.isoformat(),
                "created_at": company.created_at.isoformat(),
            }
            for company in companies
        ],
        "diagnostics": [
            {
                "id": str(report.id),
                "url": report.url,
                "status": report.status.value,
                "error_message": report.error_message,
                "created_at": report.created_at.isoformat(),
            }
            for report in diagnostics
        ],
        "limit": safe_limit,
    }


# ===== 公司审核 =====

@router.get("/companies")
async def list_companies_admin(
    db: DbSession,
    _: AdminUser,
    page: int = 1,
    size: int = 20,
    publish_status: Optional[str] = None,
    pipeline_status: Optional[str] = None,
    category: Optional[str] = None,
    search: Optional[str] = None,
    sort: Optional[str] = None,
):
    """管理后台公司列表（含各状态，支持搜索/分页/分类/排序）"""
    from sqlalchemy import String, cast, or_
    query = select(Company)
    if publish_status:
        query = query.where(Company.publish_status == publish_status)
    if pipeline_status:
        query = query.where(Company.pipeline_status == pipeline_status)
    if category:
        query = query.where(Company.category == category)
    if search:
        query = query.where(
            or_(
                Company.name.ilike(f"%{search}%"),
                Company.category.ilike(f"%{search}%"),
                cast(Company.tags, String).ilike(f"%{search}%"),
            )
        )
    if sort == "geo_score":
        query = query.order_by(Company.geo_score.desc().nullslast())
    elif sort == "upvotes":
        query = query.order_by(Company.upvotes.desc())
    elif sort == "created_at":
        query = query.order_by(Company.created_at.desc())
    else:
        review_priority = case(
            (Company.publish_status == PublishStatus.PENDING_REVIEW, 0),
            (Company.publish_status == PublishStatus.DRAFT, 1),
            else_=2,
        )
        query = query.order_by(review_priority.asc(), Company.updated_at.desc())

    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    result = await db.execute(query.offset((page - 1) * size).limit(size))
    companies = result.scalars().all()
    pages = max(1, (total + size - 1) // size)

    return {
        "items": [
            {
                "id": str(c.id),
                "name": c.name,
                "url": c.url,
                "short_description": c.short_description,
                "category": c.category,
                "is_geo_certified": c.is_geo_certified,
                "pipeline_status": c.pipeline_status.value,
                "pipeline_error": c.pipeline_error,
                "publish_status": c.publish_status.value,
                "geo_score": c.geo_score,
                "upvotes": c.upvotes,
                "created_at": c.created_at.isoformat(),
                "updated_at": c.updated_at.isoformat(),
            }
            for c in companies
        ],
        "total": total,
        "page": page,
        "size": size,
        "pages": pages,
    }


@router.get("/companies/{company_id}")
async def get_company_admin_detail(company_id: str, db: DbSession, _: AdminUser):
    """后台公司详情，补充流水线、结构化资料和最近诊断上下文。"""
    cid = uuid.UUID(company_id)
    result = await db.execute(select(Company).where(Company.id == cid))
    company = result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="公司不存在")

    submitter = None
    if company.submitted_by:
        submitter_result = await db.execute(select(User).where(User.id == company.submitted_by))
        submitter = submitter_result.scalar_one_or_none()

    report_count = await db.scalar(
        select(func.count(DiagnosticReport.id)).where(DiagnosticReport.company_id == cid)
    ) or 0
    report_ids_result = await db.execute(
        select(DiagnosticReport.id).where(DiagnosticReport.company_id == cid)
    )
    diagnostic_context_ids = list(report_ids_result.scalars().all())
    latest_report_result = await db.execute(
        select(DiagnosticReport)
        .where(DiagnosticReport.company_id == cid)
        .order_by(DiagnosticReport.created_at.desc())
        .limit(1)
    )
    latest_report = latest_report_result.scalar_one_or_none()

    related_message_filters = [
        cast(Message.recommended_companies, String).ilike(f"%{cid}%"),
    ]
    if diagnostic_context_ids:
        related_message_filters.append(Message.diagnostic_context_id.in_(diagnostic_context_ids))

    related_message_result = await db.execute(
        select(Message)
        .where(or_(*related_message_filters))
        .order_by(Message.created_at.desc())
    )
    related_solutions = await _load_related_solution_summaries(
        db,
        [
            (
                message,
                {
                    *({"recommended_company"} if message.recommended_companies and str(cid) in str(message.recommended_companies) else set()),
                    *({"diagnostic_context"} if message.diagnostic_context_id in diagnostic_context_ids else set()),
                },
            )
            for message in related_message_result.scalars().all()
        ],
    )

    return {
        "id": str(company.id),
        "name": company.name,
        "url": company.url,
        "logo_url": company.logo_url,
        "description": company.description,
        "short_description": company.short_description,
        "category": company.category,
        "tags": company.tags or [],
        "is_geo_certified": company.is_geo_certified,
        "founded_date": company.founded_date.isoformat() if company.founded_date else None,
        "headquarters": company.headquarters,
        "employee_count": company.employee_count,
        "funding_stage": company.funding_stage,
        "tech_level": company.tech_level,
        "tech_stack": company.tech_stack or [],
        "team_members": company.team_members or [],
        "geo_score": company.geo_score,
        "geo_details": company.geo_details or {},
        "pipeline_status": company.pipeline_status.value,
        "pipeline_error": company.pipeline_error,
        "publish_status": company.publish_status.value,
        "raw_html_key": company.raw_html_key,
        "about_html_key": company.about_html_key,
        "screenshots": company.screenshots or [],
        "upvotes": company.upvotes,
        "submitted_by": str(company.submitted_by) if company.submitted_by else None,
        "submitted_by_user": {
            "id": str(submitter.id),
            "username": submitter.username,
            "email": submitter.email,
        } if submitter else None,
        "diagnostic_report_count": report_count,
        "latest_diagnostic": {
            "id": str(latest_report.id),
            "url": latest_report.url,
            "status": latest_report.status.value,
            "overall_score": latest_report.overall_score,
            "created_at": latest_report.created_at.isoformat(),
        } if latest_report else None,
        "related_solutions": related_solutions,
        "created_at": company.created_at.isoformat(),
        "updated_at": company.updated_at.isoformat(),
    }


@router.post("/companies/{company_id}/approve")
async def approve_company(company_id: str, db: DbSession, _: AdminUser):
    """审核通过 → 发布"""
    cid = uuid.UUID(company_id)
    result = await db.execute(select(Company).where(Company.id == cid))
    company = result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="公司不存在")

    if company.pipeline_status == PipelineStatus.COMPLETED and company_profile_needs_hydration(company):
        await ensure_company_profile(db, company)
    if company_profile_needs_hydration(company):
        raise HTTPException(status_code=409, detail="公司资料未抽取完整，暂不能发布")

    await db.execute(
        update(Company).where(Company.id == cid).values(publish_status=PublishStatus.PUBLISHED)
    )
    await db.commit()
    return {"status": "published", "company_id": company_id}


@router.post("/companies/{company_id}/reject")
async def reject_company(company_id: str, db: DbSession, _: AdminUser, reason: str = ""):
    """审核驳回"""
    cid = uuid.UUID(company_id)
    await db.execute(
        update(Company).where(Company.id == cid).values(
            publish_status=PublishStatus.DRAFT,
            pipeline_error=reason or "已驳回",
        )
    )
    await db.commit()
    return {"status": "rejected", "company_id": company_id}


@router.post("/companies/{company_id}/retry-pipeline")
async def retry_pipeline(company_id: str, db: DbSession, admin_user: AdminUser):
    """重新触发入库流水线"""
    cid = uuid.UUID(company_id)
    result = await db.execute(select(Company).where(Company.id == cid))
    company = result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="公司不存在")

    usage_user = await _load_user_for_usage(db, company.submitted_by) or admin_user
    await resolve_async_ai_access(
        db=db,
        current_user=usage_user,
        module="companies",
        prompt_text=company.url,
    )

    await db.execute(
        update(Company).where(Company.id == cid).values(
            pipeline_status=PipelineStatus.PENDING,
            pipeline_error=None,
            submitted_by=usage_user.id,
        )
    )
    await db.commit()

    try:
        from app.core.celery_app import celery_app
        celery_app.send_task("app.tasks.crawl.crawl_company_website", args=[company_id, company.url])
    except Exception:
        pass

    return {"status": "retrying", "company_id": company_id}


@router.delete("/companies/{company_id}")
async def delete_company_admin(company_id: str, db: DbSession, _: AdminUser):
    """删除公司及其关联的审核数据"""
    cid = uuid.UUID(company_id)
    result = await db.execute(select(Company).where(Company.id == cid))
    company = result.scalar_one_or_none()
    if not company:
        raise HTTPException(status_code=404, detail="公司不存在")

    await db.execute(delete(CompanyVote).where(CompanyVote.company_id == cid))
    await db.execute(delete(DiagnosticReport).where(DiagnosticReport.company_id == cid))
    await db.delete(company)
    await db.commit()

    return {"status": "deleted", "company_id": company_id}


# ===== 问答管理 =====

@router.get("/solutions/conversations")
async def list_solution_conversations_admin(
    db: DbSession,
    _: AdminUser,
    page: int = 1,
    size: int = 20,
    search: Optional[str] = None,
    visibility: Optional[str] = None,
    linkage: Optional[str] = None,
):
    """后台问答会话列表，附带摘要统计。"""
    from sqlalchemy import or_

    query = select(Conversation)
    if visibility == "public":
        query = query.where(Conversation.user_id.is_(None))
    elif visibility == "owned":
        query = query.where(Conversation.user_id.is_not(None))

    if linkage == "recommendations":
        query = query.where(
            Conversation.id.in_(
                select(Message.conversation_id).where(
                    Message.recommended_companies.is_not(None),
                    cast(Message.recommended_companies, String).notin_(["[]", "{}", "null"]),
                )
            )
        )
    elif linkage == "diagnostics":
        query = query.where(
            Conversation.id.in_(
                select(Message.conversation_id).where(Message.diagnostic_context_id.is_not(None))
            )
        )

    if search:
        like = f"%{search}%"
        query = query.where(
            or_(
                Conversation.title.ilike(like),
                Conversation.user_id.in_(
                    select(User.id).where(
                        or_(User.username.ilike(like), User.email.ilike(like))
                    )
                ),
                Conversation.id.in_(
                    select(Message.conversation_id).where(
                        or_(
                            Message.content.ilike(like),
                            cast(Message.recommended_companies, String).ilike(like),
                        )
                    )
                ),
            )
        )
    query = query.order_by(Conversation.updated_at.desc())

    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    result = await db.execute(query.offset((page - 1) * size).limit(size))
    conversations = result.scalars().all()
    pages = max(1, (total + size - 1) // size)

    conversation_ids = [conversation.id for conversation in conversations]
    user_ids = {conversation.user_id for conversation in conversations if conversation.user_id}

    messages_by_conversation: dict[uuid.UUID, list[Message]] = {}
    latest_message_by_conversation: dict[uuid.UUID, Message] = {}
    if conversation_ids:
        message_result = await db.execute(
            select(Message)
            .where(Message.conversation_id.in_(conversation_ids))
            .order_by(Message.created_at.asc())
        )
        for message in message_result.scalars().all():
            messages_by_conversation.setdefault(message.conversation_id, []).append(message)
            latest_message_by_conversation[message.conversation_id] = message

    users_by_id: dict[uuid.UUID, User] = {}
    if user_ids:
        user_result = await db.execute(select(User).where(User.id.in_(list(user_ids))))
        users_by_id = {user.id: user for user in user_result.scalars().all()}

    items = []
    total_message_count = 0
    total_assistant_message_count = 0
    conversations_with_recommendations = 0
    conversations_with_diagnostics = 0
    public_conversation_count = 0

    for conversation in conversations:
        messages = messages_by_conversation.get(conversation.id, [])
        latest_message = latest_message_by_conversation.get(conversation.id)
        message_count = len(messages)
        assistant_messages = [
            message for message in messages
            if (message.role.value if isinstance(message.role, MessageRole) else str(message.role)) == "assistant"
        ]
        has_recommendations = any(
            bool(_normalize_recommended_companies(message.recommended_companies)) for message in messages
        )
        diagnostic_context_ids = list({
            str(message.diagnostic_context_id)
            for message in messages
            if message.diagnostic_context_id
        })
        recommendation_company_count = sum(
            len(_normalize_recommended_companies(message.recommended_companies))
            for message in messages
        )
        user = users_by_id.get(conversation.user_id)
        last_assistant_message = assistant_messages[-1] if assistant_messages else None

        total_message_count += message_count
        total_assistant_message_count += len(assistant_messages)
        conversations_with_recommendations += int(has_recommendations)
        conversations_with_diagnostics += int(bool(diagnostic_context_ids))
        public_conversation_count += int(conversation.user_id is None)

        items.append(
            {
                "id": str(conversation.id),
                "title": conversation.title or "未命名问答会话",
                "user_id": str(conversation.user_id) if conversation.user_id else None,
                "is_public": conversation.user_id is None,
                "username": user.username if user else None,
                "user_email": user.email if user else None,
                "message_count": message_count,
                "assistant_message_count": len(assistant_messages),
                "has_recommendations": has_recommendations,
                "recommendation_company_count": recommendation_company_count,
                "diagnostic_context_ids": diagnostic_context_ids,
                "diagnostic_context_count": len(diagnostic_context_ids),
                "latest_message_excerpt": (
                    (latest_message.content or "").strip().replace("\n", " ")[:120]
                    if latest_message else ""
                ),
                "last_assistant_message_at": (
                    last_assistant_message.created_at.isoformat() if last_assistant_message else None
                ),
                "created_at": conversation.created_at.isoformat(),
                "updated_at": conversation.updated_at.isoformat(),
            }
        )

    return {
        "items": items,
        "total": total,
        "page": page,
        "size": size,
        "pages": pages,
        "summary": {
            "message_count": total_message_count,
            "assistant_message_count": total_assistant_message_count,
            "conversations_with_recommendations": conversations_with_recommendations,
            "conversations_with_diagnostics": conversations_with_diagnostics,
            "public_conversation_count": public_conversation_count,
            "owned_conversation_count": len(conversations) - public_conversation_count,
            "average_message_count": round(total_message_count / len(conversations), 1) if conversations else 0,
        },
    }


async def _load_related_solution_summaries(
    db: DbSession,
    matched_messages: list[tuple[Message, set[str]]],
    limit: int = 6,
) -> list[dict]:
    """将匹配到的消息折叠成问答会话摘要。"""
    if not matched_messages:
        return []

    ordered_conversation_ids: list[uuid.UUID] = []
    conversation_matches: dict[uuid.UUID, set[str]] = {}
    conversation_highlights: dict[uuid.UUID, str] = {}

    for message, match_types in matched_messages:
        if message.conversation_id not in conversation_matches:
            ordered_conversation_ids.append(message.conversation_id)
            conversation_matches[message.conversation_id] = set()
        conversation_matches[message.conversation_id].update(match_types)
        if message.content and message.conversation_id not in conversation_highlights:
            conversation_highlights[message.conversation_id] = (
                message.content.strip().replace("\n", " ")[:120]
            )

    selected_ids = ordered_conversation_ids[:limit]
    conversation_result = await db.execute(
        select(Conversation)
        .where(Conversation.id.in_(selected_ids))
        .order_by(Conversation.updated_at.desc())
    )
    conversations = conversation_result.scalars().all()
    user_ids = {conversation.user_id for conversation in conversations if conversation.user_id}
    users_by_id: dict[uuid.UUID, User] = {}
    if user_ids:
        user_result = await db.execute(select(User).where(User.id.in_(list(user_ids))))
        users_by_id = {user.id: user for user in user_result.scalars().all()}

    return [
        {
            "id": str(conversation.id),
            "title": conversation.title or "未命名问答会话",
            "username": users_by_id.get(conversation.user_id).username if users_by_id.get(conversation.user_id) else None,
            "user_email": users_by_id.get(conversation.user_id).email if users_by_id.get(conversation.user_id) else None,
            "updated_at": conversation.updated_at.isoformat(),
            "latest_message_excerpt": conversation_highlights.get(conversation.id, ""),
            "match_types": sorted(conversation_matches.get(conversation.id, set())),
        }
        for conversation in conversations
    ]


@router.get("/solutions/conversations/{conversation_id}")
async def get_solution_conversation_admin(
    conversation_id: str,
    db: DbSession,
    _: AdminUser,
):
    """后台获取单个问答会话详情。"""
    cid = uuid.UUID(conversation_id)
    result = await db.execute(select(Conversation).where(Conversation.id == cid))
    conversation = result.scalar_one_or_none()
    if not conversation:
        raise HTTPException(status_code=404, detail="问答会话不存在")

    message_result = await db.execute(
        select(Message)
        .where(Message.conversation_id == cid)
        .order_by(Message.created_at.asc())
    )
    messages = message_result.scalars().all()

    user = None
    if conversation.user_id:
        user_result = await db.execute(select(User).where(User.id == conversation.user_id))
        user = user_result.scalar_one_or_none()

    diagnostic_ids = list(
        {
            message.diagnostic_context_id
            for message in messages
            if message.diagnostic_context_id
        }
    )
    diagnostics_by_id = {}
    if diagnostic_ids:
        diagnostic_result = await db.execute(
            select(DiagnosticReport).where(DiagnosticReport.id.in_(diagnostic_ids))
        )
        diagnostics_by_id = {
            report.id: report for report in diagnostic_result.scalars().all()
        }

    assistant_messages = []
    user_messages = []
    recommended_company_count = 0
    for message in messages:
        normalized_companies = _normalize_recommended_companies(message.recommended_companies)
        recommended_company_count += len(normalized_companies)
        role_value = message.role.value if isinstance(message.role, MessageRole) else str(message.role)
        if role_value == "assistant":
            assistant_messages.append(message)
        elif role_value == "user":
            user_messages.append(message)

    return {
        "id": str(conversation.id),
        "title": conversation.title or "未命名问答会话",
        "user_id": str(conversation.user_id) if conversation.user_id else None,
        "is_public": conversation.user_id is None,
        "visibility": "public" if conversation.user_id is None else "owned",
        "username": user.username if user else None,
        "user_email": user.email if user else None,
        "created_at": conversation.created_at.isoformat(),
        "updated_at": conversation.updated_at.isoformat(),
        "message_count": len(messages),
        "assistant_message_count": len(assistant_messages),
        "diagnostic_context_count": len(diagnostic_ids),
        "recommended_company_count": recommended_company_count,
        "first_message_at": messages[0].created_at.isoformat() if messages else None,
        "last_user_message_at": user_messages[-1].created_at.isoformat() if user_messages else None,
        "last_assistant_message_at": assistant_messages[-1].created_at.isoformat() if assistant_messages else None,
        "messages": [
            {
                "id": str(message.id),
                "role": message.role.value if isinstance(message.role, MessageRole) else str(message.role),
                "content": message.content,
                "recommended_companies": _normalize_recommended_companies(message.recommended_companies),
                "diagnostic_context_id": str(message.diagnostic_context_id) if message.diagnostic_context_id else None,
                "diagnostic_context": (
                    {
                        "report_id": str(diagnostics_by_id[message.diagnostic_context_id].id),
                        "url": diagnostics_by_id[message.diagnostic_context_id].url,
                        "status": diagnostics_by_id[message.diagnostic_context_id].status.value,
                        "overall_score": diagnostics_by_id[message.diagnostic_context_id].overall_score,
                    }
                    if message.diagnostic_context_id in diagnostics_by_id
                    else None
                ),
                "created_at": message.created_at.isoformat(),
            }
            for message in messages
        ],
    }


@router.delete("/solutions/conversations/{conversation_id}")
async def delete_solution_conversation_admin(
    conversation_id: str,
    db: DbSession,
    _: AdminUser,
):
    """后台删除问答会话及其消息。"""
    cid = uuid.UUID(conversation_id)
    result = await db.execute(select(Conversation).where(Conversation.id == cid))
    conversation = result.scalar_one_or_none()
    if not conversation:
        raise HTTPException(status_code=404, detail="问答会话不存在")

    await db.execute(delete(Message).where(Message.conversation_id == cid))
    await db.execute(delete(Conversation).where(Conversation.id == cid))
    await db.commit()

    return {"status": "deleted", "conversation_id": conversation_id}


class SolutionTemplatesRequest(BaseModel):
    system_prompt: str
    response_instruction: str
    streaming_system_prompt: str


@router.get("/solutions/templates")
async def get_solution_templates_admin(db: DbSession, _: AdminUser):
    """获取 AI 问答回答模板配置。"""
    config = await get_solution_template_config()
    result = await db.execute(select(Setting).where(Setting.key == SOLUTION_TEMPLATES_SETTING_KEY))
    setting = result.scalar_one_or_none()
    updated_by_user = None
    if setting and setting.updated_by:
        user_result = await db.execute(select(User).where(User.id == setting.updated_by))
        updated_by_user = user_result.scalar_one_or_none()
    return _serialize_solution_template_payload(config, setting, updated_by_user)


@router.put("/solutions/templates")
async def update_solution_templates_admin(
    data: SolutionTemplatesRequest,
    db: DbSession,
    admin: AdminUser,
):
    """更新 AI 问答回答模板，并使运行时缓存立即生效。"""
    payload = {
        "system_prompt": data.system_prompt.strip(),
        "response_instruction": data.response_instruction.strip(),
        "streaming_system_prompt": data.streaming_system_prompt.strip(),
    }
    if not all(payload.values()):
        raise HTTPException(status_code=400, detail="回答模板内容不能为空")

    result = await db.execute(select(Setting).where(Setting.key == SOLUTION_TEMPLATES_SETTING_KEY))
    setting = result.scalar_one_or_none()
    if setting:
        setting.value = payload
        setting.category = "solutions"
        setting.is_public = False
        setting.updated_by = admin.id
    else:
        db.add(
            Setting(
                key=SOLUTION_TEMPLATES_SETTING_KEY,
                value=payload,
                category="solutions",
                is_public=False,
                updated_by=admin.id,
            )
        )
    await db.commit()
    await invalidate_runtime_settings_cache()

    config = await get_solution_template_config(force_refresh=True)
    result = await db.execute(select(Setting).where(Setting.key == SOLUTION_TEMPLATES_SETTING_KEY))
    setting = result.scalar_one_or_none()
    updated_by_user = None
    if setting and setting.updated_by:
        user_result = await db.execute(select(User).where(User.id == setting.updated_by))
        updated_by_user = user_result.scalar_one_or_none()
    return _serialize_solution_template_payload(config, setting, updated_by_user)


@router.post("/solutions/templates/reset")
async def reset_solution_templates_admin(db: DbSession, _: AdminUser):
    """恢复回答模板默认值。"""
    await db.execute(delete(Setting).where(Setting.key == SOLUTION_TEMPLATES_SETTING_KEY))
    await db.commit()
    await invalidate_runtime_settings_cache()

    config = await get_solution_template_config(force_refresh=True)
    return _serialize_solution_template_payload(config, None, None)


class SolutionChannelItem(BaseModel):
    key: str
    name: str
    description: str = ""
    icon: str = "forum"
    enabled: bool = True
    system_hint: str = ""
    sample_questions: list[str] = Field(default_factory=list)


class SolutionChannelsRequest(BaseModel):
    default_channel_key: str
    channels: list[SolutionChannelItem]


@router.get("/solutions/channels")
async def get_solution_channels_admin(db: DbSession, _: AdminUser):
    """获取 AI 问答频道配置。"""
    config = await get_solution_channel_config()
    result = await db.execute(select(Setting).where(Setting.key == SOLUTION_CHANNELS_SETTING_KEY))
    setting = result.scalar_one_or_none()
    updated_by_user = None
    if setting and setting.updated_by:
        user_result = await db.execute(select(User).where(User.id == setting.updated_by))
        updated_by_user = user_result.scalar_one_or_none()
    return _serialize_solution_channel_payload(config, setting, updated_by_user)


@router.put("/solutions/channels")
async def update_solution_channels_admin(
    data: SolutionChannelsRequest,
    db: DbSession,
    admin: AdminUser,
):
    """更新 AI 问答频道配置。"""
    seen = set()
    channels = []
    for item in data.channels:
        key = item.key.strip()
        name = item.name.strip()
        if not key or not name:
            raise HTTPException(status_code=400, detail="频道 key 和名称不能为空")
        if key in seen:
            raise HTTPException(status_code=400, detail=f"频道 key 重复: {key}")
        seen.add(key)
        channels.append(
            {
                "key": key[:60],
                "name": name[:80],
                "description": item.description.strip()[:240],
                "icon": (item.icon.strip() or "forum")[:40],
                "enabled": item.enabled,
                "system_hint": item.system_hint.strip()[:500],
                "sample_questions": [
                    question.strip()[:160]
                    for question in item.sample_questions
                    if question.strip()
                ][:6],
            }
        )

    if not channels:
        raise HTTPException(status_code=400, detail="至少保留一个频道")

    enabled_keys = {channel["key"] for channel in channels if channel["enabled"]}
    if not enabled_keys:
        raise HTTPException(status_code=400, detail="至少启用一个频道")

    default_key = data.default_channel_key.strip()
    if default_key not in enabled_keys:
        raise HTTPException(status_code=400, detail="默认频道必须存在且已启用")

    payload = {
        "default_channel_key": default_key,
        "channels": channels,
    }

    result = await db.execute(select(Setting).where(Setting.key == SOLUTION_CHANNELS_SETTING_KEY))
    setting = result.scalar_one_or_none()
    if setting:
        setting.value = payload
        setting.category = "solutions"
        setting.is_public = False
        setting.updated_by = admin.id
    else:
        db.add(
            Setting(
                key=SOLUTION_CHANNELS_SETTING_KEY,
                value=payload,
                category="solutions",
                is_public=False,
                updated_by=admin.id,
            )
        )
    await db.commit()
    await invalidate_runtime_settings_cache()

    config = await get_solution_channel_config(force_refresh=True)
    result = await db.execute(select(Setting).where(Setting.key == SOLUTION_CHANNELS_SETTING_KEY))
    setting = result.scalar_one_or_none()
    updated_by_user = None
    if setting and setting.updated_by:
        user_result = await db.execute(select(User).where(User.id == setting.updated_by))
        updated_by_user = user_result.scalar_one_or_none()
    return _serialize_solution_channel_payload(config, setting, updated_by_user)


@router.post("/solutions/channels/reset")
async def reset_solution_channels_admin(db: DbSession, _: AdminUser):
    """恢复 AI 问答频道默认配置。"""
    await db.execute(delete(Setting).where(Setting.key == SOLUTION_CHANNELS_SETTING_KEY))
    await db.commit()
    await invalidate_runtime_settings_cache()

    config = await get_solution_channel_config(force_refresh=True)
    return _serialize_solution_channel_payload(config, None, None)


# ===== 诊断管理 =====


def _build_diagnostic_report_payload(
    report: DiagnosticReport,
    company: Company | None,
    user: User | None,
    rules: dict,
) -> dict:
    return {
        "id": str(report.id),
        "url": report.url,
        "status": report.status.value,
        "overall_score": report.overall_score,
        "company_id": str(report.company_id) if report.company_id else None,
        "company_name": company.name if company else None,
        "user_id": str(report.user_id) if report.user_id else None,
        "username": user.username if user else None,
        "user_email": user.email if user else None,
        "schema_analysis": report.schema_analysis or {},
        "content_analysis": report.content_analysis or {},
        "meta_analysis": report.meta_analysis or {},
        "citation_analysis": report.citation_analysis or {},
        "recommendations": report.recommendations or {},
        "error_message": report.error_message,
        "raw_html_key": report.raw_html_key,
        "created_at": report.created_at.isoformat(),
        "rule_config": rules,
    }

@router.get("/diagnostics/reports")
async def list_diagnostic_reports_admin(
    db: DbSession,
    _: AdminUser,
    page: int = 1,
    size: int = 20,
    status_filter: Optional[str] = None,
    search: Optional[str] = None,
):
    """后台诊断报告列表，附带统计摘要。"""
    query = select(DiagnosticReport)
    if status_filter:
        query = query.where(DiagnosticReport.status == status_filter)
    if search:
        like = f"%{search.strip()}%"
        query = query.where(
            or_(
                DiagnosticReport.url.ilike(like),
                DiagnosticReport.company_id.in_(
                    select(Company.id).where(
                        or_(
                            Company.name.ilike(like),
                            Company.url.ilike(like),
                        )
                    )
                ),
                DiagnosticReport.user_id.in_(
                    select(User.id).where(
                        or_(
                            User.username.ilike(like),
                            User.email.ilike(like),
                        )
                    )
                ),
            )
        )
    query = query.order_by(DiagnosticReport.created_at.desc())

    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    result = await db.execute(query.offset((page - 1) * size).limit(size))
    reports = result.scalars().all()
    pages = max(1, (total + size - 1) // size)

    company_ids = {report.company_id for report in reports if report.company_id}
    user_ids = {report.user_id for report in reports if report.user_id}

    companies_by_id = {}
    users_by_id = {}
    if company_ids:
        company_result = await db.execute(select(Company).where(Company.id.in_(list(company_ids))))
        companies_by_id = {company.id: company for company in company_result.scalars().all()}
    if user_ids:
        user_result = await db.execute(select(User).where(User.id.in_(list(user_ids))))
        users_by_id = {user.id: user for user in user_result.scalars().all()}

    completed_count = 0
    failed_count = 0
    scored_values: list[float] = []
    items = []

    for report in reports:
        company = companies_by_id.get(report.company_id)
        user = users_by_id.get(report.user_id)

        completed_count += int(report.status == DiagnosticStatus.COMPLETED)
        failed_count += int(report.status == DiagnosticStatus.FAILED)
        if report.overall_score is not None:
            scored_values.append(report.overall_score)

        items.append(
            {
                "id": str(report.id),
                "url": report.url,
                "status": report.status.value,
                "overall_score": report.overall_score,
                "company_id": str(report.company_id) if report.company_id else None,
                "company_name": company.name if company else None,
                "user_id": str(report.user_id) if report.user_id else None,
                "username": user.username if user else None,
                "user_email": user.email if user else None,
                "error_message": report.error_message,
                "created_at": report.created_at.isoformat(),
            }
        )

    average_score = round(sum(scored_values) / len(scored_values), 1) if scored_values else None

    return {
        "items": items,
        "total": total,
        "page": page,
        "size": size,
        "pages": pages,
        "summary": {
            "completed_count": completed_count,
            "failed_count": failed_count,
            "average_score": average_score,
        },
    }


@router.get("/diagnostics/reports/{report_id}")
async def get_diagnostic_report_admin(
    report_id: str,
    db: DbSession,
    _: AdminUser,
):
    """后台获取单份诊断报告详情。"""
    rid = uuid.UUID(report_id)
    result = await db.execute(select(DiagnosticReport).where(DiagnosticReport.id == rid))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="诊断报告不存在")

    company = None
    user = None
    if report.company_id:
        company_result = await db.execute(select(Company).where(Company.id == report.company_id))
        company = company_result.scalar_one_or_none()
    if report.user_id:
        user_result = await db.execute(select(User).where(User.id == report.user_id))
        user = user_result.scalar_one_or_none()

    rules = await get_diagnostic_rule_config()
    related_message_result = await db.execute(
        select(Message)
        .where(Message.diagnostic_context_id == rid)
        .order_by(Message.created_at.desc())
    )
    related_solutions = await _load_related_solution_summaries(
        db,
        [(message, {"diagnostic_context"}) for message in related_message_result.scalars().all()],
    )
    payload = _build_diagnostic_report_payload(report, company, user, rules)
    payload["related_solutions"] = related_solutions
    return payload


@router.post("/diagnostics/reports/{report_id}/retry")
async def retry_diagnostic_report_admin(
    report_id: str,
    db: DbSession,
    admin_user: AdminUser,
):
    """重新触发诊断抓取与分析链路。"""
    rid = uuid.UUID(report_id)
    result = await db.execute(select(DiagnosticReport).where(DiagnosticReport.id == rid))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="诊断报告不存在")

    usage_user = await _load_user_for_usage(db, report.user_id) or admin_user
    await resolve_async_ai_access(
        db=db,
        current_user=usage_user,
        module="diagnostics",
        prompt_text=report.url,
    )

    await db.execute(
        update(DiagnosticReport)
        .where(DiagnosticReport.id == rid)
        .values(status=DiagnosticStatus.PENDING, error_message=None, user_id=usage_user.id)
    )
    await db.commit()

    try:
        from app.core.celery_app import celery_app

        celery_app.send_task(
            "app.tasks.crawl.crawl_diagnostic_page",
            args=[report_id, report.url],
        )
    except Exception:
        pass

    return {"status": "retrying", "report_id": report_id}


class DiagnosticRulesRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    schema_weight: float = Field(alias="schema")
    content_weight: float = Field(alias="content")
    meta_weight: float = Field(alias="meta")
    citation_weight: float = Field(alias="citation")


@router.get("/diagnostics/rules")
async def get_diagnostic_rules_admin(_: AdminUser):
    """获取后台可配置的诊断评分权重。"""
    return await get_diagnostic_rule_config()


@router.put("/diagnostics/rules")
async def update_diagnostic_rules_admin(
    data: DiagnosticRulesRequest,
    db: DbSession,
    admin: AdminUser,
):
    """更新诊断评分权重，按比例归一化后用于后续报告评分。"""
    weights = {
        "schema": data.schema_weight,
        "content": data.content_weight,
        "meta": data.meta_weight,
        "citation": data.citation_weight,
    }
    if any(value < 0 for value in weights.values()):
        raise HTTPException(status_code=400, detail="诊断权重不能为负数")
    if sum(weights.values()) <= 0:
        raise HTTPException(status_code=400, detail="诊断权重总和必须大于 0")

    result = await db.execute(select(Setting).where(Setting.key == DIAGNOSTIC_RULES_SETTING_KEY))
    setting = result.scalar_one_or_none()
    if setting:
        setting.value = weights
        setting.category = "diagnostics"
        setting.is_public = False
        setting.updated_by = admin.id
    else:
        db.add(
            Setting(
                key=DIAGNOSTIC_RULES_SETTING_KEY,
                value=weights,
                category="diagnostics",
                is_public=False,
                updated_by=admin.id,
            )
        )
    await db.commit()
    await invalidate_runtime_settings_cache()
    return await get_diagnostic_rule_config(force_refresh=True)


def _diagnostic_export_markdown(detail: dict, rules: dict) -> str:
    """将诊断详情导出为 Markdown 文本。"""
    lines = [
        "# GEO 诊断报告",
        "",
        f"- URL: {detail['url']}",
        f"- 状态: {detail['status']}",
        f"- 综合评分: {detail['overall_score'] if detail['overall_score'] is not None else '--'}",
        f"- 公司: {detail.get('company_name') or '--'}",
        f"- 用户: {detail.get('username') or detail.get('user_email') or '--'}",
        f"- 生成时间: {detail['created_at']}",
        "",
        "## 当前评分权重",
        "",
        f"- Schema: {rules['weights']['schema']}%",
        f"- Content: {rules['weights']['content']}%",
        f"- Meta: {rules['weights']['meta']}%",
        f"- Citation: {rules['weights']['citation']}%",
        "",
        "## 维度评分",
        "",
        f"- Schema: {(detail.get('schema_analysis') or {}).get('score', '--')}",
        f"- Content: {(detail.get('content_analysis') or {}).get('score', '--')}",
        f"- Meta: {(detail.get('meta_analysis') or {}).get('score', '--')}",
        f"- Citation: {(detail.get('citation_analysis') or {}).get('score', '--')}",
        "",
    ]

    for section_key, section_title in [
        ("urgent", "高优先级建议"),
        ("recommended", "建议优化项"),
        ("optional", "可选优化项"),
    ]:
        lines.extend(["## " + section_title, ""])
        items = (detail.get("recommendations") or {}).get(section_key) or []
        if not items:
            lines.append("- 暂无")
            lines.append("")
            continue
        for item in items:
            if isinstance(item, dict):
                title = item.get("item") or "建议项"
                action = item.get("action") or "--"
                lines.append(f"- {title}: {action}")
            else:
                lines.append(f"- {item}")
        lines.append("")

    if detail.get("error_message"):
        lines.extend(["## 错误信息", "", detail["error_message"], ""])

    return "\n".join(lines).strip() + "\n"


@router.get("/diagnostics/reports/{report_id}/export")
async def export_diagnostic_report_admin(
    report_id: str,
    db: DbSession,
    admin_user: AdminUser,
    format: str = "markdown",
):
    """导出诊断报告，当前支持 markdown。"""
    if format not in {"markdown", "json"}:
        raise HTTPException(status_code=400, detail="仅支持 markdown 或 json 导出")

    detail = await get_diagnostic_report_admin(report_id, db, admin_user)
    if format == "json":
        return detail

    markdown_body = _diagnostic_export_markdown(detail, detail["rule_config"])
    filename = f"diagnostic-report-{report_id}.md"
    return Response(
        content=markdown_body,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ===== 内容管理 (Wiki) =====

class ContentCreateRequest(BaseModel):
    title: str
    content_type: str = "tutorial"
    markdown_body: str = ""
    status: Optional[str] = None
    cover_image: Optional[str] = None
    tags: list[str] = []
    reading_time_minutes: Optional[int] = None


@router.get("/tutorials/{content_id}")
@router.get("/content/{content_id}")
async def get_content_admin(content_id: str, db: DbSession, _: AdminUser):
    """后台获取单篇文章完整数据（含 markdown_body）"""
    cid = uuid.UUID(content_id)
    result = await db.execute(select(Content).where(Content.id == cid))
    article = result.scalar_one_or_none()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    return {
        "id": str(article.id),
        "title": article.title,
        "slug": article.slug,
        "path_key": article.path_key,
        "content_type": article.content_type.value,
        "status": article.status.value,
        "markdown_body": article.markdown_body or "",
        "html_body": render_markdown(article.markdown_body),
        "cover_image": article.cover_image,
        "tags": article.tags if isinstance(article.tags, list) else [],
        "reading_time_minutes": article.reading_time_minutes,
        "view_count": article.view_count,
        "created_at": article.created_at.isoformat(),
        "updated_at": article.updated_at.isoformat(),
    }


@router.get("/tutorials")
@router.get("/content")
async def list_content_admin(
    db: DbSession,
    _: AdminUser,
    page: int = 1,
    size: int = 20,
    content_type: Optional[str] = None,
    status_filter: Optional[str] = None,
    search: Optional[str] = None,
):
    """后台文章列表（含草稿，支持教程业务筛选与统计）"""
    filters = []
    if content_type:
        filters.append(Content.content_type == content_type)
    if status_filter:
        filters.append(Content.status == status_filter)
    if search:
        like = f"%{search.strip()}%"
        filters.append(
            or_(
                Content.title.ilike(like),
                Content.slug.ilike(like),
                Content.path_key.ilike(like),
                cast(Content.tags, String).ilike(like),
            )
        )

    total = await db.scalar(select(func.count(Content.id)).where(*filters))
    result = await db.execute(
        select(Content)
        .where(*filters)
        .order_by(Content.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    articles = result.scalars().all()
    pages = max(1, (total + size - 1) // size)
    tutorial_total = await db.scalar(
        select(func.count(Content.id)).where(Content.content_type == ContentType.TUTORIAL)
    )
    tutorial_published = await db.scalar(
        select(func.count(Content.id)).where(
            Content.content_type == ContentType.TUTORIAL,
            Content.status == ContentStatus.PUBLISHED,
        )
    )
    draft_assets = await db.scalar(
        select(func.count(Content.id)).where(Content.status == ContentStatus.DRAFT)
    )
    total_views = await db.scalar(select(func.coalesce(func.sum(Content.view_count), 0)))
    template_total = await db.scalar(
        select(func.count(Content.id)).where(Content.content_type == ContentType.TEMPLATE)
    )
    return {
        "items": [
            {
                "id": str(a.id),
                "title": a.title,
                "slug": a.slug,
                "path_key": a.path_key,
                "content_type": a.content_type.value,
                "status": a.status.value,
                "view_count": a.view_count,
                "reading_time_minutes": a.reading_time_minutes,
                "tags": a.tags if isinstance(a.tags, list) else [],
                "created_at": a.created_at.isoformat(),
                "updated_at": a.updated_at.isoformat(),
            }
            for a in articles
        ],
        "summary": {
            "tutorial_total": tutorial_total or 0,
            "tutorial_published": tutorial_published or 0,
            "draft_assets": draft_assets or 0,
            "template_total": template_total or 0,
            "total_views": total_views or 0,
        },
        "total": total,
        "page": page,
        "size": size,
        "pages": pages,
    }


@router.post("/tutorials", status_code=status.HTTP_201_CREATED)
@router.post("/content", status_code=status.HTTP_201_CREATED)
async def create_content(data: ContentCreateRequest, db: DbSession, admin: AdminUser):
    """创建 Wiki 文章"""
    import re
    slug = re.sub(r"[^\w\-]", "-", data.title.lower().replace(" ", "-"))[:280]
    # 计算阅读时间（约 200 字/分钟）
    reading_time = data.reading_time_minutes or max(1, len(data.markdown_body) // 400)
    target_status = ContentStatus(data.status) if data.status else ContentStatus.DRAFT

    article = Content(
        title=data.title,
        slug=slug,
        path_key=await _generate_unique_content_path_key(db),
        content_type=data.content_type,
        status=target_status,
        markdown_body=data.markdown_body,
        cover_image=data.cover_image,
        tags=data.tags,
        reading_time_minutes=reading_time,
        author_id=admin.id,
    )
    db.add(article)
    await db.commit()
    await db.refresh(article)
    return {"id": str(article.id), "slug": article.slug, "path_key": article.path_key}


@router.put("/tutorials/{content_id}")
@router.put("/content/{content_id}")
async def update_content(content_id: str, data: ContentCreateRequest, db: DbSession, _: AdminUser):
    """更新 Wiki 文章（支持修改状态）"""
    cid = uuid.UUID(content_id)
    result = await db.execute(select(Content).where(Content.id == cid))
    article = result.scalar_one_or_none()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")

    reading_time = data.reading_time_minutes or max(1, len(data.markdown_body) // 400)
    values = dict(
        title=data.title,
        content_type=data.content_type,
        markdown_body=data.markdown_body,
        cover_image=data.cover_image,
        tags=data.tags,
        reading_time_minutes=reading_time,
    )
    if data.status:
        values["status"] = ContentStatus(data.status)
    await db.execute(update(Content).where(Content.id == cid).values(**values))
    await db.commit()
    return {"id": content_id, "status": "updated"}


@router.post("/tutorials/{content_id}/publish")
@router.post("/content/{content_id}/publish")
async def publish_content(content_id: str, db: DbSession, _: AdminUser):
    """发布文章"""
    await db.execute(
        update(Content).where(Content.id == uuid.UUID(content_id)).values(status=ContentStatus.PUBLISHED)
    )
    await db.commit()
    return {"status": "published"}


@router.delete("/tutorials/{content_id}", status_code=status.HTTP_204_NO_CONTENT)
@router.delete("/content/{content_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_content(content_id: str, db: DbSession, _: AdminUser):
    """删除文章"""
    from sqlalchemy import delete as sql_delete
    cid = uuid.UUID(content_id)
    result = await db.execute(select(Content).where(Content.id == cid))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="文章不存在")
    await db.execute(sql_delete(Content).where(Content.id == cid))
    await db.commit()


# ===== 专家管理 =====

class ExpertProfileRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=120)
    avatar_initials: Optional[str] = Field(default=None, max_length=12)
    title: str = Field(..., min_length=1, max_length=160)
    category: str = Field(default="strategy", max_length=50)
    specialty_label: str = Field(default="策略", max_length=50)
    summary: str = ""
    expertise: list[str] = Field(default_factory=list)
    consultation: str = ""
    keywords: list[str] = Field(default_factory=list)
    sort_order: int = 100
    is_featured: bool = True
    is_published: bool = False


def _normalize_string_list(items: list[str] | None, *, limit: int = 12) -> list[str]:
    if not isinstance(items, list):
        return []
    cleaned: list[str] = []
    for item in items:
        value = str(item or "").strip()
        if value and value not in cleaned:
            cleaned.append(value[:160])
        if len(cleaned) >= limit:
            break
    return cleaned


def _expert_values(data: ExpertProfileRequest) -> dict:
    return {
        "display_name": data.display_name.strip(),
        "avatar_initials": (data.avatar_initials or "")[:12].strip() or None,
        "title": data.title.strip(),
        "category": data.category.strip() or "strategy",
        "specialty_label": data.specialty_label.strip() or "策略",
        "summary": data.summary.strip(),
        "expertise": _normalize_string_list(data.expertise),
        "consultation": data.consultation.strip(),
        "keywords": _normalize_string_list(data.keywords),
        "sort_order": data.sort_order,
        "is_featured": data.is_featured,
        "is_published": data.is_published,
    }


def _serialize_admin_expert(expert: ExpertProfile) -> dict:
    payload = serialize_expert(expert)
    payload["created_by"] = str(expert.created_by) if expert.created_by else None
    return payload


async def _expert_summary(db: DbSession, filters: list) -> dict:
    total = await db.scalar(select(func.count(ExpertProfile.id)).where(*filters))
    published = await db.scalar(
        select(func.count(ExpertProfile.id)).where(*filters, ExpertProfile.is_published == True)
    )
    featured = await db.scalar(
        select(func.count(ExpertProfile.id)).where(*filters, ExpertProfile.is_featured == True)
    )
    category_rows = await db.execute(
        select(ExpertProfile.category, func.count(ExpertProfile.id))
        .where(*filters)
        .group_by(ExpertProfile.category)
        .order_by(ExpertProfile.category)
    )
    return {
        "total": total or 0,
        "published": published or 0,
        "draft": (total or 0) - (published or 0),
        "featured": featured or 0,
        "category_counts": [
            {"category": category, "count": count}
            for category, count in category_rows.fetchall()
        ],
    }


@router.get("/experts")
async def list_experts_admin(
    db: DbSession,
    _: AdminUser,
    page: int = 1,
    size: int = 20,
    category: Optional[str] = None,
    status_filter: Optional[str] = None,
    search: Optional[str] = None,
):
    """后台专家列表与统计。"""
    safe_page = max(1, page)
    safe_size = max(1, min(size, 100))
    filters = []
    if category:
        filters.append(ExpertProfile.category == category)
    if status_filter == "published":
        filters.append(ExpertProfile.is_published == True)
    elif status_filter == "draft":
        filters.append(ExpertProfile.is_published == False)
    elif status_filter == "featured":
        filters.append(ExpertProfile.is_featured == True)
    if search:
        like = f"%{search.strip()}%"
        filters.append(
            or_(
                ExpertProfile.display_name.ilike(like),
                ExpertProfile.title.ilike(like),
                ExpertProfile.specialty_label.ilike(like),
                ExpertProfile.summary.ilike(like),
                ExpertProfile.consultation.ilike(like),
                cast(ExpertProfile.expertise, String).ilike(like),
                cast(ExpertProfile.keywords, String).ilike(like),
            )
        )

    query = (
        select(ExpertProfile)
        .where(*filters)
        .order_by(ExpertProfile.sort_order.asc(), ExpertProfile.created_at.desc())
    )
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    result = await db.execute(query.offset((safe_page - 1) * safe_size).limit(safe_size))
    experts = result.scalars().all()
    return {
        "items": [_serialize_admin_expert(expert) for expert in experts],
        "summary": await _expert_summary(db, filters),
        "total": total or 0,
        "page": safe_page,
        "size": safe_size,
        "pages": max(1, ((total or 0) + safe_size - 1) // safe_size),
    }


@router.post("/experts", status_code=status.HTTP_201_CREATED)
async def create_expert_admin(data: ExpertProfileRequest, db: DbSession, admin: AdminUser):
    """创建专家频道画像。"""
    expert = ExpertProfile(**_expert_values(data), created_by=admin.id)
    db.add(expert)
    await db.commit()
    await db.refresh(expert)
    return _serialize_admin_expert(expert)


@router.get("/experts/{expert_id}")
async def get_expert_admin(expert_id: str, db: DbSession, _: AdminUser):
    """获取专家详情。"""
    result = await db.execute(select(ExpertProfile).where(ExpertProfile.id == uuid.UUID(expert_id)))
    expert = result.scalar_one_or_none()
    if not expert:
        raise HTTPException(status_code=404, detail="专家不存在")
    return _serialize_admin_expert(expert)


@router.put("/experts/{expert_id}")
async def update_expert_admin(expert_id: str, data: ExpertProfileRequest, db: DbSession, _: AdminUser):
    """更新专家频道画像。"""
    cid = uuid.UUID(expert_id)
    result = await db.execute(select(ExpertProfile).where(ExpertProfile.id == cid))
    expert = result.scalar_one_or_none()
    if not expert:
        raise HTTPException(status_code=404, detail="专家不存在")
    for key, value in _expert_values(data).items():
        setattr(expert, key, value)
    await db.commit()
    await db.refresh(expert)
    return _serialize_admin_expert(expert)


@router.delete("/experts/{expert_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expert_admin(expert_id: str, db: DbSession, _: AdminUser):
    """删除专家频道画像。"""
    cid = uuid.UUID(expert_id)
    result = await db.execute(select(ExpertProfile.id).where(ExpertProfile.id == cid))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="专家不存在")
    await db.execute(delete(ExpertProfile).where(ExpertProfile.id == cid))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ===== 用户管理 =====

@router.get("/users")
async def list_users(
    db: DbSession,
    _: AdminUser,
    page: int = 1,
    size: int = 20,
    role: Optional[str] = None,
    is_active: Optional[bool] = None,
    search: Optional[str] = None,
):
    """用户列表（分页，支持搜索/角色/状态筛选）"""
    from sqlalchemy import or_
    query = select(User)
    if role:
        query = query.where(User.role == role)
    if is_active is not None:
        query = query.where(User.is_active == is_active)
    if search:
        query = query.where(
            or_(
                User.username.ilike(f"%{search}%"),
                User.email.ilike(f"%{search}%"),
                User.phone.ilike(f"%{search}%"),
            )
        )
    query = query.order_by(User.created_at.desc())

    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    result = await db.execute(query.offset((page - 1) * size).limit(size))
    users = result.scalars().all()
    pages = max(1, (total + size - 1) // size)

    return {
        "items": [
            {
                "id": str(u.id),
                "email": u.email,
                "username": u.username,
                "phone": u.phone,
                "role": u.role.value,
                "is_active": u.is_active,
                "is_verified": u.is_verified,
                "created_at": u.created_at.isoformat(),
            }
            for u in users
        ],
        "total": total,
        "page": page,
        "size": size,
        "pages": pages,
    }


@router.post("/users/{user_id}/toggle-active")
async def toggle_user_active(user_id: str, db: DbSession, admin: AdminUser):
    """启用/停用用户"""
    uid = uuid.UUID(user_id)
    if uid == admin.id:
        raise HTTPException(status_code=400, detail="不能停用当前登录的管理员账号")

    result = await db.execute(select(User).where(User.id == uid))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    next_active = not bool(user.is_active)
    await db.execute(update(User).where(User.id == uid).values(is_active=next_active))
    await db.commit()
    return {"user_id": user_id, "is_active": next_active}


class RoleUpdateRequest(BaseModel):
    role: str


class AdminUserCreateRequest(BaseModel):
    email: EmailStr
    username: str = Field(min_length=2, max_length=100)
    password: str = Field(min_length=6, max_length=128)
    role: str = Field(default="user", pattern="^(admin|enterprise|user)$")
    phone: str | None = Field(default=None, min_length=6, max_length=30)


class AdminKeywordPackCreateRequest(BaseModel):
    seeds: list[str] = Field(default_factory=list, min_length=1, max_length=8)
    title: str | None = Field(default=None, max_length=200)
    source_type: str = Field(default="manual", pattern="^(manual|company|diagnostic|solution|tutorial)$")
    source_ref_id: uuid.UUID | None = None


def _serialize_keyword_pack_summary(pack: KeywordPack) -> dict:
    return {
        "id": str(pack.id),
        "title": pack.title,
        "seed_keywords": pack.seed_keywords if isinstance(pack.seed_keywords, list) else [],
        "source_type": pack.source_type,
        "source_ref_id": str(pack.source_ref_id) if pack.source_ref_id else None,
        "status": pack.status,
        "summary": pack.summary,
        "profile": pack.profile if isinstance(pack.profile, dict) else {},
        "dimension_count": pack.dimension_count,
        "total_keywords": pack.total_keywords,
        "avg_recommendation_score": pack.avg_recommendation_score,
        "avg_business_score": pack.avg_business_score,
        "high_recommendation_ratio": pack.high_recommendation_ratio,
        "high_business_ratio": pack.high_business_ratio,
        "generation_mode": pack.generation_mode,
        "created_by": str(pack.created_by) if pack.created_by else None,
        "created_at": pack.created_at.isoformat() if pack.created_at else None,
        "updated_at": pack.updated_at.isoformat() if pack.updated_at else None,
    }


def _serialize_keyword_pack_detail(pack: KeywordPack, items: list[KeywordItem]) -> dict:
    dimensions_by_key: dict[str, dict] = {}
    for item in items:
        dimension = dimensions_by_key.setdefault(
            item.dimension_key,
            {
                "key": item.dimension_key,
                "name": item.dimension_name or item.dimension_key,
                "icon": item.dimension_icon or "tag",
                "description": item.dimension_description or "",
                "count": 0,
                "items": [],
            },
        )
        dimension["items"].append({
            "id": str(item.id),
            "keyword": item.keyword,
            "recommendation_score": item.recommendation_score,
            "business_score": item.business_score,
            "intent_label": item.intent_label,
            "source": item.source,
            "reason": item.reason,
            "is_selected": item.is_selected,
        })
        dimension["count"] += 1

    return {
        **_serialize_keyword_pack_summary(pack),
        "dimensions": list(dimensions_by_key.values()),
    }


@router.post("/users", status_code=status.HTTP_201_CREATED)
async def create_user_admin(data: AdminUserCreateRequest, db: DbSession, _: AdminUser):
    """后台创建用户。当前仅创建本地账号，不发送外部邀请邮件。"""
    phone = _normalize_phone(data.phone) if data.phone else None
    filters = [User.email == str(data.email), User.username == data.username]
    if phone:
        filters.append(User.phone == phone)

    result = await db.execute(select(User).where(or_(*filters)))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="用户名、邮箱或手机号已存在")

    user = User(
        email=str(data.email),
        username=data.username,
        phone=phone,
        hashed_password=_hash_password(data.password),
        role=UserRole(data.role),
        is_active=True,
        is_verified=False,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return {
        "id": str(user.id),
        "email": user.email,
        "username": user.username,
        "phone": user.phone,
        "role": user.role.value,
        "is_active": user.is_active,
        "is_verified": user.is_verified,
        "created_at": user.created_at.isoformat(),
    }


@router.put("/users/{user_id}/role")
async def update_user_role(user_id: str, data: RoleUpdateRequest, db: DbSession, admin: AdminUser):
    """修改用户角色"""
    if data.role not in [r.value for r in UserRole]:
        raise HTTPException(status_code=400, detail=f"无效角色: {data.role}")
    uid = uuid.UUID(user_id)
    if uid == admin.id:
        raise HTTPException(status_code=400, detail="不能修改当前登录管理员的角色")

    result = await db.execute(select(User.id).where(User.id == uid))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="用户不存在")

    await db.execute(update(User).where(User.id == uid).values(role=data.role))
    await db.commit()
    return {"user_id": user_id, "role": data.role}


# ===== 拓词管理 =====

@router.get("/keywords/summary")
async def keyword_summary_admin(db: DbSession, _: AdminUser):
    """后台拓词总览统计。"""
    total_packs = await db.scalar(select(func.count(KeywordPack.id)))
    total_keywords = await db.scalar(select(func.coalesce(func.sum(KeywordPack.total_keywords), 0)))
    completed_packs = await db.scalar(
        select(func.count(KeywordPack.id)).where(KeywordPack.status == "completed")
    )
    avg_recommendation = await db.scalar(select(func.avg(KeywordPack.avg_recommendation_score)))
    avg_business = await db.scalar(select(func.avg(KeywordPack.avg_business_score)))

    latest_result = await db.execute(select(KeywordPack).order_by(KeywordPack.created_at.desc()).limit(1))
    latest_pack = latest_result.scalar_one_or_none()

    source_rows = await db.execute(
        select(KeywordPack.source_type, func.count(KeywordPack.id))
        .group_by(KeywordPack.source_type)
        .order_by(KeywordPack.source_type)
    )
    dimension_rows = await db.execute(
        select(KeywordItem.dimension_key, KeywordItem.dimension_name, func.count(KeywordItem.id))
        .group_by(KeywordItem.dimension_key, KeywordItem.dimension_name)
        .order_by(func.count(KeywordItem.id).desc())
        .limit(8)
    )

    return {
        "total_packs": total_packs or 0,
        "completed_packs": completed_packs or 0,
        "total_keywords": total_keywords or 0,
        "avg_recommendation_score": round(float(avg_recommendation or 0), 1),
        "avg_business_score": round(float(avg_business or 0), 1),
        "latest_pack": _serialize_keyword_pack_summary(latest_pack) if latest_pack else None,
        "source_counts": [
            {"source_type": source_type, "count": count}
            for source_type, count in source_rows.fetchall()
        ],
        "dimension_counts": [
            {"key": key, "name": name or key, "count": count}
            for key, name, count in dimension_rows.fetchall()
        ],
    }


@router.get("/keywords/packs")
async def list_keyword_packs_admin(
    db: DbSession,
    _: AdminUser,
    page: int = 1,
    size: int = 20,
    search: Optional[str] = None,
    source_type: Optional[str] = None,
):
    """后台词包列表。"""
    safe_page = max(1, page)
    safe_size = max(1, min(size, 100))
    query = select(KeywordPack)

    if source_type:
        query = query.where(KeywordPack.source_type == source_type)
    if search:
        like = f"%{search}%"
        query = query.where(
            or_(
                KeywordPack.title.ilike(like),
                cast(KeywordPack.seed_keywords, String).ilike(like),
                cast(KeywordPack.profile, String).ilike(like),
            )
        )

    query = query.order_by(KeywordPack.created_at.desc())
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    result = await db.execute(query.offset((safe_page - 1) * safe_size).limit(safe_size))
    packs = result.scalars().all()

    return {
        "items": [_serialize_keyword_pack_summary(pack) for pack in packs],
        "total": total or 0,
        "page": safe_page,
        "size": safe_size,
        "pages": max(1, ((total or 0) + safe_size - 1) // safe_size),
    }


@router.post("/keywords/packs", status_code=status.HTTP_201_CREATED)
async def create_keyword_pack_admin(data: AdminKeywordPackCreateRequest, db: DbSession, admin: AdminUser):
    """生成并保存后台拓词词包。"""
    try:
        expanded = await expand_keywords(data.seeds)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    seeds = expanded.get("seeds") or data.seeds
    profile = expanded.get("profile") or {}
    summary = expanded.get("summary") or {}
    dimensions = expanded.get("dimensions") or []
    title = (data.title or "").strip() or f"{' / '.join(seeds[:3])} 拓词包"

    pack = KeywordPack(
        title=title[:200],
        seed_keywords=seeds,
        source_type=data.source_type,
        source_ref_id=data.source_ref_id,
        status="completed",
        summary=profile.get("keyword_strategy") or profile.get("business_model") or "",
        profile=profile,
        dimension_count=len(dimensions),
        total_keywords=int(summary.get("total_keywords") or 0),
        avg_recommendation_score=float(summary.get("average_recommendation_score") or 0),
        avg_business_score=float(summary.get("average_business_score") or 0),
        high_recommendation_ratio=float(summary.get("high_recommendation_ratio") or 0),
        high_business_ratio=float(summary.get("high_business_ratio") or 0),
        generation_mode="hybrid",
        generation_meta={
            "created_from": "admin",
            "dimension_count": len(dimensions),
            "generated_at": datetime.utcnow().isoformat(),
        },
        created_by=admin.id,
    )
    db.add(pack)
    await db.flush()

    items: list[KeywordItem] = []
    for dimension in dimensions:
        dimension_key = str(dimension.get("key") or "unknown")
        for raw_item in dimension.get("items") or []:
            keyword = str(raw_item.get("keyword") or "").strip()
            if not keyword:
                continue
            dedupe_key = f"{dimension_key}:{keyword.lower()}"
            item = KeywordItem(
                pack_id=pack.id,
                dimension_key=dimension_key,
                dimension_name=dimension.get("name") or dimension_key,
                dimension_icon=dimension.get("icon") or "tag",
                dimension_description=dimension.get("description") or "",
                keyword=keyword[:300],
                recommendation_score=int(raw_item.get("recommendation_score") or 0),
                business_score=int(raw_item.get("business_score") or 0),
                intent_label=raw_item.get("intent_label") or dimension_key,
                source=raw_item.get("source") or "generated",
                dedupe_key=dedupe_key[:500],
                reason=raw_item.get("reason"),
            )
            db.add(item)
            items.append(item)

    pack.total_keywords = len(items)
    await db.commit()
    await db.refresh(pack)

    return _serialize_keyword_pack_detail(pack, items)


@router.get("/keywords/packs/{pack_id}")
async def get_keyword_pack_admin(pack_id: str, db: DbSession, _: AdminUser):
    """后台词包详情。"""
    cid = uuid.UUID(pack_id)
    result = await db.execute(select(KeywordPack).where(KeywordPack.id == cid))
    pack = result.scalar_one_or_none()
    if not pack:
        raise HTTPException(status_code=404, detail="词包不存在")

    items_result = await db.execute(
        select(KeywordItem)
        .where(KeywordItem.pack_id == pack.id)
        .order_by(KeywordItem.created_at.asc())
    )
    return _serialize_keyword_pack_detail(pack, items_result.scalars().all())


@router.get("/keywords/packs/{pack_id}/export")
async def export_keyword_pack_admin(pack_id: str, db: DbSession, _: AdminUser):
    """导出词包 CSV。"""
    detail = await get_keyword_pack_admin(pack_id, db, _)
    lines = ["dimension,key,keyword,recommendation_score,business_score,reason"]
    for dimension in detail.get("dimensions") or []:
        for item in dimension.get("items") or []:
            values = [
                dimension.get("name") or dimension.get("key") or "",
                dimension.get("key") or "",
                item.get("keyword") or "",
                str(item.get("recommendation_score") or 0),
                str(item.get("business_score") or 0),
                item.get("reason") or "",
            ]
            escaped = [f'"{str(value).replace(chr(34), chr(34) + chr(34))}"' for value in values]
            lines.append(",".join(escaped))

    filename = f"keyword-pack-{pack_id}.csv"
    return Response(
        "\ufeff" + "\n".join(lines),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/keywords/packs/{pack_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_keyword_pack_admin(pack_id: str, db: DbSession, _: AdminUser):
    """删除词包及词项。"""
    cid = uuid.UUID(pack_id)
    result = await db.execute(select(KeywordPack.id).where(KeywordPack.id == cid))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="词包不存在")
    await db.execute(delete(KeywordItem).where(KeywordItem.pack_id == cid))
    await db.execute(delete(KeywordPack).where(KeywordPack.id == cid))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ===== API 成本控制 =====


@router.get("/api-policy")
async def get_api_policy(db: DbSession, _: AdminUser):
    """读取 AI API 成本控制策略与用量摘要。"""
    policy = await get_ai_usage_policy_config()
    summary = await admin_usage_summary(db)
    return {
        "policy": public_policy_payload(policy),
        "summary": summary,
    }


@router.put("/api-policy")
async def update_api_policy(request: dict, db: DbSession, admin: AdminUser):
    """更新 AI API 成本控制策略。"""
    current_policy = await get_ai_usage_policy_config()
    next_policy = normalize_policy_payload(request, current_policy)
    await store_policy_setting(db, admin, next_policy)
    await db.commit()
    await invalidate_runtime_settings_cache()
    return {
        "status": "saved",
        "policy": public_policy_payload(await get_ai_usage_policy_config(force_refresh=True)),
    }


# ===== LLM API Provider 管理 =====


class LLMProviderItem(BaseModel):
    id: str | None = Field(default=None, max_length=50)
    name: str = Field(..., max_length=80)
    base_url: str = Field(..., max_length=240)
    model: str = Field(..., max_length=120)
    api_key: str | None = Field(default=None, max_length=3000)
    enabled: bool = True
    priority: int = Field(default=1, ge=1, le=999)


class LLMProvidersRequest(BaseModel):
    strategy: str = Field(default="failover", max_length=40)
    providers: list[LLMProviderItem] = Field(default_factory=list)


class LLMProviderTestRequest(BaseModel):
    provider_id: str | None = Field(default=None, max_length=50)
    provider: LLMProviderItem | None = None


def _is_masked_secret(value: str | None) -> bool:
    return bool(value) and set(str(value).strip()) <= {"•", " "}


def _normalize_llm_provider_id(value: str | None, index: int) -> str:
    raw = (value or "").strip().lower()
    normalized = re.sub(r"[^a-z0-9_-]+", "-", raw).strip("-_")
    return (normalized or f"provider-{index + 1}")[:50]


def _public_llm_provider(provider: dict[str, Any]) -> dict[str, Any]:
    api_key = provider.get("api_key")
    return {
        "id": provider["id"],
        "name": provider.get("name") or provider["id"],
        "base_url": provider.get("base_url") or "",
        "model": provider.get("model") or "",
        "enabled": bool(provider.get("enabled", True)),
        "priority": int(provider.get("priority") or 1),
        "has_api_key": bool(api_key),
        "api_key": MASKED_SECRET_TEXT if api_key else "",
    }


def _serialize_llm_provider_payload(config: dict[str, Any], updated_at: str | None = None) -> dict[str, Any]:
    return {
        "strategy": config.get("strategy") or "failover",
        "providers": [_public_llm_provider(provider) for provider in config.get("providers") or []],
        "provider_count": len(config.get("providers") or []),
        "enabled_provider_count": sum(1 for provider in config.get("providers") or [] if provider.get("enabled", True)),
        "updated_at": updated_at,
    }


async def _load_setting_value(db: DbSession, key: str, default: Any = None) -> Any:
    result = await db.execute(select(Setting).where(Setting.key == key))
    setting = result.scalar_one_or_none()
    if not setting:
        return default
    return decrypt_setting_value(setting.value, setting.key, setting.category)


async def _store_setting_value(
    db: DbSession,
    admin: User,
    key: str,
    value: Any,
    *,
    category: str,
    is_public: bool = False,
) -> Setting:
    stored_value = encrypt_setting_value(value, key, category)
    result = await db.execute(select(Setting).where(Setting.key == key))
    setting = result.scalar_one_or_none()
    if setting:
        setting.value = stored_value
        setting.category = category
        setting.is_public = is_public
        setting.updated_by = admin.id
    else:
        setting = Setting(
            key=key,
            value=stored_value,
            category=category,
            is_public=is_public,
            updated_by=admin.id,
        )
        db.add(setting)
    return setting


def _normalize_admin_llm_provider(
    raw: dict[str, Any],
    existing_keys: dict[str, Any],
    index: int,
) -> dict[str, Any] | None:
    provider_id = _normalize_llm_provider_id(str(raw.get("id") or raw.get("key") or ""), index)
    api_key = raw.get("api_key")
    if _is_masked_secret(api_key):
        api_key = existing_keys.get(provider_id)
    api_key = str(api_key or existing_keys.get(provider_id) or "").strip()
    provider = {
        "id": provider_id,
        "name": str(raw.get("name") or f"API {index + 1}").strip()[:80],
        "base_url": str(raw.get("base_url") or "").strip()[:240],
        "model": str(raw.get("model") or "").strip()[:120],
        "enabled": bool(raw.get("enabled", True)),
        "priority": max(1, min(999, int(raw.get("priority") or index + 1))),
        "api_key": api_key,
    }
    if not provider["name"]:
        provider["name"] = provider_id
    if not provider["base_url"] or not provider["model"]:
        return None
    return provider


def _merge_llm_provider_keys_from_config(
    existing_keys: dict[str, Any] | None,
    config: dict[str, Any] | None,
) -> dict[str, str]:
    """Merge saved provider keys with the legacy runtime fallback keys.

    This protects the first save after upgrading from the legacy single-LLM
    setting: the UI only has a masked placeholder, so the backend must recover
    the real key from the resolved runtime provider before writing the new pool.
    """
    merged = {
        str(key): str(value)
        for key, value in (existing_keys or {}).items()
        if str(key or "").strip() and str(value or "").strip()
    }
    for provider in (config or {}).get("providers") or []:
        if not isinstance(provider, dict):
            continue
        provider_id = str(provider.get("id") or "").strip()
        api_key = str(provider.get("api_key") or "").strip()
        if provider_id and api_key:
            merged.setdefault(provider_id, api_key)
    return merged


def _ensure_enabled_llm_provider_has_key(provider: dict[str, Any], index: int) -> None:
    if provider.get("enabled", True) and not provider.get("api_key"):
        raise HTTPException(status_code=400, detail=f"第 {index + 1} 个启用 API 缺少 API Key")


async def _load_admin_llm_provider_config(db: DbSession) -> dict[str, Any]:
    metadata = await _load_setting_value(db, LLM_PROVIDERS_SETTING_KEY, None)
    key_map = await _load_setting_value(db, LLM_PROVIDER_KEYS_SETTING_KEY, {}) or {}
    if not isinstance(key_map, dict):
        key_map = {}

    providers: list[dict[str, Any]] = []
    strategy = "failover"
    if isinstance(metadata, dict):
        strategy = metadata.get("strategy") if metadata.get("strategy") in {"failover", "round_robin"} else "failover"
        for index, item in enumerate(metadata.get("providers") or []):
            if not isinstance(item, dict):
                continue
            provider = _normalize_admin_llm_provider(item, key_map, index)
            if provider:
                providers.append(provider)

    if not providers:
        runtime = await get_ai_runtime_config(force_refresh=True)
        if runtime.get("llm_base_url") and runtime.get("llm_model"):
            providers.append(
                {
                    "id": "primary",
                    "name": "主 LLM",
                    "base_url": runtime.get("llm_base_url") or "",
                    "model": runtime.get("llm_model") or "",
                    "enabled": True,
                    "priority": 1,
                    "api_key": runtime.get("llm_api_key") or "",
                }
            )

    providers.sort(key=lambda item: (int(item.get("priority") or 999), item["id"]))
    return {"strategy": strategy, "providers": providers}


def _llm_chat_completions_url(base_url: str) -> str:
    normalized = (base_url or "").strip().rstrip("/")
    if not normalized:
        raise HTTPException(status_code=400, detail="API Base URL 不能为空")
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"


@router.get("/llm-providers")
async def get_llm_providers_admin(db: DbSession, _: AdminUser):
    """读取多 LLM API Provider 配置，API Key 只返回脱敏占位。"""
    config = await _load_admin_llm_provider_config(db)
    result = await db.execute(select(Setting).where(Setting.key == LLM_PROVIDERS_SETTING_KEY))
    setting = result.scalar_one_or_none()
    return _serialize_llm_provider_payload(
        config,
        setting.updated_at.isoformat() if setting and setting.updated_at else None,
    )


@router.put("/llm-providers")
async def update_llm_providers_admin(
    request: LLMProvidersRequest,
    db: DbSession,
    admin: AdminUser,
):
    """更新多 LLM API Provider 配置。"""
    if request.strategy not in {"failover", "round_robin"}:
        raise HTTPException(status_code=400, detail="API 轮询策略不合法")
    if not request.providers:
        raise HTTPException(status_code=400, detail="请至少配置一个 API")

    existing_keys = await _load_setting_value(db, LLM_PROVIDER_KEYS_SETTING_KEY, {}) or {}
    if not isinstance(existing_keys, dict):
        existing_keys = {}
    existing_keys = _merge_llm_provider_keys_from_config(
        existing_keys,
        await _load_admin_llm_provider_config(db),
    )

    providers: list[dict[str, Any]] = []
    next_key_map: dict[str, str] = {}
    seen_ids: set[str] = set()
    for index, item in enumerate(request.providers[:12]):
        raw = item.model_dump()
        provider = _normalize_admin_llm_provider(raw, existing_keys, index)
        if not provider:
            raise HTTPException(status_code=400, detail=f"第 {index + 1} 个 API 缺少 Base URL 或模型名称")
        if provider["id"] in seen_ids:
            raise HTTPException(status_code=400, detail=f"API 标识重复：{provider['id']}")
        seen_ids.add(provider["id"])
        _ensure_enabled_llm_provider_has_key(provider, index)
        if provider["api_key"]:
            next_key_map[provider["id"]] = provider["api_key"]
        providers.append(provider)

    if not any(provider.get("enabled", True) for provider in providers):
        raise HTTPException(status_code=400, detail="至少需要启用一个 API")
    enabled_with_keys = [
        provider
        for provider in providers
        if provider.get("enabled", True) and provider.get("api_key")
    ]
    if not enabled_with_keys:
        raise HTTPException(status_code=400, detail="至少需要一个启用 API 填写 API Key")

    metadata = {
        "strategy": request.strategy,
        "providers": [
            {
                "id": provider["id"],
                "name": provider["name"],
                "base_url": provider["base_url"],
                "model": provider["model"],
                "enabled": provider["enabled"],
                "priority": provider["priority"],
            }
            for provider in providers
        ],
    }
    await _store_setting_value(db, admin, LLM_PROVIDERS_SETTING_KEY, metadata, category="llm")
    await _store_setting_value(db, admin, LLM_PROVIDER_KEYS_SETTING_KEY, next_key_map, category="api_keys")

    primary = enabled_with_keys[0]
    await _store_setting_value(db, admin, "llm_api_key", primary.get("api_key") or "", category="api_keys")
    await _store_setting_value(db, admin, "llm_base_url", primary.get("base_url") or "", category="llm")
    await _store_setting_value(db, admin, "llm_model", primary.get("model") or "", category="llm")

    await db.commit()
    await invalidate_runtime_settings_cache()
    await ai_client.reset_clients()
    refreshed = await _load_admin_llm_provider_config(db)
    return {
        "status": "saved",
        **_serialize_llm_provider_payload(refreshed, _utc_now().isoformat()),
    }


@router.post("/llm-providers/test")
async def test_llm_provider_admin(
    request: LLMProviderTestRequest,
    db: DbSession,
    _: AdminUser,
):
    """测试单个 OpenAI 兼容 LLM API 是否可用。"""
    existing_config = await _load_admin_llm_provider_config(db)
    existing_keys = {provider["id"]: provider.get("api_key") or "" for provider in existing_config.get("providers") or []}

    provider: dict[str, Any] | None = None
    if request.provider:
        provider = _normalize_admin_llm_provider(request.provider.model_dump(), existing_keys, 0)
    elif request.provider_id:
        provider = next(
            (item for item in existing_config.get("providers") or [] if item.get("id") == request.provider_id),
            None,
        )
    if not provider:
        raise HTTPException(status_code=404, detail="未找到要测试的 API 配置")
    if not provider.get("api_key"):
        raise HTTPException(status_code=400, detail="请先填写 API Key 后再测试")

    payload = {
        "model": provider["model"],
        "messages": [
            {"role": "system", "content": "You are a concise API health checker."},
            {"role": "user", "content": "Reply with OK only."},
        ],
        "temperature": 0,
        "max_tokens": 16,
    }
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                _llm_chat_completions_url(provider["base_url"]),
                headers={
                    "Authorization": f"Bearer {provider['api_key']}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        latency_ms = int((time.perf_counter() - started) * 1000)
        if response.is_error:
            detail = response.text[:300]
            return {
                "ok": False,
                "provider_id": provider["id"],
                "status_code": response.status_code,
                "latency_ms": latency_ms,
                "message": f"请求失败：HTTP {response.status_code}",
                "detail": detail,
                "tested_at": _utc_now_iso(),
            }
        body = response.json()
        content = ai_client._extract_chat_content(body).strip()
        return {
            "ok": bool(content),
            "provider_id": provider["id"],
            "status_code": response.status_code,
            "latency_ms": latency_ms,
            "message": "测试通过" if content else "接口返回空内容",
            "content_preview": content[:120],
            "tested_at": _utc_now_iso(),
        }
    except Exception as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return {
            "ok": False,
            "provider_id": provider["id"],
            "latency_ms": latency_ms,
            "message": str(exc)[:300],
            "tested_at": _utc_now_iso(),
        }


# ===== 前台模块管理 =====


class FrontendModuleItem(BaseModel):
    key: str = Field(..., max_length=50)
    enabled: bool = True


class FrontendModulesRequest(BaseModel):
    default_module: str = Field(..., max_length=50)
    modules: list[FrontendModuleItem] = Field(default_factory=list)


@router.get("/frontend-modules")
async def get_frontend_modules_admin(db: DbSession, _: AdminUser):
    """读取前台频道模块开关配置。"""
    config = await get_frontend_module_config()
    result = await db.execute(select(Setting).where(Setting.key == FRONTEND_MODULES_SETTING_KEY))
    setting = result.scalar_one_or_none()
    updated_by_user = None
    if setting and setting.updated_by:
        user_result = await db.execute(select(User).where(User.id == setting.updated_by))
        updated_by_user = user_result.scalar_one_or_none()
    return _serialize_frontend_module_payload(config, setting, updated_by_user)


@router.put("/frontend-modules")
async def update_frontend_modules_admin(
    request: FrontendModulesRequest,
    db: DbSession,
    admin: AdminUser,
):
    """更新前台频道模块开关配置。"""
    if not request.modules:
        raise HTTPException(status_code=400, detail="请至少提交一个前台模块")
    current_config = await get_frontend_module_config()
    allowed_keys = {
        str(module.get("key", "")).strip().lower()
        for module in current_config.get("modules") or []
        if str(module.get("key", "")).strip()
    }
    submitted_keys = {item.key.strip().lower() for item in request.modules}
    unknown_keys = submitted_keys - allowed_keys
    if unknown_keys:
        raise HTTPException(status_code=400, detail=f"未知前台模块：{', '.join(sorted(unknown_keys))}")
    enabled_keys = {item.key.strip().lower() for item in request.modules if item.enabled}
    if not enabled_keys:
        raise HTTPException(status_code=400, detail="至少需要保留一个前台模块开启")
    default_module = request.default_module.strip().lower()
    if default_module not in allowed_keys:
        raise HTTPException(status_code=400, detail="未知默认入口模块")
    if default_module not in enabled_keys:
        raise HTTPException(status_code=400, detail="默认入口必须是已开启的前台模块")

    next_config = normalize_frontend_module_payload(request.model_dump(), current_config)
    result = await db.execute(select(Setting).where(Setting.key == FRONTEND_MODULES_SETTING_KEY))
    setting = result.scalar_one_or_none()
    if setting:
        setting.value = next_config
        setting.category = "frontend"
        setting.is_public = False
        setting.updated_by = admin.id
    else:
        db.add(
            Setting(
                key=FRONTEND_MODULES_SETTING_KEY,
                value=next_config,
                category="frontend",
                is_public=False,
                updated_by=admin.id,
            )
        )
    await db.commit()
    await invalidate_runtime_settings_cache()
    refreshed = await get_frontend_module_config(force_refresh=True)
    result = await db.execute(select(Setting).where(Setting.key == FRONTEND_MODULES_SETTING_KEY))
    saved_setting = result.scalar_one_or_none()
    return _serialize_frontend_module_payload(refreshed, saved_setting, admin)


# ===== 自定义首页 =====

def _serialize_homepage_release(release: HomepageRelease) -> dict:
    is_builtin = str(release.id) == DEFAULT_HOMEPAGE_RELEASE_ID
    return {
        "id": str(release.id),
        "title": release.title,
        "is_builtin": is_builtin,
        "source_type": release.source_type.value if hasattr(release.source_type, "value") else release.source_type,
        "status": release.status.value if hasattr(release.status, "value") else release.status,
        "entry_path": release.entry_path,
        "storage_path": release.storage_path,
        "file_count": release.file_count,
        "compressed_size": release.compressed_size,
        "extracted_size": release.extracted_size,
        "sha256": release.sha256,
        "manifest": release.release_manifest or {},
        "error_message": release.error_message,
        "created_by": str(release.created_by) if release.created_by else None,
        "created_at": release.created_at.isoformat() if release.created_at else None,
        "activated_at": release.activated_at.isoformat() if release.activated_at else None,
        "preview_url": f"/api/admin/homepage/releases/{release.id}/preview",
    }


async def _load_homepage_release_or_404(db: DbSession, release_id: uuid.UUID) -> HomepageRelease:
    result = await db.execute(select(HomepageRelease).where(HomepageRelease.id == release_id))
    release = result.scalar_one_or_none()
    if not release:
        raise HTTPException(status_code=404, detail="首页版本不存在")
    return release


async def _store_homepage_runtime(db: DbSession, admin: User, payload: dict) -> dict:
    current = await get_homepage_runtime_config()
    next_config = normalize_homepage_runtime_payload(
        {
            **payload,
            "updated_by": str(admin.id),
            "updated_at": _utc_now_iso(),
        },
        current,
    )
    result = await db.execute(select(Setting).where(Setting.key == HOMEPAGE_RUNTIME_SETTING_KEY))
    setting = result.scalar_one_or_none()
    if setting:
        setting.value = next_config
        setting.category = "frontend"
        setting.is_public = False
        setting.updated_by = admin.id
    else:
        db.add(
            Setting(
                key=HOMEPAGE_RUNTIME_SETTING_KEY,
                value=next_config,
                category="frontend",
                is_public=False,
                updated_by=admin.id,
            )
        )
    return next_config


@router.get("/homepage")
async def get_homepage_admin(db: DbSession, _: AdminUser):
    runtime = await get_homepage_runtime_config()
    result = await db.execute(select(HomepageRelease).order_by(HomepageRelease.created_at.desc()))
    releases = result.scalars().all()
    return {
        "runtime": runtime,
        "releases": [_serialize_homepage_release(release) for release in releases],
    }


@router.post("/homepage/releases", status_code=status.HTTP_201_CREATED)
async def create_homepage_release_admin(
    db: DbSession,
    admin: AdminUser,
    source_type: str = Form(...),
    title: str = Form(...),
    html: Optional[str] = Form(default=None),
    file: UploadFile | None = File(default=None),
):
    clean_title = (title or "").strip()[:200]
    if not clean_title:
        raise HTTPException(status_code=400, detail="请填写首页版本名称")
    try:
        source_type_enum = HomepageSourceType(source_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="首页来源类型不合法") from exc

    release_id = uuid.uuid4()
    root = homepage_root()
    try:
        if source_type_enum == HomepageSourceType.SINGLE_HTML:
            manifest = build_single_html_release(root, str(release_id), clean_title, html or "")
        else:
            if not file:
                raise HomepageAssetError("请上传 .zip 首页包")
            payload = await file.read()
            manifest = build_zip_homepage_release(
                root,
                str(release_id),
                clean_title,
                file.filename or "homepage.zip",
                payload,
            )
    except HomepageAssetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    release = HomepageRelease(
        id=release_id,
        title=clean_title,
        source_type=source_type_enum,
        status=HomepageReleaseStatus.DRAFT,
        entry_path=manifest["entry_path"],
        storage_path=manifest["storage_path"],
        file_count=manifest["file_count"],
        compressed_size=manifest["compressed_size"],
        extracted_size=manifest["extracted_size"],
        sha256=manifest.get("sha256"),
        release_manifest=manifest,
        created_by=admin.id,
    )
    db.add(release)
    await db.commit()
    await db.refresh(release)
    return _serialize_homepage_release(release)


@router.get("/homepage/releases/{release_id}")
async def get_homepage_release_admin(release_id: uuid.UUID, db: DbSession, _: AdminUser):
    release = await _load_homepage_release_or_404(db, release_id)
    return _serialize_homepage_release(release)


@router.get("/homepage/releases/{release_id}/preview", response_class=HTMLResponse)
async def preview_homepage_release_admin(release_id: uuid.UUID, db: DbSession, _: AdminUser):
    release = await _load_homepage_release_or_404(db, release_id)
    index_path = public_release_path(homepage_root(), str(release.id)) / release.entry_path
    if not index_path.is_file():
        raise HTTPException(status_code=404, detail="首页预览文件不存在")
    html = index_path.read_text(encoding="utf-8")
    html = html.replace("/_custom_homepage/active/", f"/_custom_homepage/releases/{release.id}/")
    return HTMLResponse(
        html,
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@router.post("/homepage/releases/{release_id}/activate")
async def activate_homepage_release_admin(release_id: uuid.UUID, db: DbSession, admin: AdminUser):
    release = await _load_homepage_release_or_404(db, release_id)
    if release.status == HomepageReleaseStatus.FAILED:
        raise HTTPException(status_code=400, detail="失败版本不能启用")
    try:
        activate_homepage_release(homepage_root(), str(release.id))
    except HomepageAssetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    analytics_code = await _load_setting_value(db, ANALYTICS_TRACKING_CODE_SETTING_KEY, "")
    if analytics_code:
        apply_analytics_to_active_homepage(homepage_root(), analytics_code)

    await db.execute(
        update(HomepageRelease)
        .where(HomepageRelease.status == HomepageReleaseStatus.ACTIVE)
        .values(status=HomepageReleaseStatus.ARCHIVED)
    )
    release.status = HomepageReleaseStatus.ACTIVE
    release.activated_at = _utc_now()
    runtime = await _store_homepage_runtime(
        db,
        admin,
        {
            "mode": "custom",
            "active_release_id": str(release.id),
            "fallback_enabled": True,
            "company_list_path": "/companies",
        },
    )
    await db.commit()
    await invalidate_runtime_settings_cache()
    return {
        "runtime": runtime,
        "release": _serialize_homepage_release(release),
    }


@router.post("/homepage/default")
async def restore_default_homepage_admin(db: DbSession, admin: AdminUser):
    reset_active_homepage(homepage_root())
    await db.execute(
        update(HomepageRelease)
        .where(HomepageRelease.status == HomepageReleaseStatus.ACTIVE)
        .values(status=HomepageReleaseStatus.ARCHIVED)
    )
    runtime = await _store_homepage_runtime(
        db,
        admin,
        {
            "mode": "default",
            "active_release_id": None,
            "fallback_enabled": True,
            "company_list_path": "/companies",
        },
    )
    await db.commit()
    await invalidate_runtime_settings_cache()
    return {"runtime": runtime}


@router.delete("/homepage/releases/{release_id}")
async def delete_homepage_release_admin(release_id: uuid.UUID, db: DbSession, _: AdminUser):
    release = await _load_homepage_release_or_404(db, release_id)
    if str(release.id) == DEFAULT_HOMEPAGE_RELEASE_ID:
        raise HTTPException(status_code=400, detail="内置首页版本不能删除")
    if release.status == HomepageReleaseStatus.ACTIVE:
        raise HTTPException(status_code=400, detail="当前启用版本不能删除，请先恢复默认首页或启用其他版本")

    root = homepage_root()
    shutil_paths = [
        source_release_path(root, str(release.id)).parent,
        public_release_path(root, str(release.id)),
    ]
    for path in shutil_paths:
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
    await db.execute(delete(HomepageRelease).where(HomepageRelease.id == release.id))
    await db.commit()
    return {"status": "deleted"}


# ===== 系统设置 =====

ADMIN_ENTRY_ALLOWED_ALIASES = {
    "admin",
    "manage",
    "console",
    "backend",
    "control",
    "dashboard",
}


def _normalize_admin_entry_path(value) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "/admin"
    if "://" in raw or raw.startswith("//") or "?" in raw or "#" in raw:
        raise HTTPException(status_code=422, detail="后台入口路径只能填写站内基础路径，例如 /admin-ops")
    if not raw.startswith("/"):
        raw = f"/{raw}"
    raw = raw.rstrip("/") or "/admin"
    segment = raw.lstrip("/")
    if "/" in segment:
        raise HTTPException(status_code=422, detail="后台入口路径只能是一段基础路径，不能包含多级路径")
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,48}", segment):
        raise HTTPException(status_code=422, detail="后台入口路径只能包含字母、数字、中划线和下划线，长度 3-48")
    if segment not in ADMIN_ENTRY_ALLOWED_ALIASES and not re.fullmatch(r"admin-[A-Za-z0-9][A-Za-z0-9_-]{1,42}", segment):
        raise HTTPException(
            status_code=422,
            detail="后台入口路径仅支持 /admin、/manage、/console、/backend、/control、/dashboard 或 /admin-xxx",
        )
    return f"/{segment}"

@router.get("/settings")
async def get_settings(db: DbSession, _: AdminUser):
    """获取全量系统设置（API key 脱敏）"""
    result = await db.execute(select(Setting).order_by(Setting.category, Setting.key))
    settings_list = result.scalars().all()

    settings_out = {}
    for s in settings_list:
        decrypted_value = decrypt_setting_value(s.value, s.key, s.category)
        value = mask_setting_value(decrypted_value, s.key, s.category)
        settings_out[s.key] = {
            "value": value,
            "category": s.category,
            "is_public": s.is_public,
            "updated_at": s.updated_at.isoformat() if s.updated_at else None,
        }
    return settings_out


@router.put("/settings")
async def update_settings(request: dict, db: DbSession, admin: AdminUser):
    """批量更新系统设置（直接传 {key: {value: ...}} 字典）
    API Key 字段：若传入值为全 • 占位符则跳过（不覆盖真实值）
    """
    analytics_code_to_apply: str | None = None
    for key, val in request.items():
        value = val.get("value", val) if isinstance(val, dict) else val
        if key == "admin_entry_path":
            value = _normalize_admin_entry_path(value)
        if key == ANALYTICS_TRACKING_CODE_SETTING_KEY:
            value = str(value or "").strip()
            if len(value.encode("utf-8")) > 20000:
                raise HTTPException(status_code=400, detail="网站统计代码不能超过 20KB")
            analytics_code_to_apply = value
        # 跳过前端占位符（用户未修改 API Key 时传回的 ••• 字符串）
        if isinstance(value, str) and set(value) <= {"•", " "} and len(value) > 0:
            continue
        result = await db.execute(select(Setting).where(Setting.key == key))
        setting = result.scalar_one_or_none()
        category = (
            val.get("category") if isinstance(val, dict) and val.get("category") else
            setting.category if setting else None
        )
        category = infer_setting_category(key, category)
        stored_value = encrypt_setting_value(value, key, category)
        if setting:
            update_values = {
                "value": stored_value,
                "category": category,
                "updated_by": admin.id,
            }
            if key == ANALYTICS_TRACKING_CODE_SETTING_KEY:
                update_values["is_public"] = True
            await db.execute(update(Setting).where(Setting.key == key).values(**update_values))
        else:
            is_public = (
                True if key == ANALYTICS_TRACKING_CODE_SETTING_KEY
                else bool(val.get("is_public")) if isinstance(val, dict) else False
            )
            db.add(
                Setting(
                    key=key,
                    value=stored_value,
                    category=category,
                    is_public=is_public,
                    updated_by=admin.id,
                )
            )

    await db.commit()
    if analytics_code_to_apply is not None:
        apply_analytics_to_active_homepage(homepage_root(), analytics_code_to_apply)
    await invalidate_runtime_settings_cache()
    await ai_client.reset_clients()
    return {"status": "saved", "updated_keys": list(request.keys())}
