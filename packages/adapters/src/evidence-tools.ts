import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { contentHashOf, evidenceId, type EvidenceToolRuntime, type ProjectScope, type ToolRead } from "@testknowledge/core";
import type { Evidence, EvidenceType } from "@testknowledge/model";

/**
 * A repository read as evidence.
 *
 * Every result becomes a real Evidence record, so a fact the model found for itself is cited
 * and checked exactly like a fact the deterministic adapters produced. Model output still has
 * to point at something that exists.
 */

const MAX_FILE_BYTES = 200_000;
const MAX_WALK_ENTRIES = 2000;

function isOutside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

function sourceTypeFor(path: string): EvidenceType {
  if (/\.md$/iu.test(path)) return "project_document";
  if (/(^|\/)(tests?|__tests__)\//iu.test(path) || /(^|\/)test_[^/]*\.py$/iu.test(path) || /_test\.[a-z]+$/iu.test(path)) return "test_code";
  return "production_code";
}

export class RepoEvidenceToolRuntime implements EvidenceToolRuntime {
  readonly id = "tool.repo.read.v1";

  async read(tool: ToolRead, scope: ProjectScope): Promise<Evidence[]> {
    const root = resolve(scope.repo);
    const canonicalRoot = await realpath(root);
    switch (tool.tool) {
      case "read":
        return [await this.readOne(root, canonicalRoot, tool, scope)];
      case "list_dir": {
        const entries = await this.walk(root, canonicalRoot, tool.target);
        return [this.toEvidence(scope, tool.target, `目录 ${tool.target} 下的文件清单`, entries.join("\n"), "project_document")];
      }
      case "glob": {
        const entries = await this.walk(root, canonicalRoot, "");
        const pattern = new RegExp(`^${(tool.target || "").replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*\*/gu, ".*").replace(/\*/gu, "[^/]*").replace(/\?/gu, ".")}$`, "u");
        const matched = entries.filter((entry) => pattern.test(entry));
        return [this.toEvidence(scope, tool.target, `匹配 ${tool.target} 的文件清单`, matched.join("\n"), "project_document")];
      }
      case "grep": {
        const entries = await this.walk(root, canonicalRoot, "");
        const needle = tool.options?.pattern ?? tool.target;
        const hits: string[] = [];
        for (const entry of entries) {
          const text = await this.readText(root, canonicalRoot, entry);
          if (text === null || !text.includes(needle)) continue;
          for (const [index, line] of text.split("\n").entries()) {
            if (line.includes(needle)) hits.push(`${entry}:${index + 1}:${line.trim().slice(0, 200)}`);
          }
        }
        return [this.toEvidence(scope, tool.target, `包含 ${needle} 的位置`, hits.join("\n"), "project_document")];
      }
    }
  }

  private async readText(root: string, canonicalRoot: string, path: string): Promise<string | null> {
    const absolute = resolve(root, path);
    if (isOutside(root, absolute)) return null;
    try {
      const canonical = await realpath(absolute);
      if (isOutside(canonicalRoot, canonical)) return null;
      const info = await stat(canonical);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
      return await readFile(canonical, "utf8");
    } catch {
      return null;
    }
  }

  private async readOne(root: string, canonicalRoot: string, tool: ToolRead, scope: ProjectScope): Promise<Evidence> {
    const text = await this.readText(root, canonicalRoot, tool.target);
    if (text === null) throw new Error(`Cannot read repository path: ${tool.target}`);
    const limit = tool.options?.limit;
    const lines = text.split("\n");
    const selected = typeof limit === "number" && limit > 0 ? lines.slice(0, limit) : lines;
    const body = selected.join("\n");
    return this.toEvidence(scope, tool.target, `读取 ${tool.target}`, body, sourceTypeFor(tool.target), {
      lineStart: 1,
      lineEnd: Math.max(1, selected.length),
      symbol: "",
    });
  }

  private async walk(root: string, canonicalRoot: string, start: string): Promise<string[]> {
    const entries: string[] = [];
    const visit = async (path: string): Promise<void> => {
      if (entries.length >= MAX_WALK_ENTRIES) return;
      const absolute = resolve(root, path);
      if (isOutside(root, absolute)) return;
      let children: string[];
      try {
        const canonical = await realpath(absolute);
        if (isOutside(canonicalRoot, canonical)) return;
        children = await readdir(absolute);
      } catch {
        return;
      }
      for (const child of children.sort()) {
        if (child === ".git" || child === "node_modules") continue;
        const next = path === "" ? child : `${path}/${child}`;
        const info = await stat(join(root, next)).catch(() => null);
        if (!info) continue;
        if (info.isDirectory()) await visit(next);
        else entries.push(next);
        if (entries.length >= MAX_WALK_ENTRIES) return;
      }
    };
    await visit(start);
    return entries;
  }

  private toEvidence(
    scope: ProjectScope,
    target: string,
    summary: string,
    content: string,
    sourceType: EvidenceType,
    span?: { lineStart: number; lineEnd: number; symbol: string },
  ): Evidence {
    const contentHash = contentHashOf(content);
    const sourceRef = span ? `${target}:${span.lineStart}-${span.lineEnd}` : `${target}`;
    return {
      id: evidenceId(scope.repo, `${sourceRef}`, contentHash),
      sourceType,
      sourceRef,
      repo: scope.repo,
      revision: scope.revision,
      path: target === "" ? "." : target,
      symbol: span?.symbol ?? "",
      lineStart: span?.lineStart ?? 1,
      lineEnd: span?.lineEnd ?? Math.max(1, content.split("\n").length),
      contentHash,
      extractedAt: new Date().toISOString(),
      extractor: this.id,
      content,
      confidence: 1,
      payload: { toolRead: { target, summary } },
    };
  }
}
