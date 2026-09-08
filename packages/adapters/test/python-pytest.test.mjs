import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PythonPytestAdapter } from "../dist/python-pytest.js";

const scope = (repo) => ({ repo, revision: "test-revision" });

async function withRepo(files, run) {
  const repo = await mkdtemp(join(tmpdir(), "testknowledge-"));
  try {
    for (const [path, text] of Object.entries(files)) await writeFile(join(repo, path), text, "utf8");
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

const SOURCES = {
  "conftest.py": ["import pytest", "", "@pytest.fixture", "def sample_client():", "    return Client()"].join("\n"),
  "test_sample.py": [
    "import pytest",
    "",
    "@pytest.mark.parametrize('value', [1, 2])",
    "def test_load_config(sample_client, monkeypatch):",
    "    assert sample_client.ok",
    "",
    "class TestGroup:",
    "    def test_inner(self):",
    "        assert True",
    "",
    "def helper():",
    "    assert False",
  ].join("\n"),
};

test("default discovery flags conftest fixtures and test functions", async () => {
  await withRepo(SOURCES, async (repo) => {
    const evidence = await new PythonPytestAdapter().collect(
      { path: "conftest.py", type: "production_code", text: SOURCES["conftest.py"] },
      scope(repo),
    );
    const fixture = evidence.find((item) => item.symbol === "sample_client");
    assert.ok(fixture, "conftest fixture should be collected");
    assert.equal(fixture.payload.isFixture, true);
    assert.equal(fixture.payload.isTest, false);
    assert.equal(fixture.sourceType, "test_code");
    assert.deepEqual(fixture.payload.decorators, ["pytest.fixture"]);
  });
});

test("default discovery classifies test, class method, and helper", async () => {
  await withRepo(SOURCES, async (repo) => {
    const evidence = await new PythonPytestAdapter().collect(
      { path: "test_sample.py", type: "production_code", text: SOURCES["test_sample.py"] },
      scope(repo),
    );
    const top = evidence.find((item) => item.symbol === "test_load_config");
    assert.equal(top?.payload.isTest, true);
    assert.deepEqual(top?.payload.fixtureRequests, ["sample_client", "monkeypatch"]);
    assert.deepEqual(top?.payload.decorators, ["pytest.mark.parametrize('value', [1, 2])"]);

    const inner = evidence.find((item) => item.symbol === "test_inner");
    assert.equal(inner?.payload.isTest, true);
    assert.equal(inner?.payload.inTestClass, true);
    assert.equal(inner?.payload.enclosingClass, "TestGroup");

    const helper = evidence.find((item) => item.symbol === "helper");
    assert.equal(helper?.payload.isTest, false);
  });
});

test("pytest.ini changes which functions are considered tests", async () => {
  await withRepo({ ...SOURCES, "pytest.ini": "[pytest]\npython_functions = check" }, async (repo) => {
    const evidence = await new PythonPytestAdapter().collect(
      { path: "test_sample.py", type: "production_code", text: SOURCES["test_sample.py"] },
      scope(repo),
    );
    assert.equal(evidence.find((item) => item.symbol === "test_load_config")?.payload.isTest, false);
    assert.equal(evidence.find((item) => item.symbol === "test_inner")?.payload.isTest, false);
  });
});

test("files outside python_files are not promoted to test modules", async () => {
  await withRepo({ "helpers.py": "def test_like():\n    assert True" }, async (repo) => {
    const evidence = await new PythonPytestAdapter().collect(
      { path: "helpers.py", type: "production_code", text: "def test_like():\n    assert True" },
      scope(repo),
    );
    const fn = evidence.find((item) => item.symbol === "test_like");
    assert.equal(fn?.payload.isTestModule, false);
    assert.equal(fn?.payload.isTest, false);
    assert.equal(fn?.sourceType, "production_code");
  });
});

test("evidence ids do not depend on the project revision", async () => {
  await withRepo(SOURCES, async (repo) => {
    const adapter = new PythonPytestAdapter();
    const file = { path: "test_sample.py", type: "test_code", text: SOURCES["test_sample.py"] };
    const first = await adapter.collect(file, { repo, revision: "revision-1" });
    const second = await adapter.collect(file, { repo, revision: "revision-2" });
    assert.deepEqual(
      second.map((item) => item.id),
      first.map((item) => item.id),
    );
  });
});

test("evidence ids change when the analysed content changes", async () => {
  await withRepo(SOURCES, async (repo) => {
    const adapter = new PythonPytestAdapter();
    const file = { path: "test_sample.py", type: "test_code", text: SOURCES["test_sample.py"] };
    const first = await adapter.collect(file, { repo, revision: "revision-1" });
    const changed = await adapter.collect(
      { ...file, text: `${file.text}\n\ndef test_added():\n    assert True\n` },
      { repo, revision: "revision-2" },
    );
    const firstIds = new Set(first.map((item) => item.id));
    assert.ok(changed.some((item) => !firstIds.has(item.id)), "changed content must produce new evidence ids");
  });
});
