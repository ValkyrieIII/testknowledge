# TestKnowledge usage

For test-design tasks, call the `testknowledge/get_test_context` MCP tool before proposing tests. Pass the repository path, the concrete task, known target symbols, and changed files. Use the returned project map, evidence links, run instructions, boundaries, risks, and oracles as project-specific context.

Treat `candidate`, `stale`, and `rejected` knowledge as unverified. Do not turn an abstention into a claim: when the context pack says that no applicable verified knowledge exists, fall back to ordinary code reasoning and state that project-specific experience was unavailable.

Do not call knowledge-review, verification, merge, rollback, feedback, build, or evaluation-recording tools unless the user explicitly asks to change the local knowledge base. TestKnowledge never executes tests; execution evidence must come from a separately authorized, isolated run and must match the repository revision.

When changing this repository, also follow the nearest `AGENTS.md`. In particular, do not create, modify, or run tests unless the user explicitly requests it; use lint, type checking, and builds only, and do not describe those checks as proof of functional correctness.
