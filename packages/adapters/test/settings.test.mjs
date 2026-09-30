import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SettingsStore, settingsFilePath } from "../dist/settings.js";

const root = mkdtempSync(join(tmpdir(), "tk-settings-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

function store(environment = {}) {
  const dir = join(root, String(++counter));
  mkdirSync(dir, { recursive: true });
  const filePath = settingsFilePath(dir);
  return { filePath, store: new SettingsStore(filePath, environment) };
}

test("a saved configuration is read back by a new store", () => {
  const { filePath, store: first } = store();
  first.update({ llm: { baseUrl: "https://example.test/v1", apiKey: "secret", model: "deepseek-flash" } });
  const second = new SettingsStore(filePath, {});
  assert.deepEqual(second.llm(), { baseUrl: "https://example.test/v1", apiKey: "secret", model: "deepseek-flash" });
  assert.deepEqual(second.view(), { llm: { baseUrl: "https://example.test/v1", model: "deepseek-flash", hasApiKey: true }, envManaged: false });
});

test("the api key never leaves the store through the view", () => {
  const { store: instance } = store();
  instance.update({ llm: { baseUrl: "https://example.test/v1", apiKey: "secret", model: "m" } });
  assert.equal(JSON.stringify(instance.view()).includes("secret"), false);
});

test("an omitted field keeps the stored value and an empty key clears it", () => {
  const { store: instance } = store();
  instance.update({ llm: { baseUrl: "https://example.test/v1", apiKey: "secret", model: "m" } });
  instance.update({ llm: { model: "other" } });
  assert.deepEqual(instance.llm(), { baseUrl: "https://example.test/v1", apiKey: "secret", model: "other" });
  instance.update({ llm: { apiKey: "" } });
  assert.equal(instance.llm().apiKey, "");
});

test("the environment overrides the file and a blank variable counts as unset", () => {
  const { store: instance } = store({ TESTKNOWLEDGE_LLM_MODEL: "from-env", TESTKNOWLEDGE_LLM_BASE_URL: "  " });
  instance.update({ llm: { baseUrl: "https://file.test/v1", apiKey: "file-key", model: "file-model" } });
  assert.deepEqual(instance.llm(), { baseUrl: "https://file.test/v1", apiKey: "file-key", model: "from-env" });
  assert.equal(instance.view().envManaged, true);
});

test("a missing or malformed file falls back to the environment", () => {
  const { filePath, store: instance } = store({ TESTKNOWLEDGE_LLM_API_KEY: "env-key" });
  assert.deepEqual(instance.read(), {});
  writeFileSync(filePath, "{ not json", "utf8");
  assert.deepEqual(new SettingsStore(filePath, {}).read(), {});
  writeFileSync(filePath, JSON.stringify({ llm: { baseUrl: "not-a-url" } }), "utf8");
  assert.deepEqual(new SettingsStore(filePath, {}).read(), {});
  assert.equal(instance.llm().apiKey, "env-key");
});

test("an update writes the document as JSON", () => {
  const { filePath, store: instance } = store();
  instance.update({ llm: { apiKey: "k" } });
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { llm: { apiKey: "k" } });
});
