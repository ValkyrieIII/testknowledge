import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ContextRequest } from "@testknowledge/model";
import type { StructuralContext, StructuralContextProvider } from "@testknowledge/core";

type JsonObject = Record<string, unknown>;

function runCodeGraph(args: string[]): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    execFile("codegraph", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 5 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(JSON.parse(stdout) as JsonObject);
      } catch (cause) {
        reject(new Error("CodeGraph returned invalid JSON", { cause }));
      }
    });
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mentionedInTask(task: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "u").test(task);
}

export class CodeGraphCliStructuralProvider implements StructuralContextProvider {
  async analyze(request: ContextRequest): Promise<StructuralContext> {
    await access(join(request.repo, ".codegraph"));
    const paths = new Set<string>();
    const targetSymbols = new Set<string>(request.targetSymbols);
    const warnings: string[] = [];
    const collect = async (label: string, args: string[], read: (body: JsonObject) => string[]): Promise<void> => {
      try {
        for (const path of read(await runCodeGraph(args))) paths.add(path);
      } catch {
        warnings.push(`codegraph_${label}_failed`);
      }
    };

    try {
      const body = await runCodeGraph(["context", "-p", request.repo, "-f", "json", "--no-code", [request.task, ...request.targetSymbols].join(" ")]);
      for (const path of stringArray(body.relatedFiles)) paths.add(path);
      const entryPoints = Array.isArray(body.entryPoints) ? body.entryPoints : [];
      for (const entry of entryPoints.slice(0, 16)) {
        if (entry === null || typeof entry !== "object") continue;
        const name = (entry as { name?: unknown }).name;
        if (typeof name === "string" && name.length >= 3 && mentionedInTask(request.task, name)) targetSymbols.add(name);
      }
    } catch {
      warnings.push("codegraph_context_failed");
    }
    const tasks: Promise<void>[] = [];
    if (request.changedFiles.length > 0) {
      tasks.push(collect("affected", ["affected", "-p", request.repo, "-j", ...request.changedFiles], (body) => stringArray(body.affectedTests)));
    }
    for (const symbol of [...targetSymbols].slice(0, 8)) {
      tasks.push(collect(`impact_${symbol}`, ["impact", "-p", request.repo, "-j", symbol], (body) => {
        const affected = Array.isArray(body.affected) ? body.affected : [];
        return affected.flatMap((item) => item !== null && typeof item === "object" && typeof (item as { filePath?: unknown }).filePath === "string" ? [(item as { filePath: string }).filePath] : []);
      }));
    }
    await Promise.all(tasks);
    return { relatedPaths: [...paths], targetSymbols: [...targetSymbols], source: "codegraph", warnings };
  }
}
