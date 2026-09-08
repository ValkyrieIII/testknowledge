const identifierPattern = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g;

export function lexicalTokens(value: string): string[] {
  const normalized = value.replace(/[\\/.:#()[\]{}=+\-]/g, " ");
  const tokens = new Set<string>();
  for (const chunk of normalized.split(/\s+/u)) {
    if (!chunk) continue;
    tokens.add(chunk.toLocaleLowerCase());
    for (const part of chunk.replaceAll("_", " ").match(identifierPattern) ?? []) {
      tokens.add(part.toLocaleLowerCase());
    }
    if (typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
      for (const segment of segmenter.segment(chunk)) {
        if (segment.isWordLike && segment.segment.trim()) {
          tokens.add(segment.segment.toLocaleLowerCase());
        }
      }
    }
  }
  return [...tokens];
}

export function searchableText(...values: string[]): string {
  return [...new Set(values.flatMap(lexicalTokens))].join(" ");
}
