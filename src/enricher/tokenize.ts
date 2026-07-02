/**
 * Lightweight language-aware token stream for the meaningful-change heuristic
 * (PRD-016a). Not a full AST: identifiers, literals, and punctuation are split
 * into coarse tokens suitable for multiset Jaccard comparison.
 */

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[^\s\w]+/g;

/** Tokenize source text into a multiset-friendly token list (lowercased). */
export function tokenizeSource(text: string): string[] {
  const tokens: string[] = [];
  const matches = text.match(TOKEN_RE);
  if (matches === null) return tokens;
  for (const raw of matches) {
    const t = raw.trim().toLowerCase();
    if (t.length > 0) tokens.push(t);
  }
  return tokens;
}

/** Build a multiset frequency map from tokens. */
export function tokenMultiset(tokens: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}
