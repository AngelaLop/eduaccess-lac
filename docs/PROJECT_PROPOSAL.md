# Project Proposal: EduAccess LAC

## One-Line Description
An interactive geo-platform with an AI assistant that helps Latin American education ministers make evidence-based decisions about where to build schools and allocate infrastructure budgets.

## The Problem
Education ministries in Latin America and the Caribbean need to decide where to invest limited infrastructure budgets to maximize school access and reduce dropout. Today, this data exists but is buried in spreadsheets, GIS files, and technical reports that policymakers can't easily navigate. A director writing a funding proposal for the IDB shouldn't need to be a GIS expert to answer "which municipalities have the most kids far from a school?" This platform turns 6+ months of rigorous indicator work (532,000+ schools across 21 countries) into a tool that a non-technical minister can open, explore, and use to justify budget decisions in minutes.

## Target User
Directors and technical staff at Ministries of Education in LAC countries. Specifically, the person who sits down to write a school infrastructure investment proposal and needs to identify where new schools would have the greatest impact. They are not GIS specialists. They may not be comfortable with dashboards. They need answers, not tools.

## Core Features (v1)
1. **Interactive country map**: Click on Panama to see a choropleth of municipalities colored by accessibility indicators, powered by MapLibre GL JS
2. **Indicator panel**: Side panel showing key metrics for the selected municipality (% of school-age children within 15/30/60 min of a school, poverty rate, school-age population, schools per capita)
3. **AI data assistant**: A chat interface where users type natural language questions ("rank the top 5 municipalities with the highest proportion of high schoolers more than 30 minutes from a school") and get results displayed on the map, powered by text-to-SQL generation
4. **Guided onboarding**: Pre-built example queries and a default meaningful map view so first-time users immediately see value without figuring out what to click
5. **Municipality detail view**: Click a municipality to see its full indicator profile with contextual data (poverty, population, education levels)

## Tech Stack
- **Frontend**: Next.js (familiar from coursework, supports i18n for multilingual needs)
- **Styling**: Tailwind CSS
- **Map**: MapLibre GL JS (free, open-source, capable of choropleths, popups, and interactive layers)
- **Database**: Supabase (stores indicator tables computed from the existing Python pipeline; enables SQL queries from the AI assistant)
- **Auth**: Not required for v1 (public data platform); Clerk or Supabase Auth can be added later if user accounts become necessary
- **AI/LLM**: Google Gemini 2.5 Flash (free tier) for text-to-SQL generation, with Claude Haiku 4.5 as a fallback if quality is insufficient (~$0.006 per query)
- **Deployment**: Vercel
- **MCP Servers**: Supabase MCP (for database management during development), Playwright MCP (for testing the UI and map interactions)

## Stretch Goals
- **Add more countries**: Honduras, Colombia, and up to 21 nations as their indicators are computed in the existing pipeline
- **Spanish and Portuguese versions**: Full i18n support (critical for actual adoption by LAC ministries)
- **Comparative views**: Side-by-side municipality comparison or country-level rankings
- **Export reports**: Generate PDF/Excel summaries for a selected municipality that a minister can attach to a funding proposal
- **Proactive AI suggestions**: When a user clicks a municipality, the bot offers contextual insights ("This municipality has high walking travel times but low motorized times, suggesting road infrastructure exists but public transport may be lacking")
- **Multiple transport mode toggle**: Switch between walking and motorized accessibility views
- **Temporal analysis**: Show how accessibility changes if a school is hypothetically placed in a specific location

## Biggest Risk
Two main risks:

1. **UX for non-technical users**: The platform must feel simpler than the spreadsheets it replaces, not more complex. If a minister opens it and doesn't understand what they're looking at within 30 seconds, the project fails regardless of how good the data is. Mitigation: build simple, test early and often with real users (classmates, IDB colleagues), and iterate weekly.

2. **AI assistant reliability**: The text-to-SQL bot must generate correct queries. A wrong answer given with confidence to a policymaker making budget decisions is worse than no answer at all. Mitigation: constrain the bot to a known schema with clear column descriptions, validate SQL before execution, and show the query results transparently so users can verify.

## Week 5 Goal
A deployed, working platform showing **Panama** with:
- An interactive MapLibre map where users can click municipalities and see them highlighted
- At least **3 computed indicators** displayed per municipality (e.g., % within 30 min walking, poverty rate, schools per 1,000 school-age children)
- A **working AI chatbot** that can answer at least 5 types of natural language queries by generating SQL against the Supabase indicator tables
- Hosted on Vercel with a shareable URL

This is the "prove the idea works" milestone. If a classmate can open the link, ask the bot a question about Panamanian school access, and get a meaningful answer highlighted on the map, the core concept is validated.
