function escapeRegex(char: string): string {
  return /[.*+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

export function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else {
      regex += escapeRegex(char);
    }
  }
  regex += "$";
  return new RegExp(regex);
}

export function splitPatterns(value: string): string[] {
  return value.split(",").map(p => p.trim()).filter(Boolean);
}

export function matchesAnyPattern(input: string, patterns: string[]): boolean {
  return patterns.some(pattern => globToRegExp(pattern).test(input));
}
