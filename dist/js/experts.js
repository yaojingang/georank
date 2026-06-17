/**
 * GEOrank - 专家频道
 */
(function () {
    'use strict';

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const API_BASE = ['80', '443', ''].includes(window.location.port)
        ? ''
        : `${window.location.protocol}//${window.location.hostname}:8000`;

    const CATEGORY_META = {
        methodology: { label: '方法论', icon: 'psychology', tags: ['GEO 方法论', '开源项目', '行业标准'] },
        'ai-workflow': { label: 'AI 工作流', icon: 'auto_awesome', tags: ['AI 产品', '独立开发', '内容创作'] },
        'seo-practice': { label: 'SEO/GEO', icon: 'travel_explore', tags: ['搜索营销', '出海 SEO', '中小制造'] },
        'traffic-growth': { label: '流量增长', icon: 'monitoring', tags: ['全域优化', '关键词排名', '企业获客'] },
        overseas: { label: '出海 GEO', icon: 'public', tags: ['海外 GEO', '企业培训', 'AI 应用'] },
        strategy: { label: '策略', icon: 'route', tags: ['路线图', '诊断拆解', '增长节奏'] },
        technical: { label: '技术', icon: 'data_object', tags: ['Schema', 'JSON-LD', '抓取检查'] },
        content: { label: '内容', icon: 'article', tags: ['内容结构', 'FAQ', '可引用事实'] },
        reputation: { label: '品牌治理', icon: 'verified', tags: ['可信来源', '案例证据', '实体识别'] },
        industry: { label: '行业', icon: 'cases', tags: ['行业案例', '竞品对标', '转化页'] },
    };

    const DEFAULT_EXPERTS = [
        {
            slug: 'yao-jingang',
            display_name: '姚金刚',
            avatar_initials: '姚',
            title: '中国知名 GEO 专家',
            category: 'methodology',
            specialty_label: 'GEO 方法论',
            sort_order: 1,
            updated_at: '2026-06-17T00:00:00+08:00',
            summary: '中国知名 GEO 专家，第一届 GEO 大会发起者，《AI营销：从SEO到GEO》作者，GEOFlow 开源项目发起人。',
            keywords: ['GEO 大会', 'GEOFlow', 'GEO 开源', 'GEO 文档', 'AI 营销'],
            paragraphs: [
                '姚金刚是国内较早系统推动 GEO 研究、开源与行业交流的实践者，发起并成功举办中国第一届 GEO 大会，创立国内第一批 GEO 公司，并推动国内早期 GEO 行业标准与方法论建设。',
                '他是 GEO 书籍《AI营销：从SEO到GEO》作者，开源 GEO 项目 GEOFlow 已获得 2.5k star，并免费开源 17 套 GEO Skill。',
                '他发布《GEO白皮书》《GEO蓝皮书》《GEO红皮书》，累计超过 40 万字，访问量超过 10 万，持续把 GEO 研究成果开放给行业。',
                '他发布 GEO 论文《From Citation Selection to Citation Absorption: A Measurement Framework for Generative Engine Optimization Across AI Search Platforms》，围绕 AI 搜索平台的引用选择与引用吸收建立测量框架。',
                '他也是 WaytoAGI 的 GEO 公开课发起者，每月免费分享 GEO 公开课，曾在知名上市公司、独角兽公司任职营销高管。',
            ],
            highlights: [
                '发起并成功举办中国第一届 GEO 大会',
                'GEO 书籍《AI营销：从SEO到GEO》作者',
                '开源 GEO 项目 GEOFlow，已获得 2.5k star',
                '发布《GEO白皮书》《GEO蓝皮书》《GEO红皮书》，累计超过 40 万字，访问量超 10 万',
                '免费开源 17 套 GEO Skill',
                '发布 arXiv GEO 论文，提出跨 AI 搜索平台测量框架',
                'WaytoAGI 的 GEO 公开课发起者',
                '创立国内第一批 GEO 公司',
                '曾在知名上市公司、独角兽公司任职营销高管',
            ],
            links: [
                {
                    label: '阅读 arXiv 论文',
                    href: 'https://arxiv.org/abs/2604.25707',
                },
            ],
        },
        {
            slug: 'qiao-xiangyang',
            display_name: '乔向阳',
            avatar_initials: '乔',
            title: 'AI 产品经理 / AI 自媒体 / 独立开发者 / AI 营销与 GEO 实践者',
            category: 'ai-workflow',
            specialty_label: 'AI 工作流',
            sort_order: 2,
            updated_at: '2026-06-17T00:00:00+08:00',
            summary: '中文 AI 圈中具有代表性的实践型内容创作者，擅长把 AI 前沿信息转化为普通产品经理、创作者、创业者和营销人可理解、可上手的工具判断与工作流方案。',
            keywords: ['AI 产品经理', 'AI 工作流', 'AI 营销', 'GEO 实践', '独立开发'],
            paragraphs: [
                '乔向阳，是中文 AI 圈中具有代表性的实践型内容创作者，核心定位是“AI 产品经理、AI 自媒体、独立开发者、AI 营销与 GEO 实践者”。他曾任字节跳动 / TikTok 商业化 AI 产品经理，也有连续创业、SEO 增长和产品实战背景，主理公众号“向阳乔木推荐看”、X 账号 @vista8、个人站 qiaomu.ai，并在 GitHub 以 @joeseesun 发布多个 AI 工作流项目。',
                '他的内容特点在于把 AI 前沿信息转化为普通产品经理、创作者、创业者和营销人可以理解、可以上手的工具判断与工作流方案。2022 年 ChatGPT 3.5 出现后，他开始密集跟踪 OpenAI、Anthropic、Google、xAI、AI Agent、AI 编程、AI 搜索等方向，并通过 X、公众号、博客和社群持续输出。',
                '乔向阳的主要内容包括 AI 工具与模型实测、AI 编程、独立开发、GEO 与 AI 营销、AI 教育和工作坊。他关注 Codex、Claude、Raycast AI、NotebookLM、Gemini、Sora、即梦、Suno 等工具，并强调工具之间如何组成高效工作流。',
                '在实践层面，他的 GitHub 项目覆盖内容处理、NotebookLM 资料生成、OpenCLI 技能、AI 海报设计、知识网站生成等方向。其中 qiaomu-anything-to-notebooklm、qiaomu-opencli-skills 等项目体现了他把 AI 工具产品化、流程化的能力。',
                '在商业化方向，他参与 GEO 白皮书、GEO 大会，并与姚金刚一起出版 GEO 书籍《AI营销：从SEO到GEO》，把传统 SEO 经验延伸到 AI 搜索时代，关注品牌如何被大模型理解、引用和推荐。',
            ],
            highlights: [
                '曾任字节跳动 / TikTok 商业化 AI 产品经理',
                '持续跟踪 OpenAI、Anthropic、Google、xAI、AI Agent、AI 编程和 AI 搜索',
                '擅长 AI 工具实测、AI 编程、独立开发、GEO 与 AI 营销',
                'GitHub 项目覆盖内容处理、NotebookLM 资料生成、OpenCLI 技能、AI 海报设计和知识网站生成',
                '参与 GEO 白皮书、GEO 大会，并与姚金刚共同出版《AI营销：从SEO到GEO》',
            ],
        },
        {
            slug: 'fu-wei',
            display_name: '夫唯',
            avatar_initials: '夫',
            title: '搜外创始人 / 搜索营销与 GEO 实操专家',
            category: 'seo-practice',
            specialty_label: 'SEO/GEO',
            sort_order: 3,
            updated_at: '2026-06-17T00:00:00+08:00',
            summary: '本名黄凤华，SEOWHY 搜外创始人，深耕系统化 SEO 教学，行业进入 AI 时代后转向谷歌出海 SEO 与 GEO 生成引擎优化研究。',
            keywords: ['搜外', '出海 SEO', '中小制造', '低成本 GEO', '实操方法论'],
            paragraphs: [
                '夫唯，本名黄凤华，国内知名搜索营销专家、SEOWHY 搜外创始人。2008 年创办搜外平台，深耕系统化 SEO 教学，累计培育学员四万余人，大批从业者任职于各类电商与互联网企业，是国内 SEO 行业标杆级导师。',
                '行业迈入 AI 时代后，夫唯重心转向谷歌出海 SEO 与 GEO 生成引擎优化研究，独创搜外派 GEO 落地体系。',
                '该体系立足传统实业与中小工厂实际经营视角，摒弃高额投入玩法，主打低成本落地、长效稳定运营，贴合中小制造企业推广需求，现已成为制造业落地 GEO 普及率最高的实操方法论。',
                '多年行业沉淀，让其打通传统搜索与 AI 智能推荐两套流量逻辑，持续为实体工厂输出适配工业化场景的全域营销方案。',
            ],
            highlights: [
                'SEOWHY 搜外创始人',
                '2008 年创办搜外平台',
                '累计培育 SEO 学员四万余人',
                '独创搜外派 GEO 落地体系',
                '聚焦传统实业、中小工厂、谷歌出海 SEO 与 GEO 落地',
            ],
        },
        {
            slug: 'guangtou-niuge',
            display_name: '光头牛哥',
            avatar_initials: '牛',
            title: 'AI GEO 全域优化专家 / 搜索营销实战专家',
            category: 'traffic-growth',
            specialty_label: '流量增长',
            sort_order: 4,
            updated_at: '2026-06-17T00:00:00+08:00',
            summary: '本名冷洪利，国内资深搜索营销专家、AI GEO 全域优化领军人物，长期深耕 SEO、出海电商 SEO 与豆包生态 GEO 运营。',
            keywords: ['豆包 GEO', '出海 SEO', '全域优化', '流量体系', '企业获客'],
            paragraphs: [
                '光头牛哥，本名冷洪利，国内资深搜索营销专家、AI GEO 全域优化领军人物，SEO 牛人网、抖音头部 GEO IP 曝光率 GEO 创始人。',
                '2010 年创立 SEO 牛人网，依托扎实的技术功底，平台核心关键词百度 SEO 排名连续三年稳居行业第三位，成为国内早期搜索营销领域标杆平台，影响了大批行业从业者。',
                '为深耕一线实战、打磨落地方法论，他后续主导列表网、筑龙网等大型互联网平台流量搭建，成功打造百万 IP 稳定流量体系，落地 1800 万关键词排名经典案例，深度吃透传统搜索引擎流量底层逻辑。',
                '伴随 AI 浪潮全面到来，冷洪利率先布局 GEO 生成引擎优化赛道，同步深耕出海电商 SEO 与豆包生态 GEO 运营两大方向。他深度拆解 GEO 算法规则、内容架构、流量分发、品牌引用与商业投放逻辑，结合二十余年搜索营销实战积淀，重构行业投放模型。',
                '基于海量一线落地经验，他先后编撰推出《出海电商 SEO+GEO 爆量获客实操手册》《豆包 7 日获客实操手册》《豆包 GEO 百问百答》三本行业实战著作，内容摒弃空洞理论，全流程拆解落地玩法，免费对外开放分享。',
                '现阶段，冷洪利聚焦服务大型连锁企业与上市公司，围绕出海 SEO、豆包 GEO 全域布局、内容资产搭建、可信信源打造和投放策略规划，提供一体化解决方案。',
            ],
            highlights: [
                '2010 年创立 SEO 牛人网',
                '主导列表网、筑龙网等大型平台流量搭建',
                '打造百万 IP 稳定流量体系',
                '落地 1800 万关键词排名案例',
                '深耕出海电商 SEO 与豆包生态 GEO 运营',
                '编撰三本 GEO 与 AI 获客实操资料',
                '服务大型连锁企业与上市公司',
            ],
        },
        {
            slug: 'zhang-kai',
            display_name: '张凯',
            avatar_initials: '张',
            title: '海外 GEO 专家 / 企业培训顾问 / AI 应用开发者',
            category: 'overseas',
            specialty_label: '出海 GEO',
            sort_order: 5,
            updated_at: '2026-06-17T00:00:00+08:00',
            summary: '连续创业者、企业培训顾问、AI 应用开发者、海外 GEO 专家，曾服务多家世界 500 强企业数字营销培训项目。',
            keywords: ['海外 GEO', '企业培训', 'AI 应用', '出海企业', 'frevana'],
            paragraphs: [
                '张凯是连续创业者、企业培训顾问、AI 应用开发者、海外 GEO 专家。',
                '作为企业培训顾问期间，他曾服务过腾讯、字节、欧莱雅、蒙牛、上汽、达能等全球 500 强企业关于数字营销领域方向的培训项目。',
                '作为 AI 应用开发者，他曾大量完成各种类型的 AI 应用项目，覆盖 AI 基建、教育培训、营销领域等多个方向。',
                '作为海外 GEO 专家，他任 frevana.com 中国区负责人、flickbloom.com 合伙人、arXiv GEO 相关文章一作，参与服务多家出海企业的 GEO 相关服务，帮助合作伙伴组建 GEO 团队并赋能业务。',
            ],
            highlights: [
                '连续创业者',
                '企业培训顾问，服务过腾讯、字节、欧莱雅、蒙牛、上汽、达能等企业培训项目',
                'AI 应用开发者，覆盖 AI 基建、教育培训、营销等方向',
                'frevana.com 中国区负责人',
                'flickbloom.com 合伙人',
                'arXiv GEO 相关文章一作',
                '参与服务多家出海企业 GEO 项目',
            ],
        },
    ];

    const state = {
        category: 'all',
        query: '',
        sort: 'recommended',
        experts: DEFAULT_EXPERTS,
        activeExpertKey: '',
    };

    function normalize(text) {
        return String(text || '').trim().toLowerCase();
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function uniqueList(items) {
        const seen = new Set();
        return (items || [])
            .map(item => String(item || '').trim())
            .filter(item => {
                if (!item || seen.has(item)) return false;
                seen.add(item);
                return true;
            });
    }

    function expertInitials(expert) {
        const explicit = String(expert?.avatar_initials || '').trim();
        if (explicit) return explicit.slice(0, 4).toUpperCase();
        return String(expert?.display_name || 'EX')
            .replace(/[^A-Za-z\u4e00-\u9fa5]/g, '')
            .slice(0, 2)
            .toUpperCase() || 'EX';
    }

    function expertKey(expert) {
        return String(expert?.slug || expert?.id || '').trim();
    }

    function expertHref(expert) {
        const key = expertKey(expert);
        return key ? `/experts/${encodeURIComponent(key)}` : '/experts';
    }

    function expertTags(expert) {
        const meta = CATEGORY_META[expert.category] || {};
        return uniqueList([
            expert.specialty_label || meta.label || '',
            ...(Array.isArray(expert.keywords) ? expert.keywords : []),
            ...(Array.isArray(expert.expertise) ? expert.expertise : []),
            ...(Array.isArray(meta.tags) ? meta.tags : []),
            'GEO',
        ]).slice(0, 5);
    }

    function searchText(expert) {
        return [
            expert.display_name,
            expert.title,
            expert.summary,
            expert.specialty_label,
            expert.consultation,
            ...(Array.isArray(expert.keywords) ? expert.keywords : []),
            ...(Array.isArray(expert.expertise) ? expert.expertise : []),
            ...(Array.isArray(expert.paragraphs) ? expert.paragraphs : []),
            ...(Array.isArray(expert.highlights) ? expert.highlights : []),
        ].filter(Boolean).join(' ');
    }

    function renderExpertTags(tags) {
        const normalized = uniqueList(tags).slice(0, 5);
        if (!normalized.length) return '';
        return `
            <div class="expert-keyword-tags" aria-label="专家关键词">
                ${normalized.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}
            </div>
        `;
    }

    function renderExpertCards() {
        const grid = $('#expert-list');
        if (!grid) return;

        const cards = state.experts.map(expert => {
            const meta = CATEGORY_META[expert.category] || { label: expert.specialty_label || '专家' };
            return `
                <a class="expert-card" href="${expertHref(expert)}" data-category="${escapeHtml(expert.category || '')}" data-updated-at="${escapeHtml(expert.updated_at || '')}" data-sort-order="${Number(expert.sort_order || 100)}" data-keywords="${escapeHtml(searchText(expert))}">
                    <div class="expert-avatar">${escapeHtml(expertInitials(expert))}</div>
                    <div class="expert-card-main">
                        <div class="expert-card-heading">
                            <h2>${escapeHtml(expert.display_name || '未命名专家')}</h2>
                            <span>${escapeHtml(expert.title || `${meta.label || 'GEO'} 专家`)}</span>
                        </div>
                        <p class="expert-summary">${escapeHtml(expert.summary || '暂无专家介绍')}</p>
                        ${renderExpertTags(expertTags(expert))}
                    </div>
                    <span class="material-symbols-outlined expert-card-arrow" aria-hidden="true">arrow_forward</span>
                </a>
            `;
        }).join('');

        grid.innerHTML = `
            ${cards}
            <div class="experts-empty-state is-hidden" data-experts-empty role="status" aria-live="polite">
                <h2>没有匹配的专家</h2>
                <p>可以换一个关键词，或切回“全部”后重新筛选。</p>
            </div>
        `;
        sortExpertCards();
        updateDirectionCounts();
        applyFilters();
    }

    function updateDirectionCounts() {
        const counts = { all: state.experts.length };
        state.experts.forEach(expert => {
            const category = expert.category || '';
            if (category) counts[category] = (counts[category] || 0) + 1;
        });
        $$('[data-expert-count]').forEach(item => {
            const key = item.dataset.expertCount || 'all';
            item.textContent = String(counts[key] || 0);
        });
    }

    function sortExpertCards() {
        const grid = $('#expert-list');
        const emptyState = $('[data-experts-empty]');
        if (!grid) return;
        const cards = $$('.expert-card', grid);
        const sorted = [...cards].sort((a, b) => {
            if (state.sort === 'recent') {
                const aTime = Date.parse(a.dataset.updatedAt || '') || 0;
                const bTime = Date.parse(b.dataset.updatedAt || '') || 0;
                if (aTime !== bTime) return bTime - aTime;
            }
            return Number(a.dataset.sortOrder || 100) - Number(b.dataset.sortOrder || 100);
        });
        sorted.forEach(card => grid.insertBefore(card, emptyState || null));
    }

    function applyFilters() {
        const query = normalize(state.query);
        let visibleCount = 0;

        $$('.expert-card').forEach(card => {
            const category = card.dataset.category || '';
            const haystack = normalize([
                card.textContent || '',
                card.dataset.keywords || '',
            ].join(' '));
            const categoryMatched = state.category === 'all' || category === state.category;
            const queryMatched = !query || haystack.includes(query);
            const isVisible = categoryMatched && queryMatched;
            card.classList.toggle('is-hidden', !isVisible);
            if (isVisible) visibleCount += 1;
        });

        const emptyState = $('[data-experts-empty]');
        if (emptyState) emptyState.classList.toggle('is-hidden', visibleCount > 0);
    }

    function findExpertByKey(key) {
        const normalizedKey = decodeURIComponent(String(key || '')).trim();
        if (!normalizedKey) return null;
        return state.experts.find(expert => {
            return expertKey(expert) === normalizedKey || String(expert.id || '') === normalizedKey;
        }) || null;
    }

    function getRequestedExpertKey() {
        const params = new URLSearchParams(window.location.search);
        const fromQuery = params.get('expert') || params.get('slug') || '';
        if (fromQuery) return fromQuery;

        const segments = window.location.pathname.split('/').filter(Boolean);
        const expertIndex = segments.lastIndexOf('experts');
        if (expertIndex >= 0 && segments[expertIndex + 1]) {
            return segments[expertIndex + 1];
        }
        return '';
    }

    function setViewMode(mode) {
        const listView = $('[data-experts-list-view]');
        const detailView = $('[data-expert-detail-view]');
        if (listView) listView.classList.toggle('is-hidden', mode === 'detail');
        if (detailView) detailView.classList.toggle('is-hidden', mode !== 'detail');
    }

    function updateDocumentMeta(expert) {
        const meta = document.querySelector('meta[name="description"]');
        if (!expert) {
            document.title = 'GEO 专家频道 - GEOrank';
            if (meta) meta.setAttribute('content', 'GEOrank 专家频道，推荐 GEO 与 AI 搜索相关专家介绍。');
            return;
        }
        document.title = `${expert.display_name} - GEO 专家频道 - GEOrank`;
        if (meta) meta.setAttribute('content', expert.summary || `${expert.display_name} 的 GEO 专家介绍。`);
    }

    function renderDetailLinks(expert) {
        if (!Array.isArray(expert.links) || !expert.links.length) return '';
        return `
            <div class="expert-detail-links">
                ${expert.links.map(link => `
                    <a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">
                        ${escapeHtml(link.label || '查看资料')}
                        <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                    </a>
                `).join('')}
            </div>
        `;
    }

    function renderDetail(expert) {
        const detailView = $('[data-expert-detail-view]');
        if (!detailView) return;

        if (!expert) {
            setViewMode('detail');
            updateDocumentMeta(null);
            detailView.innerHTML = `
                <a class="expert-back-link" href="/experts">
                    <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
                    返回专家列表
                </a>
                <div class="expert-not-found">
                    <h1>没有找到这位专家</h1>
                    <p>可以返回专家频道，查看当前已收录的 GEO 与 AI 实践专家。</p>
                </div>
            `;
            return;
        }

        const meta = CATEGORY_META[expert.category] || { label: expert.specialty_label || '专家', icon: 'person_search' };
        const paragraphs = Array.isArray(expert.paragraphs) && expert.paragraphs.length
            ? expert.paragraphs
            : [expert.summary, expert.consultation].filter(Boolean);
        const highlights = uniqueList([
            ...(Array.isArray(expert.highlights) ? expert.highlights : []),
            ...(Array.isArray(expert.expertise) ? expert.expertise : []),
        ]);

        setViewMode('detail');
        updateDocumentMeta(expert);
        detailView.innerHTML = `
            <a class="expert-back-link" href="/experts">
                <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
                返回专家列表
            </a>

            <article class="expert-detail-card">
                <header class="expert-detail-hero">
                    <div class="expert-detail-avatar">${escapeHtml(expertInitials(expert))}</div>
                    <div>
                        <p class="experts-eyebrow">${escapeHtml(meta.label || expert.specialty_label || 'GEO Expert')}</p>
                        <h1>${escapeHtml(expert.display_name || '未命名专家')}</h1>
                        <p class="expert-detail-title">${escapeHtml(expert.title || 'GEO 专家')}</p>
                        ${renderExpertTags(expertTags(expert))}
                    </div>
                </header>

                <section class="expert-detail-section">
                    <h2>专家介绍</h2>
                    <div class="expert-detail-body">
                        ${paragraphs.map(item => `<p>${escapeHtml(item)}</p>`).join('')}
                    </div>
                    ${renderDetailLinks(expert)}
                </section>

                ${highlights.length ? `
                    <section class="expert-detail-section">
                        <h2>代表经历与能力</h2>
                        <ul class="expert-highlight-list">
                            ${highlights.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
                        </ul>
                    </section>
                ` : ''}
            </article>
        `;
    }

    function isBuiltInExpertSet(items) {
        if (!Array.isArray(items) || !items.length) return false;
        const names = new Set(items.map(item => String(item.display_name || '').trim()));
        return DEFAULT_EXPERTS.every(expert => names.has(expert.display_name));
    }

    function normalizeApiExpert(apiExpert) {
        const builtIn = DEFAULT_EXPERTS.find(expert => expert.display_name === apiExpert.display_name);
        return {
            ...(builtIn || {}),
            id: apiExpert.id || builtIn?.id,
            slug: builtIn?.slug || apiExpert.id,
            display_name: apiExpert.display_name || builtIn?.display_name || '未命名专家',
            avatar_initials: apiExpert.avatar_initials || builtIn?.avatar_initials,
            title: apiExpert.title || builtIn?.title || 'GEO 专家',
            category: builtIn?.category || apiExpert.category || 'methodology',
            specialty_label: apiExpert.specialty_label || builtIn?.specialty_label || '',
            summary: apiExpert.summary || builtIn?.summary || '',
            expertise: Array.isArray(apiExpert.expertise) ? apiExpert.expertise : builtIn?.expertise,
            keywords: Array.isArray(apiExpert.keywords) && apiExpert.keywords.length ? apiExpert.keywords : builtIn?.keywords,
            consultation: apiExpert.consultation || builtIn?.consultation || '',
            sort_order: builtIn?.sort_order || apiExpert.sort_order || 100,
            updated_at: apiExpert.updated_at || builtIn?.updated_at,
        };
    }

    async function loadPublishedExperts() {
        try {
            const response = await fetch(`${API_BASE}/api/experts?size=100`, { headers: { Accept: 'application/json' } });
            if (!response.ok) return;
            const data = await response.json();
            if (!isBuiltInExpertSet(data.items)) return;
            state.experts = data.items.map(normalizeApiExpert)
                .sort((a, b) => Number(a.sort_order || 100) - Number(b.sort_order || 100));
            renderPage();
        } catch (_) {
            // 静态内置专家资料会继续作为前台兜底，不打断用户浏览。
        }
    }

    function renderPage() {
        if (state.activeExpertKey) {
            const expert = findExpertByKey(state.activeExpertKey);
            renderDetail(expert);
            return;
        }
        setViewMode('list');
        updateDocumentMeta(null);
        renderExpertCards();
    }

    function bindFilters() {
        $$('[data-expert-filter]').forEach(button => {
            button.addEventListener('click', () => {
                state.category = button.dataset.expertFilter || 'all';
                $$('[data-expert-filter]').forEach(item => {
                    const isActive = (item.dataset.expertFilter || 'all') === state.category;
                    item.classList.toggle('is-active', isActive);
                    item.setAttribute('aria-pressed', String(isActive));
                });
                applyFilters();
            });
        });

        $$('[data-expert-sort]').forEach(button => {
            button.addEventListener('click', () => {
                state.sort = button.dataset.expertSort || 'recommended';
                $$('[data-expert-sort]').forEach(item => {
                    const isActive = (item.dataset.expertSort || 'recommended') === state.sort;
                    item.classList.toggle('is-active', isActive);
                    item.setAttribute('aria-pressed', String(isActive));
                });
                sortExpertCards();
                applyFilters();
            });
        });

        $('#expert-search')?.addEventListener('input', event => {
            state.query = event.target.value;
            applyFilters();
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        state.activeExpertKey = getRequestedExpertKey();
        bindFilters();
        renderPage();
        loadPublishedExperts();
    });
})();
