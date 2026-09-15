import { createHash } from "node:crypto";
import type { Evidence } from "@testknowledge/model";
import type { ProjectScope, SourceAdapter, SourceFile } from "@testknowledge/core";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export class MarkdownAdapter implements SourceAdapter {
  readonly id = "source.markdown.v1";

  supports(file: SourceFile): boolean {
    return file.type === "project_document" || file.path.endsWith(".md");
  }

  async collect(file: SourceFile, scope: ProjectScope): Promise<Evidence[]> {
    const lines = file.text.split("\n");
    const headings = [...file.text.matchAll(/^#{1,6}\s+(.+)$/gm)];
    if (headings.length === 0) {
      return [this.record(file, scope, "", 1, Math.max(1, lines.length), file.text)];
    }
    return headings.map((heading, index) => {
      const start = (heading.index ?? 0) === 0 ? 1 : file.text.slice(0, heading.index ?? 0).split("\n").length;
      const next = headings[index + 1];
      const end = next ? file.text.slice(0, next.index ?? file.text.length).split("\n").length - 1 : lines.length;
      return this.record(file, scope, heading[1]?.trim() ?? "section", start, Math.max(start, end), lines.slice(start - 1, end).join("\n"));
    });
  }

  private record(file: SourceFile, scope: ProjectScope, symbol: string, start: number, end: number, snippet: string): Evidence {
    const contentHash = hash(snippet);
    return {
      id: `ev_${hash(`${scope.repo}:${file.path}:${symbol}:${start}:${contentHash}`).slice(0, 24)}`,
      sourceType: file.type,
      sourceRef: `${file.path}:${start}`,
      repo: scope.repo,
      revision: scope.revision,
      path: file.path,
      symbol,
      lineStart: start,
      lineEnd: end,
      contentHash,
      extractedAt: new Date().toISOString(),
      extractor: this.id,
      content: snippet,
      confidence: 1,
      payload: { snippet, format: "markdown" },
    };
  }
}
