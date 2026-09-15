export type DocumentedRunInstruction = {
  commandText: string;
  workingDirectory?: string;
};

function recordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

function commandTextOf(entry: Record<string, unknown>): string {
  if (typeof entry.commandText === "string" && entry.commandText.trim()) return entry.commandText.trim();
  if (Array.isArray(entry.command) && entry.command.length > 0 && entry.command.every((part): part is string => typeof part === "string")) {
    return entry.command.join(" ").trim();
  }
  return "";
}

/**
 * Read the per-step command and working-directory pairs a source adapter recorded.
 *
 * Commands and working directories that were scanned independently are never zipped here:
 * pairing them by position produces a relationship the source never stated. An empty result
 * means the source recorded no pairing, and callers must surface that absence instead of
 * inventing an association.
 */
export function documentedRunInstructions(profile: unknown): DocumentedRunInstruction[] {
  if (profile === null || typeof profile !== "object") return [];
  const entries = recordList((profile as Record<string, unknown>).runInstructions);
  const seen = new Set<string>();
  const instructions: DocumentedRunInstruction[] = [];
  for (const entry of entries) {
    const commandText = commandTextOf(entry);
    if (!commandText) continue;
    const workingDirectory = typeof entry.workingDirectory === "string" ? entry.workingDirectory.trim() : "";
    const key = `${workingDirectory}\u0000${commandText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    instructions.push(workingDirectory ? { commandText, workingDirectory } : { commandText });
  }
  return instructions;
}

/** Render documented instructions one clause each, so a command never separates from its directory. */
export function runInstructionTexts(profile: unknown): string[] {
  return documentedRunInstructions(profile).map((instruction) => instruction.workingDirectory
    ? `命令：${instruction.commandText}（工作目录：${instruction.workingDirectory}）`
    : `命令：${instruction.commandText}`);
}
