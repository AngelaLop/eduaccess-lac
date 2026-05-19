/**
 * SQL validator for /api/ask.
 * Guards: SELECT-only, single allowed view, LIMIT required, no injection vectors.
 * Designed to be unit-testable — every check is a named function.
 */

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

// The per-district view is the default; /api/ask passes 'v_equity' for the
// equity question path. Both are server-chosen literals, never user input.
const ALLOWED_VIEW = 'v_indicators_adm2';
const MAX_LIMIT = 50;

const ALLOWED_FUNCTIONS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'FLOOR', 'CEIL', 'CEILING',
  'ABS', 'COALESCE', 'NULLIF', 'CAST', 'LEAST', 'GREATEST',
  'LENGTH', 'TRIM', 'LTRIM', 'RTRIM', 'UPPER', 'LOWER', 'CONCAT',
  'SUBSTRING', 'SUBSTR', 'REPLACE', 'TO_CHAR', 'TO_NUMBER',
  'EXTRACT', 'DATE_PART', 'DATE_TRUNC',
  'ARRAY_AGG', 'STRING_AGG', 'BOOL_AND', 'BOOL_OR',
  'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP',
  'PERCENTILE_CONT', 'PERCENTILE_DISC',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE',
  'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
]);

// SQL syntax tokens that appear before ( but are NOT function calls.
// Includes operators (IN, NOT, EXISTS, ...) and clause keywords (WHERE,
// HAVING, AND, ...) since the LLM frequently writes `WHERE (a AND b)` etc.
const NON_FUNCTION_KEYWORDS = new Set([
  'IN', 'NOT', 'EXISTS', 'ANY', 'ALL', 'SOME', 'OVER',
  'FILTER', 'GROUP', 'BETWEEN', 'DISTINCT', 'INTERVAL',
  'WHERE', 'HAVING', 'ON', 'AND', 'OR',
  'CASE', 'WHEN', 'THEN', 'ELSE',
  'SELECT', 'FROM', 'WITH', 'AS', 'BY',
  'UNION', 'INTERSECT', 'EXCEPT',
  'LIKE', 'ILIKE', 'IS', 'VALUES',
  'LIMIT', 'OFFSET', 'USING', 'LATERAL',
]);

/** Strip single-line and block comments, skipping over string literals. */
export function stripComments(sql: string): string {
  let result = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      result += sql[i++];
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          result += sql[i++];
          result += sql[i++];
        } else if (sql[i] === "'") {
          result += sql[i++];
          break;
        } else {
          result += sql[i++];
        }
      }
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      result += ' ';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      result += ' ';
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    result += sql[i++];
  }
  return result;
}

/** Remove all text inside parentheses (any depth) to expose top-level tokens only. */
function stripParens(sql: string): string {
  let depth = 0;
  let result = '';
  for (const ch of sql) {
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth > 0) depth--; }
    else if (depth === 0) result += ch;
  }
  return result;
}

export function checkStartsWithSelect(sql: string): ValidationResult {
  if (/^\s*SELECT\b/i.test(sql)) return { ok: true };
  return { ok: false, reason: 'Query must start with SELECT.' };
}

export function checkNoSemicolon(sql: string): ValidationResult {
  if (/;/.test(sql)) return { ok: false, reason: 'Query must not contain semicolons.' };
  return { ok: true };
}

/**
 * No subqueries / CTEs / LATERAL. checkAllowedView strips parenthesised text
 * before validating relations, so a nested SELECT could otherwise hide a
 * `FROM other_table` from it. Forbidding nesting keeps the single-view
 * guarantee airtight — the query is always one flat SELECT on the view.
 */
export function checkNoSubqueries(sql: string): ValidationResult {
  const selectCount = (sql.match(/\bSELECT\b/gi) ?? []).length;
  if (selectCount > 1) {
    return { ok: false, reason: 'Subqueries and CTEs are not allowed — use a single SELECT.' };
  }
  if (/\b(LATERAL|WITH)\b/i.test(sql)) {
    return { ok: false, reason: 'WITH / LATERAL are not allowed.' };
  }
  return { ok: true };
}

export function checkAllowedView(sql: string, view: string = ALLOWED_VIEW): ValidationResult {
  // Block double-quoted identifiers — could mask relation names
  if (/"[^"]+"/.test(sql)) {
    return { ok: false, reason: 'Double-quoted identifiers are not allowed.' };
  }

  // Must have an explicit FROM <view> at the top level
  if (!new RegExp(`\\bFROM\\s+${view}\\b`, 'i').test(sql)) {
    return { ok: false, reason: `Query must use FROM ${view}.` };
  }

  // Strip parens so EXTRACT(… FROM col) doesn't trigger a false positive on the checks below
  const topLevel = stripParens(
    sql.replace(new RegExp(`\\b${view}\\b`, 'gi'), '__VIEW__')
  );

  // No other relation may follow FROM or JOIN
  const otherRelation = topLevel.match(
    /\b(?:FROM|JOIN)\s+(?!__VIEW__)([a-zA-Z_][a-zA-Z0-9_]*)/i
  );
  if (otherRelation) {
    return { ok: false, reason: `Only ${view} is allowed. Found: ${otherRelation[1]}` };
  }

  // Block comma joins: FROM __VIEW__ [alias], other_table
  const commaJoin = topLevel.match(
    /\bFROM\s+[a-zA-Z_][a-zA-Z0-9_]*(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?\s*,/i
  );
  if (commaJoin) {
    return { ok: false, reason: 'Comma-separated table references are not allowed.' };
  }

  return { ok: true };
}

export function checkHasLimit(sql: string): ValidationResult {
  // Check only the top-level query so a LIMIT inside a subquery doesn't satisfy the requirement
  const topLevel = stripParens(sql);
  const match = topLevel.match(/\bLIMIT\s+(\d+)/i);
  if (match) {
    const n = parseInt(match[1], 10);
    if (n > MAX_LIMIT) {
      return { ok: false, reason: `LIMIT must be ${MAX_LIMIT} or less (got ${n}).` };
    }
    return { ok: true };
  }

  // No LIMIT — only accept it when the query is a single-row aggregate.
  // Conditions: at least one aggregate function in the top-level SELECT
  // clause, no top-level GROUP BY, no window function (OVER). These three
  // together guarantee the query returns exactly one row, so LIMIT adds
  // nothing. stripParens has already collapsed e.g. `SUM(x)` to `SUM`, so
  // the aggregate names appear as standalone tokens we can match cleanly.
  const selectMatch = topLevel.match(/SELECT\s+([\s\S]*?)\s+FROM\s/i);
  const selectClause = selectMatch ? selectMatch[1] : '';
  const hasAggregateInSelect = /\b(COUNT|SUM|AVG|MIN|MAX)\b/i.test(selectClause);
  const hasTopLevelGroupBy = /\bGROUP\s+BY\b/i.test(topLevel);
  const hasTopLevelWindow = /\bOVER\b/i.test(topLevel);
  if (hasAggregateInSelect && !hasTopLevelGroupBy && !hasTopLevelWindow) {
    return { ok: true };
  }
  return { ok: false, reason: `Query must include LIMIT (max ${MAX_LIMIT}).` };
}

export function checkNoDangerousFunctions(sql: string): ValidationResult {
  const patterns: [RegExp, string][] = [
    [/\bpg_/i,                   'pg_* functions are not allowed.'],
    [/\binformation_schema\b/i,   'information_schema access is not allowed.'],
    [/\bpg_catalog\b/i,           'pg_catalog access is not allowed.'],
    [/\\copy\b/i,                 '\\copy is not allowed.'],
    [/\bcopy\s*\(/i,              'COPY() is not allowed.'],
    [/\bdblink\s*\(/i,            'dblink is not allowed.'],
    [/\blo_\w+\s*\(/i,            'Large-object functions are not allowed.'],
    [/\bset_config\s*\(/i,        'set_config is not allowed.'],
    [/\bcurrent_setting\s*\(/i,   'current_setting is not allowed.'],
    [/\bDROP\b/i,                 'DDL is not allowed.'],
    [/\bTRUNCATE\b/i,             'DDL is not allowed.'],
    [/\bINSERT\b/i,               'DML is not allowed.'],
    [/\bUPDATE\b/i,               'DML is not allowed.'],
    [/\bDELETE\b/i,               'DML is not allowed.'],
    [/\bCREATE\b/i,               'DDL is not allowed.'],
    [/\bALTER\b/i,                'DDL is not allowed.'],
    [/\bGRANT\b/i,                'DCL is not allowed.'],
    [/\bEXECUTE\b/i,              'EXECUTE is not allowed.'],
    [/\bPREPARE\b/i,              'PREPARE is not allowed.'],
  ];
  for (const [pattern, reason] of patterns) {
    if (pattern.test(sql)) return { ok: false, reason };
  }
  return { ok: true };
}

/**
 * Multi-country guard: the query must pin country_iso to the active country.
 * Every `country_iso = 'XXX'` literal must equal the active country, and
 * `country_iso` may not be used with IN / != / <> (which could widen the
 * scope). This is the pre-check; /api/ask additionally wraps the view in a
 * server-side country-scoped subquery so the data source is hard-locked
 * regardless of the WHERE clause.
 */
export function checkCountryFilter(sql: string, country: string): ValidationResult {
  if (/\bcountry_iso\s*(?:\bin\b|!=|<>)/i.test(sql)) {
    return { ok: false, reason: "country_iso must be a single = '<country>' filter." };
  }
  const matches = [...sql.matchAll(/\bcountry_iso\s*=\s*'([A-Za-z]{3})'/gi)];
  if (matches.length === 0) {
    return { ok: false, reason: `Query must filter country_iso = '${country}'.` };
  }
  for (const m of matches) {
    if (m[1].toUpperCase() !== country.toUpperCase()) {
      return {
        ok: false,
        reason: `Query filters country_iso = '${m[1]}' but the active country is '${country}'.`,
      };
    }
  }
  return { ok: true };
}

/** Allowlist-based check: every function call must be in the approved set. */
export function checkFunctionAllowlist(sql: string): ValidationResult {
  for (const [, name] of sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const upper = name.toUpperCase();
    if (NON_FUNCTION_KEYWORDS.has(upper)) continue;
    if (!ALLOWED_FUNCTIONS.has(upper)) {
      return { ok: false, reason: `Function '${name}' is not in the allowed list.` };
    }
  }
  return { ok: true };
}

/** Run all checks in order. Returns the first failure or ok. */
export function validateSQL(
  rawSql: string,
  country: string,
  view: string = ALLOWED_VIEW
): ValidationResult {
  const sql = stripComments(rawSql);
  const checks = [
    checkNoSemicolon(sql),
    checkStartsWithSelect(sql),
    checkNoSubqueries(sql),
    checkAllowedView(sql, view),
    checkCountryFilter(sql, country),
    checkHasLimit(sql),
    checkNoDangerousFunctions(sql),
    checkFunctionAllowlist(sql),
  ];
  for (const result of checks) {
    if (!result.ok) return result;
  }
  return { ok: true };
}
