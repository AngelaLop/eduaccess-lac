# EduAccess LAC — v1 Summary

**Built:** 2026-04-28 | **Live:** https://eduaccess-lac.vercel.app | **Course:** Design, Build, Ship (MPCS 51238)

## What we built

EduAccess LAC v1 is a deployed, public geo-platform that lets a non-technical user open a URL, see Panama colored by school accessibility, tap a district, and ask the AI assistant a plain-English question about education access — all in under 30 seconds.

## Architecture

The stack is a Next.js 16 (App Router) frontend on Vercel, a Supabase Postgres database, and a Groq-hosted Llama 3.3 70B language model. The data layer holds all 32 scenario combinations from the IDB Panama pilot (2,656 rows across 83 districts), loaded from 32 long-format CSVs computed offline by the IDB Accessibility Platform pipeline. The frontend queries a single curated view (`v_panama_indicators`) using Supabase's anon key with RLS; the AI chat endpoint runs server-side with a service role key and a `run_sql` Postgres function that executes pre-validated SELECT queries only.

The SQL validator (`lib/sql-validator.ts`) enforces six named checks before any query reaches the database: SELECT-only, single allowed view, LIMIT ≤ 50, no semicolons, no DDL/DML, no pg_* functions. The LLM gets two attempts per question; the second attempt receives the validation error as feedback.

Every district panel includes a robustness card answering "how much can we trust this?": data completeness percentage, population source (WorldPop 2023), friction surface (MAP Weiss et al. 2020), and travel-time model (Fast Marching Method on 1 km grid). This directly addresses the TA feedback to explain the robustness of recommendations.

## Known limitations

- Panama only; Honduras and other countries require v2 (Railway pipeline worker)
- Robustness card is static; a scored Robustness Auditor agent ships in v3
- No school-count or poverty-rate indicators in v1 (not in the district-level source tables)
- Map geometry simplified to 3% (471 KB); some island districts may render slightly imprecise borders
- Chat highlights clear on district click; a shared highlight state would be cleaner in v2
