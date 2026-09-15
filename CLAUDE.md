# TestKnowledge usage

Read and follow `AGENTS.md` for repository-wide engineering constraints.

For test-design work, query the `testknowledge` MCP server with `get_test_context` before proposing tests. Supply the repository, concrete task, target symbols, and changed files when known. Ground project-specific claims in returned evidence and distinguish verified knowledge from candidate, stale, or rejected material.

If the context pack abstains because no applicable verified knowledge exists, use ordinary code reasoning and say that project-specific experience was unavailable. Do not review, verify, merge, roll back, rebuild, or record feedback/evaluations in the knowledge base unless the user explicitly asks for that state change. TestKnowledge performs static extraction only; externally produced execution evidence remains a separate input.
