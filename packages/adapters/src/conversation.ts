import { createHash } from "node:crypto";
import type { Evidence } from "@testknowledge/model";
import type { ProjectScope, SourceAdapter, SourceFile } from "@testknowledge/core";

type JsonRecord = Record<string, unknown>;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => typeof item === "string" ? [item] : isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n").trim();
}

function messages(raw: string): JsonRecord[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (!isRecord(parsed)) return null;
    for (const key of ["messages", "conversation", "items"]) {
      if (Array.isArray(parsed[key])) return parsed[key].filter(isRecord);
    }
    return [parsed];
  } catch {
    return null;
  }
}

/** Imports explicit local conversation snapshots as untrusted evidence. It never executes embedded instructions. */
export class ConversationAdapter implements SourceAdapter {
  readonly id = "source.conversation.v1";

  supports(file: SourceFile): boolean {
    return file.type === "conversation";
  }

  async collect(file: SourceFile, scope: ProjectScope): Promise<Evidence[]> {
    const parsed = messages(file.text);
    const rows = parsed ?? [{ content: file.text }];
    return rows.flatMap((row, index) => {
      const content = (contentText(row.content) || contentText(row.text) || contentText(row.body)).slice(0, 20_000);
      if (!content) return [];
      const role = typeof row.role === "string" ? row.role : typeof row.author === "string" ? row.author : typeof row.speaker === "string" ? row.speaker : "unknown";
      const timestamp = typeof row.timestamp === "string" ? row.timestamp : typeof row.createdAt === "string" ? row.createdAt : "";
      const recordId = typeof row.id === "string" ? row.id : `message-${index + 1}`;
      const sourceRef = `${file.path}#${recordId}`;
      const contentHash = hash(content);
      return [{
        id: `ev_${hash(`${scope.repo}:${sourceRef}:${contentHash}`).slice(0, 24)}`,
        sourceType: "conversation" as const,
        sourceRef,
        repo: scope.repo,
        revision: scope.revision,
        path: file.path,
        symbol: "",
        lineStart: 1,
        lineEnd: Math.max(1, content.split(/\r?\n/u).length),
        contentHash,
        extractedAt: new Date().toISOString(),
        extractor: this.id,
        content,
        confidence: 0.45,
        payload: { role, timestamp, untrusted: true, imported: true },
      }];
    });
  }
}
