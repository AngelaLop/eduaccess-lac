/**
 * SQL validator for /api/ask.
 * Guards: SELECT-only, single allowed view, LIMIT required, no injection vectors.
 * Designed to be unit-testable — every check is a named function.
 * Codex second-pass review target.
 */

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

const ALLOWED_VIEW = 'v_panama_indicators';
const MAX_LIMIT = 50;

/** Strip single-line and block comments before any other check. */
export function stripComments(sql: string): string {
  // Block comments /* ... */
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Single-line comments -- ...
  s = s.replace(/--[^\n]*/g, ' ');
  return s;
}

export function checkStartsWithSelect(sql: string): ValidationResult {
  if (/^\s*SELECT\b/i.test(sql)) return { ok: true };
  return { ok: false, reason: 'Query must start with SELECT.' };
}

export function checkNoSemicolon(sql: string): ValidationResult {
  if (/;/.test(sql)) return { ok: false, reason: 'Query must not contain semicolons.' };
  return { ok: true };
}

export function checkAllowedView(sql: string): ValidationResult {
  // Must reference the allowed view
  if (!new RegExp(`\\b${ALLOWED_VIEW}\\b`, 'i').test(sql)) {
    return {
      ok: false,
      reason: `Query must reference ${ALLOWED_VIEW}.`,
    };
  }

  // Must NOT reference any other table or view (catches FROM foo, JOIN foo, etc.)
  // Strip the allowed view name first, then look for remaining FROM/JOIN targets
  const withoutAllowed = sql.replace(new RegExp(`\\b${ALLOWED_VIEW}\\b`, 'gi'), '__VIEW__');
  const otherRelation = withoutAllowed.match(
    /\b(?:FROM|JOIN)\s+(?!__VIEW__)([a-zA-Z_][a-zA-Z0-9_]*)/i
  );
  if (otherRelation) {
    return {
      ok: false,
      reason: `Query may only reference ${ALLOWED_VIEW}. Found: ${otherRelation[1]}`,
    };
  }

  return { ok: true };
}

export function checkHasLimit(sql: string): ValidationResult {
  const match = sql.match(/\bLIMIT\s+(\d+)/i);
  if (!match) return { ok: false, reason: `Query must include LIMIT (max ${MAX_LIMIT}).` };
  const n = parseInt(match[1], 10);
  if (n > MAX_LIMIT) {
    return { ok: false, reason: `LIMIT must be ${MAX_LIMIT} or less (got ${n}).` };
  }
  return { ok: true };
}

export function checkNoDangerousFunctions(sql: string): ValidationResult {
  const patterns: [RegExp, string][] = [
    [/\bpg_/i,             'pg_* functions are not allowed.'],
    [/\binformation_schema\b/i, 'information_schema access is not allowed.'],
    [/\bpg_catalog\b/i,    'pg_catalog access is not allowed.'],
    [/\\copy\b/i,          '\\copy is not allowed.'],
    [/\bcopy\s*\(/i,       'COPY() is not allowed.'],
    [/\bDROP\b/i,          'DDL is not allowed.'],
    [/\bTRUNCATE\b/i,      'DDL is not allowed.'],
    [/\bINSERT\b/i,        'DML is not allowed.'],
    [/\bUPDATE\b/i,        'DML is not allowed.'],
    [/\bDELETE\b/i,        'DML is not allowed.'],
    [/\bCREATE\b/i,        'DDL is not allowed.'],
    [/\bALTER\b/i,         'DDL is not allowed.'],
    [/\bGRANT\b/i,         'DCL is not allowed.'],
    [/\bEXECUTE\b/i,       'EXECUTE is not allowed.'],
  ];

  for (const [pattern, reason] of patterns) {
    if (pattern.test(sql)) return { ok: false, reason };
  }
  return { ok: true };
}

/** Run all checks in order. Returns the first failure or ok. */
export function validateSQL(rawSql: string): ValidationResult {
  const sql = stripComments(rawSql);

  const checks = [
    checkNoSemicolon(sql),
    checkStartsWithSelect(sql),
    checkAllowedView(sql),
    checkHasLimit(sql),
    checkNoDangerousFunctions(sql),
  ];

  for (const result of checks) {
    if (!result.ok) return result;
  }
  return { ok: true };
}
