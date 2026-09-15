import { createHash } from "node:crypto";

/**
 * Content-addressed evidence identity.
 *
 * Deliberately excludes the revision: the same fact observed in two revisions keeps one
 * identity, so a re-read never fabricates a new evidence record. Any producer that observes
 * repository bytes should mint ids through here, including agent tool reads.
 */
export function evidenceId(repo: string, sourceRef: string, contentHash: string): string {
  return `ev_${createHash("sha256").update(`${repo}:${sourceRef}:${contentHash}`).digest("hex").slice(0, 24)}`;
}

export function contentHashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
