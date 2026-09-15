import assert from "node:assert/strict";
import { test } from "node:test";
import { TestEnvironmentAdapter } from "../dist/test-environment.js";

const scope = { repo: "/repo", revision: "rev" };

/** The shape that produced a wrong knowledge card: a test step, then a later step with a directory. */
const CI = `name: CI
on: [push]
jobs:
  test:
    steps:
      - name: Run backend tests
        run: python -m pytest -q
      - name: Build frontend
        working-directory: frontend
        run: pnpm build
`;

test("a command is never published beside a directory it did not come from", async () => {
  const [evidence] = await new TestEnvironmentAdapter().collect(
    { path: ".github/workflows/ci-cd.yml", type: "test_configuration", text: CI },
    scope,
  );
  const profile = evidence.payload.environmentProfile;

  assert.equal("workingDirectories" in profile, false, "a bare directory list invites a pairing the source never stated");
  assert.doesNotMatch(evidence.content, /frontend/u, "the unrelated step's directory must not reach the published summary at all");

  const instructions = profile.runInstructions;
  assert.deepEqual(instructions, [{ commandText: "python -m pytest -q" }]);
  assert.equal(instructions[0].workingDirectory, undefined, "pytest must not inherit the frontend step's directory");
});

test("a documented step keeps its own directory", async () => {
  const [evidence] = await new TestEnvironmentAdapter().collect(
    {
      path: "ci.yml",
      type: "test_configuration",
      text: "steps:\n  - name: test\n    working-directory: backend\n    run: python -m pytest -q\n",
    },
    scope,
  );

  assert.deepEqual(evidence.payload.environmentProfile.runInstructions, [{ commandText: "python -m pytest -q", workingDirectory: "backend" }]);
});
