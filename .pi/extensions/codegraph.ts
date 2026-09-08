/**
 * CodeGraph extension for pi.
 *
 * Registers the `codegraph_explore` and `codegraph_node` custom tools, backed by
 * the locally installed `codegraph` CLI. Output is identical to the CodeGraph MCP
 * tools. Tools are usable only in projects that contain a `.codegraph/` index.
 *
 * Windows note: pi.exec spawns with shell:false, which cannot execute npm's
 * `codegraph.cmd` shim. We parse the shim to find the underlying
 * `node_modules/**​/npm-shim.js` entry and run it with the current Node binary.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EXPLORE_TIMEOUT_MS = 180_000;
const NODE_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// CLI launcher resolution
// ---------------------------------------------------------------------------

let launcherPromise: Promise<string[]> | undefined;

/**
 * Resolve the argv prefix used to launch the codegraph CLI.
 *
 * Returns e.g. ["codegraph"] on POSIX, or [nodePath, npmShimJs] on Windows.
 * Falls back to ["codegraph"]; execute() reports a clear error if that fails.
 */
async function resolveLauncher(): Promise<string[]> {
	if (!launcherPromise) {
		launcherPromise = (async () => {
			if (process.platform !== "win32") return ["codegraph"];

			const dirs = (process.env.PATH ?? "")
				.split(";")
				.map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
				.filter(Boolean);

			for (const dir of dirs) {
				for (const candidate of ["codegraph.cmd", "codegraph", "codegraph.exe"]) {
					const shim = join(dir, candidate);
					if (!existsSync(shim)) continue;
					if (candidate.endsWith(".exe")) return [shim];

					// Parse the shim (cmd or sh script) for its node_modules JS entry.
					const content = await readFile(shim, "utf8").catch(() => "");
					const match = content.match(/node_modules[\\/][^\s"%]+?\.js/);
					if (match) {
						return [process.execPath, join(dirname(shim), match[0].replace(/\//g, "\\"))];
					}
				}
			}
			return ["codegraph"];
		})();
	}
	return launcherPromise;
}

interface CodegraphRunResult {
	stdout: string;
	stderr: string;
	code: number;
}

async function runCodegraph(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<CodegraphRunResult> {
	const prefix = await resolveLauncher();
	return pi.exec(prefix[0], [...prefix.slice(1), ...args], { cwd, signal, timeout: timeoutMs });
}

function ensureIndexed(cwd: string): void {
	if (!existsSync(join(cwd, ".codegraph"))) {
		throw new Error(
			"This project has no CodeGraph index (no .codegraph/ directory). " +
				"Ask the user whether to run `codegraph init` — indexing is their decision.",
		);
	}
}

/** The CLI is commander-based; guard operand-style args that look like flags. */
function asOperand(value: string): string[] {
	return value.startsWith("-") ? ["--", value] : [value];
}

/** Some models emit a leading @ in path arguments; strip it like built-in tools do. */
function normalizeArg(value: string): string {
	return value.replace(/^@/, "");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function codegraphExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"Explore a codebase area via the project's CodeGraph index (.codegraph/): returns the relevant " +
			"symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep " +
			"can't follow. One call answers most code questions. Name a file or symbol in the query to read " +
			"its current line-numbered source.",
		promptSnippet: "Answer most code questions in one call from the CodeGraph index (source + call paths)",
		promptGuidelines: [
			"Reach for codegraph_explore BEFORE grep/find or reading files when you need to understand or locate code, provided the project has a .codegraph/ index.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					'Symbol names or a natural-language question, e.g. "JSONLRepository writeKnowledge" or "how do knowledge cards get verified?"',
			}),
			max_files: Type.Optional(
				Type.Number({ description: "Maximum number of files to include source from." }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			ensureIndexed(ctx.cwd);

			const args = ["explore"];
			if (params.max_files !== undefined) {
				args.push("--max-files", String(Math.floor(params.max_files)));
			}
			args.push(...asOperand(params.query));

			const result = await runCodegraph(pi, args, ctx.cwd, signal, EXPLORE_TIMEOUT_MS);
			if (result.code !== 0) {
				throw new Error(
					`codegraph explore failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
				);
			}
			return {
				content: [{ type: "text", text: result.stdout.trim() || "(no results)" }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "codegraph_node",
		label: "CodeGraph Node",
		description:
			"Read one symbol or file via the project's CodeGraph index (.codegraph/). With a symbol name: " +
			"returns its source plus the caller/callee trail. With a file: returns the file with line numbers " +
			"plus its dependents. Use --file to disambiguate a symbol defined in multiple files.",
		promptSnippet: "Read a single symbol's source + caller/callee trail, or a file + dependents, from the index",
		promptGuidelines: [
			"Use codegraph_node when you need exactly one symbol's source and its caller/callee trail from the CodeGraph index; use codegraph_explore for broader questions.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Symbol name to read (source + caller/callee trail)." }),
			),
			file: Type.Optional(
				Type.String({
					description:
						"File path: read the file with line numbers + dependents, or disambiguate `name` to this file.",
				}),
			),
			offset: Type.Optional(Type.Number({ description: "File mode: 1-based start line." })),
			limit: Type.Optional(Type.Number({ description: "File mode: maximum lines." })),
			symbols_only: Type.Optional(
				Type.Boolean({ description: "File mode: just the symbol map + dependents." }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			ensureIndexed(ctx.cwd);

			const name = params.name !== undefined ? normalizeArg(params.name) : undefined;
			const file = params.file !== undefined ? normalizeArg(params.file) : undefined;
			if (!name && !file) {
				throw new Error("Provide at least one of `name` (symbol) or `file` (path).");
			}

			const args = ["node"];
			if (file !== undefined) args.push("--file", file);
			if (params.offset !== undefined) args.push("--offset", String(Math.floor(params.offset)));
			if (params.limit !== undefined) args.push("--limit", String(Math.floor(params.limit)));
			if (params.symbols_only) args.push("--symbols-only");
			if (name !== undefined) args.push(...asOperand(name));

			const result = await runCodegraph(pi, args, ctx.cwd, signal, NODE_TIMEOUT_MS);
			if (result.code !== 0) {
				throw new Error(
					`codegraph node failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
				);
			}
			return {
				content: [{ type: "text", text: result.stdout.trim() || "(no results)" }],
				details: {},
			};
		},
	});

	pi.registerCommand("codegraph", {
		description: "Show CodeGraph index status for this project",
		handler: async (_args, ctx) => {
			try {
				const result = await runCodegraph(pi, ["status"], ctx.cwd, undefined, STATUS_TIMEOUT_MS);
				const text = (result.stdout || result.stderr).trim();
				ctx.ui.notify(text || "No output", result.code === 0 ? "info" : "error");
			} catch (err) {
				ctx.ui.notify(`codegraph status failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
