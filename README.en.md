# GEOrank

[简体中文](README.md) | English

GEOrank is an open-source workbench for Generative Engine Optimization. It helps teams diagnose AI search visibility, turn insights into Q&A and action plans, expand keyword assets, generate structured content tools, and manage the workflow through a self-hosted admin console.

This repository includes the product code, engineering structure, configuration templates, and demo data required to run GEOrank locally. It does not include private production data, real expert profiles, real tutorial assets, user conversations, generated customer plans, keyword packs, database dumps, object storage files, or API keys.

## Why GEOrank?

Search is moving from traditional result pages to AI answers. Users increasingly ask systems such as ChatGPT, Claude, Perplexity, and Gemini directly instead of clicking through search result pages.

That creates a new set of questions:

- Can AI systems accurately understand your company, products, and expertise?
- Is your website structured in a way that can be summarized, cited, and recommended by AI systems?
- Should your team prioritize Schema, page structure, metadata, citation signals, or content readability?
- How can a diagnostic report become an executable 30/60/90-day action plan?
- How can keywords, questions, tutorials, tools, and expert resources become reusable assets?
- How can an open-source system support user-owned API keys and reduce platform operating costs?

GEOrank turns those disconnected tasks into a structured workflow: diagnose, ask, plan, expand, structure, and manage.

The open-source build shows the built-in GEO workbench homepage at `/` by default. The original company directory remains available at `/companies`, and you can upload or switch custom homepage releases from the admin settings panel.

## Use Cases

- **GEO research and market tracking**: organize companies, tools, services, experts, tutorials, and examples.
- **AI visibility diagnostics**: evaluate whether a website can be understood, cited, and recommended by AI search systems.
- **Brand and content planning**: generate executable GEO plans from goals, constraints, resources, and website context.
- **Keyword and question assets**: expand business terms into questions, scenarios, commercial-intent keywords, and recommendation patterns.
- **AI-readable content production**: generate JSON-LD, llms.txt, GEO titles, and knowledge-base drafts.
- **Self-hosted GEO platform**: configure API providers, modules, usage policy, custom homepage releases, and analytics snippets.

## Features

| Module | Description |
|---|---|
| Company Directory | Collect, review, categorize, and publish GEO-related companies, tools, services, and examples |
| Website Diagnostics | Evaluate Schema, page structure, metadata, content readability, citation signals, and AI search visibility |
| AI Q&A | Generate structured answers around GEO, AI search, and brand visibility with company and diagnostic context |
| GEO Action Plans | Generate executable 30/60/90-day optimization plans from goals, websites, resources, and constraints |
| Keyword Expansion | Build reusable keyword assets across topics, questions, scenarios, commercial intent, and recommendation patterns |
| GEO Tools | Generate JSON-LD, llms.txt, GEO titles, AI-friendliness checks, and knowledge-base drafts |
| Experts | Present public expert profiles, expertise areas, and consultation directions |
| Tutorials | Organize GEO knowledge, technical markup, content structure, governance, and practical examples |
| Admin Console | Manage content, settings, API providers, usage policy, modules, homepage releases, and analytics snippets |

## Architecture

GEOrank is a monorepo with a static frontend, a Next.js 2.0 migration path, a FastAPI backend, and shared packages.

- **Frontend**: the 3009 static frontend is the current experience baseline, with a Next.js App Router migration path.
- **Admin**: Next.js admin console for companies, diagnostics, Q&A, keywords, experts, tutorials, users, and settings.
- **Backend**: FastAPI, SQLAlchemy, Alembic, Celery.
- **Data services**: PostgreSQL, Redis, Qdrant, Neo4j, MinIO.
- **AI layer**: OpenAI-compatible chat and embedding providers with configurable API pools.
- **Tooling**: pnpm workspace, Turborepo, OpenAPI SDK, Docker Compose.

## Local Development

```bash
pnpm install
cp .env.example .env
docker compose up -d

# Web app
pnpm dev:web

# Admin app
pnpm dev:admin
```

AI-powered features require an OpenAI-compatible model provider. Configure your provider in `.env` or in the admin settings panel after the backend is running.

## Open Source Boundary

This repository only contains product code, engineering structure, configuration templates, and demo data.

It does not include:

- Real API keys.
- Production databases, vector stores, graph data, or object storage files.
- Real expert profiles.
- Real tutorial content.
- User conversations.
- Customer plans or diagnostic records.
- Keyword packs or commercial datasets.
- Runtime custom-homepage releases uploaded by users through the admin console, except for the built-in default homepage included with the repository.

## Disclaimer

GEOrank is a research and engineering project for Generative Engine Optimization. It helps teams analyze and improve AI search visibility, but it does not sell rankings, guarantee model recommendations, or represent any AI search provider.

## License

Apache-2.0
