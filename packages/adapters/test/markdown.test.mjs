import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkdownAdapter } from "../dist/markdown.js";

const TEXT = "# 标题一\n\n内容\n\n# 标题二\n\n内容二\n";

test("markdown evidence ids do not depend on the project revision", async () => {
  const adapter = new MarkdownAdapter();
  const file = { path: "DESIGN.md", type: "project_document", text: TEXT };
  const first = await adapter.collect(file, { repo: "/repo", revision: "revision-1" });
  const second = await adapter.collect(file, { repo: "/repo", revision: "revision-2" });
  assert.deepEqual(
    second.map((item) => item.id),
    first.map((item) => item.id),
  );
});

test("markdown evidence ids change only for the edited section", async () => {
  const adapter = new MarkdownAdapter();
  const first = await adapter.collect({ path: "DESIGN.md", type: "project_document", text: TEXT }, { repo: "/repo", revision: "revision-1" });
  const changed = await adapter.collect(
    { path: "DESIGN.md", type: "project_document", text: TEXT.replace("内容", "内容改了") },
    { repo: "/repo", revision: "revision-2" },
  );
  assert.notEqual(changed[0]?.id, first[0]?.id, "edited section gets a new id");
  assert.equal(changed[1]?.id, first[1]?.id, "untouched section keeps its id");
});
