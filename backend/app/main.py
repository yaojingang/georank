"""
GEOrank — FastAPI 主入口
"""
from contextlib import asynccontextmanager
from datetime import datetime
import json
import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import text

from app.core.config import settings
from app.core.database import engine, Base
from app.core.logging_utils import configure_logging, log_event
from app.api import router as api_router
from app.web.company_pages import router as company_pages_router
from app.web.tutorial_pages import router as tutorial_pages_router

# 速率限制器（基于客户端 IP），全局默认 200次/分钟
limiter = Limiter(key_func=get_remote_address, default_limits=["200/minute"])
logger = logging.getLogger("georank.api")

configure_logging(settings.DEBUG)


async def _init_db():
    """创建所有表（生产环境应用 Alembic 迁移，此处为开发便利）"""
    # 导入所有模型，确保 Base.metadata 包含全部表
    import app.models  # noqa: F401
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _seed_settings(db):
    """初始化系统配置项（幂等：仅在 key 不存在时写入）"""
    from sqlalchemy import select
    from app.models.settings import Setting
    from app.services.runtime_settings import (
        get_default_ai_usage_policy_config,
        get_default_llm_provider_config,
        get_default_frontend_module_config,
        get_default_homepage_runtime_config,
    )

    defaults = [
        {"key": "site_name", "value": "GEOrank", "category": "basic", "is_public": True},
        {"key": "site_description", "value": "追踪生成式人工智能搜索引擎优化领域的顶尖创新者与技术先锋。", "category": "basic", "is_public": True},
        {"key": "default_language", "value": "zh-CN", "category": "basic", "is_public": True},
        {"key": "timezone", "value": "Asia/Shanghai", "category": "basic", "is_public": False},
        {"key": "admin_entry_path", "value": "/admin", "category": "security", "is_public": False},
        {"key": "analytics_tracking_code", "value": "", "category": "analytics", "is_public": True},
        {"key": "geo_auto_score", "value": True, "category": "geo_engine", "is_public": False},
        {"key": "geo_rescan_days", "value": 30, "category": "geo_engine", "is_public": False},
        {"key": "geo_score_public", "value": False, "category": "geo_engine", "is_public": True},
        {"key": "geo_score_version", "value": "v2.4", "category": "geo_engine", "is_public": False},
        {"key": "openai_api_key", "value": "", "category": "api_keys", "is_public": False},
        {"key": "google_search_api_key", "value": "", "category": "api_keys", "is_public": False},
        {"key": "llm_api_key", "value": "", "category": "api_keys", "is_public": False},
        {"key": "llm_base_url", "value": "", "category": "llm", "is_public": False},
        {"key": "llm_model", "value": "gpt-4o-mini", "category": "llm", "is_public": False},
        {"key": "llm_fallback_model", "value": "", "category": "llm", "is_public": False},
        {"key": "llm_providers", "value": get_default_llm_provider_config(), "category": "llm", "is_public": False},
        {"key": "llm_provider_keys", "value": {}, "category": "api_keys", "is_public": False},
        {"key": "embedding_api_key", "value": "", "category": "api_keys", "is_public": False},
        {"key": "embedding_base_url", "value": "", "category": "llm", "is_public": False},
        {"key": "embedding_model", "value": "text-embedding-3-small", "category": "llm", "is_public": False},
        {"key": "embedding_dimensions", "value": 1536, "category": "llm", "is_public": False},
        {"key": "codex_api_key", "value": "", "category": "api_keys", "is_public": False},
        {"key": "codex_base_url", "value": "", "category": "llm", "is_public": False},
        {"key": "codex_model", "value": "gpt-5.3-codex-spark", "category": "llm", "is_public": False},
        {"key": "api_usage_policy", "value": get_default_ai_usage_policy_config(), "category": "ai_usage", "is_public": False},
        {"key": "frontend_modules", "value": get_default_frontend_module_config(), "category": "frontend", "is_public": False},
        {"key": "homepage_runtime", "value": get_default_homepage_runtime_config(), "category": "frontend", "is_public": False},
    ]

    for item in defaults:
        result = await db.execute(select(Setting).where(Setting.key == item["key"]))
        if not result.scalar_one_or_none():
            db.add(Setting(**item))

    await db.commit()


async def _seed_default_homepage_release(db):
    """初始化开源版内置首页版本（幂等：不覆盖用户后续操作）。"""
    from sqlalchemy import select

    from app.models.homepage import HomepageRelease, HomepageReleaseStatus, HomepageSourceType
    from app.services.homepage_assets import ENTRY_PATH, homepage_root, public_release_path
    from app.services.runtime_settings import DEFAULT_HOMEPAGE_RELEASE_ID, DEFAULT_HOMEPAGE_RELEASE_TITLE

    release_uuid = uuid.UUID(DEFAULT_HOMEPAGE_RELEASE_ID)
    result = await db.execute(select(HomepageRelease).where(HomepageRelease.id == release_uuid))
    if result.scalar_one_or_none():
        return

    root = homepage_root()
    public_dir = public_release_path(root, DEFAULT_HOMEPAGE_RELEASE_ID)
    if not (public_dir / ENTRY_PATH).is_file():
        return

    manifest_path = root / "releases" / DEFAULT_HOMEPAGE_RELEASE_ID / "manifest.json"
    manifest = {}
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            manifest = {}

    files = [path for path in public_dir.rglob("*") if path.is_file()]
    created_at = datetime.utcnow()
    raw_created_at = manifest.get("created_at")
    if isinstance(raw_created_at, str) and raw_created_at.strip():
        try:
            created_at = datetime.fromisoformat(raw_created_at.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            pass

    db.add(
        HomepageRelease(
            id=release_uuid,
            title=manifest.get("title") or DEFAULT_HOMEPAGE_RELEASE_TITLE,
            source_type=HomepageSourceType.ZIP_PACKAGE,
            status=HomepageReleaseStatus.ACTIVE,
            entry_path=manifest.get("entry_path") or ENTRY_PATH,
            storage_path=str(root / "releases" / DEFAULT_HOMEPAGE_RELEASE_ID),
            file_count=int(manifest.get("file_count") or len(files)),
            compressed_size=int(manifest.get("compressed_size") or 0),
            extracted_size=int(manifest.get("extracted_size") or sum(path.stat().st_size for path in files)),
            sha256=manifest.get("sha256"),
            release_manifest=manifest,
            created_by=None,
            created_at=created_at,
            activated_at=created_at,
        )
    )
    await db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期 — 启动时初始化 DB 和默认配置"""
    await _init_db()

    from app.core.database import async_session
    async with async_session() as db:
        try:
            await _seed_settings(db)
            await _seed_default_homepage_release(db)
        except Exception as e:
            print(f"[startup] settings init skipped: {e}")

    yield
    # 关闭时清理资源
    await engine.dispose()


app = FastAPI(
    title="GEOrank API",
    description="GEO 公司知识库平台 — 后端 API 服务",
    version="1.3.0",
    # 生产环境关闭 API 文档，防止接口信息泄露
    docs_url="/api/docs" if settings.DEBUG else None,
    redoc_url="/api/redoc" if settings.DEBUG else None,
    lifespan=lifespan,
)

# 速率限制
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# CORS — 开发模式允许所有来源，生产环境使用配置白名单
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.DEBUG else settings.CORS_ORIGINS,
    allow_credentials=False if settings.DEBUG else True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=3600,
)


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """输出请求结构化日志并附带 request_id。"""
    request_id = uuid.uuid4().hex[:12]
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        log_event(
            logger,
            logging.ERROR,
            "http.request.failed",
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            query=str(request.url.query or ""),
            duration_ms=duration_ms,
        )
        raise

    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    response.headers["X-Request-ID"] = request_id
    log_event(
        logger,
        logging.INFO,
        "http.request",
        request_id=request_id,
        method=request.method,
        path=request.url.path,
        query=str(request.url.query or ""),
        status_code=response.status_code,
        duration_ms=duration_ms,
    )
    return response

# 路由挂载
app.include_router(api_router, prefix="/api")
app.include_router(company_pages_router)
app.include_router(tutorial_pages_router)


@app.get("/api/health")
async def health_check():
    """健康检查 — 返回服务状态"""
    return {"status": "ok", "service": "georank", "version": "1.3.0"}


async def _check_database() -> dict:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return {"status": "ok"}


async def _check_redis() -> dict:
    client = Redis.from_url(settings.REDIS_URL, encoding="utf-8", decode_responses=True)
    try:
        await client.ping()
    finally:
        await client.aclose()
    return {"status": "ok"}


@app.get("/api/readiness")
async def readiness_check():
    """就绪检查 — 验证关键依赖是否可用"""
    dependencies = {}
    overall_status = "ok"

    for name, checker in (("database", _check_database), ("redis", _check_redis)):
        try:
            dependencies[name] = await checker()
        except Exception as exc:
            overall_status = "degraded"
            dependencies[name] = {"status": "error", "detail": str(exc)}

    status_code = 200 if overall_status == "ok" else 503
    return JSONResponse(
        status_code=status_code,
        content={
            "status": overall_status,
            "service": "georank",
            "version": "1.3.0",
            "dependencies": dependencies,
        },
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """全局异常兜底 — 不向客户端暴露内部错误详情"""
    import logging
    logging.getLogger("georank").error(
        "Unhandled exception: %s %s", request.method, request.url.path, exc_info=exc
    )
    return JSONResponse(status_code=500, content={"detail": "服务器内部错误"})
