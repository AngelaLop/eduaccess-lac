# Security Review — Class Prompt (Week 7)

**How to use:** open your project in Claude Code or Codex, paste the prompt block below into your agent. Run during the in-class audit. The prompt asks your agent to *report* — not to make any changes — so you can decide what to fix yourself.

**Time:** 5–15 min depending on project size. Then walk through findings with TAs and your cohort.

---

## The prompt (paste this whole block to your agent)

```
You are doing a security audit on my project. Don't make any changes — just report. Don't read any .env files; use .env.example or the code's references to env vars instead.

Cover these seven layers in order. For each, do the check, then list any issues you find.

1. SECRETS AND ENV VARS
- Run: git log --all -p | grep -iE 'sk-[a-z0-9]{20,}|AIza[a-z0-9_-]{20,}|ghp_[a-z0-9]{20,}|secret.{0,3}[:=]'
- Confirm .env, .env.local, .env.* are all in .gitignore.
- Search source files for hardcoded keys, tokens, passwords, connection strings.
- Check package.json, vercel.json, supabase/config.toml, and any deploy configs for committed secrets.

2. AUTH SURFACES AND RLS
- List every API route or server endpoint in the project.
- For each route, identify: does it require auth? Does it check the user's role/permissions? Does middleware actually run on it (matcher coverage)?
- For Supabase tables: is RLS enabled? Do policies actually check auth.uid() or equivalent? Are there tables holding user data with RLS off?
- Identify any route that the frontend "hides" but the API doesn't actually gate.

3. AI INPUTS AND RATE LIMITS
- Find every place user input flows into an LLM call (Anthropic, OpenAI, Gemini, etc.).
- Is the input bounded? Is there input validation before it reaches the model?
- Is there a rate limit per user / per IP / per key?
- Is there a per-call token cap? A daily token budget?
- Is there a prompt-injection surface (untrusted scraped content reaching the model with tool access)?

4. DEV / PREVIEW / PROD ENVIRONMENTS
- Are dev/preview/prod env vars separated in Vercel/Supabase/Clerk?
- Any preview deployment pointed at production credentials?
- Are sensitive env vars (DATABASE_URL, API keys) scoped to the right environments?

5. PRE-COMMIT (HUSKY) AND CI GATES
- Is there a .husky/ directory? What runs on pre-commit?
- Is there .github/workflows/? Does CI run: lint, types, build, tests, secret scanning, dependency review?
- Is --no-verify referenced anywhere?
- Are lockfiles committed (package-lock.json, pnpm-lock.yaml, yarn.lock)?

6. MONITORING AND ERROR TRACKING
- Is error tracking integrated (Sentry, Axiom, Logflare, Vercel logs)?
- Are LLM calls logged (prompt, model, tool calls, tokens, cost)?
- What gets alerted on, if anything?

7. SUPPLY CHAIN
- Check package.json dependencies. Anything suspicious — typosquats (express-validatr instead of express-validator), low weekly downloads, recently created, single-maintainer?
- Run npm audit (or pnpm audit / yarn audit) and report findings.
- Are there MCP servers configured for the agent? List the tools each MCP server exposes.
- Is there a CLAUDE.md / AGENTS.md deny list for .env, secrets/, etc.?

REPORT FORMAT
For each issue you find, give:
- LAYER (which of the 7)
- LOCATION (file:line if possible, or "config" / "missing")
- SEVERITY (critical / high / medium / low)
- WHAT'S WRONG (one sentence)
- FIX (one sentence with the specific change)

Don't include code snippets longer than 5 lines.
Be honest about what you can't verify without running code (e.g., RLS policies in a hosted DB you can't query, behavior under load).

Close with:
- TOTAL by severity
- THE ONE FIX I'd do first, and why
- ANYTHING THE AGENT SHOULDN'T BE TRUSTED WITH on this project (write access, .env, etc.) — recommend a deny list for the context file.
```
---