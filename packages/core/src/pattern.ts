/**
 * The `pattern` dialect: the part of regex syntax the generator (faker's `fromRegExp`) really expands, and nothing
 * else. Faker writes anything it does not understand (`\d`, groups, `|`, anchors) into the value as literal text,
 * so such a pattern could never produce a matching string, and re-checking it with a backtracking `RegExp` let a
 * 30-character pattern run for minutes. Patterns are therefore parsed here into a flat list of
 * "one of these characters, between min and max times" and matched in time linear in the value's length.
 *
 * Supported: literal characters, `.`, classes such as `[A-Z0-9]` or `[^a-f]`, and the quantifiers `?`, `*`, `+`,
 * `{n}` and `{n,m}` on a letter, digit, `.` or class.
 */

/** Largest `{n}` / `{n,m}` count: a tiny pattern such as `a{1000000}` would otherwise produce megabyte cells. */
export const MAX_PATTERN_REPEAT = 100;

export class PatternError extends Error {}

interface Token {
  /** Whether a UTF-16 code unit belongs to this atom. */
  has(code: number): boolean;
  min: number;
  max: number;
}

export interface CompiledPattern {
  /** Whole-string match (anchors are implied). */
  test(value: string): boolean;
}

const CLASS_BODY = /^\^?(?:[A-Za-z0-9_]-[A-Za-z0-9_]|[A-Za-z0-9_!@#$&()`.+,/"-])+$/;
const QUANTIFIABLE = /^[.A-Za-z0-9]$/;
const SPECIAL = new Set(["\\", "(", ")", "|", "^", "$", "]", "{", "}", "?", "*", "+"]);

function classToken(body: string): (code: number) => boolean {
  if (!CLASS_BODY.test(body)) {
    throw new PatternError(`unsupported character class [${body}] (use letters, digits, ranges like A-Z and the characters _ - ! @ # $ & ( ) \` . + , / ")`);
  }
  let re: RegExp;
  try {
    re = new RegExp(`[${body}]`);
  } catch {
    throw new PatternError(`invalid character class [${body}]`);
  }
  const ascii = new Uint8Array(128);
  for (let c = 0; c < 128; c++) ascii[c] = re.test(String.fromCharCode(c)) ? 1 : 0;
  return (code) => (code < 128 ? ascii[code] === 1 : re.test(String.fromCharCode(code)));
}

const anyChar = (code: number): boolean => code !== 10 && code !== 13 && code !== 0x2028 && code !== 0x2029;

/** Parse a pattern, throwing `PatternError` (with a message for the schema author) on anything unsupported. */
export function compilePattern(pattern: string): CompiledPattern {
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    let has: (code: number) => boolean;
    let quantifiable = true;
    if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) throw new PatternError(`"[" is never closed`);
      has = classToken(pattern.slice(i + 1, end));
      i = end + 1;
    } else if (ch === ".") {
      has = anyChar;
      i++;
    } else if (SPECIAL.has(ch)) {
      throw new PatternError(
        ch === "\\" || ch === "(" || ch === ")" || ch === "|" || ch === "^" || ch === "$"
          ? `"${ch}" is not supported: escapes, groups, alternatives and anchors cannot be generated (write a class such as [0-9] instead of \\d; the whole value is always matched)`
          : `"${ch}" is not expected here`,
      );
    } else {
      const code = ch.charCodeAt(0);
      has = (c) => c === code;
      quantifiable = QUANTIFIABLE.test(ch);
      i++;
    }
    let min = 1;
    let max = 1;
    const q = pattern[i];
    if (q === "?" || q === "*" || q === "+") {
      if (!quantifiable) throw new PatternError(`"${q}" can only follow a letter, a digit, "." or a class`);
      min = q === "+" ? 1 : 0;
      max = q === "?" ? 1 : Infinity;
      i++;
    } else if (q === "{") {
      const m = /^\{(\d+)(?:,(\d+))?\}/.exec(pattern.slice(i));
      if (!m) throw new PatternError(`"{" must start a count such as {3} or {2,5}`);
      if (!quantifiable) throw new PatternError(`a count can only follow a letter, a digit, "." or a class`);
      min = Number(m[1]);
      max = m[2] === undefined ? min : Number(m[2]);
      if (min > max) throw new PatternError(`{${m[1]},${m[2]}} is out of order`);
      if (max > MAX_PATTERN_REPEAT) throw new PatternError(`a count may be at most ${MAX_PATTERN_REPEAT}`);
      i += m[0].length;
    }
    const next = pattern[i];
    if (next === "?" || next === "*" || next === "+" || next === "{") throw new PatternError(`"${next}" cannot follow another quantifier`);
    tokens.push({ has, min, max });
  }

  const fixed = tokens.every((t) => t.min === t.max);
  const fixedLength = fixed ? tokens.reduce((n, t) => n + t.min, 0) : -1;

  return {
    test(value: string): boolean {
      const n = value.length;
      if (fixed) {
        // The usual case (`[A-Z]{3}-[0-9]{4}`): one pass, nothing allocated.
        if (n !== fixedLength) return false;
        let p = 0;
        for (const t of tokens) {
          for (let k = 0; k < t.min; k++) if (!t.has(value.charCodeAt(p++))) return false;
        }
        return true;
      }
      // reach[p] = some split of the tokens so far consumes exactly the first p characters. One pass per token.
      let reach = new Uint8Array(n + 1);
      reach[0] = 1;
      const run = new Int32Array(n + 1);
      for (const t of tokens) {
        for (let p = n - 1; p >= 0; p--) run[p] = t.has(value.charCodeAt(p)) ? run[p + 1]! + 1 : 0;
        const marks = new Int32Array(n + 2);
        let any = false;
        for (let p = 0; p <= n; p++) {
          if (!reach[p] || run[p]! < t.min) continue;
          marks[p + t.min]!++;
          marks[p + Math.min(run[p]!, t.max) + 1]!--;
          any = true;
        }
        if (!any) return false;
        const next = new Uint8Array(n + 1);
        for (let p = 0, open = 0; p <= n; p++) {
          open += marks[p]!;
          if (open > 0) next[p] = 1;
        }
        reach = next;
        run[n] = 0;
      }
      return reach[n] === 1;
    },
  };
}
