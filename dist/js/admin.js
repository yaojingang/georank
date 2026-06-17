/**
 * GEOrank Admin — 后台管理系统核心 JS
 * 覆盖：认证守卫、API 封装、Toast/Confirm、侧边栏、各页面数据加载
 */
(function () {
    'use strict';

    // ─── 配置 ───────────────────────────────────────────────────────────────
    // 本地 3001 端口时指向 8000；生产走 Traefik 同域路由
    const API_BASE = ['80', '443', ''].includes(window.location.port)
        ? ''
        : `${window.location.protocol}//${window.location.hostname}:8000`;
    const APP_ORIGIN = window.location.origin;

    const TOKEN_KEY = 'georank_admin_token';
    const ADMIN_ALIAS_BASES = new Set(['admin', 'manage', 'console', 'backend', 'control', 'dashboard']);
    const ADMIN_ALIAS_PATTERN = /^admin-[A-Za-z0-9][A-Za-z0-9_-]{1,42}$/;
    let configuredAdminEntryPath = null;
    let currentAdminUser = null;

    function isCanonicalAdminPath(path) {
        return path === '/admin' || path.startsWith('/admin/');
    }

    function isAdminEntrySegment(segment) {
        return ADMIN_ALIAS_BASES.has(segment) || ADMIN_ALIAS_PATTERN.test(segment);
    }

    function normalizeAdminEntryPath(value) {
        let raw = String(value || '').trim();
        if (!raw) return '/admin';
        if (raw.includes('://') || raw.startsWith('//') || raw.includes('?') || raw.includes('#')) {
            throw new Error('后台入口路径只能填写站内基础路径');
        }
        if (!raw.startsWith('/')) raw = `/${raw}`;
        raw = raw.replace(/\/+$/, '') || '/admin';
        const segment = raw.slice(1);
        if (segment.includes('/')) throw new Error('后台入口路径不能包含多级路径');
        if (!/^[A-Za-z0-9_-]{3,48}$/.test(segment)) {
            throw new Error('后台入口路径只能包含字母、数字、中划线和下划线，长度 3-48');
        }
        if (!isAdminEntrySegment(segment)) {
            throw new Error('后台入口路径仅支持 /admin、/manage、/console、/backend、/control、/dashboard 或 /admin-xxx');
        }
        return `/${segment}`;
    }

    function getAdminBaseFromPath(pathname = window.location.pathname) {
        const firstSegment = String(pathname || '').split('/').filter(Boolean)[0] || 'admin';
        return isAdminEntrySegment(firstSegment) ? `/${firstSegment}` : '/admin';
    }

    function getActiveAdminBasePath() {
        return getAdminBaseFromPath() || configuredAdminEntryPath || '/admin';
    }

    function canonicalizeAdminPath(path) {
        const cleanPath = (path || '').replace(/\/$/, '') || '/admin';
        const segments = cleanPath.split('/').filter(Boolean);
        const first = segments[0] || 'admin';
        if (!isAdminEntrySegment(first)) return cleanPath;
        const suffix = segments.slice(1).join('/');
        return suffix ? `/admin/${suffix}` : '/admin';
    }

    function toActiveAdminPath(path) {
        if (!isCanonicalAdminPath(path)) return path;
        const base = configuredAdminEntryPath || getActiveAdminBasePath();
        if (base === '/admin') return path;
        const suffix = path.slice('/admin'.length);
        return `${base}${suffix}`;
    }

    function withAppOrigin(path) {
        if (!path || /^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('#')) return path;
        if (isCanonicalAdminPath(path)) path = toActiveAdminPath(path);
        return new URL(path, `${APP_ORIGIN}/`).toString();
    }

    function buildPublicCompanyDetailHref(companyId, pathKey = '') {
        const identifier = pathKey || companyId;
        if (!identifier) return withAppOrigin('/');
        return withAppOrigin(`/c/${encodeURIComponent(identifier)}`);
    }

    function buildPublicTutorialDetailHref(pathKey, slug = '') {
        const identifier = pathKey || slug;
        if (!identifier) return withAppOrigin('/tutorial');
        return withAppOrigin(`/tutorial/${encodeURIComponent(identifier)}`);
    }

    function getPathname(urlOrPath) {
        if (!urlOrPath) return '';
        try {
            return new URL(urlOrPath, `${APP_ORIGIN}/`).pathname.replace(/\/$/, '') || '/';
        } catch (_) {
            return (urlOrPath || '').replace(/\/$/, '') || '/';
        }
    }

    function normalizeAdminModulePath(path) {
        const cleanPath = canonicalizeAdminPath(path);
        if (cleanPath.includes('tutorials-edit') || cleanPath.includes('content-edit')) return '/admin/tutorials';
        if (cleanPath.includes('tutorials') || cleanPath.includes('content')) return '/admin/tutorials';
        if (cleanPath.includes('experts')) return '/admin/experts';
        if (cleanPath.includes('keywords')) return '/admin/keywords';
        if (cleanPath.includes('diagnostics')) return '/admin/diagnostics';
        if (cleanPath.includes('solutions')) return '/admin/solutions';
        if (cleanPath.includes('companies')) return '/admin/companies';
        if (cleanPath.includes('users')) return '/admin/users';
        if (cleanPath.includes('settings')) return '/admin/settings';
        return '/admin';
    }

    function normalizeAdminLinks() {
        document.querySelectorAll('a[href]').forEach(link => {
            const href = link.getAttribute('href');
            if (!href) return;
            if (isCanonicalAdminPath(href) || href === '/') {
                link.href = withAppOrigin(href);
            }
        });
    }

    function getAdminSelectionParam(key) {
        return new URLSearchParams(window.location.search).get(key);
    }

    function setAdminSelectionParam(key, value) {
        const url = new URL(window.location.href);
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
        history.replaceState(null, '', url.toString());
    }

    function bindAdminDialogOverlay(overlay, closeHandler) {
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', handleKeydown);
            closeHandler?.();
        };
        function handleKeydown(event) {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            close();
        }
        document.addEventListener('keydown', handleKeydown);
        overlay?.addEventListener('click', event => {
            if (event.target === overlay) close();
        });
        return close;
    }

    // ─── Token 工具 ─────────────────────────────────────────────────────────
    const Auth = {
        get: () => localStorage.getItem(TOKEN_KEY),
        set: (t) => localStorage.setItem(TOKEN_KEY, t),
        clear: () => localStorage.removeItem(TOKEN_KEY),
    };

    function formatApiErrorDetail(detail, fallback = '请求失败') {
        if (!detail) return fallback;
        if (typeof detail === 'string') return detail;
        const fieldLabels = {
            email: '邮箱',
            username: '用户名',
            password: '密码',
            phone: '手机号',
            role: '角色',
            url: '网址',
            title: '标题',
            seeds: '种子词',
            admin_entry_path: '后台入口路径',
        };
        const normalizeMessage = (item) => {
            const raw = String(item?.msg || item?.message || item?.detail || fallback);
            const loc = Array.isArray(item?.loc) ? item.loc.filter(part => part !== 'body') : [];
            const field = loc.length ? String(loc[loc.length - 1]) : '';
            const label = fieldLabels[field] || field || '字段';
            if (item?.type === 'missing') return `${label}不能为空`;
            if (field === 'email' && raw.includes('reserved name')) return '邮箱域名不能使用保留域名';
            if (field === 'email' && raw.toLowerCase().includes('valid email')) return '邮箱格式无效';
            if (raw.includes('String should have at least')) return `${label}长度不足`;
            if (raw.includes('String should have at most')) return `${label}长度超出限制`;
            return field ? `${label}: ${raw}` : raw;
        };
        if (Array.isArray(detail)) return detail.map(normalizeMessage).join('；');
        if (typeof detail === 'object') {
            if (detail.detail && detail.detail !== detail) return formatApiErrorDetail(detail.detail, fallback);
            if (detail.message) return String(detail.message);
        }
        return fallback;
    }

    // ─── API 请求封装 ────────────────────────────────────────────────────────
    async function api(method, path, body) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        const token = Auth.get();
        if (token) opts.headers['Authorization'] = `Bearer ${token}`;
        if (body !== undefined) opts.body = JSON.stringify(body);

        const res = await fetch(`${API_BASE}${path}`, opts);
        if (res.status === 204) return null;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(formatApiErrorDetail(data.detail || data, `请求失败 (${res.status})`));
        }
        return data;
    }

    async function apiForm(method, path, formData) {
        const opts = {
            method,
            headers: {},
            body: formData,
        };
        const token = Auth.get();
        if (token) opts.headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`${API_BASE}${path}`, opts);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(formatApiErrorDetail(data.detail || data, `请求失败 (${res.status})`));
        }
        return data;
    }

    async function downloadAuthenticatedFile(path, fallbackFilename) {
        const headers = {};
        const token = Auth.get();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`${API_BASE}${path}`, { method: 'GET', headers });
        if (!res.ok) {
            let message = `下载失败 (${res.status})`;
            try {
                const data = await res.json();
                message = data.detail || message;
            } catch (_) {}
            throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
        }

        const blob = await res.blob();
        const disposition = res.headers.get('content-disposition') || '';
        const matchedFilename = disposition.match(/filename="?([^"]+)"?/i);
        const filename = matchedFilename?.[1] || fallbackFilename || 'download.txt';
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }

    async function loadConfiguredAdminEntryPath() {
        try {
            const data = await api('GET', '/api/admin/settings');
            const value = data?.admin_entry_path?.value;
            configuredAdminEntryPath = normalizeAdminEntryPath(value || getAdminBaseFromPath());
            return data;
        } catch (_) {
            configuredAdminEntryPath = getAdminBaseFromPath();
            return null;
        }
    }

    // ─── Toast 通知 ──────────────────────────────────────────────────────────
    function toast(msg, type = 'success') {
        const color = type === 'success' ? 'bg-green-600'
            : type === 'error' ? 'bg-red-600'
            : type === 'warning' ? 'bg-orange-500'
            : 'bg-slate-700';
        const icon = type === 'success' ? 'check_circle'
            : type === 'error' ? 'error'
            : type === 'warning' ? 'warning'
            : 'info';

        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none';
            document.body.appendChild(container);
        }

        const el = document.createElement('div');
        el.className = `flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-white text-sm font-medium ${color} pointer-events-auto translate-x-0 opacity-100 transition-all duration-300`;
        el.innerHTML = `<span class="material-symbols-outlined text-lg">${icon}</span><span>${escapeHtml(msg)}</span>`;
        container.appendChild(el);

        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateX(24px)';
            setTimeout(() => el.remove(), 300);
        }, 3500);
    }

    // ─── 确认对话框 ──────────────────────────────────────────────────────────
    function confirm(msg) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 z-[9998] bg-black/40 flex items-center justify-center';
            overlay.innerHTML = `
<div class="admin-dialog bg-white rounded-2xl shadow-2xl p-6 max-w-sm mx-4 w-full">
    <p class="text-sm font-semibold text-on-surface mb-6">${escapeHtml(msg)}</p>
    <div class="flex gap-3 justify-end">
        <button id="confirm-cancel" class="btn admin-btn-secondary px-5 py-2 rounded-lg text-sm">取消</button>
        <button id="confirm-ok" class="btn btn-primary px-5 py-2 rounded-lg text-sm">确认</button>
    </div>
</div>`;
            document.body.appendChild(overlay);
            overlay.querySelector('#confirm-ok').onclick = () => { overlay.remove(); resolve(true); };
            overlay.querySelector('#confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
        });
    }

    // ─── 登录页面 ────────────────────────────────────────────────────────────
    function showLoginModal(errMsg) {
        document.getElementById('login-modal')?.remove();
        document.body.style.opacity = '1'; // 登录弹窗时也要可见
        const modal = document.createElement('div');
        modal.id = 'login-modal';
        modal.className = 'fixed inset-0 z-[9997] flex min-h-screen';
        modal.innerHTML = `
<!-- 左侧品牌面板 -->
<div class="hidden lg:flex flex-col justify-between w-[460px] flex-shrink-0 relative overflow-hidden" style="background:linear-gradient(145deg,#0f172a 0%,#1e3a5f 50%,#0f172a 100%)">
    <!-- 装饰圆 -->
    <div class="absolute -top-32 -right-32 w-80 h-80 rounded-full" style="background:radial-gradient(circle,rgba(59,130,246,0.15),transparent 70%)"></div>
    <div class="absolute -bottom-40 -left-20 w-96 h-96 rounded-full" style="background:radial-gradient(circle,rgba(99,102,241,0.12),transparent 70%)"></div>
    <!-- 网格纹理 -->
    <div class="absolute inset-0 opacity-[0.04]" style="background-image:linear-gradient(rgba(255,255,255,0.5) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.5) 1px,transparent 1px);background-size:40px 40px"></div>

    <!-- Logo & 标题 -->
    <div class="relative z-10 p-12">
        <div class="flex items-center gap-3 mb-14">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:rgba(59,130,246,0.9)">
                <span class="material-symbols-outlined text-white" style="font-size:22px">hub</span>
            </div>
            <div>
                <span class="text-xl font-extrabold text-white font-headline tracking-tight">GEOrank</span>
                <span class="text-[10px] font-bold tracking-widest uppercase text-blue-400 block -mt-0.5">Admin Console</span>
            </div>
        </div>
        <h2 class="text-[2rem] font-extrabold text-white font-headline leading-tight mb-4">AI 时代的<br>搜索优化中枢</h2>
        <p class="text-slate-400 text-sm leading-relaxed">管理并追踪 GEO 公司生态，驱动<br>生成式搜索时代的品牌可见度。</p>
    </div>

    <!-- 特性列表 -->
    <div class="relative z-10 p-12 space-y-4">
        <div class="flex items-center gap-3.5">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(59,130,246,0.15)">
                <span class="material-symbols-outlined text-blue-400" style="font-size:16px">monitoring</span>
            </div>
            <span class="text-slate-300 text-sm">实时 GEO 评分追踪与分析</span>
        </div>
        <div class="flex items-center gap-3.5">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(59,130,246,0.15)">
                <span class="material-symbols-outlined text-blue-400" style="font-size:16px">apartment</span>
            </div>
            <span class="text-slate-300 text-sm">公司数据库管理与审核</span>
        </div>
        <div class="flex items-center gap-3.5">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(59,130,246,0.15)">
                <span class="material-symbols-outlined text-blue-400" style="font-size:16px">auto_awesome</span>
            </div>
            <span class="text-slate-300 text-sm">AI 驱动的内容优化引擎</span>
        </div>
        <p class="text-slate-600 text-xs pt-4">© 2026 GEOrank Platform · 仅限授权管理员</p>
    </div>
</div>

<!-- 右侧表单面板 -->
<div class="flex-1 flex items-center justify-center bg-slate-50 p-8">
    <div class="w-full max-w-[380px]">
        <!-- 移动端 Logo -->
        <div class="flex items-center gap-3 mb-10 lg:hidden">
            <div class="w-9 h-9 rounded-xl bg-primary flex items-center justify-center">
                <span class="material-symbols-outlined text-white text-xl">hub</span>
            </div>
            <span class="text-lg font-extrabold font-headline tracking-tight">GEOrank Admin</span>
        </div>

        <h1 class="text-[1.75rem] font-extrabold font-headline tracking-tight text-on-surface mb-1">欢迎回来</h1>
        <p class="text-sm text-slate-500 mb-8">登录 GEOrank 后台管理系统</p>

        ${errMsg ? `
        <div class="mb-6 p-4 rounded-xl border flex items-start gap-3" style="background:#fef2f2;border-color:#fecaca">
            <span class="material-symbols-outlined text-red-500 flex-shrink-0 mt-0.5" style="font-size:18px">error</span>
            <span class="text-sm text-red-600 font-medium">${escapeHtml(errMsg)}</span>
        </div>` : ''}

        <form id="login-form" class="space-y-5">
            <div>
                <label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">用户名</label>
                <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-400 pointer-events-none" style="font-size:18px">person</span>
                    <input id="login-username" type="text" value="admin"
                        class="form-input pl-11 py-3 text-sm rounded-xl"
                        placeholder="输入用户名" required autocomplete="username">
                </div>
            </div>
            <div>
                <label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">密码</label>
                <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-400 pointer-events-none" style="font-size:18px">lock</span>
                    <input id="login-pwd" type="password"
                        class="form-input pl-11 py-3 text-sm rounded-xl"
                        placeholder="输入密码" required autocomplete="current-password">
                </div>
            </div>
            <button type="submit" id="login-btn"
                class="btn btn-primary w-full py-3.5 rounded-xl text-sm font-bold tracking-wide flex items-center justify-center gap-2 mt-1"
                style="background:linear-gradient(135deg,#2563EB,#1d4ed8);box-shadow:0 4px 14px rgba(37,99,235,0.35)">
                <span class="material-symbols-outlined" style="font-size:18px">login</span>
                登录后台
            </button>
        </form>

        <div class="mt-10 flex items-center justify-center gap-1.5 text-xs text-slate-400">
            <span class="material-symbols-outlined" style="font-size:14px">shield</span>
            <span>安全连接 · 仅限授权管理员访问</span>
        </div>
    </div>
</div>`;
        document.body.appendChild(modal);

        // 密码框回车聚焦逻辑
        modal.querySelector('#login-username').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); modal.querySelector('#login-pwd').focus(); }
        });

        modal.querySelector('#login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = modal.querySelector('#login-btn');
            btn.innerHTML = '<span class="material-symbols-outlined animate-spin" style="font-size:18px">progress_activity</span> 登录中…';
            btn.disabled = true;
            try {
                const username = modal.querySelector('#login-username').value.trim();
                const pwd = modal.querySelector('#login-pwd').value;
                const data = await api('POST', '/api/auth/login', { username, password: pwd });
                Auth.set(data.access_token);
                const me = await api('GET', '/api/auth/me');
                if (me.role !== 'admin') {
                    Auth.clear();
                    throw new Error('需要管理员权限');
                }
                modal.remove();
                initPage();
            } catch (err) {
                showLoginModal(err.message);
            }
        });
    }

    // ─── 侧边栏 & 顶栏 ──────────────────────────────────────────────────────
    function renderSidebar(user) {
        const initials = (user?.username || 'A').slice(0, 2).toUpperCase();
        const html = `
<div class="flex flex-col h-full bg-white border-r border-slate-100">
    <div class="px-6 h-16 flex items-center gap-3 border-b border-slate-50">
        <div class="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <span class="material-symbols-outlined text-white text-sm">hub</span>
        </div>
        <div>
            <span class="text-sm font-bold font-headline tracking-tight">GEOrank</span>
            <span class="text-[10px] text-slate-400 block -mt-0.5 font-semibold tracking-widest uppercase">Admin</span>
        </div>
    </div>
    <nav class="flex-1 px-4 py-6 space-y-1 overflow-y-auto scrollbar-hide">
        <p class="px-3 mb-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">概览</p>
        <a href="${withAppOrigin('/admin')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">dashboard</span><span>仪表盘</span>
        </a>
        <p class="px-3 mt-6 mb-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">业务模块</p>
        <a href="${withAppOrigin('/admin/companies')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">apartment</span><span>公司管理</span>
        </a>
        <a href="${withAppOrigin('/admin/diagnostics')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">analytics</span><span>诊断管理</span>
        </a>
        <a href="${withAppOrigin('/admin/solutions')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">psychology</span><span>问答管理</span>
        </a>
        <a href="${withAppOrigin('/admin/keywords')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">manage_search</span><span>拓词管理</span>
        </a>
        <a href="${withAppOrigin('/admin/tutorials')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">menu_book</span><span>教程管理</span>
        </a>
        <a href="${withAppOrigin('/admin/experts')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">person_search</span><span>专家管理</span>
        </a>
        <p class="px-3 mt-6 mb-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">平台管理</p>
        <a href="${withAppOrigin('/admin/users')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">group</span><span>用户管理</span>
        </a>
        <a href="${withAppOrigin('/admin/settings')}" data-admin-link class="sidebar-link">
            <span class="material-symbols-outlined text-lg">settings</span><span>系统设置</span>
        </a>
        <a href="${withAppOrigin('/')}" class="sidebar-link">
            <span class="material-symbols-outlined text-lg">open_in_new</span><span>访问前台</span>
        </a>
    </nav>
    <div class="px-4 py-4 border-t border-slate-50">
        <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 transition-colors">
            <div class="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold">${escapeHtml(initials)}</div>
            <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold truncate">${escapeHtml(user?.username || 'Admin')}</p>
                <p class="text-[10px] text-slate-400 truncate">${escapeHtml(user?.email || '')}</p>
            </div>
            <button id="logout-btn" title="退出登录" class="w-7 h-7 flex items-center justify-center rounded hover:bg-red-50 transition-colors">
                <span class="material-symbols-outlined text-slate-400 hover:text-red-500 text-lg">logout</span>
            </button>
        </div>
    </div>
</div>`;
        const el = document.getElementById('admin-sidebar');
        if (el) el.innerHTML = html;

        // 高亮当前页
        const path = normalizeAdminModulePath(window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/admin');
        document.querySelectorAll('[data-admin-link]').forEach(link => {
            const href = normalizeAdminModulePath(getPathname(link.getAttribute('href')));
            if (path === href || (path === '/admin' && href === '/admin')) {
                link.classList.add('active');
            }
        });

        // 退出登录
        document.getElementById('logout-btn')?.addEventListener('click', () => {
            Auth.clear();
            showLoginModal();
        });
    }

    function renderTopbar(title) {
        const el = document.getElementById('admin-topbar');
        if (!el) return;
        el.innerHTML = `
<header class="h-16 bg-white border-b border-slate-100 flex items-center justify-between px-6 lg:px-8 sticky top-0 z-20">
    <div class="flex items-center gap-4">
        <button id="sidebar-toggle" class="lg:hidden w-9 h-9 flex items-center justify-center rounded-lg hover:bg-slate-50 transition-colors">
            <span class="material-symbols-outlined text-slate-600">menu</span>
        </button>
        ${title ? `<span class="text-sm font-semibold text-on-surface-variant hidden md:block">${title}</span>` : ''}
    </div>
    <div class="flex items-center gap-2">
        <span class="text-xs text-slate-400 hidden sm:block">GEOrank Admin v1.3</span>
    </div>
</header>`;

        document.addEventListener('click', e => {
            if (e.target.closest('#sidebar-toggle')) {
                document.getElementById('admin-sidebar')?.classList.toggle('open');
                document.getElementById('sidebar-overlay')?.classList.toggle('active');
            }
            if (e.target.closest('#sidebar-overlay')) {
                document.getElementById('admin-sidebar')?.classList.remove('open');
                document.getElementById('sidebar-overlay')?.classList.remove('active');
            }
        });
    }

    // ─── 工具函数 ────────────────────────────────────────────────────────────
    function formatDate(iso) {
        if (!iso) return '--';
        return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    }

    function timeAgo(iso) {
        if (!iso) return '--';
        const diff = Date.now() - new Date(iso).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return `${m} 分钟前`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h} 小时前`;
        return `${Math.floor(h / 24)} 天前`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isSafeAdminPreviewUrl(rawValue, attrName) {
        const value = String(rawValue || '').trim();
        if (!value) return true;

        const normalized = value.replace(/[\u0000-\u001F\u007F\s]+/g, '');
        if (/^(javascript|vbscript):/i.test(normalized)) return false;
        if (/^data:/i.test(normalized)) {
            return attrName === 'src' && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);/i.test(normalized);
        }

        try {
            const parsed = new URL(value, `${APP_ORIGIN}/`);
            return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol);
        } catch (_) {
            return false;
        }
    }

    function normalizeExternalHttpUrl(rawValue) {
        const value = String(rawValue || '').trim();
        if (!value) return '';

        try {
            const parsed = new URL(value);
            return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
        } catch (_) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
            try {
                const parsed = new URL(`https://${value}`);
                return parsed.hostname ? parsed.href : '';
            } catch (_) {
                return '';
            }
        }
    }

    function safeExternalHttpHref(rawValue) {
        return escapeHtml(normalizeExternalHttpUrl(rawValue) || '#');
    }

    function sanitizeAdminPreviewHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');

        template.content.querySelectorAll('script, iframe, object, embed, link, meta, base, form, input, button, textarea, select').forEach(node => node.remove());
        template.content.querySelectorAll('*').forEach(node => {
            Array.from(node.attributes).forEach(attr => {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
                    node.removeAttribute(attr.name);
                    return;
                }
                if (['href', 'src', 'xlink:href', 'action', 'formaction', 'poster'].includes(name) && !isSafeAdminPreviewUrl(attr.value, name)) {
                    node.removeAttribute(attr.name);
                }
            });
            if (node.tagName === 'A') {
                node.setAttribute('rel', 'noopener noreferrer');
            }
        });

        return template.innerHTML.trim() || '<p class="text-sm text-slate-400">暂无正文内容</p>';
    }

    function ensureAdminPreviewOverlay() {
        let overlay = document.querySelector('.admin-preview-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'admin-preview-overlay';
            overlay.hidden = true;
            document.body.appendChild(overlay);
        }
        overlay.onclick = () => closeAdminPreviewDrawer();
        return overlay;
    }

    function getAdminPreviewPanel() {
        return document.querySelector('.admin-preview-modal, .admin-preview-drawer');
    }

    function openAdminPreviewDrawer() {
        const previewPanel = getAdminPreviewPanel();
        if (!previewPanel) return;
        const overlay = ensureAdminPreviewOverlay();
        overlay.hidden = false;
        previewPanel.hidden = false;
        document.body.classList.add('admin-preview-open');
        previewPanel.querySelector('[data-preview-close]')?.focus?.({ preventScroll: true });
    }

    function closeAdminPreviewDrawer() {
        document.querySelector('.admin-preview-overlay')?.setAttribute('hidden', '');
        document.querySelectorAll('.admin-preview-modal, .admin-preview-drawer').forEach(panel => {
            panel.setAttribute('hidden', '');
        });
        document.body.classList.remove('admin-preview-open');
        setAdminSelectionParam('company', '');
        setAdminSelectionParam('content', '');
        setAdminSelectionParam('conversation', '');
        setAdminSelectionParam('report', '');
        setAdminSelectionParam('expert', '');
        selectedCompanyId = null;
        selectedContentId = null;
        selectedSolutionConversationId = null;
        selectedDiagnosticReportId = null;
        selectedKeywordPackId = null;
        selectedExpertId = null;
        document.querySelectorAll('.data-table tr.is-selected').forEach(row => row.classList.remove('is-selected'));
    }

    function setupAdminPreviewDrawer() {
        const previewPanel = getAdminPreviewPanel();
        if (!previewPanel) return;
        ensureAdminPreviewOverlay();
        previewPanel.hidden = true;
        previewPanel.addEventListener('click', (event) => {
            if (event.target.closest('[data-preview-close]')) {
                closeAdminPreviewDrawer();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !previewPanel.hidden) closeAdminPreviewDrawer();
        });
    }

    const PUBLISH_BADGE = {
        published: '<span class="badge badge-success">已发布</span>',
        pending_review: '<span class="badge badge-warning">待审核</span>',
        draft: '<span class="badge badge-neutral">草稿</span>',
        archived: '<span class="badge badge-neutral">已下架</span>',
    };

    const PIPELINE_BADGE = {
        completed: '<span class="badge badge-success">已完成</span>',
        pending: '<span class="badge badge-neutral">等待中</span>',
        crawling: '<span class="badge badge-warning">爬取中</span>',
        cleaning: '<span class="badge badge-info">清洗中</span>',
        graph_building: '<span class="badge badge-info">图谱构建</span>',
        vectorizing: '<span class="badge badge-info">向量化</span>',
        failed: '<span class="badge badge-error">失败</span>',
    };

    const CONTENT_TYPE_LABEL = {
        tutorial: '教程', template: '方案模板', whitepaper: '白皮书', announcement: '公告',
    };

    // ─── 仪表盘页 ────────────────────────────────────────────────────────────
    const DASHBOARD_TREND_SERIES = [
        { key: 'companies', label: '公司', color: '#2563eb' },
        { key: 'diagnostics', label: '诊断', color: '#7c3aed' },
        { key: 'conversations', label: '问答', color: '#16a34a' },
        { key: 'keyword_packs', label: '拓词', color: '#059669' },
        { key: 'contents', label: '内容', color: '#f97316' },
    ];

    function renderDashboardTrend(trend = []) {
        const chart = document.getElementById('dashboard-trend-chart');
        const legend = document.getElementById('dashboard-trend-legend');
        const totalEl = document.getElementById('dashboard-trend-total');
        if (!chart) return;
        if (!trend.length) {
            chart.innerHTML = '<div class="admin-chart-empty">暂无近 14 天趋势数据</div>';
            if (legend) legend.innerHTML = '';
            if (totalEl) totalEl.textContent = '0';
            return;
        }

        const width = 820;
        const height = 260;
        const padding = { top: 28, right: 32, bottom: 42, left: 42 };
        const values = trend.flatMap(day => DASHBOARD_TREND_SERIES.map(series => Number(day[series.key] || 0)));
        const max = Math.max(1, ...values);
        const xStep = trend.length > 1 ? (width - padding.left - padding.right) / (trend.length - 1) : 0;
        const yFor = value => padding.top + (height - padding.top - padding.bottom) * (1 - Number(value || 0) / max);
        const total = trend.reduce((sum, day) => (
            sum + DASHBOARD_TREND_SERIES.reduce((daySum, series) => daySum + Number(day[series.key] || 0), 0)
        ), 0);
        if (totalEl) totalEl.textContent = total.toLocaleString();

        const grid = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
            const y = padding.top + (height - padding.top - padding.bottom) * ratio;
            const label = Math.round(max * (1 - ratio));
            return `
<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#e5edf7" stroke-width="1" />
<text x="12" y="${y + 4}" font-size="11" fill="#94a3b8">${label}</text>`;
        }).join('');

        const lines = DASHBOARD_TREND_SERIES.map((series, seriesIndex) => {
            const points = trend.map((day, index) => {
                const x = padding.left + xStep * index;
                const y = yFor(day[series.key]);
                return `${x.toFixed(1)},${y.toFixed(1)}`;
            }).join(' ');
            const pointDots = trend.map((day, index) => {
                const value = Number(day[series.key] || 0);
                if (!value) return '';
                const x = padding.left + xStep * index;
                const y = yFor(value);
                return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${series.color}" opacity="0.9"><title>${escapeHtml(day.label)} ${escapeHtml(series.label)} ${value}</title></circle>`;
            }).join('');
            return `
<polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="${seriesIndex === 0 ? 3 : 2.2}" stroke-linecap="round" stroke-linejoin="round" opacity="${seriesIndex === 0 ? 1 : 0.82}" />
${pointDots}`;
        }).join('');

        const labels = trend.map((day, index) => {
            if (index !== 0 && index !== trend.length - 1 && index % 3 !== 0) return '';
            const x = padding.left + xStep * index;
            return `<text x="${x}" y="${height - 14}" text-anchor="middle" font-size="11" fill="#94a3b8">${escapeHtml(day.label || '')}</text>`;
        }).join('');

        chart.innerHTML = `
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近 14 天运营趋势">
    ${grid}
    ${lines}
    ${labels}
</svg>`;

        if (legend) {
            legend.innerHTML = DASHBOARD_TREND_SERIES.map(series => {
                const value = trend.reduce((sum, day) => sum + Number(day[series.key] || 0), 0);
                return `
<span class="admin-trend-legend__item">
    <span class="admin-trend-legend__dot" style="background:${series.color}"></span>
    ${escapeHtml(series.label)} ${value.toLocaleString()}
</span>`;
            }).join('');
        }
    }

    function renderDashboardModuleHealth(health = {}) {
        const container = document.getElementById('dashboard-module-health');
        if (!container) return;
        const rows = [
            { key: 'companies', label: '公司库', doneLabel: '已发布', attentionLabel: '待审/失败' },
            { key: 'diagnostics', label: '诊断报告', doneLabel: '已完成', attentionLabel: '失败' },
            { key: 'qa', label: '问答归档', doneLabel: '已归档', attentionLabel: '待处理' },
            { key: 'keywords', label: '拓词资产', doneLabel: '已保存', attentionLabel: '待处理' },
            { key: 'content', label: '教程内容', doneLabel: '已发布', attentionLabel: '草稿' },
        ];
        container.innerHTML = rows.map(row => {
            const item = health[row.key] || {};
            const total = Number(item.total || 0);
            const done = Number(item.done || 0);
            const attention = Number(item.attention || 0);
            const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
            return `
<div class="admin-health-row">
    <div class="admin-health-row__top">
        <div>
            <p class="admin-health-row__title">${escapeHtml(row.label)}</p>
            <p class="admin-health-row__meta">${escapeHtml(row.doneLabel)} ${done.toLocaleString()} / 总量 ${total.toLocaleString()}</p>
        </div>
        <span class="badge ${attention ? 'badge-warning' : 'badge-success'}">${escapeHtml(row.attentionLabel)} ${attention.toLocaleString()}</span>
    </div>
    <div class="admin-progress-track" aria-label="${escapeHtml(row.label)}完成占比 ${pct}%">
        <div class="admin-progress-track__bar" style="width:${pct}%"></div>
    </div>
</div>`;
        }).join('');
    }

    function renderDashboardEmpty(message) {
        return `<div class="admin-dashboard-empty-card">${escapeHtml(message)}</div>`;
    }

    function formatDashboardScore(value) {
        const score = Number(value);
        return Number.isFinite(score) ? score.toFixed(1) : '--';
    }

    function renderDashboardReminderItems(items, emptyMessage) {
        if (!items.length) return renderDashboardEmpty(emptyMessage);

        const allowedTones = new Set(['danger', 'warning', 'info', 'success', 'neutral']);
        return items.map(item => {
            const tone = allowedTones.has(item.tone) ? item.tone : 'neutral';
            return `
<a href="${escapeHtml(item.href || '#')}" class="admin-dashboard-reminder-item admin-dashboard-reminder-item--${tone}">
    <span class="material-symbols-outlined admin-dashboard-reminder-icon">${escapeHtml(item.icon || 'notifications')}</span>
    <span class="admin-dashboard-reminder-main">
        <span class="admin-dashboard-reminder-label">${escapeHtml(item.label || '--')}</span>
        <strong>${escapeHtml(item.title || '--')}</strong>
        <span>${escapeHtml(item.meta || '')}</span>
    </span>
    <span class="admin-dashboard-reminder-time">${escapeHtml(timeAgo(item.time))}</span>
</a>`;
        }).join('');
    }

    async function initDashboard() {
        renderTopbar('仪表盘');
        try {
            const [stats, recentCompanies, failures, draftTutorials, recentSolutions, keywordSummary] = await Promise.all([
                api('GET', '/api/admin/dashboard'),
                api('GET', '/api/admin/companies?size=5&sort=created_at'),
                api('GET', '/api/admin/ops/recent-failures?limit=4'),
                api('GET', '/api/admin/tutorials?content_type=tutorial&status_filter=draft&size=3'),
                api('GET', '/api/admin/solutions/conversations?size=3'),
                api('GET', '/api/admin/keywords/summary'),
            ]);

            // 统计卡片
            const setStatValue = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value;
            };
            setStatValue('dashboard-stat-companies', stats.total_companies.toLocaleString());
            setStatValue('dashboard-stat-diagnostics', stats.total_diagnostics.toLocaleString());
            setStatValue('dashboard-stat-solutions', (stats.total_solutions ?? 0).toLocaleString());
            setStatValue('dashboard-stat-keywords', Number(keywordSummary.total_packs || 0).toLocaleString());
            setStatValue('dashboard-stat-contents', stats.total_contents.toLocaleString());

            const pipelineStats = stats.pipeline_stats || {};
            const failureStats = stats.failure_stats || {};
            const draftSummary = draftTutorials.summary || {};

            const companiesPendingEl = document.getElementById('dashboard-companies-pending');
            const diagnosticsFailedEl = document.getElementById('dashboard-diagnostics-failed');
            const solutionsRecentEl = document.getElementById('dashboard-solutions-recent');
            const contentDraftsEl = document.getElementById('dashboard-content-drafts');

            if (companiesPendingEl) companiesPendingEl.textContent = Number(pipelineStats.pending_review || 0).toLocaleString();
            if (diagnosticsFailedEl) diagnosticsFailedEl.textContent = Number(failureStats.failed_diagnostics || 0).toLocaleString();
            if (solutionsRecentEl) solutionsRecentEl.textContent = Number(stats.total_solutions ?? recentSolutions.total ?? 0).toLocaleString();
            setStatValue('dashboard-keywords-packs', Number(keywordSummary.total_packs || 0).toLocaleString());
            if (contentDraftsEl) contentDraftsEl.textContent = Number(draftSummary.draft_assets || draftTutorials.total || 0).toLocaleString();

            renderDashboardTrend(stats.trend || []);
            renderDashboardModuleHealth(stats.module_health || {});

            // GEO 评分分布（真实数据）
            const dist = stats.geo_distribution || {};
            const distRows = document.querySelectorAll('#dashboard-score-distribution > div');
            const distData = [
                { pct: dist.excellent || 0 },
                { pct: dist.good || 0 },
                { pct: dist.average || 0 },
                { pct: dist.poor || 0 },
            ];
            distRows.forEach((row, i) => {
                if (!distData[i]) return;
                const pct = distData[i].pct;
                const pctEl = row.querySelector('span.font-bold');
                const bar = row.querySelector('.bg-primary, .bg-blue-300, .bg-orange-300, .bg-red-300');
                if (pctEl) pctEl.textContent = pct + '%';
                if (bar) bar.style.width = pct + '%';
            });

            // 最近公司列表
            const companyActivityEl = document.getElementById('dashboard-company-activity');
            if (companyActivityEl) {
                const companies = Array.isArray(recentCompanies?.items) ? recentCompanies.items : [];
                if (!companies.length) {
                    companyActivityEl.innerHTML = renderDashboardEmpty('暂无公司动态');
                } else {
                    companyActivityEl.innerHTML = companies.slice(0, 5).map(c => {
                        const title = c.name || c.url || '未命名公司';
                        const href = c.id ? withAppOrigin(`/admin/companies?company=${c.id}`) : withAppOrigin('/admin/companies');
                        const status = PUBLISH_BADGE[c.publish_status] || `<span class="badge badge-neutral">${escapeHtml(c.publish_status || '未设置')}</span>`;
                        return `
<a href="${href}" class="admin-dashboard-company-item">
    <span class="admin-dashboard-company-item__avatar">${escapeHtml(getCompanyInitials(title))}</span>
    <span class="admin-dashboard-company-item__body">
        <span class="admin-dashboard-company-item__top">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(timeAgo(c.updated_at || c.created_at))}</span>
        </span>
        <span class="admin-dashboard-company-item__meta">
            <span class="admin-dashboard-company-tag">${escapeHtml(c.category || '未分类')}</span>
            ${status}
        </span>
    </span>
    <span class="admin-dashboard-company-score">
        <strong>${formatDashboardScore(c.geo_score)}</strong>
        <span>GEO</span>
    </span>
</a>`;
                    }).join('');
                }
            }

            const failureItems = [
                ...(failures.companies || []).map(item => ({
                    label: '公司入库失败',
                    title: item.name || item.url || '未命名公司',
                    meta: item.pipeline_error || item.url || '无详细错误',
                    href: withAppOrigin(`/admin/companies?company=${item.id}`),
                    time: item.updated_at || item.created_at,
                    icon: 'business',
                    tone: 'warning',
                })),
                ...(failures.diagnostics || []).map(item => ({
                    label: '诊断失败',
                    title: item.url || '未知诊断地址',
                    meta: item.error_message || '等待重新执行',
                    href: withAppOrigin(`/admin/diagnostics?report=${item.id}`),
                    time: item.created_at,
                    icon: 'error',
                    tone: 'danger',
                })),
            ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 3);

            const failuresEl = document.getElementById('dashboard-failures');
            if (failuresEl) {
                failuresEl.innerHTML = renderDashboardReminderItems(failureItems, '当前没有失败阻塞项');
            }

            const asyncUsageEl = document.getElementById('dashboard-async-usage');
            if (asyncUsageEl) {
                const asyncUsage = stats.async_usage || {};
                const asyncModules = Array.isArray(asyncUsage.modules) ? asyncUsage.modules : [];
                const totalTokens = Number(asyncUsage.total_tokens || 0);
                const totalRequests = Number(asyncUsage.total_requests || 0);
                if (!totalTokens && !totalRequests) {
                    asyncUsageEl.innerHTML = renderDashboardEmpty('暂无异步 AI 消耗记录');
                } else {
                    const rows = asyncModules.length ? asyncModules : [
                        { label: '异步任务', total_tokens: totalTokens, request_count: totalRequests },
                    ];
                    asyncUsageEl.innerHTML = `
<div class="admin-dashboard-token-summary">
    <div>
        <span>异步 Token</span>
        <strong>${totalTokens.toLocaleString()}</strong>
    </div>
    <span class="badge badge-info">${totalRequests.toLocaleString()} 次任务</span>
</div>
${rows.slice(0, 3).map(item => {
    const tokens = Number(item.total_tokens || 0);
    const pct = totalTokens ? Math.min(100, Math.round(tokens / totalTokens * 100)) : 0;
    return `
<div class="admin-dashboard-token-row">
    <div class="admin-dashboard-token-row__top">
        <strong>${escapeHtml(item.label || item.module || '异步任务')}</strong>
        <span class="badge badge-neutral">${pct}%</span>
    </div>
    <p>${tokens.toLocaleString()} token · ${Number(item.request_count || 0).toLocaleString()} 次</p>
    <div class="admin-progress-track" aria-label="${escapeHtml(item.label || item.module || '异步任务')}消耗占比 ${pct}%">
        <div class="admin-progress-track__bar" style="width:${pct}%"></div>
    </div>
</div>`;
}).join('')}`;
                }
            }

            const followupItems = [
                {
                    label: '拓词工作台',
                    title: `${Number(keywordSummary.total_packs || 0).toLocaleString()} 个已保存拓词词包`,
                    meta: '进入拓词管理查看、导出或清理关键词资产',
                    href: withAppOrigin('/admin/keywords'),
                    time: keywordSummary.latest_pack?.updated_at || keywordSummary.latest_pack?.created_at || new Date().toISOString(),
                    icon: 'manage_search',
                    tone: 'info',
                },
                ...(draftTutorials.items || []).map(item => ({
                    label: '教程草稿',
                    title: item.title || '未命名教程',
                    meta: `${CONTENT_TYPE_LABEL[item.content_type] || item.content_type} · ${item.reading_time_minutes ? `${item.reading_time_minutes} 分钟` : '待完善'}`,
                    href: withAppOrigin(`/admin/tutorials?content=${item.id}`),
                    time: item.updated_at || item.created_at,
                    icon: 'menu_book',
                    tone: 'warning',
                })),
                ...(recentSolutions.items || []).map(item => ({
                    label: '问答会话',
                    title: item.title || '未命名问答会话',
                    meta: `${item.username || item.user_email || '未知用户'} · ${item.message_count || 0} 条消息`,
                    href: withAppOrigin(`/admin/solutions?conversation=${item.id}`),
                    time: item.updated_at || item.created_at,
                    icon: 'forum',
                    tone: 'success',
                })),
            ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 3);

            const followupsEl = document.getElementById('dashboard-followups');
            if (followupsEl) {
                followupsEl.innerHTML = renderDashboardReminderItems(followupItems, '暂无需要跟进的教程或问答记录');
            }
        } catch (err) {
            toast('加载仪表盘数据失败: ' + err.message, 'error');
        }
    }

    // ─── 拓词管理页 ──────────────────────────────────────────────────────────
    let keywordPage = 1;
    let selectedKeywordPackId = null;
    let keywordFilters = { search: '', sourceType: '' };

    const KEYWORD_SOURCE_LABEL = {
        manual: '手动',
        company: '公司',
        diagnostic: '诊断',
        solution: '问答/方案',
        tutorial: '教程',
    };

    function renderKeywordPackDetail(detail) {
        const container = document.getElementById('keyword-pack-detail');
        const badge = document.getElementById('keyword-pack-detail-badge');
        if (!container) return;

        if (!detail) {
            if (badge) {
                badge.className = 'badge badge-neutral';
                badge.textContent = '未选择';
            }
            container.innerHTML = '<div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-5 text-sm text-slate-400">点击列表中的预览按钮，或先生成一个新的拓词包。</div>';
            return;
        }

        if (badge) {
            badge.className = 'badge badge-success';
            badge.textContent = detail.status === 'completed' ? '已生成' : escapeHtml(detail.status || '词包');
        }

        const seeds = Array.isArray(detail.seed_keywords) ? detail.seed_keywords : [];
        const dimensions = Array.isArray(detail.dimensions) ? detail.dimensions : [];
        const profile = detail.profile || {};

        container.innerHTML = `
<div class="space-y-4">
    <section class="admin-detail-section p-4">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                <h3 class="text-lg font-bold font-headline truncate">${escapeHtml(detail.title || '未命名词包')}</h3>
                <p class="text-sm text-slate-500 mt-2 leading-6">${escapeHtml(detail.summary || profile.keyword_strategy || '暂无策略摘要')}</p>
            </div>
            <span class="badge badge-info">${escapeHtml(KEYWORD_SOURCE_LABEL[detail.source_type] || detail.source_type || '来源')}</span>
        </div>
        <div class="admin-detail-actions mt-4">
            <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-keyword-action="export" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">download</span>
                导出 CSV
            </button>
            <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5 text-red-500 hover:text-red-600" data-keyword-action="delete" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">delete</span>
                删除词包
            </button>
        </div>
    </section>

    <section class="admin-detail-grid">
        <div class="admin-detail-metric"><span>词项</span><strong>${Number(detail.total_keywords || 0)}</strong></div>
        <div class="admin-detail-metric"><span>维度</span><strong>${Number(detail.dimension_count || dimensions.length || 0)}</strong></div>
        <div class="admin-detail-metric"><span>推荐</span><strong>${Math.round(Number(detail.avg_recommendation_score || 0))}</strong></div>
        <div class="admin-detail-metric"><span>商业</span><strong>${Math.round(Number(detail.avg_business_score || 0))}</strong></div>
    </section>

    <section class="admin-detail-section p-4">
        <p class="text-xs font-bold tracking-widest uppercase text-slate-400 mb-3">种子词与画像</p>
        ${renderPillList(seeds, '暂无种子词')}
        <dl class="admin-detail-meta mt-4">
            ${renderMetaItem('业务画像', escapeHtml(profile.name || '--'))}
            ${renderMetaItem('业务模式', escapeHtml(profile.business_model || '--'))}
            ${renderMetaItem('目标用户', Array.isArray(profile.target_users) ? renderPillList(profile.target_users) : '--')}
            ${renderMetaItem('创建时间', escapeHtml(formatDate(detail.created_at)))}
        </dl>
    </section>

    <section class="space-y-3">
        ${dimensions.map(dimension => `
            <div class="admin-detail-section p-4">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <p class="text-sm font-bold text-slate-900">${escapeHtml(dimension.name || dimension.key)}</p>
                        <p class="text-xs text-slate-500 mt-1">${escapeHtml(dimension.description || '')}</p>
                    </div>
                    <span class="badge badge-neutral">${Number(dimension.count || (dimension.items || []).length)} 个</span>
                </div>
                <div class="mt-3 space-y-2">
                    ${(dimension.items || []).slice(0, 8).map(item => `
                        <div class="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                            <div class="flex items-start justify-between gap-3">
                                <p class="text-sm font-semibold text-slate-800 leading-6">${escapeHtml(item.keyword)}</p>
                                <div class="flex items-center gap-1 text-[11px] text-slate-500 whitespace-nowrap">
                                    <span class="admin-pill">推 ${Number(item.recommendation_score || 0)}</span>
                                    <span class="admin-pill">商 ${Number(item.business_score || 0)}</span>
                                </div>
                            </div>
                            ${item.reason ? `<p class="text-xs text-slate-500 leading-5 mt-2">${escapeHtml(item.reason)}</p>` : ''}
                        </div>
                    `).join('')}
                    ${(dimension.items || []).length > 8 ? `<p class="text-xs text-slate-400">还有 ${(dimension.items || []).length - 8} 个词项，可导出 CSV 查看完整列表。</p>` : ''}
                </div>
            </div>
        `).join('') || '<div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-5 text-sm text-slate-400">当前词包暂无维度数据。</div>'}
    </section>
</div>`;
    }

    async function loadKeywordSummary() {
        try {
            const summary = await api('GET', '/api/admin/keywords/summary');
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value;
            };
            setValue('keyword-stat-packs', Number(summary.total_packs || 0).toLocaleString());
            setValue('keyword-stat-keywords', Number(summary.total_keywords || 0).toLocaleString());
            setValue('keyword-stat-rec', summary.avg_recommendation_score ? Math.round(summary.avg_recommendation_score) : '--');
            setValue('keyword-stat-business', summary.avg_business_score ? Math.round(summary.avg_business_score) : '--');
        } catch (err) {
            toast('加载拓词统计失败: ' + err.message, 'error');
        }
    }

    async function loadKeywordPackDetail(packId) {
        const container = document.getElementById('keyword-pack-detail');
        openAdminPreviewDrawer();
        if (container) container.innerHTML = '<div class="admin-detail-section p-5 text-sm text-slate-400">正在加载词包详情...</div>';
        try {
            const detail = await api('GET', `/api/admin/keywords/packs/${packId}`);
            selectedKeywordPackId = detail.id;
            renderKeywordPackDetail(detail);
        } catch (err) {
            if (container) container.innerHTML = `<div class="admin-detail-section p-5 text-sm text-red-500">${escapeHtml(err.message)}</div>`;
        }
    }

    async function loadKeywordPacks() {
        const tbody = document.getElementById('keyword-packs-tbody');
        if (!tbody) return;
        const params = new URLSearchParams({ page: String(keywordPage), size: '20' });
        if (keywordFilters.search) params.set('search', keywordFilters.search);
        if (keywordFilters.sourceType) params.set('source_type', keywordFilters.sourceType);
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400 text-sm">加载中...</td></tr>';

        try {
            const data = await api('GET', `/api/admin/keywords/packs?${params.toString()}`);
            const items = data.items || [];
            const infoEl = document.getElementById('keyword-pagination-info');
            if (infoEl) infoEl.textContent = `共 ${Number(data.total || 0).toLocaleString()} 个词包`;

            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400 text-sm">暂无词包。前台用户生成后会出现在这里。</td></tr>';
                renderPaginationControls(document.getElementById('keyword-pagination'), 1, 1, () => {});
                renderKeywordPackDetail(null);
                return;
            }

            tbody.innerHTML = items.map(item => {
                const seeds = Array.isArray(item.seed_keywords) ? item.seed_keywords.slice(0, 3) : [];
                const isSelected = item.id === selectedKeywordPackId;
                return `
<tr data-keyword-pack-id="${item.id}" class="${isSelected ? 'is-selected' : ''}">
    <td>
        <div>
            <p class="font-semibold text-sm text-slate-900">${escapeHtml(item.title || '未命名词包')}</p>
            <p class="text-xs text-on-surface-variant mt-1 truncate max-w-[340px]">${escapeHtml(seeds.join(' / ') || '暂无种子词')}</p>
        </div>
    </td>
    <td><span class="badge badge-info">${escapeHtml(KEYWORD_SOURCE_LABEL[item.source_type] || item.source_type || '来源')}</span></td>
    <td class="font-semibold">${Number(item.total_keywords || 0)}</td>
    <td>
        <div class="text-xs text-slate-500 leading-5">
            <p>推荐 ${Math.round(Number(item.avg_recommendation_score || 0))}</p>
            <p>商业 ${Math.round(Number(item.avg_business_score || 0))}</p>
        </div>
    </td>
    <td class="text-on-surface-variant">${timeAgo(item.created_at)}</td>
    <td class="text-right">
        <button class="btn-preview-keyword w-8 h-8 inline-flex items-center justify-center rounded-md hover:bg-blue-50 transition-colors" title="预览词包" data-id="${item.id}">
            <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">preview</span>
        </button>
    </td>
</tr>`;
            }).join('');

            renderPaginationControls(
                document.getElementById('keyword-pagination'),
                data.page || 1,
                data.pages || 1,
                (page) => {
                    keywordPage = page;
                    loadKeywordPacks();
                }
            );

            if (selectedKeywordPackId && items.some(item => item.id === selectedKeywordPackId)) {
                tbody.querySelector(`tr[data-keyword-pack-id="${selectedKeywordPackId}"]`)?.classList.add('is-selected');
            }
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-12 text-red-500 text-sm">${escapeHtml(err.message)}</td></tr>`;
            renderKeywordPackDetail(null);
        }
    }

    async function initKeywords() {
        renderTopbar('拓词管理');
        const searchInput = document.getElementById('keyword-search');
        const sourceFilter = document.getElementById('keyword-source-filter');
        const refreshBtn = document.getElementById('keyword-refresh');
        const tbody = document.getElementById('keyword-packs-tbody');
        const detailPanel = document.getElementById('keyword-pack-detail');

        let searchTimer;
        searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                keywordFilters.search = searchInput.value.trim();
                keywordPage = 1;
                loadKeywordPacks();
            }, 300);
        });

        sourceFilter?.addEventListener('change', () => {
            keywordFilters.sourceType = sourceFilter.value;
            keywordPage = 1;
            loadKeywordPacks();
        });

        refreshBtn?.addEventListener('click', async () => {
            await Promise.all([loadKeywordSummary(), loadKeywordPacks()]);
        });

        tbody?.addEventListener('click', (event) => {
            const previewBtn = event.target.closest('.btn-preview-keyword');
            if (!previewBtn) return;
            event.preventDefault();
            event.stopPropagation();
            selectedKeywordPackId = previewBtn.dataset.id;
            tbody.querySelectorAll('tr').forEach(item => item.classList.remove('is-selected'));
            const row = previewBtn.closest('tr[data-keyword-pack-id]');
            row.classList.add('is-selected');
            loadKeywordPackDetail(selectedKeywordPackId);
        });

        detailPanel?.addEventListener('click', async (event) => {
            const action = event.target.closest('[data-keyword-action]');
            if (!action) return;
            const packId = action.dataset.id;
            if (action.dataset.keywordAction === 'export') {
                await downloadAuthenticatedFile(`/api/admin/keywords/packs/${packId}/export`, `keyword-pack-${packId}.csv`);
                return;
            }
            if (action.dataset.keywordAction === 'delete') {
                if (!await confirm('确认删除这个词包？删除后不可恢复。')) return;
                try {
                    await api('DELETE', `/api/admin/keywords/packs/${packId}`);
                    toast('词包已删除');
                    if (selectedKeywordPackId === packId) selectedKeywordPackId = null;
                    closeAdminPreviewDrawer();
                    await Promise.all([loadKeywordSummary(), loadKeywordPacks()]);
                } catch (err) {
                    toast(err.message, 'error');
                }
            }
        });

        await Promise.all([loadKeywordSummary(), loadKeywordPacks()]);
    }

    // ─── 公司管理页 ──────────────────────────────────────────────────────────
    let companyPage = 1;
    let selectedCompanyId = null;
    let companyFilters = { status: '', search: '', category: '', sort: '' };

    function getCompanyInitials(name) {
        return (name || '').replace(/[^A-Za-z\u4e00-\u9fa5]/g, '').slice(0, 2).toUpperCase() || 'CO';
    }

    function normalizeListItems(value) {
        if (!value) return [];
        if (Array.isArray(value)) {
            return value
                .map(item => {
                    if (item == null) return '';
                    if (typeof item === 'string' || typeof item === 'number') return String(item);
                    if (typeof item === 'object') {
                        if (item.name && item.role) return `${item.name} · ${item.role}`;
                        return item.name || item.title || item.label || item.role || JSON.stringify(item);
                    }
                    return String(item);
                })
                .filter(Boolean);
        }
        if (typeof value === 'object') {
            return Object.entries(value)
                .map(([key, itemValue]) => `${key}: ${Array.isArray(itemValue) ? itemValue.join(', ') : itemValue}`)
                .filter(Boolean);
        }
        return [String(value)];
    }

    function renderPillList(items, emptyLabel = '暂无数据') {
        if (!items.length) {
            return `<span class="text-sm text-slate-400">${emptyLabel}</span>`;
        }
        return `<div class="admin-pill-list">${items.map(item => `<span class="admin-pill">${escapeHtml(item)}</span>`).join('')}</div>`;
    }

    function renderMetaItem(label, value, valueClass = '') {
        return `
<div class="admin-detail-meta-item">
    <dt>${escapeHtml(label)}</dt>
    <dd class="${valueClass}">${value ? value : '<span class="text-slate-400">--</span>'}</dd>
</div>`;
    }

    function renderCompanyDetail(detail) {
        const detailPanel = document.getElementById('company-detail');
        const badgeEl = document.getElementById('company-detail-badge');
        if (!detailPanel || !badgeEl) return;

        badgeEl.innerHTML = PIPELINE_BADGE[detail.pipeline_status] || escapeHtml(detail.pipeline_status || 'unknown');

        const geoDetails = detail.geo_details && typeof detail.geo_details === 'object'
            ? Object.entries(detail.geo_details).slice(0, 4)
            : [];
        const latestDiagnostic = detail.latest_diagnostic;
        const relatedSolutions = Array.isArray(detail.related_solutions) ? detail.related_solutions : [];

        detailPanel.innerHTML = `
<div class="space-y-4">
    <section class="admin-detail-section p-5 space-y-3">
        <div class="flex items-start justify-between gap-4">
            <div>
                <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-lg font-bold text-slate-900">${escapeHtml(detail.name)}</h3>
                    ${detail.is_geo_certified ? '<span class="badge badge-info">GEO 认证</span>' : ''}
                    ${PUBLISH_BADGE[detail.publish_status] || ''}
                </div>
                <p class="text-sm text-slate-500 mt-2">${escapeHtml(detail.short_description || detail.description || '暂无简介')}</p>
            </div>
            <div class="w-12 h-12 rounded-2xl bg-slate-100 text-primary flex items-center justify-center text-sm font-extrabold flex-shrink-0">${escapeHtml(getCompanyInitials(detail.name))}</div>
        </div>
        <div class="admin-detail-actions">
            <a href="${buildPublicCompanyDetailHref(detail.id)}" target="_blank" rel="noreferrer" class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm">visibility</span>
                查看前台详情
            </a>
            <a href="${safeExternalHttpHref(detail.url)}" target="_blank" rel="noreferrer" class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm">open_in_new</span>
                打开官网
            </a>
            ${detail.publish_status === 'pending_review' ? `
            <button class="btn btn-primary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-company-detail-action="approve" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">check_circle</span>
                审核通过
            </button>
            <button class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-company-detail-action="reject" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">cancel</span>
                驳回
            </button>` : ''}
            ${detail.pipeline_status === 'failed' ? `
            <button class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-company-detail-action="retry" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">refresh</span>
                重试流水线
            </button>` : ''}
            <button class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5 text-red-500 hover:text-red-600" data-company-detail-action="delete" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">delete</span>
                删除公司
            </button>
        </div>
    </section>

    <section class="admin-detail-grid">
        <div class="admin-detail-metric">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">GEO 评分</div>
            <div class="mt-2 text-2xl font-extrabold text-slate-900">${detail.geo_score != null ? Number(detail.geo_score).toFixed(1) : '--'}</div>
        </div>
        <div class="admin-detail-metric">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">投票数</div>
            <div class="mt-2 text-2xl font-extrabold text-slate-900">${detail.upvotes ?? 0}</div>
        </div>
        <div class="admin-detail-metric">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">诊断报告</div>
            <div class="mt-2 text-2xl font-extrabold text-slate-900">${detail.diagnostic_report_count ?? 0}</div>
        </div>
        <div class="admin-detail-metric">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">最近诊断评分</div>
            <div class="mt-2 text-2xl font-extrabold text-slate-900">${latestDiagnostic?.overall_score != null ? Number(latestDiagnostic.overall_score).toFixed(1) : '--'}</div>
        </div>
    </section>

    <section class="admin-detail-section p-5">
        <h4 class="text-sm font-bold text-slate-900 mb-3">基础资料</h4>
        <dl class="admin-detail-meta">
            ${renderMetaItem('官网', `<a href="${safeExternalHttpHref(detail.url)}" target="_blank" rel="noreferrer" class="text-primary hover:underline break-all">${escapeHtml(detail.url)}</a>`)}
            ${renderMetaItem('分类', escapeHtml(detail.category || '--'))}
            ${renderMetaItem('总部', escapeHtml(detail.headquarters || '--'))}
            ${renderMetaItem('员工规模', escapeHtml(detail.employee_count || '--'))}
            ${renderMetaItem('融资阶段', escapeHtml(detail.funding_stage || '--'))}
            ${renderMetaItem('技术等级', escapeHtml(detail.tech_level || '--'))}
            ${renderMetaItem('成立时间', escapeHtml(detail.founded_date ? formatDate(detail.founded_date) : '--'))}
            ${renderMetaItem('提交者', detail.submitted_by_user ? `${escapeHtml(detail.submitted_by_user.username)} · ${escapeHtml(detail.submitted_by_user.email)}` : '系统导入')}
            ${renderMetaItem('创建时间', escapeHtml(formatDate(detail.created_at)))}
            ${renderMetaItem('最近更新', escapeHtml(timeAgo(detail.updated_at)))}
        </dl>
    </section>

    <section class="admin-detail-section p-5">
        <h4 class="text-sm font-bold text-slate-900 mb-3">流水线与存储</h4>
        <dl class="admin-detail-meta">
            ${renderMetaItem('入库状态', PIPELINE_BADGE[detail.pipeline_status] || escapeHtml(detail.pipeline_status))}
            ${renderMetaItem('发布状态', PUBLISH_BADGE[detail.publish_status] || escapeHtml(detail.publish_status))}
            ${renderMetaItem('错误信息', escapeHtml(detail.pipeline_error || '--'), detail.pipeline_error ? 'text-red-500' : '')}
            ${renderMetaItem('原始 HTML', escapeHtml(detail.raw_html_key || '--'))}
            ${renderMetaItem('About HTML', escapeHtml(detail.about_html_key || '--'))}
            ${renderMetaItem('截图数量', escapeHtml(String((detail.screenshots || []).length)))}
        </dl>
    </section>

    <section class="admin-detail-section p-5">
        <h4 class="text-sm font-bold text-slate-900 mb-3">标签与能力</h4>
        <div class="space-y-4">
            <div>
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">标签</div>
                ${renderPillList(normalizeListItems(detail.tags), '暂无标签')}
            </div>
            <div>
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">技术栈</div>
                ${renderPillList(normalizeListItems(detail.tech_stack), '暂无技术栈')}
            </div>
            <div>
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">团队成员</div>
                ${renderPillList(normalizeListItems(detail.team_members), '暂无团队信息')}
            </div>
        </div>
    </section>

    <section class="admin-detail-section p-5">
        <h4 class="text-sm font-bold text-slate-900 mb-3">GEO 评分拆解</h4>
        ${geoDetails.length ? `
        <div class="admin-detail-grid">
            ${geoDetails.map(([label, value]) => `
            <div class="admin-detail-metric">
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(label)}</div>
                <div class="mt-2 text-xl font-extrabold text-slate-900">${escapeHtml(value)}</div>
            </div>`).join('')}
        </div>` : '<p class="text-sm text-slate-400">当前没有更细的 GEO 评分拆解。</p>'}
    </section>

    <section class="admin-detail-section p-5">
        <h4 class="text-sm font-bold text-slate-900 mb-3">最近诊断</h4>
        ${latestDiagnostic ? `
        <div class="space-y-3">
            <div class="flex items-center gap-2 flex-wrap">
                ${latestDiagnostic.status ? (PIPELINE_BADGE[latestDiagnostic.status] || `<span class="badge badge-neutral">${escapeHtml(latestDiagnostic.status)}</span>`) : ''}
                ${latestDiagnostic.overall_score != null ? `<span class="badge badge-info">评分 ${escapeHtml(Number(latestDiagnostic.overall_score).toFixed(1))}</span>` : ''}
            </div>
            <p class="text-sm text-slate-600 break-all">${escapeHtml(latestDiagnostic.url)}</p>
            <p class="text-xs text-slate-400">生成于 ${escapeHtml(formatDate(latestDiagnostic.created_at))} · ${escapeHtml(timeAgo(latestDiagnostic.created_at))}</p>
            <a href="${withAppOrigin(`/admin/diagnostics?report=${latestDiagnostic.id}`)}" class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm">analytics</span>
                查看诊断详情
            </a>
        </div>` : '<p class="text-sm text-slate-400">该公司还没有关联诊断报告。</p>'}
    </section>

    <section class="admin-detail-section p-5">
        <div class="flex items-center justify-between gap-3 mb-3">
            <h4 class="text-sm font-bold text-slate-900">关联问答会话</h4>
            ${relatedSolutions.length ? `<span class="badge badge-info">${relatedSolutions.length} 条</span>` : ''}
        </div>
        ${relatedSolutions.length ? `
        <div class="space-y-3">
            ${relatedSolutions.map(item => `
            <a href="${withAppOrigin(`/admin/solutions?conversation=${item.id}`)}" class="block rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 hover:border-primary/25 hover:bg-white transition-colors">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <p class="text-sm font-semibold text-slate-900">${escapeHtml(item.title || '未命名问答会话')}</p>
                        <p class="mt-1 text-xs text-slate-500">${escapeHtml(item.username || item.user_email || '匿名用户')} · ${escapeHtml(timeAgo(item.updated_at))}</p>
                    </div>
                    <div class="flex items-center gap-1.5 flex-wrap justify-end">
                        ${(item.match_types || []).map(type => `<span class="badge badge-neutral">${escapeHtml(type === 'recommended_company' ? '命中关联' : '命中诊断')}</span>`).join('')}
                    </div>
                </div>
                ${item.latest_message_excerpt ? `<p class="mt-2 text-sm text-slate-600 line-clamp-2">${escapeHtml(item.latest_message_excerpt)}</p>` : ''}
            </a>`).join('')}
        </div>` : '<p class="text-sm text-slate-400">暂未发现引用该公司或关联诊断的问答会话。</p>'}
    </section>
</div>`;
    }

    async function loadCompanyDetail(companyId) {
        const detailPanel = document.getElementById('company-detail');
        const badgeEl = document.getElementById('company-detail-badge');
        if (!detailPanel || !badgeEl || !companyId) return;

        openAdminPreviewDrawer();
        setAdminSelectionParam('company', companyId);
        badgeEl.textContent = '加载中';
        badgeEl.className = 'badge badge-neutral';
        detailPanel.innerHTML = '<div class="admin-detail-section p-5 text-sm text-slate-400">正在加载公司详情...</div>';

        try {
            const detail = await api('GET', `/api/admin/companies/${companyId}`);
            renderCompanyDetail(detail);
        } catch (err) {
            badgeEl.textContent = '加载失败';
            badgeEl.className = 'badge badge-error';
            detailPanel.innerHTML = `<div class="admin-detail-section p-5 text-sm text-red-500">${escapeHtml(err.message)}</div>`;
        }
    }

    async function handleCompanyAction(action, companyId) {
        if (!companyId) return;

        try {
            if (action === 'approve') {
                if (!await confirm('确认审核通过并发布此公司？')) return;
                await api('POST', `/api/admin/companies/${companyId}/approve`);
                toast('已审核通过并发布');
            } else if (action === 'reject') {
                if (!await confirm('确认驳回此公司？')) return;
                await api('POST', `/api/admin/companies/${companyId}/reject`);
                toast('已驳回', 'warning');
            } else if (action === 'retry') {
                await api('POST', `/api/admin/companies/${companyId}/retry-pipeline`);
                toast('已重新触发流水线');
            } else if (action === 'delete') {
                if (!await confirm('确认删除这家公司？此操作会同时删除关联投票和诊断记录，且不可恢复。')) return;
                await api('DELETE', `/api/admin/companies/${companyId}`);
                if (selectedCompanyId === companyId) {
                    selectedCompanyId = null;
                    setAdminSelectionParam('company', '');
                }
                closeAdminPreviewDrawer();
                toast('公司已删除', 'warning');
            }

            await loadCompanies();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function fetchPinnedCompany(companyId) {
        if (!companyId) return null;
        try {
            const detail = await api('GET', `/api/admin/companies/${companyId}`);
            return {
                id: detail.id,
                name: detail.name,
                url: detail.url,
                short_description: detail.short_description,
                category: detail.category,
                is_geo_certified: detail.is_geo_certified,
                pipeline_status: detail.pipeline_status,
                pipeline_error: detail.pipeline_error,
                publish_status: detail.publish_status,
                geo_score: detail.geo_score,
                upvotes: detail.upvotes,
                created_at: detail.created_at,
                updated_at: detail.updated_at,
                __pinned: true,
            };
        } catch (_) {
            return null;
        }
    }

    async function loadCompanies() {
        const params = new URLSearchParams({ page: companyPage, size: 20 });
        if (companyFilters.status) params.set('publish_status', companyFilters.status);
        if (companyFilters.search) params.set('search', companyFilters.search);
        if (companyFilters.category) params.set('category', companyFilters.category);
        if (companyFilters.sort) params.set('sort', companyFilters.sort);

        const tbody = document.getElementById('companies-tbody');
        const paginationInfo = document.getElementById('companies-pagination-info');
        const paginationContainer = document.getElementById('companies-pagination');
        const detailPanel = document.getElementById('company-detail');
        const badgeEl = document.getElementById('company-detail-badge');
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400 text-sm">加载中...</td></tr>';

        try {
            const data = await api('GET', `/api/admin/companies?${params}`);
            let { items = [], total = 0, pages = 1 } = data;

            if (selectedCompanyId && !items.some(item => item.id === selectedCompanyId)) {
                const pinnedCompany = await fetchPinnedCompany(selectedCompanyId);
                if (pinnedCompany) {
                    items = [pinnedCompany, ...items];
                }
            }

            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400 text-sm">暂无符合条件的公司</td></tr>';
                if (paginationInfo) paginationInfo.textContent = '共 0 家公司';
                if (paginationContainer) paginationContainer.innerHTML = '';
                if (badgeEl) {
                    badgeEl.textContent = '未选择';
                    badgeEl.className = 'badge badge-neutral';
                }
                if (detailPanel) {
                    detailPanel.innerHTML = '<div class="admin-detail-section p-5 text-sm text-slate-400">当前筛选条件下没有公司记录。</div>';
                }
                selectedCompanyId = null;
                setAdminSelectionParam('company', '');
                return;
            }

            tbody.innerHTML = items.map(c => `
<tr data-id="${c.id}" class="${c.id === selectedCompanyId ? 'is-selected' : ''}">
    <td>
        <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-xs font-bold text-primary">${escapeHtml(getCompanyInitials(c.name))}</div>
            <div>
                <div class="flex items-center gap-2 flex-wrap">
                    <p class="font-semibold text-sm text-slate-900">${escapeHtml(c.name)}</p>
                    ${c.is_geo_certified ? '<span class="badge badge-info">认证</span>' : ''}
                    ${c.__pinned ? '<span class="badge badge-info">当前定位</span>' : ''}
                </div>
                <p class="text-xs text-on-surface-variant truncate max-w-[220px]">${escapeHtml(c.short_description || c.url)}</p>
            </div>
        </div>
    </td>
    <td><span class="tag text-[10px]">${escapeHtml(c.category || '--')}</span></td>
    <td>
        ${PIPELINE_BADGE[c.pipeline_status] || escapeHtml(c.pipeline_status)}
        ${c.pipeline_status === 'failed' && c.pipeline_error ? `<p class="text-[10px] text-red-500 mt-1 max-w-[170px] truncate" title="${escapeHtml(c.pipeline_error)}">${escapeHtml(c.pipeline_error)}</p>` : ''}
    </td>
    <td>${PUBLISH_BADGE[c.publish_status] || escapeHtml(c.publish_status)}</td>
    <td class="font-bold text-slate-900">${c.geo_score != null ? Number(c.geo_score).toFixed(1) : '--'}</td>
    <td class="text-on-surface-variant">${escapeHtml(timeAgo(c.updated_at || c.created_at))}</td>
    <td class="text-right">
        <div class="flex items-center justify-end gap-1">
            ${c.publish_status === 'pending_review' ? `
            <button class="btn-approve w-8 h-8 flex items-center justify-center rounded-md hover:bg-green-50 transition-colors" title="审核通过" data-id="${c.id}">
                <span class="material-symbols-outlined text-slate-400 hover:text-green-600 text-lg">check_circle</span>
            </button>
            <button class="btn-reject w-8 h-8 flex items-center justify-center rounded-md hover:bg-red-50 transition-colors" title="驳回" data-id="${c.id}">
                <span class="material-symbols-outlined text-slate-400 hover:text-red-500 text-lg">cancel</span>
            </button>` : ''}
            ${c.pipeline_status === 'failed' ? `
            <button class="btn-retry w-8 h-8 flex items-center justify-center rounded-md hover:bg-orange-50 transition-colors" title="重试流水线" data-id="${c.id}">
                <span class="material-symbols-outlined text-slate-400 hover:text-orange-500 text-lg">refresh</span>
            </button>` : ''}
            <button class="btn-delete w-8 h-8 flex items-center justify-center rounded-md hover:bg-red-50 transition-colors" title="删除公司" data-id="${c.id}">
                <span class="material-symbols-outlined text-slate-400 hover:text-red-500 text-lg">delete</span>
            </button>
            <button class="btn-preview-company w-8 h-8 flex items-center justify-center rounded-md hover:bg-blue-50 transition-colors" title="预览公司详情" data-id="${c.id}">
                <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">preview</span>
            </button>
            <a href="${buildPublicCompanyDetailHref(c.id)}" target="_blank" rel="noreferrer" class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-50 transition-colors" title="查看前台详情">
                <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">open_in_new</span>
            </a>
        </div>
    </td>
</tr>`).join('');

            if (paginationInfo) paginationInfo.textContent = `共 ${total} 家公司`;
            renderPaginationControls(paginationContainer, companyPage, pages, (p) => {
                companyPage = p;
                loadCompanies();
            });

            Array.from(tbody.querySelectorAll('tr[data-id]')).forEach(row => {
                row.classList.toggle('is-selected', row.dataset.id === selectedCompanyId);
            });
            if (selectedCompanyId && items.some(item => item.id === selectedCompanyId)) {
                await loadCompanyDetail(selectedCompanyId);
            }
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-red-500 text-sm">${escapeHtml(err.message)}</td></tr>`;
            if (badgeEl) {
                badgeEl.textContent = '加载失败';
                badgeEl.className = 'badge badge-error';
            }
            if (detailPanel) {
                detailPanel.innerHTML = `<div class="admin-detail-section p-5 text-sm text-red-500">${escapeHtml(err.message)}</div>`;
            }
        }
    }

    async function initCompanies() {
        renderTopbar('公司管理');
        selectedCompanyId = getAdminSelectionParam('company') || selectedCompanyId;

        try {
            const stats = await api('GET', '/api/admin/dashboard');
            const ps = stats.pipeline_stats || {};
            const pipelineMap = {
                'companies-pipeline-crawling': ps.crawling || 0,
                'companies-pipeline-cleaning': ps.cleaning || 0,
                'companies-pipeline-graph': ps.graph_building || 0,
                'companies-pipeline-vectorizing': ps.vectorizing || 0,
                'companies-pipeline-review': ps.pending_review || 0,
            };
            Object.entries(pipelineMap).forEach(([id, value]) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value;
            });
        } catch (_) {}

        const statusSelect = document.getElementById('companies-status-filter');
        const categorySelect = document.getElementById('companies-category-filter');
        const sortSelect = document.getElementById('companies-sort-filter');
        const searchInput = document.getElementById('companies-search');
        const refreshButton = document.getElementById('companies-refresh');
        const tbody = document.getElementById('companies-tbody');
        const detailPanel = document.getElementById('company-detail');

        if (statusSelect) {
            statusSelect.innerHTML = `
<option value="">全部状态</option>
<option value="published">已发布</option>
<option value="pending_review">待审核</option>
<option value="draft">草稿</option>
<option value="archived">已下架</option>`;
            statusSelect.addEventListener('change', () => {
                companyFilters.status = statusSelect.value;
                companyPage = 1;
                loadCompanies();
            });
        }

        if (categorySelect) {
            categorySelect.innerHTML = `
<option value="">全部分类</option>
<option value="GEO工具">GEO工具</option>
<option value="AI搜索">AI搜索</option>
<option value="GEO咨询">GEO咨询</option>
<option value="知识图谱">知识图谱</option>
<option value="AI写作">AI写作</option>
<option value="其他">其他</option>`;
            categorySelect.addEventListener('change', () => {
                companyFilters.category = categorySelect.value;
                companyPage = 1;
                loadCompanies();
            });
        }

        if (sortSelect) {
            sortSelect.innerHTML = `
<option value="">待审核优先</option>
<option value="created_at">最新添加</option>
<option value="geo_score">GEO 评分排序</option>
<option value="upvotes">投票最多</option>`;
            sortSelect.addEventListener('change', () => {
                companyFilters.sort = sortSelect.value;
                companyPage = 1;
                loadCompanies();
            });
        }

        let searchTimer;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    companyFilters.search = searchInput.value.trim();
                    companyPage = 1;
                    loadCompanies();
                }, 400);
            });
        }

        refreshButton?.addEventListener('click', () => loadCompanies());

        tbody?.addEventListener('click', async (e) => {
            const approveBtn = e.target.closest('.btn-approve');
            const rejectBtn = e.target.closest('.btn-reject');
            const retryBtn = e.target.closest('.btn-retry');
            const deleteBtn = e.target.closest('.btn-delete');
            const previewBtn = e.target.closest('.btn-preview-company');
            const row = e.target.closest('tr[data-id]');

            if (approveBtn) {
                e.preventDefault();
                e.stopPropagation();
                await handleCompanyAction('approve', approveBtn.dataset.id);
                return;
            }
            if (rejectBtn) {
                e.preventDefault();
                e.stopPropagation();
                await handleCompanyAction('reject', rejectBtn.dataset.id);
                return;
            }
            if (retryBtn) {
                e.preventDefault();
                e.stopPropagation();
                await handleCompanyAction('retry', retryBtn.dataset.id);
                return;
            }
            if (deleteBtn) {
                e.preventDefault();
                e.stopPropagation();
                await handleCompanyAction('delete', deleteBtn.dataset.id);
                return;
            }
            if (!previewBtn) return;
            e.preventDefault();
            e.stopPropagation();
            selectedCompanyId = previewBtn.dataset.id;
            Array.from(tbody.querySelectorAll('tr[data-id]')).forEach(item => {
                item.classList.toggle('is-selected', item.dataset.id === selectedCompanyId);
            });
            await loadCompanyDetail(selectedCompanyId);
        });

        detailPanel?.addEventListener('click', async (e) => {
            const actionBtn = e.target.closest('[data-company-detail-action]');
            if (!actionBtn) return;
            await handleCompanyAction(actionBtn.dataset.companyDetailAction, actionBtn.dataset.id);
        });

        await loadCompanies();
    }

    // ─── 分页渲染辅助 ────────────────────────────────────────────────────────
    function renderPagination(current, total, onChange) {
        const container = document.querySelector('.flex.items-center.gap-1:last-child');
        if (!container || total <= 1) return;

        const pages = [];
        if (total <= 7) {
            for (let i = 1; i <= total; i++) pages.push(i);
        } else {
            pages.push(1);
            if (current > 3) pages.push('…');
            for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
            if (current < total - 2) pages.push('…');
            pages.push(total);
        }

        container.innerHTML = `
<button class="w-8 h-8 rounded-md flex items-center justify-center hover:bg-slate-100 text-slate-400 ${current === 1 ? 'opacity-30 cursor-not-allowed' : ''}" data-page="${current - 1}">
    <span class="material-symbols-outlined text-lg">chevron_left</span>
</button>
${pages.map(p => p === '…'
    ? `<span class="text-slate-400 px-1">…</span>`
    : `<button class="w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold ${p === current ? 'bg-primary text-white' : 'hover:bg-slate-100'}" data-page="${p}">${p}</button>`
).join('')}
<button class="w-8 h-8 rounded-md flex items-center justify-center hover:bg-slate-100 text-slate-400 ${current === total ? 'opacity-30 cursor-not-allowed' : ''}" data-page="${current + 1}">
    <span class="material-symbols-outlined text-lg">chevron_right</span>
</button>`;

        container.onclick = (e) => {
            const btn = e.target.closest('[data-page]');
            if (!btn) return;
            const p = parseInt(btn.dataset.page, 10);
            if (Number.isNaN(p) || p < 1 || p > total || p === current) return;
            onChange(p);
        };
    }

    function renderPaginationControls(container, current, total, onChange) {
        if (!container) return;
        container.innerHTML = '';
        if (total <= 1) return;

        const pages = [];
        if (total <= 7) {
            for (let i = 1; i <= total; i++) pages.push(i);
        } else {
            pages.push(1);
            if (current > 3) pages.push('…');
            for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
            if (current < total - 2) pages.push('…');
            pages.push(total);
        }

        container.innerHTML = `
<button class="w-8 h-8 rounded-md flex items-center justify-center hover:bg-slate-100 text-slate-400 ${current === 1 ? 'opacity-30 cursor-not-allowed' : ''}" data-page="${current - 1}">
    <span class="material-symbols-outlined text-lg">chevron_left</span>
</button>
${pages.map(p => p === '…'
    ? `<span class="text-slate-400 px-1">…</span>`
    : `<button class="w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold ${p === current ? 'bg-primary text-white' : 'hover:bg-slate-100'}" data-page="${p}">${p}</button>`
).join('')}
<button class="w-8 h-8 rounded-md flex items-center justify-center hover:bg-slate-100 text-slate-400 ${current === total ? 'opacity-30 cursor-not-allowed' : ''}" data-page="${current + 1}">
    <span class="material-symbols-outlined text-lg">chevron_right</span>
</button>`;

        container.onclick = (e) => {
            const btn = e.target.closest('[data-page]');
            if (!btn) return;
            const p = parseInt(btn.dataset.page, 10);
            if (Number.isNaN(p) || p < 1 || p > total || p === current) return;
            onChange(p);
        };
    }

    // ─── 内容管理页 ──────────────────────────────────────────────────────────
    let contentPage = 1;
    let selectedContentId = null;
    let contentFilters = { type: 'tutorial', status: '', search: '' };

    const CONTENT_STATUS_BADGE = {
        published: '<span class="badge badge-success">已发布</span>',
        draft: '<span class="badge badge-neutral">草稿</span>',
        archived: '<span class="badge badge-neutral">已下架</span>',
    };

    function renderContentDetail(detail) {
        const container = document.getElementById('content-detail');
        const badge = document.getElementById('content-detail-badge');
        if (!container || !badge) return;

        if (!detail) {
            setAdminSelectionParam('content', '');
            badge.textContent = '未选中';
            container.innerHTML = `
<div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-6 text-sm text-slate-400">
    点击列表中的预览按钮，查看标签、阅读信息与渲染后的预览内容。
</div>`;
            return;
        }

        badge.textContent = CONTENT_TYPE_LABEL[detail.content_type] || detail.content_type || '详情';
        const statusBadge = CONTENT_STATUS_BADGE[detail.status] || escapeHtml(detail.status || '--');
        const tags = Array.isArray(detail.tags) ? detail.tags : [];
        const previewHtml = sanitizeAdminPreviewHtml(detail.html_body);

        container.innerHTML = `
<div class="space-y-4">
    <div class="admin-detail-section p-4">
        <div class="flex items-start justify-between gap-3">
            <div>
                <p class="text-lg font-bold font-headline">${escapeHtml(detail.title || '未命名教程')}</p>
                <div class="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                    <span>Slug：${escapeHtml(detail.slug || '--')}</span>
                    <span>短码：${escapeHtml(detail.path_key || '--')}</span>
                    <span>${CONTENT_TYPE_LABEL[detail.content_type] || escapeHtml(detail.content_type || '--')}</span>
                    <span>${detail.reading_time_minutes ? `${detail.reading_time_minutes} 分钟阅读` : '阅读时间待估算'}</span>
                </div>
            </div>
            ${statusBadge}
        </div>
        <div class="admin-detail-actions mt-4">
            ${detail.status === 'published' && (detail.path_key || detail.slug) ? `
            <a href="${buildPublicTutorialDetailHref(detail.path_key, detail.slug)}" target="_blank" rel="noreferrer" class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm">open_in_new</span>
                前台查看
            </a>` : ''}
            <a href="${withAppOrigin(`/admin/tutorials-edit?id=${detail.id}`)}" class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm">edit</span>
                编辑内容
            </a>
            ${detail.status !== 'published' ? `
            <button class="btn btn-primary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-content-action="publish" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">publish</span>
                直接发布
            </button>` : ''}
            <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-content-action="delete" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">delete</span>
                删除
            </button>
        </div>
    </div>
    <div class="admin-detail-grid">
        <div class="admin-detail-metric">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">浏览量</p>
            <p class="mt-2 text-lg font-bold">${Number(detail.view_count || 0).toLocaleString()}</p>
        </div>
        <div class="admin-detail-metric">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">创建时间</p>
            <p class="mt-2 text-lg font-bold">${escapeHtml(formatDate(detail.created_at))}</p>
        </div>
    </div>
    <dl class="admin-detail-meta">
        ${renderMetaItem('最近更新', escapeHtml(timeAgo(detail.updated_at || detail.created_at)))}
        ${renderMetaItem('标签', tags.length ? `<div class="admin-pill-list">${tags.map(tag => `<span class="admin-pill">${escapeHtml(tag)}</span>`).join('')}</div>` : '--')}
    </dl>
    <div class="space-y-2">
        <div class="flex items-center justify-between">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-widest">渲染预览</p>
            <span class="text-[11px] text-slate-400">管理员预览</span>
        </div>
        <div class="admin-content-preview">${previewHtml}</div>
    </div>
</div>`;
    }

    async function loadContentDetail(contentId) {
        selectedContentId = contentId;
        document.querySelectorAll('#content-tbody tr[data-id]').forEach(row => {
            row.classList.toggle('is-selected', row.dataset.id === contentId);
        });
        setAdminSelectionParam('content', contentId);
        openAdminPreviewDrawer();

        try {
            const detail = await api('GET', `/api/admin/tutorials/${contentId}`);
            renderContentDetail(detail);
        } catch (err) {
            toast('加载内容详情失败: ' + err.message, 'error');
        }
    }

    async function publishContent(contentId) {
        if (!contentId) return;
        if (!await confirm('确认发布此内容？')) return;
        try {
            await api('POST', `/api/admin/tutorials/${contentId}/publish`);
            toast('内容已发布');
            await loadContents();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function deleteContent(contentId) {
        if (!contentId) return;
        if (!await confirm('确认删除此文章？此操作不可恢复。')) return;
        try {
            await api('DELETE', `/api/admin/tutorials/${contentId}`);
            toast('文章已删除', 'warning');
            selectedContentId = null;
            closeAdminPreviewDrawer();
            await loadContents();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function loadContents() {
        const params = new URLSearchParams({ page: String(contentPage), size: '20' });
        if (contentFilters.type) params.set('content_type', contentFilters.type);
        if (contentFilters.status) params.set('status_filter', contentFilters.status);
        if (contentFilters.search) params.set('search', contentFilters.search);

        const tbody = document.getElementById('content-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400 text-sm">加载中...</td></tr>';

        try {
            const data = await api('GET', `/api/admin/tutorials?${params.toString()}`);
            const { items = [], total = 0, pages = 1, summary = {} } = data;

            const totalEl = document.getElementById('content-stat-total');
            const publishedEl = document.getElementById('content-stat-published');
            const draftEl = document.getElementById('content-stat-draft');
            const viewsEl = document.getElementById('content-stat-views');
            const infoEl = document.getElementById('content-pagination-info');

            if (totalEl) totalEl.textContent = Number(summary.tutorial_total || 0).toLocaleString();
            if (publishedEl) publishedEl.textContent = Number(summary.tutorial_published || 0).toLocaleString();
            if (draftEl) draftEl.textContent = Number(summary.draft_assets || 0).toLocaleString();
            if (viewsEl) viewsEl.textContent = Number(summary.total_views || 0).toLocaleString();
            if (infoEl) infoEl.textContent = `共 ${total} 篇内容`;

            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400 text-sm">当前筛选下暂无内容，调整筛选条件或新建教程后再查看</td></tr>';
                renderPaginationControls(document.getElementById('content-pagination'), 1, 1, () => {});
                renderContentDetail(null);
                return;
            }

            tbody.innerHTML = items.map(c => {
                const typeLabel = CONTENT_TYPE_LABEL[c.content_type] || c.content_type;
                const statusBadge = CONTENT_STATUS_BADGE[c.status] || escapeHtml(c.status || '--');
                const tags = Array.isArray(c.tags) ? c.tags : [];
                return `
<tr data-id="${c.id}">
    <td>
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                <span class="material-symbols-outlined text-primary text-base">article</span>
            </div>
            <div class="min-w-0">
                <p class="font-semibold text-sm truncate max-w-[280px]">${escapeHtml(c.title)}</p>
                <p class="text-xs text-on-surface-variant truncate max-w-[300px]">${escapeHtml(c.slug || tags.join(', ') || '--')}</p>
            </div>
        </div>
    </td>
    <td><span class="badge badge-info">${escapeHtml(typeLabel)}</span></td>
    <td>${statusBadge}</td>
    <td class="text-on-surface-variant">${c.reading_time_minutes ? `${c.reading_time_minutes} 分钟` : '--'}</td>
    <td class="font-medium">${Number(c.view_count || 0).toLocaleString()}</td>
    <td class="text-on-surface-variant">${escapeHtml(timeAgo(c.updated_at || c.created_at))}</td>
    <td class="text-right">
        <div class="flex items-center justify-end gap-1">
            ${c.status === 'published' && (c.path_key || c.slug) ? `
            <a href="${buildPublicTutorialDetailHref(c.path_key, c.slug)}" target="_blank" rel="noreferrer" class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-50 transition-colors" title="查看前台详情" data-content-link="frontend">
                <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">open_in_new</span>
            </a>` : ''}
            <button class="btn-preview-content w-8 h-8 flex items-center justify-center rounded-md hover:bg-blue-50 transition-colors" data-id="${c.id}" title="预览内容">
                <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">preview</span>
            </button>
            <a href="${withAppOrigin(`/admin/tutorials-edit?id=${c.id}`)}" class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-blue-50 transition-colors" title="编辑" data-content-link="edit">
                <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">edit</span>
            </a>
            ${c.status !== 'published' ? `
            <button class="btn-publish-content w-8 h-8 flex items-center justify-center rounded-md hover:bg-green-50 transition-colors" data-id="${c.id}" title="发布">
                <span class="material-symbols-outlined text-slate-400 hover:text-green-600 text-lg">publish</span>
            </button>` : ''}
            <button class="btn-delete-content w-8 h-8 flex items-center justify-center rounded-md hover:bg-red-50 transition-colors" data-id="${c.id}" title="删除">
                <span class="material-symbols-outlined text-slate-400 hover:text-red-500 text-lg">delete</span>
            </button>
        </div>
    </td>
</tr>`;
            }).join('');

            tbody.onclick = async (e) => {
                const pubBtn = e.target.closest('.btn-publish-content');
                if (pubBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    await publishContent(pubBtn.dataset.id);
                    return;
                }

                const delBtn = e.target.closest('.btn-delete-content');
                if (delBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    await deleteContent(delBtn.dataset.id);
                    return;
                }

                const previewBtn = e.target.closest('.btn-preview-content');
                if (!previewBtn) return;
                e.preventDefault();
                e.stopPropagation();
                await loadContentDetail(previewBtn.dataset.id);
            };

            renderPaginationControls(
                document.getElementById('content-pagination'),
                data.page || 1,
                data.pages || 1,
                (page) => {
                    contentPage = page;
                    loadContents();
                }
            );

            if (selectedContentId) {
                if (items.some(item => item.id === selectedContentId)) {
                    document.querySelector(`#content-tbody tr[data-id="${selectedContentId}"]`)?.classList.add('is-selected');
                }
                await loadContentDetail(selectedContentId);
            }
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-red-500 text-sm">${escapeHtml(err.message)}</td></tr>`;
            renderContentDetail(null);
        }
    }

    async function initContent() {
        renderTopbar('教程管理');
        selectedContentId = getAdminSelectionParam('content') || selectedContentId;
        const searchInput = document.getElementById('content-search');
        const statusFilter = document.getElementById('content-status-filter');
        const refreshBtn = document.getElementById('content-refresh');
        const detailPanel = document.getElementById('content-detail');

        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => {
                    b.className = 'tab-btn px-3 py-1.5 rounded-md text-sm font-medium text-on-surface-variant hover:bg-white transition-colors';
                });
                btn.className = 'tab-btn px-3 py-1.5 rounded-md text-sm font-semibold bg-white shadow-sm text-on-surface';
                contentFilters.type = btn.dataset.type || '';
                contentPage = 1;
                loadContents();
            });
        });

        let searchTimer;
        searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                contentFilters.search = searchInput.value.trim();
                contentPage = 1;
                loadContents();
            }, 300);
        });

        statusFilter?.addEventListener('change', () => {
            contentFilters.status = statusFilter.value;
            contentPage = 1;
            loadContents();
        });

        refreshBtn?.addEventListener('click', () => loadContents());
        detailPanel?.addEventListener('click', async (e) => {
            const publishBtn = e.target.closest('[data-content-action="publish"]');
            if (publishBtn) {
                await publishContent(publishBtn.dataset.id);
                return;
            }
            const deleteBtn = e.target.closest('[data-content-action="delete"]');
            if (deleteBtn) {
                await deleteContent(deleteBtn.dataset.id);
            }
        });

        await loadContents();
    }

    // ─── 专家管理页 ──────────────────────────────────────────────────────────
    let expertPage = 1;
    let selectedExpertId = null;
    let editingExpertId = null;
    let expertFilters = { category: '', status: '', search: '' };

    const EXPERT_CATEGORY_LABEL = {
        strategy: '策略',
        technical: '技术',
        content: '内容',
        reputation: '品牌治理',
        industry: '行业',
    };

    function splitExpertList(value) {
        return String(value || '')
            .split(/[\n,，、;；]+/)
            .map(item => item.trim())
            .filter(Boolean);
    }

    function getExpertInitials(name, initials) {
        const explicit = String(initials || '').trim();
        if (explicit) return explicit.slice(0, 4).toUpperCase();
        return String(name || '')
            .replace(/[^A-Za-z\u4e00-\u9fa5]/g, '')
            .slice(0, 2)
            .toUpperCase() || 'EX';
    }

    function expertStatusBadge(expert) {
        return expert?.is_published
            ? '<span class="badge badge-success">已发布</span>'
            : '<span class="badge badge-neutral">草稿</span>';
    }

    function setExpertEditorOpen(isOpen) {
        const modal = document.getElementById('expert-editor-modal');
        if (!modal) return;
        modal.classList.toggle('hidden', !isOpen);
        modal.classList.toggle('flex', isOpen);
        document.body.classList.toggle('overflow-hidden', isOpen);
    }

    function resetExpertEditorForm() {
        editingExpertId = null;
        const title = document.getElementById('expert-editor-title');
        if (title) title.textContent = '新建专家';
        [
            'expert-display-name',
            'expert-avatar-initials',
            'expert-title',
            'expert-specialty-label',
            'expert-summary',
            'expert-expertise',
            'expert-consultation',
            'expert-keywords',
        ].forEach(id => {
            const input = document.getElementById(id);
            if (input) input.value = '';
        });
        const category = document.getElementById('expert-category');
        const sortOrder = document.getElementById('expert-sort-order');
        const featured = document.getElementById('expert-is-featured');
        const published = document.getElementById('expert-is-published');
        if (category) category.value = 'strategy';
        if (sortOrder) sortOrder.value = '100';
        if (featured) featured.checked = true;
        if (published) published.checked = false;
    }

    function fillExpertEditor(expert) {
        editingExpertId = expert?.id || null;
        const setValue = (id, value) => {
            const input = document.getElementById(id);
            if (input) input.value = value ?? '';
        };
        const title = document.getElementById('expert-editor-title');
        if (title) title.textContent = editingExpertId ? '编辑专家' : '新建专家';
        setValue('expert-display-name', expert?.display_name || '');
        setValue('expert-avatar-initials', expert?.avatar_initials || '');
        setValue('expert-title', expert?.title || '');
        setValue('expert-specialty-label', expert?.specialty_label || EXPERT_CATEGORY_LABEL[expert?.category] || '');
        setValue('expert-summary', expert?.summary || '');
        setValue('expert-expertise', Array.isArray(expert?.expertise) ? expert.expertise.join('\n') : '');
        setValue('expert-consultation', expert?.consultation || '');
        setValue('expert-keywords', Array.isArray(expert?.keywords) ? expert.keywords.join(', ') : '');
        setValue('expert-sort-order', String(expert?.sort_order ?? 100));
        const category = document.getElementById('expert-category');
        const featured = document.getElementById('expert-is-featured');
        const published = document.getElementById('expert-is-published');
        if (category) category.value = expert?.category || 'strategy';
        if (featured) featured.checked = expert?.is_featured !== false;
        if (published) published.checked = !!expert?.is_published;
    }

    function getExpertEditorPayload() {
        const displayName = document.getElementById('expert-display-name')?.value?.trim() || '';
        const category = document.getElementById('expert-category')?.value || 'strategy';
        const specialtyLabel = document.getElementById('expert-specialty-label')?.value?.trim()
            || EXPERT_CATEGORY_LABEL[category]
            || '专家';
        return {
            display_name: displayName,
            avatar_initials: getExpertInitials(displayName, document.getElementById('expert-avatar-initials')?.value),
            title: document.getElementById('expert-title')?.value?.trim() || '',
            category,
            specialty_label: specialtyLabel,
            summary: document.getElementById('expert-summary')?.value?.trim() || '',
            expertise: splitExpertList(document.getElementById('expert-expertise')?.value),
            consultation: document.getElementById('expert-consultation')?.value?.trim() || '',
            keywords: splitExpertList(document.getElementById('expert-keywords')?.value),
            sort_order: Number.parseInt(document.getElementById('expert-sort-order')?.value || '100', 10) || 100,
            is_featured: !!document.getElementById('expert-is-featured')?.checked,
            is_published: !!document.getElementById('expert-is-published')?.checked,
        };
    }

    async function openExpertEditor(expertId = null) {
        resetExpertEditorForm();
        if (!expertId) {
            setExpertEditorOpen(true);
            document.getElementById('expert-display-name')?.focus?.();
            return;
        }

        try {
            const detail = await api('GET', `/api/admin/experts/${expertId}`);
            fillExpertEditor(detail);
            setExpertEditorOpen(true);
            document.getElementById('expert-display-name')?.focus?.();
        } catch (err) {
            setExpertEditorOpen(false);
            toast('加载专家失败: ' + err.message, 'error');
        }
    }

    function closeExpertEditor() {
        setExpertEditorOpen(false);
        resetExpertEditorForm();
    }

    function renderExpertDetail(detail) {
        const container = document.getElementById('expert-detail');
        const badge = document.getElementById('expert-detail-badge');
        if (!container || !badge) return;

        if (!detail) {
            setAdminSelectionParam('expert', '');
            badge.textContent = '未选择';
            container.innerHTML = '<div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-5 text-sm text-slate-400">点击列表中的预览按钮，查看专家画像、专长和咨询场景。</div>';
            return;
        }

        const expertise = Array.isArray(detail.expertise) ? detail.expertise : [];
        const keywords = Array.isArray(detail.keywords) ? detail.keywords : [];
        const categoryLabel = EXPERT_CATEGORY_LABEL[detail.category] || detail.specialty_label || detail.category || '--';
        badge.textContent = categoryLabel;
        container.innerHTML = `
<div class="space-y-4">
    <div class="admin-detail-section p-5">
        <div class="flex items-start gap-4">
            <div class="w-12 h-12 rounded-xl bg-blue-50 text-primary flex items-center justify-center text-sm font-extrabold flex-shrink-0">
                ${escapeHtml(getExpertInitials(detail.display_name, detail.avatar_initials))}
            </div>
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                    <h3 class="text-lg font-extrabold font-headline">${escapeHtml(detail.display_name || '未命名专家')}</h3>
                    ${expertStatusBadge(detail)}
                    ${detail.is_featured ? '<span class="badge badge-info">频道推荐</span>' : ''}
                </div>
                <p class="text-sm font-semibold text-slate-700 mt-1">${escapeHtml(detail.title || '--')}</p>
                <p class="text-sm text-slate-500 leading-6 mt-3">${escapeHtml(detail.summary || '暂无介绍')}</p>
            </div>
        </div>
        <div class="admin-detail-actions mt-5">
            <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-expert-action="edit" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">edit</span>
                编辑
            </button>
            <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-expert-action="delete" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">delete</span>
                删除
            </button>
        </div>
    </div>
    <dl class="admin-detail-meta">
        ${renderMetaItem('方向', escapeHtml(categoryLabel))}
        ${renderMetaItem('排序', escapeHtml(String(detail.sort_order ?? 100)))}
        ${renderMetaItem('创建时间', escapeHtml(formatDate(detail.created_at)))}
        ${renderMetaItem('最近更新', escapeHtml(timeAgo(detail.updated_at || detail.created_at)))}
        ${renderMetaItem('专长', expertise.length ? `<div class="admin-pill-list">${expertise.map(item => `<span class="admin-pill">${escapeHtml(item)}</span>`).join('')}</div>` : '--')}
        ${renderMetaItem('搜索关键词', keywords.length ? `<div class="admin-pill-list">${keywords.map(item => `<span class="admin-pill">${escapeHtml(item)}</span>`).join('')}</div>` : '--')}
    </dl>
    <div class="admin-detail-section p-5">
        <p class="text-xs font-bold text-slate-500 uppercase tracking-widest">适合咨询</p>
        <p class="text-sm text-slate-600 leading-7 mt-3">${escapeHtml(detail.consultation || '暂无咨询场景说明')}</p>
    </div>
</div>`;
    }

    async function loadExpertDetail(expertId) {
        if (!expertId) return;
        selectedExpertId = expertId;
        document.querySelectorAll('#experts-tbody tr[data-id]').forEach(row => {
            row.classList.toggle('is-selected', row.dataset.id === expertId);
        });
        setAdminSelectionParam('expert', expertId);
        openAdminPreviewDrawer();
        const container = document.getElementById('expert-detail');
        if (container) container.innerHTML = '<div class="admin-detail-section p-5 text-sm text-slate-400">正在加载专家详情...</div>';

        try {
            const detail = await api('GET', `/api/admin/experts/${expertId}`);
            renderExpertDetail(detail);
        } catch (err) {
            if (container) container.innerHTML = `<div class="admin-detail-section p-5 text-sm text-red-500">${escapeHtml(err.message)}</div>`;
        }
    }

    async function deleteExpert(expertId) {
        if (!expertId) return;
        if (!await confirm('确认删除这位专家？删除后前台专家频道也会移除该画像。')) return;
        try {
            await api('DELETE', `/api/admin/experts/${expertId}`);
            toast('专家已删除', 'warning');
            if (selectedExpertId === expertId) {
                selectedExpertId = null;
                closeAdminPreviewDrawer();
            }
            await loadExperts();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function loadExperts() {
        const tbody = document.getElementById('experts-tbody');
        if (!tbody) return;

        const params = new URLSearchParams({ page: String(expertPage), size: '20' });
        if (expertFilters.category) params.set('category', expertFilters.category);
        if (expertFilters.status) params.set('status_filter', expertFilters.status);
        if (expertFilters.search) params.set('search', expertFilters.search);
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400 text-sm">加载中...</td></tr>';

        try {
            const data = await api('GET', `/api/admin/experts?${params.toString()}`);
            const { items = [], total = 0, summary = {} } = data;
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value;
            };
            setValue('expert-stat-total', Number(summary.total || 0).toLocaleString());
            setValue('expert-stat-published', Number(summary.published || 0).toLocaleString());
            setValue('expert-stat-draft', Number(summary.draft || 0).toLocaleString());
            setValue('expert-stat-featured', Number(summary.featured || 0).toLocaleString());
            const infoEl = document.getElementById('expert-pagination-info');
            if (infoEl) infoEl.textContent = `共 ${Number(total || 0).toLocaleString()} 位专家`;

            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400 text-sm">当前筛选下暂无专家，点击右上角新建一个专家画像。</td></tr>';
                renderPaginationControls(document.getElementById('expert-pagination'), 1, 1, () => {});
                renderExpertDetail(null);
                return;
            }

            tbody.innerHTML = items.map(expert => {
                const categoryLabel = EXPERT_CATEGORY_LABEL[expert.category] || expert.specialty_label || expert.category || '--';
                const expertise = Array.isArray(expert.expertise) ? expert.expertise.slice(0, 3) : [];
                const isSelected = selectedExpertId === expert.id;
                return `
<tr data-id="${expert.id}" class="${isSelected ? 'is-selected' : ''}">
    <td>
        <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-blue-50 text-primary flex items-center justify-center flex-shrink-0 text-xs font-extrabold">
                ${escapeHtml(getExpertInitials(expert.display_name, expert.avatar_initials))}
            </div>
            <div class="min-w-0">
                <p class="font-semibold text-sm truncate max-w-[280px]">${escapeHtml(expert.display_name || '未命名专家')}</p>
                <p class="text-xs text-on-surface-variant truncate max-w-[440px]">${escapeHtml(expert.title || expertise.join(' / ') || '--')}</p>
            </div>
        </div>
    </td>
    <td><span class="badge badge-info">${escapeHtml(categoryLabel)}</span></td>
    <td>${expertStatusBadge(expert)}</td>
    <td>${expert.is_featured ? '<span class="badge badge-info">推荐</span>' : '<span class="badge badge-neutral">普通</span>'}</td>
    <td class="font-semibold">${Number(expert.sort_order ?? 100)}</td>
    <td class="text-on-surface-variant">${escapeHtml(timeAgo(expert.updated_at || expert.created_at))}</td>
    <td class="text-right">
        <div class="flex items-center justify-end gap-1">
            <button class="btn-preview-expert w-8 h-8 flex items-center justify-center rounded-md hover:bg-blue-50 transition-colors" data-id="${expert.id}" title="预览">
                <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">preview</span>
            </button>
            <button class="btn-edit-expert w-8 h-8 flex items-center justify-center rounded-md hover:bg-blue-50 transition-colors" data-id="${expert.id}" title="编辑">
                <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">edit</span>
            </button>
            <button class="btn-delete-expert w-8 h-8 flex items-center justify-center rounded-md hover:bg-red-50 transition-colors" data-id="${expert.id}" title="删除">
                <span class="material-symbols-outlined text-slate-400 hover:text-red-500 text-lg">delete</span>
            </button>
        </div>
    </td>
</tr>`;
            }).join('');

            renderPaginationControls(
                document.getElementById('expert-pagination'),
                data.page || 1,
                data.pages || 1,
                (page) => {
                    expertPage = page;
                    loadExperts();
                }
            );

            if (selectedExpertId && items.some(item => item.id === selectedExpertId)) {
                document.querySelector(`#experts-tbody tr[data-id="${selectedExpertId}"]`)?.classList.add('is-selected');
            }
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-red-500 text-sm">${escapeHtml(err.message)}</td></tr>`;
            renderExpertDetail(null);
        }
    }

    async function saveExpert(event) {
        event.preventDefault();
        const payload = getExpertEditorPayload();
        if (!payload.display_name) {
            toast('请填写专家姓名', 'warning');
            document.getElementById('expert-display-name')?.focus();
            return;
        }
        if (!payload.title) {
            toast('请填写专家头衔', 'warning');
            document.getElementById('expert-title')?.focus();
            return;
        }
        if (!payload.summary) {
            toast('请填写一句话介绍', 'warning');
            document.getElementById('expert-summary')?.focus();
            return;
        }

        const submitBtn = document.getElementById('expert-editor-submit');
        const wasPreviewOpen = document.body.classList.contains('admin-preview-open');
        try {
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>保存中...';
            }
            const detail = editingExpertId
                ? await api('PUT', `/api/admin/experts/${editingExpertId}`, payload)
                : await api('POST', '/api/admin/experts', payload);
            toast(editingExpertId ? '专家已更新' : '专家已创建');
            selectedExpertId = detail.id;
            closeExpertEditor();
            await loadExperts();
            if (wasPreviewOpen) await loadExpertDetail(detail.id);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<span class="material-symbols-outlined text-sm">save</span>保存专家';
            }
        }
    }

    async function initExperts() {
        renderTopbar('专家管理');
        selectedExpertId = getAdminSelectionParam('expert') || selectedExpertId;
        const searchInput = document.getElementById('expert-search');
        const categoryFilter = document.getElementById('expert-category-filter');
        const statusFilter = document.getElementById('expert-status-filter');
        const refreshBtn = document.getElementById('expert-refresh');
        const createBtn = document.getElementById('expert-create-button');
        const tbody = document.getElementById('experts-tbody');
        const form = document.getElementById('expert-editor-form');
        const closeButtons = [
            document.getElementById('expert-editor-close'),
            document.getElementById('expert-editor-cancel'),
        ];
        const detailPanel = document.getElementById('expert-detail');

        let searchTimer;
        searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                expertFilters.search = searchInput.value.trim();
                expertPage = 1;
                loadExperts();
            }, 300);
        });
        categoryFilter?.addEventListener('change', () => {
            expertFilters.category = categoryFilter.value;
            expertPage = 1;
            loadExperts();
        });
        statusFilter?.addEventListener('change', () => {
            expertFilters.status = statusFilter.value;
            expertPage = 1;
            loadExperts();
        });
        refreshBtn?.addEventListener('click', () => loadExperts());
        createBtn?.addEventListener('click', () => openExpertEditor());
        closeButtons.forEach(button => button?.addEventListener('click', closeExpertEditor));
        const expertEditorModal = document.getElementById('expert-editor-modal');
        expertEditorModal?.addEventListener('click', event => {
            if (event.target.id === 'expert-editor-modal') closeExpertEditor();
        });
        if (expertEditorModal && !expertEditorModal.dataset.escapeBound) {
            expertEditorModal.dataset.escapeBound = 'true';
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !expertEditorModal.classList.contains('hidden')) {
                    event.preventDefault();
                    closeExpertEditor();
                }
            });
        }
        form?.addEventListener('submit', saveExpert);

        tbody?.addEventListener('click', async (event) => {
            const previewBtn = event.target.closest('.btn-preview-expert');
            const editBtn = event.target.closest('.btn-edit-expert');
            const deleteBtn = event.target.closest('.btn-delete-expert');
            if (previewBtn) {
                event.preventDefault();
                event.stopPropagation();
                await loadExpertDetail(previewBtn.dataset.id);
                return;
            }
            if (editBtn) {
                event.preventDefault();
                event.stopPropagation();
                await openExpertEditor(editBtn.dataset.id);
                return;
            }
            if (deleteBtn) {
                event.preventDefault();
                event.stopPropagation();
                await deleteExpert(deleteBtn.dataset.id);
            }
        });

        detailPanel?.addEventListener('click', async (event) => {
            const action = event.target.closest('[data-expert-action]');
            if (!action) return;
            if (action.dataset.expertAction === 'edit') {
                await openExpertEditor(action.dataset.id);
                return;
            }
            if (action.dataset.expertAction === 'delete') {
                await deleteExpert(action.dataset.id);
            }
        });

        await loadExperts();
        if (selectedExpertId) await loadExpertDetail(selectedExpertId);
    }

    // ─── 内容编辑页 ──────────────────────────────────────────────────────────
    let easyMDE = null;
    let editingContentId = null;

    async function initContentEdit() {
        renderTopbar('教程编辑');

        // 从 URL 读取 id
        const urlId = new URLSearchParams(window.location.search).get('id');
        editingContentId = urlId || null;

        // 初始化 EasyMDE
        easyMDE = new EasyMDE({
            element: document.getElementById('easymde-editor'),
            autofocus: !urlId,
            spellChecker: false,
            placeholder: '在此输入 Markdown 内容...',
            toolbar: [
                'bold', 'italic', 'heading', '|',
                'quote', 'unordered-list', 'ordered-list', '|',
                'link', 'image', 'code', 'table', '|',
                'preview', 'side-by-side', 'fullscreen', '|',
                'guide'
            ],
            status: ['lines', 'words'],
            minHeight: '100%',
        });

        // 如果是编辑模式，加载文章数据
        if (urlId) {
            try {
                const c = await api('GET', `/api/admin/tutorials/${urlId}`);
                document.getElementById('editor-title').value = c.title || '';
                document.getElementById('editor-type').value = c.content_type || 'tutorial';
                document.getElementById('editor-tags').value = (c.tags || []).join(', ');
                easyMDE.value(c.markdown_body || '');
                document.title = `编辑: ${c.title} - Admin | GEOrank`;
            } catch (err) {
                toast('加载文章失败: ' + err.message, 'error');
            }
        }

        // 保存/发布
        async function saveContent(status) {
            const title = document.getElementById('editor-title')?.value?.trim();
            const content_type = document.getElementById('editor-type')?.value;
            const tagsRaw = document.getElementById('editor-tags')?.value || '';
            const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
            const markdown_body = easyMDE ? easyMDE.value().trim() : '';

            if (!title) { toast('请输入文章标题', 'warning'); return; }
            if (!markdown_body) { toast('请输入文章内容', 'warning'); return; }

            const reading_time_minutes = Math.max(1, Math.ceil(markdown_body.length / 400));
            const payload = { title, markdown_body, content_type, status, tags, reading_time_minutes };

            try {
                if (editingContentId) {
                    await api('PUT', `/api/admin/tutorials/${editingContentId}`, payload);
                    toast(status === 'published' ? '已更新并发布' : '已保存为草稿');
                } else {
                    const res = await api('POST', '/api/admin/tutorials', payload);
                    editingContentId = res.id;
                    // 更新 URL 不刷新页面
                    history.replaceState(null, '', withAppOrigin(`/admin/tutorials-edit?id=${res.id}`));
                    toast(status === 'published' ? '文章已创建并发布' : '已保存为草稿');
                }
            } catch (err) { toast(err.message, 'error'); }
        }

        document.getElementById('editor-save-draft')?.addEventListener('click', () => saveContent('draft'));
        document.getElementById('editor-publish')?.addEventListener('click', () => saveContent('published'));
    }

    // ─── 问答管理页 ──────────────────────────────────────────────────────────
    let solutionsPage = 1;
    let solutionsFilters = { search: '', visibility: '', linkage: '' };
    let selectedSolutionConversationId = null;
    let solutionTemplateConfig = null;
    let solutionChannelConfig = null;

    function summarizeTemplateText(text, limit = 110) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return '未配置';
        return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
    }

    function renderSolutionTemplateSummary(config) {
        const container = document.getElementById('solutions-template-summary');
        if (!container) return;

        if (!config) {
            container.innerHTML = '<div class="text-sm text-slate-400">回答模板暂不可用</div>';
            return;
        }

        const templateMetaItems = [
            config.uses_default ? '默认模板' : '自定义模板',
            'System Prompt',
            'Response Instruction',
            'Streaming Prompt',
            config.updated_at ? `最近更新 ${timeAgo(config.updated_at)}` : '当前使用默认模板',
            `${config.customized_field_count || 0}/${config.template_field_total || 3} 项已自定义`,
            ...(config.updated_by_username ? [`更新人 ${config.updated_by_username}`] : []),
        ];

        container.innerHTML = `
<div class="space-y-4">
    <div class="admin-solutions-template-summary__top">
        <div class="admin-solutions-template-copy">
            <p class="admin-solutions-eyebrow">当前回答模板</p>
            <p class="admin-solutions-summary-copy">后台配置会直接影响 AI 问答时的系统提示词和回答指令。</p>
        </div>
        <div class="admin-solutions-template-meta">
            ${templateMetaItems.map((item, index) => `<span class="admin-solutions-template-pill${index === 0 ? ' is-primary' : ''}">${escapeHtml(item)}</span>`).join('')}
        </div>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div class="admin-detail-section p-3">
            <p class="text-xs font-semibold text-slate-700 uppercase tracking-wide">System Prompt</p>
            <p class="text-sm text-slate-500 mt-2 leading-6">${escapeHtml(summarizeTemplateText(config.system_prompt))}</p>
        </div>
        <div class="admin-detail-section p-3">
            <p class="text-xs font-semibold text-slate-700 uppercase tracking-wide">Response Instruction</p>
            <p class="text-sm text-slate-500 mt-2 leading-6">${escapeHtml(summarizeTemplateText(config.response_instruction))}</p>
        </div>
        <div class="admin-detail-section p-3">
            <p class="text-xs font-semibold text-slate-700 uppercase tracking-wide">Streaming Prompt</p>
            <p class="text-sm text-slate-500 mt-2 leading-6">${escapeHtml(summarizeTemplateText(config.streaming_system_prompt))}</p>
        </div>
    </div>
    ${Array.isArray(config.customized_fields) && config.customized_fields.length ? `
        <div class="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-xs text-blue-800">
            当前已自定义字段：${config.customized_fields.map(field => escapeHtml(field)).join(' · ')}
        </div>
    ` : ''}
</div>`;
    }

    function openSolutionTemplateModal() {
        const current = solutionTemplateConfig || {
            system_prompt: '',
            response_instruction: '',
            streaming_system_prompt: '',
        };
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[9998] bg-slate-900/45 flex items-center justify-center p-4';
        overlay.innerHTML = `
<div class="admin-dialog bg-white rounded-2xl shadow-2xl w-full max-w-4xl">
    <div class="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
        <div>
            <h3 class="text-lg font-bold font-headline">配置回答模板</h3>
            <p class="text-sm text-slate-500 mt-1">保存后会立即影响后续 AI 问答的系统提示词和回答指令。</p>
        </div>
        <button type="button" id="solution-template-close" class="w-9 h-9 rounded-lg hover:bg-slate-50 flex items-center justify-center">
            <span class="material-symbols-outlined text-slate-400">close</span>
        </button>
    </div>
    <form id="solution-template-form" class="p-6 space-y-5">
        <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">System Prompt</span>
                <textarea name="system_prompt" class="form-input min-h-[220px]">${escapeHtml(current.system_prompt || '')}</textarea>
            </label>
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">Response Instruction</span>
                <textarea name="response_instruction" class="form-input min-h-[220px]">${escapeHtml(current.response_instruction || '')}</textarea>
            </label>
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">Streaming Prompt</span>
                <textarea name="streaming_system_prompt" class="form-input min-h-[220px]">${escapeHtml(current.streaming_system_prompt || '')}</textarea>
            </label>
        </div>
        <div class="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">
            建议把“角色定义”“输出风格”“关联公司数量”等规则写在模板里，后续 AI 问答会直接复用。
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3">
            <button type="button" id="solution-template-reset" class="btn admin-btn-secondary px-5 py-2 rounded-lg text-sm inline-flex items-center gap-2">
                <span class="material-symbols-outlined text-sm">restart_alt</span>
                恢复默认模板
            </button>
            <div class="flex items-center justify-end gap-3">
            <button type="button" id="solution-template-cancel" class="btn admin-btn-secondary px-5 py-2 rounded-lg text-sm">取消</button>
            <button type="submit" id="solution-template-submit" class="btn btn-primary px-5 py-2 rounded-lg text-sm">保存模板</button>
            </div>
        </div>
    </form>
</div>`;
        document.body.appendChild(overlay);

        const close = bindAdminDialogOverlay(overlay, () => overlay.remove());
        overlay.querySelector('#solution-template-close')?.addEventListener('click', close);
        overlay.querySelector('#solution-template-cancel')?.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('#solution-template-reset')?.addEventListener('click', async () => {
            if (!await confirm('确认恢复为默认回答模板？当前自定义内容会被清除。')) return;
            try {
                solutionTemplateConfig = await api('POST', '/api/admin/solutions/templates/reset');
                renderSolutionTemplateSummary(solutionTemplateConfig);
                toast('已恢复默认回答模板');
                close();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
        overlay.querySelector('#solution-template-form')?.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submitBtn = overlay.querySelector('#solution-template-submit');
            if (submitBtn) submitBtn.disabled = true;

            const form = new FormData(event.currentTarget);
            const payload = {
                system_prompt: String(form.get('system_prompt') || '').trim(),
                response_instruction: String(form.get('response_instruction') || '').trim(),
                streaming_system_prompt: String(form.get('streaming_system_prompt') || '').trim(),
            };

            try {
                solutionTemplateConfig = await api('PUT', '/api/admin/solutions/templates', payload);
                renderSolutionTemplateSummary(solutionTemplateConfig);
                toast('回答模板已更新');
                close();
            } catch (err) {
                toast(err.message, 'error');
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }

    async function loadSolutionTemplates() {
        try {
            solutionTemplateConfig = await api('GET', '/api/admin/solutions/templates');
            renderSolutionTemplateSummary(solutionTemplateConfig);
        } catch (err) {
            renderSolutionTemplateSummary(null);
            toast('加载回答模板失败: ' + err.message, 'error');
        }
    }

    function renderSolutionChannelSummary(config) {
        const container = document.getElementById('solutions-channel-summary');
        if (!container) return;

        if (!config) {
            container.innerHTML = '<div class="text-sm text-slate-400">问答频道暂不可用</div>';
            return;
        }

        const channels = Array.isArray(config.channels) ? config.channels : [];
        const enabledCount = Number(config.enabled_channel_count ?? channels.filter(channel => channel.enabled !== false).length);
        const defaultChannel = channels.find(channel => channel.key === config.default_channel_key) || channels[0] || {};

        container.innerHTML = `
<div class="space-y-4">
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
            <p class="text-xs font-bold text-slate-500 uppercase tracking-widest">当前问答频道</p>
            <p class="text-sm text-slate-500 mt-1">前台 /solutions 会按频道切换提示词、介绍文案和推荐问题。</p>
        </div>
        <div class="flex flex-wrap gap-2 text-xs text-slate-500">
            <span class="admin-pill">${config.uses_default ? '默认频道' : '自定义频道'}</span>
            <span class="admin-pill">${enabledCount}/${channels.length || 0} 个已启用</span>
            <span class="admin-pill">默认：${escapeHtml(defaultChannel.name || config.default_channel_key || '--')}</span>
            <span class="admin-pill">${config.updated_at ? `最近更新 ${timeAgo(config.updated_at)}` : '当前使用默认频道'}</span>
            ${config.updated_by_username ? `<span class="admin-pill">更新人 ${escapeHtml(config.updated_by_username)}</span>` : ''}
        </div>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
        ${channels.slice(0, 6).map(channel => `
            <div class="admin-detail-section p-3">
                <div class="flex items-center justify-between gap-2">
                    <p class="text-sm font-bold text-slate-900 truncate">${escapeHtml(channel.name || '未命名频道')}</p>
                    <span class="badge ${channel.enabled === false ? 'badge-neutral' : 'badge-success'}">${channel.enabled === false ? '停用' : '启用'}</span>
                </div>
                <div class="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
                    <span class="material-symbols-outlined text-sm">${escapeHtml(channel.icon || 'forum')}</span>
                    <span>${escapeHtml(channel.key || '--')}</span>
                    ${channel.key === config.default_channel_key ? '<span class="badge badge-info">默认</span>' : ''}
                </div>
                <p class="text-sm text-slate-500 mt-2 leading-6">${escapeHtml(summarizeTemplateText(channel.description, 86))}</p>
            </div>
        `).join('') || '<div class="text-sm text-slate-400">暂无频道</div>'}
    </div>
</div>`;
    }

    function buildChannelEditorRow(channel, index, defaultChannelKey) {
        const sampleQuestions = Array.isArray(channel.sample_questions) ? channel.sample_questions.join('\n') : '';
        const key = channel.key || '';
        return `
<div class="solution-channel-editor rounded-2xl border border-slate-100 bg-slate-50/60 p-4 space-y-4" data-channel-editor data-index="${index}">
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <label class="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input type="radio" name="solution-default-channel" data-field="default" ${key === defaultChannelKey ? 'checked' : ''}>
            默认频道
        </label>
        <div class="flex items-center gap-3">
            <label class="inline-flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" data-field="enabled" ${channel.enabled === false ? '' : 'checked'}>
                启用
            </label>
            <button type="button" class="btn admin-btn-secondary px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1" data-channel-action="delete">
                <span class="material-symbols-outlined text-sm">delete</span>
                删除
            </button>
        </div>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr_0.7fr] gap-3">
        <label class="space-y-2 text-sm">
            <span class="font-semibold text-slate-700">频道 Key</span>
            <input data-field="key" class="form-input" value="${escapeHtml(key)}" placeholder="geo-basics">
        </label>
        <label class="space-y-2 text-sm">
            <span class="font-semibold text-slate-700">频道名称</span>
            <input data-field="name" class="form-input" value="${escapeHtml(channel.name || '')}" placeholder="GEO 入门科普">
        </label>
        <label class="space-y-2 text-sm">
            <span class="font-semibold text-slate-700">图标</span>
            <input data-field="icon" class="form-input" value="${escapeHtml(channel.icon || 'forum')}" placeholder="forum">
        </label>
    </div>
    <label class="space-y-2 text-sm block">
        <span class="font-semibold text-slate-700">频道说明</span>
        <textarea data-field="description" class="form-input min-h-[72px]" placeholder="前台展示给用户的频道说明">${escapeHtml(channel.description || '')}</textarea>
    </label>
    <label class="space-y-2 text-sm block">
        <span class="font-semibold text-slate-700">频道系统提示补充</span>
        <textarea data-field="system_hint" class="form-input min-h-[92px]" placeholder="告诉 AI 在这个频道中应如何回答">${escapeHtml(channel.system_hint || '')}</textarea>
    </label>
    <label class="space-y-2 text-sm block">
        <span class="font-semibold text-slate-700">样例问题</span>
        <textarea data-field="sample_questions" class="form-input min-h-[92px]" placeholder="每行一个问题">${escapeHtml(sampleQuestions)}</textarea>
    </label>
</div>`;
    }

    function readChannelEditors(root) {
        const rows = Array.from(root.querySelectorAll('[data-channel-editor]'));
        const channels = rows.map(row => ({
            key: String(row.querySelector('[data-field="key"]')?.value || '').trim(),
            name: String(row.querySelector('[data-field="name"]')?.value || '').trim(),
            description: String(row.querySelector('[data-field="description"]')?.value || '').trim(),
            icon: String(row.querySelector('[data-field="icon"]')?.value || 'forum').trim() || 'forum',
            enabled: Boolean(row.querySelector('[data-field="enabled"]')?.checked),
            system_hint: String(row.querySelector('[data-field="system_hint"]')?.value || '').trim(),
            sample_questions: String(row.querySelector('[data-field="sample_questions"]')?.value || '')
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean),
        }));
        const defaultIndex = rows.findIndex(row => row.querySelector('[data-field="default"]')?.checked);
        return {
            default_channel_key: channels[Math.max(defaultIndex, 0)]?.key || channels[0]?.key || '',
            channels,
        };
    }

    function openSolutionChannelsModal() {
        const current = solutionChannelConfig || {
            default_channel_key: 'geo-basics',
            channels: [],
        };
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[9998] bg-slate-900/45 flex items-center justify-center p-4';
        overlay.innerHTML = `
<div class="admin-dialog bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col">
    <div class="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
        <div>
            <h3 class="text-lg font-bold font-headline">配置问答频道</h3>
            <p class="text-sm text-slate-500 mt-1">保存后会立即影响前台问答页的频道列表、样例问题和频道提示词。</p>
        </div>
        <button type="button" id="solution-channel-close" class="w-9 h-9 rounded-lg hover:bg-slate-50 flex items-center justify-center">
            <span class="material-symbols-outlined text-slate-400">close</span>
        </button>
    </div>
    <form id="solution-channel-form" class="min-h-0 flex-1 overflow-y-auto p-6 space-y-5">
        <div id="solution-channel-editor-list" class="space-y-4"></div>
        <div class="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">
            频道 Key 建议使用英文短横线，例如 geo-basics。至少保留一个启用频道，默认频道也必须启用。
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3 sticky bottom-0 bg-white pt-2">
            <div class="flex flex-wrap items-center gap-2">
                <button type="button" id="solution-channel-add" class="btn admin-btn-secondary px-5 py-2 rounded-lg text-sm inline-flex items-center gap-2">
                    <span class="material-symbols-outlined text-sm">add</span>
                    新增频道
                </button>
                <button type="button" id="solution-channel-reset" class="btn admin-btn-secondary px-5 py-2 rounded-lg text-sm inline-flex items-center gap-2">
                    <span class="material-symbols-outlined text-sm">restart_alt</span>
                    恢复默认频道
                </button>
            </div>
            <div class="flex items-center justify-end gap-3">
                <button type="button" id="solution-channel-cancel" class="btn admin-btn-secondary px-5 py-2 rounded-lg text-sm">取消</button>
                <button type="submit" id="solution-channel-submit" class="btn btn-primary px-5 py-2 rounded-lg text-sm">保存频道</button>
            </div>
        </div>
    </form>
</div>`;
        document.body.appendChild(overlay);

        let draftChannels = Array.isArray(current.channels)
            ? current.channels.map(channel => ({ ...channel, sample_questions: Array.isArray(channel.sample_questions) ? channel.sample_questions.slice() : [] }))
            : [];
        let draftDefaultKey = current.default_channel_key || draftChannels[0]?.key || '';
        const list = overlay.querySelector('#solution-channel-editor-list');
        const close = bindAdminDialogOverlay(overlay, () => overlay.remove());
        const renderRows = () => {
            if (!list) return;
            list.innerHTML = draftChannels.map((channel, index) => buildChannelEditorRow(channel, index, draftDefaultKey)).join('');
        };
        const syncDraft = () => {
            const payload = readChannelEditors(overlay);
            draftChannels = payload.channels;
            draftDefaultKey = payload.default_channel_key;
        };

        renderRows();
        overlay.querySelector('#solution-channel-close')?.addEventListener('click', close);
        overlay.querySelector('#solution-channel-cancel')?.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('#solution-channel-add')?.addEventListener('click', () => {
            syncDraft();
            draftChannels.push({
                key: `custom-${Date.now()}`,
                name: '新问答频道',
                description: '',
                icon: 'forum',
                enabled: true,
                system_hint: '',
                sample_questions: ['这个频道适合回答什么问题？'],
            });
            if (!draftDefaultKey) draftDefaultKey = draftChannels[0].key;
            renderRows();
        });
        list?.addEventListener('click', (event) => {
            const deleteButton = event.target.closest('[data-channel-action="delete"]');
            if (!deleteButton) return;
            const row = deleteButton.closest('[data-channel-editor]');
            const index = Number(row?.dataset.index || -1);
            if (index < 0) return;
            syncDraft();
            if (draftChannels.length <= 1) {
                toast('至少保留一个问答频道', 'warning');
                return;
            }
            draftChannels.splice(index, 1);
            if (!draftChannels.some(channel => channel.key === draftDefaultKey)) {
                draftDefaultKey = draftChannels[0]?.key || '';
            }
            renderRows();
        });
        overlay.querySelector('#solution-channel-reset')?.addEventListener('click', async () => {
            if (!await confirm('确认恢复为默认问答频道？当前自定义频道会被清除。')) return;
            try {
                solutionChannelConfig = await api('POST', '/api/admin/solutions/channels/reset');
                renderSolutionChannelSummary(solutionChannelConfig);
                toast('已恢复默认问答频道');
                close();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
        overlay.querySelector('#solution-channel-form')?.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submitBtn = overlay.querySelector('#solution-channel-submit');
            if (submitBtn) submitBtn.disabled = true;
            const payload = readChannelEditors(overlay);
            try {
                solutionChannelConfig = await api('PUT', '/api/admin/solutions/channels', payload);
                renderSolutionChannelSummary(solutionChannelConfig);
                toast('问答频道已更新');
                close();
            } catch (err) {
                toast(err.message, 'error');
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }

    async function loadSolutionChannels() {
        try {
            solutionChannelConfig = await api('GET', '/api/admin/solutions/channels');
            renderSolutionChannelSummary(solutionChannelConfig);
        } catch (err) {
            renderSolutionChannelSummary(null);
            toast('加载问答频道失败: ' + err.message, 'error');
        }
    }

    function renderSolutionDetail(detail) {
        const container = document.getElementById('solutions-detail');
        const badge = document.getElementById('solutions-detail-badge');
        if (!container || !badge) return;
        if (!detail) {
            setAdminSelectionParam('conversation', '');
            badge.textContent = '未选中';
            container.innerHTML = `
<div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-6 text-sm text-slate-400">
    点击列表中的预览按钮，查看消息流、关联公司和诊断联动上下文。
</div>`;
            return;
        }

        badge.textContent = '会话详情';
        const messagesHtml = (detail.messages || []).map(message => `
<div class="admin-detail-message ${message.role === 'user' ? 'is-user' : 'is-assistant'}">
    <div class="flex items-center justify-between gap-3 mb-2">
        <div class="flex items-center gap-2">
            <span class="badge ${message.role === 'user' ? 'badge-info' : 'badge-success'}">${message.role === 'user' ? '用户' : 'AI'}</span>
            ${message.diagnostic_context ? `<span class="badge badge-warning">诊断联动</span>` : ''}
        </div>
        <span class="text-[11px] text-slate-400">${timeAgo(message.created_at)}</span>
    </div>
    <p class="text-sm leading-6 text-slate-700 whitespace-pre-wrap">${escapeHtml(message.content || '无内容')}</p>
    ${Array.isArray(message.recommended_companies) && message.recommended_companies.length ? `
        <div class="mt-3 flex flex-wrap gap-2">
            ${message.recommended_companies.slice(0, 6).map(company => `
                ${company.company_id ? `
                <a href="${withAppOrigin(`/admin/companies?company=${company.company_id}`)}" class="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 transition-colors">
                    <span>${escapeHtml(company.name || '未命名公司')}</span>
                    ${company.geo_score ? `<span class="text-blue-500">GEO ${escapeHtml(company.geo_score)}</span>` : ''}
                </a>` : `
                <span class="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">
                    <span>${escapeHtml(company.name || '未命名公司')}</span>
                    ${company.geo_score ? `<span class="text-blue-500">GEO ${escapeHtml(company.geo_score)}</span>` : ''}
                </span>`}
            `).join('')}
        </div>` : ''}
    ${message.diagnostic_context ? `
        <div class="admin-detail-section mt-3 p-3">
            <p class="text-xs font-semibold text-slate-700">关联诊断</p>
            <p class="text-xs text-slate-500 mt-1 break-all">${escapeHtml(message.diagnostic_context.url)}</p>
            <div class="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
                <span class="badge badge-neutral">${escapeHtml(message.diagnostic_context.status)}</span>
                <span>${message.diagnostic_context.overall_score ?? '--'} 分</span>
            </div>
            <a href="${withAppOrigin(`/admin/diagnostics?report=${message.diagnostic_context.report_id}`)}" class="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                <span class="material-symbols-outlined text-sm">monitoring</span>
                打开诊断详情
            </a>
        </div>` : ''}
</div>`).join('');

        container.innerHTML = `
<div class="space-y-4">
    <div class="admin-detail-section p-4">
        <div class="flex items-start justify-between gap-3">
            <div>
                <p class="text-lg font-bold font-headline">${escapeHtml(detail.title || '未命名问答会话')}</p>
                <div class="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                    <span>用户：${escapeHtml(detail.username || detail.user_email || (detail.is_public ? '公开访客' : detail.user_id || '--'))}</span>
                    ${detail.is_public ? '<span class="badge badge-info">公开会话</span>' : ''}
                    ${!detail.is_public ? '<span class="badge badge-neutral">已归档到用户历史</span>' : ''}
                    <span>创建于 ${formatDate(detail.created_at)}</span>
                    <span>最近更新 ${timeAgo(detail.updated_at)}</span>
                </div>
            </div>
            <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-solution-action="delete" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">delete</span>
                删除会话
            </button>
        </div>
    </div>
    <div class="admin-detail-grid">
        <div class="admin-detail-metric">
            <p class="text-[11px] font-bold uppercase tracking-wide text-slate-400">消息数</p>
            <p class="mt-2 text-2xl font-black tracking-tight text-slate-900">${detail.message_count || 0}</p>
            <p class="mt-1 text-xs text-slate-500">AI 回复 ${detail.assistant_message_count || 0} 条</p>
        </div>
        <div class="admin-detail-metric">
            <p class="text-[11px] font-bold uppercase tracking-wide text-slate-400">关联公司</p>
            <p class="mt-2 text-2xl font-black tracking-tight text-slate-900">${detail.recommended_company_count || 0}</p>
            <p class="mt-1 text-xs text-slate-500">关联公司累计命中次数</p>
        </div>
        <div class="admin-detail-metric">
            <p class="text-[11px] font-bold uppercase tracking-wide text-slate-400">诊断联动</p>
            <p class="mt-2 text-2xl font-black tracking-tight text-slate-900">${detail.diagnostic_context_count || 0}</p>
            <p class="mt-1 text-xs text-slate-500">${detail.last_assistant_message_at ? `最近 AI 回复 ${timeAgo(detail.last_assistant_message_at)}` : '当前暂无 AI 回复'}</p>
        </div>
        <div class="admin-detail-metric">
            <p class="text-[11px] font-bold uppercase tracking-wide text-slate-400">会话首条消息</p>
            <p class="mt-2 text-sm font-semibold text-slate-900">${detail.first_message_at ? escapeHtml(formatDate(detail.first_message_at)) : '--'}</p>
            <p class="mt-1 text-xs text-slate-500">${detail.last_user_message_at ? `最近用户追问 ${timeAgo(detail.last_user_message_at)}` : '暂无用户追问'}</p>
        </div>
    </div>
    <div class="space-y-3 max-h-[680px] overflow-y-auto pr-1">${messagesHtml || '<div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-5 text-sm text-slate-400">当前会话暂无消息</div>'}</div>
</div>`;
    }

    async function loadSolutionDetail(conversationId) {
        selectedSolutionConversationId = conversationId;
        document.querySelectorAll('#solutions-tbody tr[data-conversation-id]').forEach(row => {
            row.classList.toggle('is-selected', row.dataset.conversationId === conversationId);
        });
        setAdminSelectionParam('conversation', conversationId);
        openAdminPreviewDrawer();

        try {
            const detail = await api('GET', `/api/admin/solutions/conversations/${conversationId}`);
            renderSolutionDetail(detail);
        } catch (err) {
            toast('加载问答会话详情失败: ' + err.message, 'error');
        }
    }

    async function deleteSolutionConversation(conversationId) {
        if (!conversationId) return;
        if (!await confirm('确认删除这条问答会话？此操作会同时删除会话消息。')) return;

        try {
            await api('DELETE', `/api/admin/solutions/conversations/${conversationId}`);
            toast('问答会话已删除');
            selectedSolutionConversationId = null;
            closeAdminPreviewDrawer();
            await loadSolutions();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function loadSolutions() {
        const params = new URLSearchParams({ page: String(solutionsPage), size: '20' });
        if (solutionsFilters.search) params.set('search', solutionsFilters.search);
        if (solutionsFilters.visibility) params.set('visibility', solutionsFilters.visibility);
        if (solutionsFilters.linkage) params.set('linkage', solutionsFilters.linkage);

        const tbody = document.getElementById('solutions-tbody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400 text-sm">加载中...</td></tr>';
        }

        try {
            const data = await api('GET', `/api/admin/solutions/conversations?${params.toString()}`);
            const items = data.items || [];
            const summary = data.summary || {};

            const totalEl = document.getElementById('solutions-total');
            const messageCountEl = document.getElementById('solutions-message-count');
            const recommendationEl = document.getElementById('solutions-recommendation-count');
            const diagnosticEl = document.getElementById('solutions-diagnostic-count');
            const infoEl = document.getElementById('solutions-pagination-info');

            if (totalEl) totalEl.textContent = (data.total || 0).toLocaleString();
            if (messageCountEl) messageCountEl.textContent = (summary.message_count || 0).toLocaleString();
            if (recommendationEl) recommendationEl.textContent = (summary.conversations_with_recommendations || 0).toLocaleString();
            if (diagnosticEl) diagnosticEl.textContent = (summary.conversations_with_diagnostics || 0).toLocaleString();
            if (infoEl) {
                infoEl.textContent = `共 ${data.total || 0} 个会话 · 公开 ${summary.public_conversation_count || 0} · 登录用户 ${summary.owned_conversation_count || 0} · 平均 ${summary.average_message_count || 0} 条消息`;
            }

            if (!tbody) return;
            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400 text-sm">暂无问答会话</td></tr>';
                renderSolutionDetail(null);
                return;
            }

            tbody.innerHTML = items.map(item => `
<tr data-conversation-id="${item.id}">
    <td>
        <div class="min-w-0">
            <p class="font-semibold text-sm truncate max-w-[320px]">${escapeHtml(item.title || '未命名问答会话')}</p>
            <p class="text-xs text-on-surface-variant mt-1 truncate max-w-[360px]">${escapeHtml(item.latest_message_excerpt || '暂无摘要')}</p>
        </div>
    </td>
    <td>
        <div class="flex items-center gap-2">
            <div class="text-sm font-medium">${escapeHtml(item.username || item.user_email || (item.is_public ? '公开访客' : '--'))}</div>
            ${item.is_public ? '<span class="badge badge-info">公开</span>' : '<span class="badge badge-neutral">已保存</span>'}
        </div>
        <div class="text-xs text-on-surface-variant">${escapeHtml(item.user_email || (item.is_public ? '未登录创建' : '--'))}</div>
    </td>
    <td>
        <div class="text-sm font-semibold">${item.message_count}</div>
        <div class="text-[11px] text-slate-400">AI ${item.assistant_message_count || 0}</div>
    </td>
    <td>
        <div class="flex items-center gap-2">
            ${item.has_recommendations ? '<span class="badge badge-success">有关联</span>' : '<span class="badge badge-neutral">无关联</span>'}
            ${item.diagnostic_context_ids?.length ? '<span class="badge badge-warning">关联诊断</span>' : ''}
        </div>
        <div class="mt-1 text-[11px] text-slate-400">关联 ${item.recommendation_company_count || 0} 次 · 诊断 ${item.diagnostic_context_count || 0} 条</div>
    </td>
    <td class="text-on-surface-variant">${timeAgo(item.updated_at)}</td>
    <td class="text-right">
        <button class="btn-preview-solution w-8 h-8 inline-flex items-center justify-center rounded-md hover:bg-blue-50 transition-colors" title="预览会话" data-id="${item.id}">
            <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">preview</span>
        </button>
    </td>
</tr>`).join('');

            tbody.onclick = (e) => {
                const previewBtn = e.target.closest('.btn-preview-solution');
                if (!previewBtn) return;
                e.preventDefault();
                e.stopPropagation();
                loadSolutionDetail(previewBtn.dataset.id);
            };

            renderPaginationControls(
                document.getElementById('solutions-pagination'),
                data.page || 1,
                data.pages || 1,
                (page) => {
                    solutionsPage = page;
                    loadSolutions();
                }
            );

            if (selectedSolutionConversationId) {
                if (items.some(item => item.id === selectedSolutionConversationId)) {
                    document.querySelector(`#solutions-tbody tr[data-conversation-id="${selectedSolutionConversationId}"]`)?.classList.add('is-selected');
                }
                await loadSolutionDetail(selectedSolutionConversationId);
            }
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center py-12 text-red-500 text-sm">${escapeHtml(err.message)}</td></tr>`;
            }
            renderSolutionDetail(null);
            toast('加载问答会话列表失败: ' + err.message, 'error');
        }
    }

    async function initSolutions() {
        renderTopbar('问答管理');
        selectedSolutionConversationId = getAdminSelectionParam('conversation') || selectedSolutionConversationId;

        const searchInput = document.getElementById('solutions-search');
        const visibilityFilter = document.getElementById('solutions-visibility-filter');
        const linkageFilter = document.getElementById('solutions-linkage-filter');
        const refreshBtn = document.getElementById('solutions-refresh');
        const detailPanel = document.getElementById('solutions-detail');
        const templateButton = document.getElementById('solutions-template-button');
        const channelButton = document.getElementById('solutions-channel-button');

        let searchTimer;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    solutionsFilters.search = searchInput.value.trim();
                    solutionsPage = 1;
                    loadSolutions();
                }, 300);
            });
        }

        visibilityFilter?.addEventListener('change', () => {
            solutionsFilters.visibility = visibilityFilter.value;
            solutionsPage = 1;
            loadSolutions();
        });

        linkageFilter?.addEventListener('change', () => {
            solutionsFilters.linkage = linkageFilter.value;
            solutionsPage = 1;
            loadSolutions();
        });

        templateButton?.addEventListener('click', () => openSolutionTemplateModal());
        channelButton?.addEventListener('click', () => openSolutionChannelsModal());
        refreshBtn?.addEventListener('click', () => loadSolutions());
        detailPanel?.addEventListener('click', async (e) => {
            const deleteBtn = e.target.closest('[data-solution-action="delete"]');
            if (!deleteBtn) return;
            await deleteSolutionConversation(deleteBtn.dataset.id);
        });
        await Promise.all([loadSolutionTemplates(), loadSolutionChannels(), loadSolutions()]);
    }

    // ─── 诊断管理页 ──────────────────────────────────────────────────────────
    let diagnosticsPage = 1;
    let diagnosticsFilters = { search: '', status_filter: '' };
    let selectedDiagnosticReportId = null;
    let diagnosticRuleConfig = null;

    function getAnalysisScoreLabel(analysis) {
        if (!analysis || typeof analysis !== 'object') return '--';
        if (typeof analysis.score === 'number') return analysis.score;
        if (typeof analysis.total_score === 'number') return analysis.total_score;
        return '--';
    }

    function getDiagnosticStatusBadge(status) {
        if (status === 'completed') return '<span class="badge badge-success">completed</span>';
        if (status === 'failed') return '<span class="badge badge-error">failed</span>';
        return `<span class="badge badge-warning">${escapeHtml(status || 'pending')}</span>`;
    }

    function formatWeightPercent(value) {
        const numeric = Number(value || 0);
        return Number.isFinite(numeric)
            ? numeric.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
            : '0';
    }

    function renderDiagnosticRuleSummary(rules) {
        const container = document.getElementById('diagnostics-rule-summary');
        if (!container) return;

        if (!rules || !rules.weights) {
            container.innerHTML = '<div class="text-sm text-slate-400">评分规则暂不可用</div>';
            return;
        }

        const items = [
            ['Schema', rules.weights.schema],
            ['Content', rules.weights.content],
            ['Meta', rules.weights.meta],
            ['Citation', rules.weights.citation],
        ];
        container.innerHTML = `
<div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
    <div>
        <p class="text-xs font-bold text-slate-500 uppercase tracking-widest">当前评分规则</p>
        <p class="text-sm text-slate-500 mt-1">后续诊断报告会按以下权重归一化计算综合分。</p>
    </div>
    <div class="flex flex-wrap gap-2">
        ${items.map(([label, value]) => `<span class="admin-pill">${label} ${formatWeightPercent(value)}%</span>`).join('')}
        <span class="admin-pill">总和 ${formatWeightPercent(rules.total)}%</span>
    </div>
</div>`;
    }

    function renderDiagnosticRecommendationItems(items) {
        if (!Array.isArray(items) || !items.length) {
            return '<div class="text-xs text-slate-400">暂无</div>';
        }
        return items.map(item => {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                const itemTitle = item.item || item.title || '建议项';
                const action = item.action || item.description || JSON.stringify(item);
                return `
<div class="rounded-lg bg-white/80 px-3 py-2 border border-slate-100">
    <p class="text-xs font-semibold text-slate-700">${escapeHtml(String(itemTitle))}</p>
    <p class="text-xs text-slate-500 mt-1 leading-5">${escapeHtml(String(action))}</p>
</div>`;
            }
            return `<div class="rounded-lg bg-white/80 px-3 py-2 border border-slate-100 text-xs text-slate-600">${escapeHtml(String(item))}</div>`;
        }).join('');
    }

    function openDiagnosticRulesModal() {
        const currentRules = diagnosticRuleConfig?.weights || {
            schema: 30,
            content: 30,
            meta: 20,
            citation: 20,
        };
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[9998] bg-slate-900/45 flex items-center justify-center p-4';
        overlay.innerHTML = `
<div class="admin-dialog bg-white rounded-2xl shadow-2xl w-full max-w-lg">
    <div class="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
        <div>
            <h3 class="text-lg font-bold font-headline">配置诊断评分规则</h3>
            <p class="text-sm text-slate-500 mt-1">修改后会应用到后续诊断报告的综合分计算。</p>
        </div>
        <button type="button" id="diagnostic-rules-close" class="w-9 h-9 rounded-lg hover:bg-slate-50 flex items-center justify-center">
            <span class="material-symbols-outlined text-slate-400">close</span>
        </button>
    </div>
    <form id="diagnostic-rules-form" class="p-6 space-y-5">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">Schema</span>
                <input name="schema" type="number" min="0" step="0.1" class="form-input" value="${formatWeightPercent(currentRules.schema)}">
            </label>
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">Content</span>
                <input name="content" type="number" min="0" step="0.1" class="form-input" value="${formatWeightPercent(currentRules.content)}">
            </label>
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">Meta</span>
                <input name="meta" type="number" min="0" step="0.1" class="form-input" value="${formatWeightPercent(currentRules.meta)}">
            </label>
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">Citation</span>
                <input name="citation" type="number" min="0" step="0.1" class="form-input" value="${formatWeightPercent(currentRules.citation)}">
            </label>
        </div>
        <div class="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">
            建议保持总和为 100。系统会按比例归一化，因此总和不为 100 也会自动换算。
        </div>
        <div class="flex items-center justify-end gap-3">
            <button type="button" id="diagnostic-rules-cancel" class="btn admin-btn-secondary px-5 py-2 rounded-lg text-sm">取消</button>
            <button type="submit" id="diagnostic-rules-submit" class="btn btn-primary px-5 py-2 rounded-lg text-sm">保存规则</button>
        </div>
    </form>
</div>`;
        document.body.appendChild(overlay);

        const close = bindAdminDialogOverlay(overlay, () => overlay.remove());
        overlay.querySelector('#diagnostic-rules-close')?.addEventListener('click', close);
        overlay.querySelector('#diagnostic-rules-cancel')?.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('#diagnostic-rules-form')?.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submitBtn = overlay.querySelector('#diagnostic-rules-submit');
            if (submitBtn) submitBtn.disabled = true;

            const form = new FormData(event.currentTarget);
            const payload = {
                schema: Number(form.get('schema') || 0),
                content: Number(form.get('content') || 0),
                meta: Number(form.get('meta') || 0),
                citation: Number(form.get('citation') || 0),
            };

            try {
                diagnosticRuleConfig = await api('PUT', '/api/admin/diagnostics/rules', payload);
                renderDiagnosticRuleSummary(diagnosticRuleConfig);
                toast('诊断评分规则已更新');
                close();
                if (selectedDiagnosticReportId) {
                    await loadDiagnosticDetail(selectedDiagnosticReportId);
                }
            } catch (err) {
                toast(err.message, 'error');
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }

    async function loadDiagnosticRuleConfig() {
        try {
            diagnosticRuleConfig = await api('GET', '/api/admin/diagnostics/rules');
            renderDiagnosticRuleSummary(diagnosticRuleConfig);
        } catch (err) {
            renderDiagnosticRuleSummary(null);
            toast('加载诊断评分规则失败: ' + err.message, 'error');
        }
    }

    function renderDiagnosticDetail(detail) {
        const container = document.getElementById('diagnostics-detail');
        const badge = document.getElementById('diagnostics-detail-badge');
        if (!container || !badge) return;
        if (!detail) {
            setAdminSelectionParam('report', '');
            badge.textContent = '未选中';
            container.innerHTML = `
<div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-6 text-sm text-slate-400">
    点击列表中的预览按钮，查看评分、分析维度和优化建议。
</div>`;
            return;
        }

        badge.textContent = detail.status || '详情';
        const ruleWeights = detail.rule_config?.weights || diagnosticRuleConfig?.weights || {};
        const recommendationLabels = {
            urgent: '高优先级建议',
            recommended: '建议优化项',
            optional: '可选优化项',
            high_priority: '高优先级建议',
        };
        const relatedSolutions = Array.isArray(detail.related_solutions) ? detail.related_solutions : [];
        const recommendationGroups = Object.entries(detail.recommendations || {}).map(([key, value]) => `
<div class="admin-detail-section p-3">
    <p class="text-xs font-semibold text-slate-700">${escapeHtml(recommendationLabels[key] || key)}</p>
    <div class="mt-2 space-y-2">${Array.isArray(value) ? renderDiagnosticRecommendationItems(value) : renderDiagnosticRecommendationItems([value])}</div>
</div>`).join('');

        container.innerHTML = `
<div class="space-y-4">
    <div class="admin-detail-section p-4">
        <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
                <p class="text-sm font-semibold break-all">${escapeHtml(detail.url)}</p>
                <div class="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                    <span>状态：${escapeHtml(detail.status)}</span>
                    <span>评分：${detail.overall_score ?? '--'}</span>
                    <span>公司：${detail.company_id ? `<a href="${withAppOrigin(`/admin/companies?company=${detail.company_id}`)}" class="text-primary hover:underline">${escapeHtml(detail.company_name || '查看公司')}</a>` : escapeHtml(detail.company_name || '--')}</span>
                    <span>用户：${escapeHtml(detail.username || detail.user_email || '--')}</span>
                    <span>创建于：${escapeHtml(formatDate(detail.created_at))}</span>
                </div>
            </div>
            ${getDiagnosticStatusBadge(detail.status)}
        </div>
        ${detail.error_message ? `<div class="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">${escapeHtml(detail.error_message)}</div>` : ''}
        <div class="mt-4 flex flex-wrap gap-2">
            <a href="${safeExternalHttpHref(detail.url)}" target="_blank" rel="noreferrer" class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm">open_in_new</span>
                打开原始 URL
            </a>
            ${detail.company_id ? `
            <a href="${withAppOrigin(`/admin/companies?company=${detail.company_id}`)}" class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5">
                <span class="material-symbols-outlined text-sm">apartment</span>
                查看公司详情
            </a>` : ''}
            <button class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-diagnostic-action="export-markdown" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">download</span>
                导出 Markdown
            </button>
            <button class="btn admin-btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-diagnostic-action="export-json" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">data_object</span>
                导出 JSON
            </button>
            ${detail.status === 'failed' ? `
            <button class="btn btn-primary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-1.5" data-diagnostic-action="retry" data-id="${detail.id}">
                <span class="material-symbols-outlined text-sm">refresh</span>
                重新诊断
            </button>` : ''}
        </div>
    </div>

    <div class="grid grid-cols-2 gap-3">
        <div class="admin-detail-section p-3">
            <p class="text-xs font-semibold text-slate-700">Schema</p>
            <p class="mt-2 text-lg font-bold">${getAnalysisScoreLabel(detail.schema_analysis)}</p>
            <p class="text-[11px] text-slate-400 mt-1">权重 ${formatWeightPercent(ruleWeights.schema)}%</p>
        </div>
        <div class="admin-detail-section p-3">
            <p class="text-xs font-semibold text-slate-700">Content</p>
            <p class="mt-2 text-lg font-bold">${getAnalysisScoreLabel(detail.content_analysis)}</p>
            <p class="text-[11px] text-slate-400 mt-1">权重 ${formatWeightPercent(ruleWeights.content)}%</p>
        </div>
        <div class="admin-detail-section p-3">
            <p class="text-xs font-semibold text-slate-700">Meta</p>
            <p class="mt-2 text-lg font-bold">${getAnalysisScoreLabel(detail.meta_analysis)}</p>
            <p class="text-[11px] text-slate-400 mt-1">权重 ${formatWeightPercent(ruleWeights.meta)}%</p>
        </div>
        <div class="admin-detail-section p-3">
            <p class="text-xs font-semibold text-slate-700">Citation</p>
            <p class="mt-2 text-lg font-bold">${getAnalysisScoreLabel(detail.citation_analysis)}</p>
            <p class="text-[11px] text-slate-400 mt-1">权重 ${formatWeightPercent(ruleWeights.citation)}%</p>
        </div>
    </div>

    ${recommendationGroups ? `<div class="space-y-3">${recommendationGroups}</div>` : '<div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-5 text-sm text-slate-400">当前报告暂无结构化建议</div>'}

    <div class="admin-detail-section p-4">
        <div class="flex items-center justify-between gap-3 mb-3">
            <h4 class="text-sm font-bold text-slate-900">关联问答会话</h4>
            ${relatedSolutions.length ? `<span class="badge badge-info">${relatedSolutions.length} 条</span>` : ''}
        </div>
        ${relatedSolutions.length ? `
        <div class="space-y-3">
            ${relatedSolutions.map(item => `
            <a href="${withAppOrigin(`/admin/solutions?conversation=${item.id}`)}" class="block rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 hover:border-primary/25 hover:bg-white transition-colors">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <p class="text-sm font-semibold text-slate-900">${escapeHtml(item.title || '未命名问答会话')}</p>
                        <p class="mt-1 text-xs text-slate-500">${escapeHtml(item.username || item.user_email || '匿名用户')} · ${escapeHtml(timeAgo(item.updated_at))}</p>
                    </div>
                    <span class="badge badge-neutral">引用诊断</span>
                </div>
                ${item.latest_message_excerpt ? `<p class="mt-2 text-sm text-slate-600 line-clamp-2">${escapeHtml(item.latest_message_excerpt)}</p>` : ''}
            </a>`).join('')}
        </div>` : '<p class="text-sm text-slate-400">暂未发现引用这份诊断的问答会话。</p>'}
    </div>
</div>`;
    }

    async function loadDiagnosticDetail(reportId) {
        selectedDiagnosticReportId = reportId;
        document.querySelectorAll('#diagnostics-tbody tr[data-report-id]').forEach(row => {
            row.classList.toggle('is-selected', row.dataset.reportId === reportId);
        });
        setAdminSelectionParam('report', reportId);
        openAdminPreviewDrawer();

        try {
            const detail = await api('GET', `/api/admin/diagnostics/reports/${reportId}`);
            renderDiagnosticDetail(detail);
        } catch (err) {
            toast('加载诊断详情失败: ' + err.message, 'error');
        }
    }

    async function retryDiagnosticReport(reportId) {
        if (!reportId) return;
        try {
            await api('POST', `/api/admin/diagnostics/reports/${reportId}/retry`);
            toast('已重新触发诊断任务');
            await loadDiagnostics();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function exportDiagnosticReport(reportId, format) {
        if (!reportId) return;
        const suffix = format === 'json' ? 'json' : 'md';
        try {
            await downloadAuthenticatedFile(
                `/api/admin/diagnostics/reports/${reportId}/export?format=${format}`,
                `diagnostic-report-${reportId}.${suffix}`
            );
            toast(`诊断报告已导出为 ${suffix.toUpperCase()}`);
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function loadDiagnostics() {
        const params = new URLSearchParams({ page: String(diagnosticsPage), size: '20' });
        if (diagnosticsFilters.search) params.set('search', diagnosticsFilters.search);
        if (diagnosticsFilters.status_filter) params.set('status_filter', diagnosticsFilters.status_filter);

        const tbody = document.getElementById('diagnostics-tbody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400 text-sm">加载中...</td></tr>';
        }

        try {
            const data = await api('GET', `/api/admin/diagnostics/reports?${params.toString()}`);
            const items = data.items || [];
            const summary = data.summary || {};

            const totalEl = document.getElementById('diagnostics-total');
            const completedEl = document.getElementById('diagnostics-completed');
            const failedEl = document.getElementById('diagnostics-failed');
            const averageEl = document.getElementById('diagnostics-average-score');
            const infoEl = document.getElementById('diagnostics-pagination-info');

            if (totalEl) totalEl.textContent = (data.total || 0).toLocaleString();
            if (completedEl) completedEl.textContent = (summary.completed_count || 0).toLocaleString();
            if (failedEl) failedEl.textContent = (summary.failed_count || 0).toLocaleString();
            if (averageEl) averageEl.textContent = summary.average_score != null ? String(summary.average_score) : '--';
            if (infoEl) infoEl.textContent = `共 ${data.total || 0} 条诊断报告`;

            if (!tbody) return;
            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400 text-sm">暂无诊断报告</td></tr>';
                renderDiagnosticDetail(null);
                return;
            }

            tbody.innerHTML = items.map(item => {
                const reportId = escapeHtml(item.id);
                const status = String(item.status || 'pending');
                const statusClass = status === 'completed' ? 'badge-success' : status === 'failed' ? 'badge-error' : 'badge-warning';
                const score = item.overall_score == null ? '--' : escapeHtml(String(item.overall_score));
                return `
<tr data-report-id="${reportId}">
    <td>
        <div class="text-sm font-medium break-all max-w-[340px]">${escapeHtml(item.url || '--')}</div>
        <div class="text-xs text-on-surface-variant mt-1">${escapeHtml(item.company_name || '未关联公司')}</div>
    </td>
    <td><span class="badge ${statusClass}">${escapeHtml(status)}</span></td>
    <td class="font-semibold">${score}</td>
    <td>
        <div class="text-sm font-medium">${escapeHtml(item.username || '--')}</div>
        <div class="text-xs text-on-surface-variant">${escapeHtml(item.user_email || '--')}</div>
    </td>
    <td class="text-on-surface-variant">${escapeHtml(timeAgo(item.created_at))}</td>
    <td class="text-right">
        <button class="btn-preview-diagnostic w-8 h-8 inline-flex items-center justify-center rounded-md hover:bg-blue-50 transition-colors" title="预览报告" data-id="${reportId}">
            <span class="material-symbols-outlined text-slate-400 hover:text-primary text-lg">preview</span>
        </button>
    </td>
</tr>`;
            }).join('');

            tbody.onclick = (e) => {
                const previewBtn = e.target.closest('.btn-preview-diagnostic');
                if (!previewBtn) return;
                e.preventDefault();
                e.stopPropagation();
                loadDiagnosticDetail(previewBtn.dataset.id);
            };

            renderPaginationControls(
                document.getElementById('diagnostics-pagination'),
                data.page || 1,
                data.pages || 1,
                (page) => {
                    diagnosticsPage = page;
                    loadDiagnostics();
                }
            );

            if (selectedDiagnosticReportId) {
                if (items.some(item => item.id === selectedDiagnosticReportId)) {
                    document.querySelector(`#diagnostics-tbody tr[data-report-id="${selectedDiagnosticReportId}"]`)?.classList.add('is-selected');
                }
                await loadDiagnosticDetail(selectedDiagnosticReportId);
            }
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center py-12 text-red-500 text-sm">${escapeHtml(err.message)}</td></tr>`;
            }
            renderDiagnosticDetail(null);
            toast('加载诊断报告列表失败: ' + err.message, 'error');
        }
    }

    async function initDiagnostics() {
        renderTopbar('诊断管理');
        selectedDiagnosticReportId = getAdminSelectionParam('report') || selectedDiagnosticReportId;

        const searchInput = document.getElementById('diagnostics-search');
        const statusFilter = document.getElementById('diagnostics-status-filter');
        const refreshBtn = document.getElementById('diagnostics-refresh');
        const detailPanel = document.getElementById('diagnostics-detail');
        const rulesButton = document.getElementById('diagnostics-rules-button');

        let searchTimer;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    diagnosticsFilters.search = searchInput.value.trim();
                    diagnosticsPage = 1;
                    loadDiagnostics();
                }, 300);
            });
        }

        statusFilter?.addEventListener('change', () => {
            diagnosticsFilters.status_filter = statusFilter.value;
            diagnosticsPage = 1;
            loadDiagnostics();
        });

        rulesButton?.addEventListener('click', () => openDiagnosticRulesModal());
        refreshBtn?.addEventListener('click', () => loadDiagnostics());
        detailPanel?.addEventListener('click', async (e) => {
            const retryBtn = e.target.closest('[data-diagnostic-action="retry"]');
            if (retryBtn) {
                await retryDiagnosticReport(retryBtn.dataset.id);
                return;
            }

            const exportMarkdownBtn = e.target.closest('[data-diagnostic-action="export-markdown"]');
            if (exportMarkdownBtn) {
                await exportDiagnosticReport(exportMarkdownBtn.dataset.id, 'markdown');
                return;
            }

            const exportJsonBtn = e.target.closest('[data-diagnostic-action="export-json"]');
            if (exportJsonBtn) {
                await exportDiagnosticReport(exportJsonBtn.dataset.id, 'json');
            }
        });
        await Promise.all([loadDiagnosticRuleConfig(), loadDiagnostics()]);
    }
    // ─── 用户管理页 ──────────────────────────────────────────────────────────
    let userPage = 1;
    let userFilters = { role: '', is_active: '', search: '' };

    function openUserInviteModal() {
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[9998] bg-slate-900/45 flex items-center justify-center p-4';
        overlay.innerHTML = `
<div class="admin-dialog bg-white rounded-2xl shadow-2xl w-full max-w-xl">
    <div class="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
        <div>
            <h3 class="text-lg font-bold font-headline">邀请用户</h3>
            <p class="text-sm text-slate-500 mt-1">创建一个本地账号。当前不会发送外部邮件，请线下同步初始密码。</p>
        </div>
        <button type="button" id="user-invite-close" class="w-9 h-9 rounded-lg hover:bg-slate-50 flex items-center justify-center">
            <span class="material-symbols-outlined text-slate-400">close</span>
        </button>
    </div>
    <form id="user-invite-form" class="p-6 space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">用户名</span>
                <input name="username" autocomplete="username" class="form-input" required minlength="2" maxlength="100" placeholder="例如：ops_admin">
            </label>
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">邮箱</span>
                <input name="email" type="email" autocomplete="email" class="form-input" required placeholder="name@example.com">
            </label>
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">手机号</span>
                <input name="phone" autocomplete="tel" class="form-input" placeholder="可选">
            </label>
            <label class="space-y-2 text-sm">
                <span class="font-semibold text-slate-700">角色</span>
                <select name="role" class="form-input">
                    <option value="user">普通用户</option>
                    <option value="enterprise">企业用户</option>
                    <option value="admin">管理员</option>
                </select>
            </label>
        </div>
        <label class="space-y-2 text-sm block">
            <span class="font-semibold text-slate-700">初始密码</span>
            <input name="password" type="password" autocomplete="new-password" class="form-input" required minlength="6" maxlength="128" placeholder="至少 6 位">
        </label>
        <div class="rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-3 text-xs leading-5 text-amber-700">
            管理员创建账号后，系统只保存本地登录凭证，不会触发邮件、短信或外部通知。
        </div>
        <div class="flex items-center justify-end gap-3 pt-2">
            <button type="button" id="user-invite-cancel" class="btn admin-btn-secondary px-5 py-2 rounded-lg text-sm">取消</button>
            <button type="submit" id="user-invite-submit" class="btn btn-primary px-5 py-2 rounded-lg text-sm">创建用户</button>
        </div>
    </form>
</div>`;
        document.body.appendChild(overlay);

        const close = bindAdminDialogOverlay(overlay, () => overlay.remove());
        overlay.querySelector('#user-invite-close')?.addEventListener('click', close);
        overlay.querySelector('#user-invite-cancel')?.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('#user-invite-form')?.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submitBtn = overlay.querySelector('#user-invite-submit');
            if (submitBtn) submitBtn.disabled = true;
            const form = new FormData(event.currentTarget);
            const payload = {
                username: String(form.get('username') || '').trim(),
                email: String(form.get('email') || '').trim(),
                phone: String(form.get('phone') || '').trim() || null,
                role: String(form.get('role') || 'user'),
                password: String(form.get('password') || ''),
            };
            try {
                await api('POST', '/api/admin/users', payload);
                toast('用户已创建');
                close();
                userPage = 1;
                await loadUsers();
            } catch (err) {
                toast(err.message, 'error');
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }

    async function loadUsers() {
        const params = new URLSearchParams({ page: userPage, size: 20 });
        if (userFilters.role) params.set('role', userFilters.role);
        if (userFilters.is_active !== '') params.set('is_active', userFilters.is_active);
        if (userFilters.search) params.set('search', userFilters.search);

        const tbody = document.querySelector('#users-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400 text-sm">加载中...</td></tr>';

        const ROLE_BADGE = {
            admin: '<span class="badge badge-error">管理员</span>',
            enterprise: '<span class="badge badge-info">企业用户</span>',
            user: '<span class="badge badge-neutral">普通用户</span>',
        };

        try {
            const data = await api('GET', `/api/admin/users?${params}`);
            const items = data.items || data || [];
            const total = data.total ?? items.length;
            const pages = data.pages || 1;

            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400 text-sm">暂无用户</td></tr>';
                const infoEl = document.querySelector('#users-pagination-info');
                if (infoEl) infoEl.textContent = '共 0 名用户';
                renderPaginationControls(document.getElementById('users-pagination'), 1, 1, () => {});
                return;
            }

            tbody.innerHTML = items.map(u => {
                const isCurrentUser = Boolean(currentAdminUser?.id && u.id === currentAdminUser.id);
                const safeUsername = escapeHtml(u.username || '未命名用户');
                const safeEmail = escapeHtml(u.email || '--');
                const initials = escapeHtml((u.username || u.email || '--').slice(0, 2).toUpperCase());
                const statusDot = u.is_active
                    ? `<span class="w-1.5 h-1.5 rounded-full bg-green-500"></span><span class="text-sm">活跃</span>`
                    : `<span class="w-1.5 h-1.5 rounded-full bg-slate-300"></span><span class="text-sm text-on-surface-variant">停用</span>`;
                return `
<tr data-uid="${u.id}">
    <td>
        <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-xs font-bold text-primary">${initials}</div>
            <div>
                <p class="font-semibold text-sm flex flex-wrap items-center gap-1.5">${safeUsername}${isCurrentUser ? '<span class="badge badge-info">当前账号</span>' : ''}</p>
                <p class="text-xs text-on-surface-variant">${safeEmail}</p>
            </div>
        </div>
    </td>
    <td>
        <select class="user-role-select form-input w-auto text-xs py-1" data-uid="${u.id}" ${isCurrentUser ? 'disabled title="当前管理员不能修改自己的角色"' : ''}>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option>
            <option value="enterprise" ${u.role === 'enterprise' ? 'selected' : ''}>企业用户</option>
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>普通用户</option>
        </select>
    </td>
    <td><span class="flex items-center gap-1.5">${statusDot}</span></td>
    <td class="font-medium">--</td>
    <td class="text-on-surface-variant">${formatDate(u.created_at)}</td>
    <td class="text-right">
        <div class="flex items-center justify-end gap-1">
            <button class="btn-toggle-active w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent" title="${isCurrentUser ? '当前管理员不能停用自己' : `${u.is_active ? '停用' : '启用'}账号`}" data-uid="${u.id}" data-active="${u.is_active}" ${isCurrentUser ? 'disabled data-self="true"' : ''}>
                <span class="material-symbols-outlined ${isCurrentUser ? 'text-slate-300' : 'text-slate-400'} text-lg">${u.is_active ? 'block' : 'check_circle'}</span>
            </button>
        </div>
    </td>
</tr>`;
            }).join('');

            const infoEl = document.querySelector('#users-pagination-info');
            if (infoEl) infoEl.textContent = `共 ${total} 名用户`;
            renderPaginationControls(document.getElementById('users-pagination'), userPage, pages, (p) => {
                userPage = p;
                loadUsers();
            });

        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-12 text-red-500 text-sm">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function initUsers() {
        renderTopbar('用户管理');

        const table = document.querySelector('table');
        if (table) table.id = 'users-table';

        const paginationRow = document.querySelector('.flex.items-center.justify-between.px-6.py-4');
        if (paginationRow) {
            const span = paginationRow.querySelector('span');
            if (span) span.id = 'users-pagination-info';
        }

        // 加载真实统计数据
        try {
            const stats = await api('GET', '/api/admin/dashboard');
            const us = stats.user_stats || {};
            const statCards = document.querySelectorAll('.stat-card');
            if (statCards[0]) statCards[0].querySelector('p.text-2xl').textContent = (us.total || 0).toLocaleString();
            if (statCards[1]) statCards[1].querySelector('p.text-2xl').textContent = (us.active || 0).toLocaleString();
            if (statCards[2]) statCards[2].querySelector('p.text-2xl').textContent = (us.admin || 0).toLocaleString();
            if (statCards[3]) statCards[3].querySelector('p.text-2xl').textContent = us.new_today || 0;
        } catch (_) {}

        // 筛选控件
        const searchInput = document.querySelector('input[type="text"]');
        const [roleSelect, statusSelect] = document.querySelectorAll('select.form-input');
        document.getElementById('users-invite-button')?.addEventListener('click', openUserInviteModal);

        if (roleSelect) {
            roleSelect.innerHTML = `
<option value="">全部角色</option>
<option value="admin">管理员</option>
<option value="enterprise">企业用户</option>
<option value="user">普通用户</option>`;
            roleSelect.addEventListener('change', () => {
                userFilters.role = roleSelect.value;
                userPage = 1;
                loadUsers();
            });
        }

        if (statusSelect) {
            statusSelect.innerHTML = `
<option value="">全部状态</option>
<option value="true">活跃</option>
<option value="false">已停用</option>`;
            statusSelect.addEventListener('change', () => {
                userFilters.is_active = statusSelect.value;
                userPage = 1;
                loadUsers();
            });
        }

        let searchTimer;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    userFilters.search = searchInput.value.trim();
                    userPage = 1;
                    loadUsers();
                }, 400);
            });
        }

        // 事件委托
        document.addEventListener('click', async (e) => {
            const toggleBtn = e.target.closest('.btn-toggle-active');
            if (toggleBtn) {
                const uid = toggleBtn.dataset.uid;
                if (currentAdminUser?.id && uid === currentAdminUser.id) {
                    toast('不能停用当前登录的管理员账号', 'error');
                    return;
                }
                const isActive = toggleBtn.dataset.active === 'true';
                const action = isActive ? '停用' : '启用';
                if (!await confirm(`确认${action}此账号？`)) return;
                try {
                    await api('POST', `/api/admin/users/${uid}/toggle-active`);
                    toast(`账号已${action}`);
                    loadUsers();
                } catch (err) { toast(err.message, 'error'); }
            }
        });

        document.addEventListener('change', async (e) => {
            const roleSelect = e.target.closest('.user-role-select');
            if (roleSelect) {
                const uid = roleSelect.dataset.uid;
                const newRole = roleSelect.value;
                if (currentAdminUser?.id && uid === currentAdminUser.id) {
                    toast('不能修改当前登录管理员的角色', 'error');
                    loadUsers();
                    return;
                }
                if (!await confirm(`确认修改此用户角色为「${newRole}」？`)) {
                    loadUsers(); // 还原
                    return;
                }
                try {
                    await api('PUT', `/api/admin/users/${uid}/role`, { role: newRole });
                    toast('角色已更新');
                } catch (err) { toast(err.message, 'error'); loadUsers(); }
            }
        });

        await loadUsers();
    }

    // ─── 系统设置页 ──────────────────────────────────────────────────────────
    async function initSettings() {
        renderTopbar('系统设置');

        let settings = {};
        try {
            settings = await api('GET', '/api/admin/settings');
        } catch (err) {
            toast('加载设置失败: ' + err.message, 'error');
            return;
        }

        let apiPolicyPayload = null;
        try {
            apiPolicyPayload = await api('GET', '/api/admin/api-policy');
            renderApiPolicy(apiPolicyPayload);
        } catch (err) {
            console.warn('[admin] load api policy failed', err);
        }

        let frontendModulesPayload = null;
        try {
            frontendModulesPayload = await api('GET', '/api/admin/frontend-modules');
            renderFrontendModules(frontendModulesPayload);
        } catch (err) {
            console.warn('[admin] load frontend modules failed', err);
        }

        let homepagePayload = null;
        try {
            homepagePayload = await api('GET', '/api/admin/homepage');
            renderHomepage(homepagePayload);
        } catch (err) {
            console.warn('[admin] load homepage settings failed', err);
        }

        let llmProviderPayload = null;
        try {
            llmProviderPayload = await api('GET', '/api/admin/llm-providers');
            renderLlmProviders(llmProviderPayload);
        } catch (err) {
            console.warn('[admin] load LLM providers failed', err);
            const statusEl = document.getElementById('llm-provider-status');
            if (statusEl) statusEl.textContent = 'LLM API 池加载失败：' + err.message;
        }

        // 填充所有 id="setting-{key}" 字段
        const textKeys = ['site_name', 'site_description', 'default_language', 'timezone', 'admin_entry_path',
                          'analytics_tracking_code',
                          'llm_api_key', 'llm_base_url', 'llm_model', 'llm_fallback_model',
                          'codex_api_key', 'codex_base_url', 'codex_model',
                          'openai_api_key', 'google_search_api_key', 'geo_score_version'];
        const checkKeys = ['geo_auto_score', 'geo_score_public'];
        const adminEntryInput = document.getElementById('setting-admin_entry_path');
        const adminEntryOpenLink = document.getElementById('admin-entry-open-link');

        const updateAdminEntryOpenLink = () => {
            if (!adminEntryInput || !adminEntryOpenLink) return;
            try {
                const normalized = normalizeAdminEntryPath(adminEntryInput.value || configuredAdminEntryPath || '/admin');
                adminEntryOpenLink.href = new URL(normalized, `${APP_ORIGIN}/`).toString();
            } catch (_) {
                adminEntryOpenLink.href = withAppOrigin('/admin');
            }
        };

        textKeys.forEach(key => {
            const el = document.getElementById('setting-' + key);
            if (!el || settings[key] === undefined) return;
            const v = settings[key]?.value;
            // API key 字段：后端已脱敏，前端显示占位符
            if (el.dataset.secretInput === 'true') {
                el.value = v ? '••••••••••••••••' : '';
                el.dataset.secretMasked = 'true';
            } else {
                el.value = v ?? '';
            }
        });
        try {
            configuredAdminEntryPath = normalizeAdminEntryPath(settings.admin_entry_path?.value || configuredAdminEntryPath || '/admin');
            if (adminEntryInput && !adminEntryInput.value) adminEntryInput.value = configuredAdminEntryPath;
        } catch (_) {
            configuredAdminEntryPath = '/admin';
            if (adminEntryInput) adminEntryInput.value = '/admin';
        }
        adminEntryInput?.addEventListener('input', updateAdminEntryOpenLink);
        adminEntryInput?.addEventListener('blur', () => {
            try {
                adminEntryInput.value = normalizeAdminEntryPath(adminEntryInput.value);
            } catch (_) {}
            updateAdminEntryOpenLink();
        });
        updateAdminEntryOpenLink();

        checkKeys.forEach(key => {
            const el = document.getElementById('setting-' + key);
            if (el && settings[key] !== undefined) el.checked = !!settings[key]?.value;
        });

        // 显示/隐藏 API Key 按钮
        document.querySelectorAll('.btn-toggle-key').forEach(btn => {
            btn.addEventListener('click', () => {
                const inp = btn.previousElementSibling;
                if (!inp) return;
                if (inp.dataset.secretInput === 'true') {
                    const masked = inp.dataset.secretMasked !== 'false';
                    inp.dataset.secretMasked = masked ? 'false' : 'true';
                    btn.textContent = masked ? '隐藏' : '显示';
                    return;
                }
                if (inp.type === 'password') {
                    inp.type = 'text';
                    btn.textContent = '隐藏';
                } else {
                    inp.type = 'password';
                    btn.textContent = '显示';
                }
            });
        });

        // Tab 切换
        const tabBtns = document.querySelectorAll('#settings-tabs .settings-tab');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                tabBtns.forEach(b => {
                    b.classList.remove('border-primary', 'text-primary');
                    b.classList.add('border-transparent', 'text-on-surface-variant');
                });
                btn.classList.add('border-primary', 'text-primary');
                btn.classList.remove('border-transparent', 'text-on-surface-variant');
                document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
                const panel = document.getElementById('panel-' + tab);
                if (panel) panel.classList.remove('hidden');
            });
        });

        // 取消按钮
        const cancelBtn = document.getElementById('settings-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => initSettings());

        // 保存按钮
        const saveBtn = document.getElementById('settings-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                try {
                    const updates = {};
                    textKeys.forEach(key => {
                        const el = document.getElementById('setting-' + key);
                        if (!el) return;
                        let v = el.value;
                        if (key === 'admin_entry_path') {
                            v = normalizeAdminEntryPath(v);
                            el.value = v;
                        }
                        // 跳过未修改的 API key 占位符
                        if (el.dataset.secretInput === 'true' && v && [...v].every(c => c === '•')) return;
                        if (el.type === 'password' && v && [...v].every(c => c === '•')) return;
                        updates[key] = { value: v };
                    });
                    checkKeys.forEach(key => {
                        const el = document.getElementById('setting-' + key);
                        if (el) updates[key] = { value: el.checked };
                    });
                    saveBtn.textContent = '保存中...';
                    saveBtn.disabled = true;
                    await api('PUT', '/api/admin/settings', updates);
                    if (updates.admin_entry_path) {
                        configuredAdminEntryPath = normalizeAdminEntryPath(updates.admin_entry_path.value);
                        renderSidebar(currentAdminUser);
                        normalizeAdminLinks();
                        updateAdminEntryOpenLink();
                    }
                    toast('设置已保存');
                } catch (err) {
                    toast('保存失败: ' + err.message, 'error');
                } finally {
                    saveBtn.textContent = '保存设置';
                    saveBtn.disabled = false;
                }
            });
        }

        const llmProviderAddBtn = document.getElementById('llm-provider-add');
        if (llmProviderAddBtn) {
            llmProviderAddBtn.onclick = () => {
                const providers = collectLlmProvidersFromDom();
                providers.push({
                    id: `provider-${Date.now().toString(36)}`,
                    name: '备用 API',
                    base_url: 'https://api.deepseek.com',
                    model: 'deepseek-chat',
                    api_key: '',
                    enabled: true,
                    priority: providers.length + 1,
                });
                renderLlmProviders({
                    strategy: document.getElementById('llm-provider-strategy')?.value || 'failover',
                    providers,
                });
            };
        }

        const llmProviderSaveBtn = document.getElementById('llm-provider-save');
        if (llmProviderSaveBtn) {
            llmProviderSaveBtn.onclick = async () => {
                try {
                    const payload = {
                        strategy: document.getElementById('llm-provider-strategy')?.value || 'failover',
                        providers: collectLlmProvidersFromDom(),
                    };
                    if (!payload.providers.length) {
                        toast('请至少配置一个 API', 'warning');
                        return;
                    }
                    llmProviderSaveBtn.textContent = '保存中...';
                    llmProviderSaveBtn.disabled = true;
                    llmProviderPayload = await api('PUT', '/api/admin/llm-providers', payload);
                    renderLlmProviders(llmProviderPayload);
                    toast('API 池已保存');
                } catch (err) {
                    toast('保存 API 池失败: ' + err.message, 'error');
                } finally {
                    llmProviderSaveBtn.textContent = '保存 API 池';
                    llmProviderSaveBtn.disabled = false;
                }
            };
        }

        const apiPolicySaveBtn = document.getElementById('api-policy-save');
        if (apiPolicySaveBtn) {
            apiPolicySaveBtn.onclick = async () => {
                try {
                    apiPolicySaveBtn.textContent = '保存中...';
                    apiPolicySaveBtn.disabled = true;
                    const modules = Array.from(document.querySelectorAll('[data-api-policy-module]:checked'))
                        .map(input => input.value);
                    const payload = {
                        access_mode: document.getElementById('api-policy-access-mode')?.value || 'platform_unlimited',
                        daily_token_limit: Number(document.getElementById('api-policy-daily-limit')?.value || 0),
                        quota_reset_timezone: document.getElementById('api-policy-timezone')?.value || 'Asia/Shanghai',
                        byok_transport_mode: document.getElementById('api-policy-byok-mode')?.value || 'proxy_transient',
                        allow_anonymous_ai_usage: Boolean(document.getElementById('api-policy-allow-anonymous')?.checked),
                        allow_user_byok: Boolean(document.getElementById('api-policy-allow-byok')?.checked),
                        metered_modules: modules,
                    };
                    apiPolicyPayload = await api('PUT', '/api/admin/api-policy', payload);
                    renderApiPolicy(apiPolicyPayload);
                    toast('API 成本策略已保存');
                } catch (err) {
                    toast('保存成本策略失败: ' + err.message, 'error');
                } finally {
                    apiPolicySaveBtn.textContent = '保存成本策略';
                    apiPolicySaveBtn.disabled = false;
                }
            };
        }

        const frontendModulesSaveBtn = document.getElementById('frontend-modules-save');
        if (frontendModulesSaveBtn) {
            frontendModulesSaveBtn.onclick = async () => {
                try {
                    const rows = Array.from(document.querySelectorAll('[data-frontend-module-row]'));
                    const modules = rows.map(row => ({
                        key: row.dataset.moduleKey,
                        enabled: Boolean(row.querySelector('[data-frontend-module-enabled]')?.checked),
                    }));
                    const defaultInput = document.querySelector('[data-frontend-module-default]:checked');
                    const defaultModule = defaultInput?.value || modules.find(item => item.enabled)?.key || '';
                    if (!modules.some(item => item.enabled)) {
                        toast('至少需要保留一个前台模块开启', 'error');
                        return;
                    }
                    if (!modules.some(item => item.key === defaultModule && item.enabled)) {
                        toast('默认入口必须是已开启的前台模块', 'error');
                        return;
                    }
                    frontendModulesSaveBtn.textContent = '保存中...';
                    frontendModulesSaveBtn.disabled = true;
                    frontendModulesPayload = await api('PUT', '/api/admin/frontend-modules', {
                        default_module: defaultModule,
                        modules,
                    });
                    renderFrontendModules(frontendModulesPayload);
                    toast('前台模块配置已保存');
                } catch (err) {
                    toast('保存前台模块失败: ' + err.message, 'error');
                } finally {
                    frontendModulesSaveBtn.textContent = '保存前台模块';
                    frontendModulesSaveBtn.disabled = false;
                }
            };
        }

        const homepageCreateBtn = document.getElementById('homepage-create-release');
        if (homepageCreateBtn) {
            homepageCreateBtn.onclick = async () => {
                const titleEl = document.getElementById('homepage-title');
                const fileEl = document.getElementById('homepage-zip-file');
                const htmlEl = document.getElementById('homepage-html');
                const title = titleEl?.value?.trim() || '';
                const file = fileEl?.files?.[0] || null;
                const html = htmlEl?.value?.trim() || '';
                if (!title) {
                    toast('请填写首页版本名称', 'warning');
                    return;
                }
                if (!file && !html) {
                    toast('请上传 zip 首页包或粘贴 HTML', 'warning');
                    return;
                }
                const form = new FormData();
                form.append('title', title);
                if (file) {
                    form.append('source_type', 'zip_package');
                    form.append('file', file);
                } else {
                    form.append('source_type', 'single_html');
                    form.append('html', html);
                }
                try {
                    homepageCreateBtn.textContent = '生成中...';
                    homepageCreateBtn.disabled = true;
                    await apiForm('POST', '/api/admin/homepage/releases', form);
                    toast('首页预览版本已生成');
                    if (titleEl) titleEl.value = '';
                    if (fileEl) fileEl.value = '';
                    if (htmlEl) htmlEl.value = '';
                    homepagePayload = await api('GET', '/api/admin/homepage');
                    renderHomepage(homepagePayload);
                } catch (err) {
                    toast('生成首页版本失败: ' + err.message, 'error');
                } finally {
                    homepageCreateBtn.textContent = '生成预览版本';
                    homepageCreateBtn.disabled = false;
                }
            };
        }

        const homepageDefaultBtn = document.getElementById('homepage-restore-default');
        if (homepageDefaultBtn) {
            homepageDefaultBtn.onclick = async () => {
                if (!await confirm('确认恢复默认首页？根路径 / 将回到原公司列表首页。')) return;
                try {
                    homepageDefaultBtn.textContent = '恢复中...';
                    homepageDefaultBtn.disabled = true;
                    homepagePayload = await api('POST', '/api/admin/homepage/default');
                    homepagePayload = await api('GET', '/api/admin/homepage');
                    renderHomepage(homepagePayload);
                    toast('已恢复默认首页');
                } catch (err) {
                    toast('恢复默认首页失败: ' + err.message, 'error');
                } finally {
                    homepageDefaultBtn.textContent = '恢复默认首页';
                    homepageDefaultBtn.disabled = false;
                }
            };
        }

        const homepageList = document.getElementById('homepage-release-list');
        if (homepageList) {
            homepageList.onclick = async (event) => {
                const previewBtn = event.target.closest('[data-homepage-preview]');
                const activateBtn = event.target.closest('[data-homepage-activate]');
                const deleteBtn = event.target.closest('[data-homepage-delete]');
                try {
                    if (previewBtn) {
                        await openHomepagePreview(previewBtn.dataset.homepagePreview);
                        return;
                    }
                    if (activateBtn) {
                        if (!await confirm('确认启用这个自定义首页版本？启用后 / 会展示该首页。')) return;
                        activateBtn.disabled = true;
                        homepagePayload = await api('POST', `/api/admin/homepage/releases/${activateBtn.dataset.homepageActivate}/activate`);
                        homepagePayload = await api('GET', '/api/admin/homepage');
                        renderHomepage(homepagePayload);
                        toast('自定义首页已启用');
                        return;
                    }
                    if (deleteBtn) {
                        if (!await confirm('确认删除这个首页版本？删除后不可恢复。')) return;
                        deleteBtn.disabled = true;
                        await api('DELETE', `/api/admin/homepage/releases/${deleteBtn.dataset.homepageDelete}`);
                        homepagePayload = await api('GET', '/api/admin/homepage');
                        renderHomepage(homepagePayload);
                        toast('首页版本已删除', 'warning');
                    }
                } catch (err) {
                    toast(err.message, 'error');
                }
            };
        }

        function isMaskedSecretValue(value) {
            return Boolean(value) && [...String(value).trim()].every(char => char === '•');
        }

        function normalizeProviderId(value, index) {
            const normalized = String(value || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, '-')
                .replace(/^[-_]+|[-_]+$/g, '');
            return (normalized || `provider-${index + 1}`).slice(0, 50);
        }

        function renderLlmProviders(payload) {
            const list = document.getElementById('llm-provider-list');
            const summaryList = document.getElementById('llm-provider-summary-list');
            const strategyEl = document.getElementById('llm-provider-strategy');
            const statusEl = document.getElementById('llm-provider-status');
            if (!list) return;
            const providers = Array.isArray(payload?.providers) ? payload.providers : [];
            document.getElementById('llm-provider-detail-label')?.remove();
            if (strategyEl) strategyEl.value = payload?.strategy || 'failover';
            if (statusEl) {
                const enabled = providers.filter(provider => provider.enabled !== false).length;
                statusEl.textContent = providers.length
                    ? `已配置 ${providers.length} 个 API，启用 ${enabled} 个。API Key 不会在后台明文展示。`
                    : '暂未配置 API，请添加至少一个 OpenAI 兼容接口。';
            }
            if (!providers.length) {
                if (summaryList) {
                    summaryList.innerHTML = `
                        <div class="admin-llm-provider-summary-card">
                            <div class="admin-llm-provider-summary__head">
                                <div>
                                    <div class="admin-llm-provider-summary__title">API 列表</div>
                                    <div class="admin-llm-provider-summary__desc">当前没有可用 API。添加后会在这里形成列表，便于查看、测试和排序。</div>
                                </div>
                                <span class="admin-llm-provider-summary__count">0 个 API</span>
                            </div>
                        </div>`;
                }
                list.innerHTML = `
                    <div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-5 text-sm text-slate-500">
                        暂无 API 配置，点击“添加 API”创建第一个 Provider。
                    </div>`;
                return;
            }
            if (summaryList) {
                summaryList.innerHTML = buildLlmProviderSummary(providers, payload?.strategy || 'failover');
            }
            list.innerHTML = providers.map((provider, index) => buildLlmProviderRow(provider, index)).join('');
            list.insertAdjacentHTML('beforebegin', `
                <div id="llm-provider-detail-label" class="admin-llm-provider-section-label">
                    <span>API 配置明细</span>
                    <span>修改后点击底部“保存 API 池”生效</span>
                </div>
            `);
            list.querySelectorAll('[data-llm-provider-remove]').forEach(btn => {
                btn.onclick = () => {
                    const row = btn.closest('[data-llm-provider-row]');
                    row?.remove();
                    renderLlmProviders({
                        strategy: document.getElementById('llm-provider-strategy')?.value || 'failover',
                        providers: collectLlmProvidersFromDom(),
                    });
                };
            });
            list.querySelectorAll('[data-llm-provider-test]').forEach(btn => {
                btn.onclick = async () => {
                    const row = btn.closest('[data-llm-provider-row]');
                    if (!row) return;
                    await testLlmProviderRow(row, btn);
                };
            });
            summaryList?.querySelectorAll('[data-llm-provider-jump]').forEach(btn => {
                btn.onclick = () => {
                    const row = list.querySelector(`[data-provider-index="${btn.dataset.llmProviderJump}"]`);
                    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    row?.classList.add('is-focused');
                    window.setTimeout(() => row?.classList.remove('is-focused'), 1200);
                };
            });
            summaryList?.querySelectorAll('[data-llm-provider-summary-test]').forEach(btn => {
                btn.onclick = async () => {
                    const row = list.querySelector(`[data-provider-index="${btn.dataset.llmProviderSummaryTest}"]`);
                    if (!row) return;
                    await testLlmProviderRow(row, btn);
                };
            });
        }

        function buildLlmProviderSummary(providers, strategy) {
            const enabled = providers.filter(provider => provider.enabled !== false).length;
            const strategyText = strategy === 'round_robin' ? '轮询分发' : '故障回退';
            const rows = providers.map((provider, index) => {
                const id = normalizeProviderId(provider.id, index);
                const statusText = provider.enabled === false ? '停用' : '启用';
                const hasKey = provider.has_api_key || isMaskedSecretValue(provider.api_key) || Boolean(provider.api_key);
                return `
                    <div class="admin-llm-provider-table__row">
                        <div class="admin-llm-provider-table__name">
                            <strong>${escapeHtml(provider.name || `API ${index + 1}`)}</strong>
                            <span>${escapeHtml(provider.base_url || '--')}</span>
                        </div>
                        <div>
                            <span class="admin-llm-provider-table__cell-muted">${escapeHtml(id)}</span>
                        </div>
                        <div>
                            <span class="admin-llm-provider-table__cell-muted">${escapeHtml(provider.model || '--')}</span>
                        </div>
                        <div>
                            <span class="admin-llm-provider-table__cell-muted">${escapeHtml(provider.priority || index + 1)}</span>
                        </div>
                        <div>
                            <span class="admin-llm-provider-status-pill ${provider.enabled === false ? 'is-disabled' : ''}">${statusText}</span>
                            <span class="admin-llm-provider-key-pill ${hasKey ? '' : 'is-missing'}">${hasKey ? 'Key 已保存' : '缺少 Key'}</span>
                        </div>
                        <div class="admin-llm-provider-table__actions">
                            <button type="button" class="btn admin-btn-secondary px-3 py-2 rounded-lg text-xs" data-llm-provider-summary-test="${index}">测试</button>
                            <button type="button" class="btn admin-btn-secondary px-3 py-2 rounded-lg text-xs" data-llm-provider-jump="${index}">编辑</button>
                        </div>
                    </div>`;
            }).join('');
            return `
                <div class="admin-llm-provider-summary-card">
                    <div class="admin-llm-provider-summary__head">
                        <div>
                            <div class="admin-llm-provider-summary__title">API 列表</div>
                            <div class="admin-llm-provider-summary__desc">当前策略：${strategyText}。列表用于快速查看线路、模型、Key 状态和测试结果。</div>
                        </div>
                        <span class="admin-llm-provider-summary__count">${enabled}/${providers.length} 启用</span>
                    </div>
                    <div class="admin-llm-provider-table">
                        <div class="admin-llm-provider-table__row is-head">
                            <span>API</span>
                            <span>Provider ID</span>
                            <span>模型</span>
                            <span>优先级</span>
                            <span>状态</span>
                            <span class="text-right">操作</span>
                        </div>
                        ${rows}
                    </div>
                </div>`;
        }

        async function testLlmProviderRow(row, button) {
            const meta = row.querySelector('[data-llm-provider-meta]');
            try {
                const provider = collectLlmProviderRow(row, Number(row.dataset.providerIndex || 0));
                const oldText = button.textContent;
                button.dataset.oldText = oldText || '测试';
                button.textContent = '测试中...';
                button.disabled = true;
                if (meta) {
                    meta.className = 'admin-llm-provider-meta';
                    meta.textContent = '正在发送最小测试请求...';
                }
                const result = await api('POST', '/api/admin/llm-providers/test', { provider });
                if (meta) {
                    meta.className = `admin-llm-provider-meta ${result.ok ? 'is-ok' : 'is-error'}`;
                    meta.textContent = result.ok
                        ? `测试通过，${result.latency_ms || 0}ms，返回：${result.content_preview || 'OK'}`
                        : `测试失败，${result.latency_ms || 0}ms，${result.message || '接口不可用'}`;
                }
                toast(result.ok ? 'API 测试通过' : 'API 测试失败', result.ok ? 'success' : 'error');
            } catch (err) {
                if (meta) {
                    meta.className = 'admin-llm-provider-meta is-error';
                    meta.textContent = '测试失败：' + err.message;
                }
                toast('API 测试失败: ' + err.message, 'error');
            } finally {
                button.textContent = button.dataset.oldText || '测试';
                button.disabled = false;
                delete button.dataset.oldText;
            }
        }

        function buildLlmProviderRow(provider, index) {
            const id = normalizeProviderId(provider.id, index);
            const enabled = provider.enabled !== false;
            const priority = Number(provider.priority || index + 1);
            const keyValue = provider.api_key || (provider.has_api_key ? '••••••••••••••••' : '');
            return `
                <div class="admin-llm-provider-card ${enabled ? '' : 'is-disabled'}" data-llm-provider-row data-provider-index="${index}">
                    <div class="admin-llm-provider-card__top">
                        <div class="admin-llm-provider-title">
                            <span class="admin-llm-provider-badge material-symbols-outlined" aria-hidden="true">api</span>
                            <div>
                                <label class="block text-xs font-semibold text-on-surface-variant mb-1.5">API 名称</label>
                                <input type="text" class="form-input" data-provider-field="name" value="${escapeHtml(provider.name || `API ${index + 1}`)}" placeholder="例如 DeepSeek 主线路">
                            </div>
                        </div>
                        <div class="admin-llm-provider-controls">
                            <label class="admin-llm-provider-enabled">
                                <input type="checkbox" data-provider-field="enabled" ${enabled ? 'checked' : ''}>
                                启用
                            </label>
                            <button type="button" class="btn admin-btn-secondary px-3 py-2 rounded-lg text-xs" data-llm-provider-test>测试</button>
                            <button type="button" class="btn admin-btn-secondary px-3 py-2 rounded-lg text-xs" data-llm-provider-remove>删除</button>
                        </div>
                    </div>
                    <div class="admin-llm-provider-grid">
                        <div>
                            <label class="block text-xs font-semibold text-on-surface-variant mb-1.5">Provider ID</label>
                            <input type="text" class="form-input" data-provider-field="id" value="${escapeHtml(id)}" placeholder="deepseek-primary">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-on-surface-variant mb-1.5">优先级</label>
                            <input type="number" min="1" max="999" class="form-input" data-provider-field="priority" value="${escapeHtml(priority)}">
                        </div>
                        <div class="span-2">
                            <label class="block text-xs font-semibold text-on-surface-variant mb-1.5">API Key</label>
                            <input type="text" autocomplete="off" spellcheck="false" class="form-input admin-secret-input" data-secret-input="true" data-secret-masked="true" data-provider-field="api_key" value="${escapeHtml(keyValue)}" placeholder="sk-...">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-on-surface-variant mb-1.5">API Base URL</label>
                            <input type="text" class="form-input" data-provider-field="base_url" value="${escapeHtml(provider.base_url || '')}" placeholder="https://api.deepseek.com">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-on-surface-variant mb-1.5">模型名称</label>
                            <input type="text" class="form-input" data-provider-field="model" value="${escapeHtml(provider.model || '')}" placeholder="deepseek-chat">
                        </div>
                    </div>
                    <div class="admin-llm-provider-meta" data-llm-provider-meta>
                        ${provider.has_api_key ? '已保存 API Key，可直接测试；如需更换，请覆盖输入新 Key。' : '尚未保存 API Key。'}
                    </div>
                </div>`;
        }

        function collectLlmProviderRow(row, index) {
            const read = (field) => row.querySelector(`[data-provider-field="${field}"]`);
            const keyEl = read('api_key');
            const apiKey = keyEl?.value?.trim() || '';
            return {
                id: normalizeProviderId(read('id')?.value, index),
                name: read('name')?.value?.trim() || `API ${index + 1}`,
                base_url: read('base_url')?.value?.trim() || '',
                model: read('model')?.value?.trim() || '',
                api_key: isMaskedSecretValue(apiKey) ? apiKey : apiKey,
                enabled: Boolean(read('enabled')?.checked),
                priority: Number(read('priority')?.value || index + 1),
            };
        }

        function collectLlmProvidersFromDom() {
            return Array.from(document.querySelectorAll('[data-llm-provider-row]'))
                .map((row, index) => collectLlmProviderRow(row, index))
                .filter(provider => provider.base_url || provider.model || provider.api_key || provider.name);
        }

        function renumberLlmProviderPriorities() {
            document.querySelectorAll('[data-llm-provider-row]').forEach((row, index) => {
                row.dataset.providerIndex = String(index);
                const priority = row.querySelector('[data-provider-field="priority"]');
                if (priority && !priority.value) priority.value = String(index + 1);
            });
        }

        function renderApiPolicy(payload) {
            const policy = payload?.policy || payload || {};
            const summary = payload?.summary || {};
            const totalTokensEl = document.querySelector('[data-api-policy-total-tokens]');
            const totalRequestsEl = document.querySelector('[data-api-policy-total-requests]');
            const byokRequestsEl = document.querySelector('[data-api-policy-byok-requests]');
            if (totalTokensEl) totalTokensEl.textContent = Number(summary.total_tokens || 0).toLocaleString();
            if (totalRequestsEl) totalRequestsEl.textContent = Number(summary.total_requests || 0).toLocaleString();
            if (byokRequestsEl) byokRequestsEl.textContent = Number(summary.byok_requests || 0).toLocaleString();

            const accessModeEl = document.getElementById('api-policy-access-mode');
            const limitEl = document.getElementById('api-policy-daily-limit');
            const timezoneEl = document.getElementById('api-policy-timezone');
            const byokModeEl = document.getElementById('api-policy-byok-mode');
            const allowAnonymousEl = document.getElementById('api-policy-allow-anonymous');
            const allowByokEl = document.getElementById('api-policy-allow-byok');
            if (accessModeEl) accessModeEl.value = policy.access_mode || 'platform_unlimited';
            if (limitEl) limitEl.value = policy.daily_token_limit ?? 20000;
            if (timezoneEl) timezoneEl.value = policy.quota_reset_timezone || 'Asia/Shanghai';
            if (byokModeEl) byokModeEl.value = policy.byok_transport_mode || 'proxy_transient';
            if (allowAnonymousEl) allowAnonymousEl.checked = Boolean(policy.allow_anonymous_ai_usage);
            if (allowByokEl) allowByokEl.checked = policy.allow_user_byok !== false;

            const modules = new Set(policy.metered_modules || []);
            document.querySelectorAll('[data-api-policy-module]').forEach(input => {
                input.checked = modules.size ? modules.has(input.value) : true;
            });
        }

        function renderFrontendModules(payload) {
            const list = document.getElementById('frontend-module-list');
            const summaryEl = document.querySelector('[data-frontend-module-summary]');
            if (!list) return;
            const modules = Array.isArray(payload?.modules) ? payload.modules : [];
            const defaultModule = payload?.default_module || modules.find(item => item.enabled !== false)?.key || '';
            const enabledCount = modules.filter(item => item.enabled !== false).length;
            if (summaryEl) {
                const defaultItem = modules.find(item => item.key === defaultModule);
                summaryEl.textContent = `${enabledCount}/${modules.length || 0} 个已开启 · 默认入口：${defaultItem?.name || defaultModule || '--'}`;
            }
            if (!modules.length) {
                list.innerHTML = `
                    <div class="lg:col-span-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                        暂未读取到前台模块配置，请稍后刷新。
                    </div>
                `;
                return;
            }
            list.innerHTML = modules.map(module => {
                const enabled = module.enabled !== false;
                const isDefault = module.key === defaultModule;
                return `
                    <div class="rounded-2xl border ${enabled ? 'border-blue-100 bg-white' : 'border-slate-200 bg-slate-50'} p-4" data-frontend-module-row data-module-key="${escapeHtml(module.key || '')}">
                        <div class="flex items-start justify-between gap-3">
                            <div>
                                <div class="flex items-center gap-2">
                                    <h4 class="text-sm font-extrabold text-slate-900">${escapeHtml(module.name || module.key || '未命名模块')}</h4>
                                    <span class="admin-pill ${enabled ? '' : 'bg-slate-100 text-slate-500'}">${enabled ? '开启' : '关闭'}</span>
                                </div>
                                <p class="mt-1 text-xs text-slate-500">${escapeHtml(module.path || '/')}</p>
                            </div>
                            <label class="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" class="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 peer" data-frontend-module-enabled aria-label="${enabled ? '关闭' : '开启'}${escapeHtml(module.name || module.key || '模块')}" ${enabled ? 'checked' : ''}>
                                <div class="pointer-events-none w-10 h-5 bg-slate-200 rounded-full peer-checked:bg-primary peer-focus:ring-2 peer-focus:ring-primary/20 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5"></div>
                            </label>
                        </div>
                        <p class="mt-3 min-h-[2.5rem] text-xs leading-5 text-slate-500">${escapeHtml(module.description || '')}</p>
                        <label class="mt-4 flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">
                            <input type="radio" name="frontend-default-module" value="${escapeHtml(module.key || '')}" data-frontend-module-default ${isDefault ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
                            <span>设为默认入口</span>
                        </label>
                    </div>
                `;
            }).join('');
            list.querySelectorAll('[data-frontend-module-enabled]').forEach(input => {
                input.addEventListener('change', () => {
                    const row = input.closest('[data-frontend-module-row]');
                    const defaultInput = row?.querySelector('[data-frontend-module-default]');
                    if (defaultInput) {
                        defaultInput.disabled = !input.checked;
                        if (!input.checked && defaultInput.checked) {
                            const nextDefault = list.querySelector('[data-frontend-module-row] [data-frontend-module-enabled]:checked')
                                ?.closest('[data-frontend-module-row]')
                                ?.querySelector('[data-frontend-module-default]');
                            if (nextDefault) nextDefault.checked = true;
                        }
                    }
                });
            });
        }

        function formatBytes(value) {
            const bytes = Number(value || 0);
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        }

        function renderHomepage(payload) {
            const runtime = payload?.runtime || {};
            const releases = Array.isArray(payload?.releases) ? payload.releases : [];
            const active = runtime.mode === 'custom' && runtime.active_release_id;
            const activeRelease = releases.find(item => item.id === runtime.active_release_id);
            const summaryEl = document.querySelector('[data-homepage-summary]');
            const modeEl = document.querySelector('[data-homepage-mode]');
            const activeTitleEl = document.querySelector('[data-homepage-active-title]');
            const companyPathEl = document.querySelector('[data-homepage-company-path]');
            const fallbackEl = document.querySelector('[data-homepage-fallback]');
            const list = document.getElementById('homepage-release-list');

            if (summaryEl) summaryEl.textContent = active ? '自定义首页已启用' : '当前使用默认首页';
            if (modeEl) modeEl.textContent = active ? '自定义首页' : '默认首页';
            if (activeTitleEl) activeTitleEl.textContent = activeRelease?.title || '--';
            if (companyPathEl) companyPathEl.textContent = runtime.company_list_path || '/companies';
            if (fallbackEl) fallbackEl.textContent = runtime.fallback_enabled === false ? '未开启' : '已开启';

            if (!list) return;
            if (!releases.length) {
                list.innerHTML = `
                    <div class="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                        还没有自定义首页版本。上传 zip 或粘贴 HTML 后，可先预览再启用。
                    </div>
                `;
                return;
            }

            list.innerHTML = releases.map(release => {
                const isActive = release.status === 'active';
                const isBuiltin = Boolean(release.is_builtin);
                const statusClass = isActive ? 'bg-green-50 text-green-700' : release.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700';
                const statusText = isActive ? '启用中' : release.status === 'failed' ? '失败' : release.status === 'archived' ? '已归档' : '草稿';
                return `
                    <div class="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                        <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                            <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                    <h4 class="truncate text-sm font-extrabold text-slate-900">${escapeHtml(release.title || '未命名首页')}</h4>
                                    <span class="admin-pill ${statusClass}">${statusText}</span>
                                    ${isBuiltin ? '<span class="admin-pill bg-slate-50 text-slate-600">内置</span>' : ''}
                                </div>
                                <p class="mt-1 text-xs leading-5 text-slate-500">
                                    ${escapeHtml(release.source_type === 'zip_package' ? 'HTML 包' : '单文件 HTML')} ·
                                    ${Number(release.file_count || 0)} 个文件 ·
                                    ${formatBytes(release.extracted_size || release.compressed_size)} ·
                                    ${escapeHtml(timeAgo(release.created_at))}
                                </p>
                                ${release.error_message ? `<p class="mt-2 text-xs text-red-600">${escapeHtml(release.error_message)}</p>` : ''}
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-xs" data-homepage-preview="${escapeHtml(release.id)}">预览</button>
                                ${isActive ? `
                                    <button class="btn btn-primary px-3 py-2 rounded-lg text-xs" disabled>已启用</button>
                                    <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-xs" disabled title="当前启用版本不能删除">当前版本</button>
                                ` : `
                                    <button class="btn btn-primary px-3 py-2 rounded-lg text-xs" data-homepage-activate="${escapeHtml(release.id)}">启用</button>
                                    ${isBuiltin ? `
                                        <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-xs" disabled title="内置首页版本不能删除">内置版本</button>
                                    ` : `
                                        <button class="btn admin-btn-secondary px-3 py-2 rounded-lg text-xs" data-homepage-delete="${escapeHtml(release.id)}">删除</button>
                                    `}
                                `}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function openHomepagePreview(releaseId) {
            if (!releaseId) return;
            const headers = {};
            const token = Auth.get();
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch(`${API_BASE}/api/admin/homepage/releases/${releaseId}/preview`, {
                method: 'GET',
                headers,
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.detail || `预览失败 (${res.status})`);
            }
            const html = await res.text();
            const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank', 'noopener');
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
    }

    // ─── 页面入口检测 ────────────────────────────────────────────────────────
    function detectPage() {
        const path = window.location.pathname;
        if (path.includes('diagnostics')) return 'diagnostics';
        if (path.includes('solutions')) return 'solutions';
        if (path.includes('keywords')) return 'keywords';
        if (path.includes('experts')) return 'experts';
        if (path.includes('companies')) return 'companies';
        if (path.includes('tutorials-edit') || path.includes('content-edit')) return 'tutorials-edit';
        if (path.includes('tutorials') || path.includes('content')) return 'tutorials';
        if (path.includes('users')) return 'users';
        if (path.includes('settings')) return 'settings';
        return 'dashboard';
    }

    async function initPage() {
        try {
            const me = await api('GET', '/api/auth/me');
            if (me.role !== 'admin') {
                Auth.clear();
                showLoginModal('需要管理员权限');
                return;
            }
            currentAdminUser = me;
            await loadConfiguredAdminEntryPath();
            renderSidebar(me);
            normalizeAdminLinks();
            setupAdminPreviewDrawer();

            const page = detectPage();
            if (page === 'dashboard') await initDashboard();
            else if (page === 'companies') await initCompanies();
            else if (page === 'diagnostics') await initDiagnostics();
            else if (page === 'solutions') await initSolutions();
            else if (page === 'keywords') await initKeywords();
            else if (page === 'experts') await initExperts();
            else if (page === 'tutorials') await initContent();
            else if (page === 'tutorials-edit') await initContentEdit();
            else if (page === 'users') await initUsers();
            else if (page === 'settings') await initSettings();

            // 鉴权完成、内容就绪后再显示页面，消除闪跳
            document.body.style.opacity = '1';
        } catch (err) {
            const hadToken = Boolean(Auth.get());
            if (hadToken) Auth.clear();
            currentAdminUser = null;
            showLoginModal(hadToken ? '登录已过期，请重新登录' : undefined);
        }
    }

    // ─── 启动 ────────────────────────────────────────────────────────────────
    // 默认隐藏，等鉴权完成后再显示，防止未授权内容闪现
    document.body.style.opacity = '0';
    document.body.style.transition = 'opacity 0.15s ease';
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPage);
    } else {
        initPage();
    }
})();
