import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PYTEST_CONFIG,
  isConftestPath,
  isFixtureDecorator,
  isTestClassName,
  isTestFunctionName,
  isTestModulePath,
  parsePytestConfigFile,
  resolvePytestConfig,
} from "../dist/pytest-discovery.js";

test("default python_files matches test_*.py and *_test.py only", () => {
  assert.equal(isTestModulePath("tests/test_sample.py"), true);
  assert.equal(isTestModulePath("tests/sample_test.py"), true);
  assert.equal(isTestModulePath("tests/helpers.py"), false);
  assert.equal(isTestModulePath("tests/conftest.py"), false);
});

test("default python_functions uses the `test` prefix", () => {
  assert.equal(isTestFunctionName("test_bar"), true);
  assert.equal(isTestFunctionName("testbar"), true);
  assert.equal(isTestFunctionName("check_bar"), false);
});

test("default python_classes uses the `Test` prefix", () => {
  assert.equal(isTestClassName("TestFoo"), true);
  assert.equal(isTestClassName("FooTest"), false);
});

test("conftest.py is recognised separately from test modules", () => {
  assert.equal(isConftestPath("tests/conftest.py"), true);
  assert.equal(isConftestPath("tests\\conftest.py"), true);
  assert.equal(isConftestPath("tests/test_conftest.py"), false);
});

test("fixture decorators are detected, including qualified and parameterised forms", () => {
  assert.equal(isFixtureDecorator("pytest.fixture"), true);
  assert.equal(isFixtureDecorator('pytest.fixture(scope="module")'), true);
  assert.equal(isFixtureDecorator("fixture"), true);
  assert.equal(isFixtureDecorator("pytest.mark.parametrize"), false);
});

test("pytest.ini overrides are parsed", () => {
  const config = parsePytestConfigFile(
    "pytest.ini",
    ["[pytest]", "python_files = check_*.py", "python_functions = *_check", "python_classes = Check"].join("\n"),
  );
  assert.deepEqual(config, {
    pythonFiles: ["check_*.py"],
    pythonFunctions: ["*_check"],
    pythonClasses: ["Check"],
  });
});

test("pyproject.toml inline arrays are parsed", () => {
  const config = parsePytestConfigFile(
    "pyproject.toml",
    ['[tool.pytest.ini_options]', 'python_files = ["check_*.py", "example_*.py"]', 'python_functions = ["*_check"]'].join("\n"),
  );
  assert.deepEqual(config.pythonFiles, ["check_*.py", "example_*.py"]);
  assert.deepEqual(config.pythonFunctions, ["*_check"]);
});

test("pyproject.toml multi-line arrays are parsed", () => {
  const config = parsePytestConfigFile(
    "pyproject.toml",
    ["[tool.pytest.ini_options]", "python_files = [", '  "test_*.py",', '  "*_test.py",', "]", "python_functions = ['check']"].join("\n"),
  );
  assert.deepEqual(config.pythonFiles, ["test_*.py", "*_test.py"]);
  assert.deepEqual(config.pythonFunctions, ["check"]);
});

test("setup.cfg uses the tool:pytest section", () => {
  const config = parsePytestConfigFile("setup.cfg", ["[tool:pytest]", "python_files = spec_*.py"].join("\n"));
  assert.deepEqual(config.pythonFiles, ["spec_*.py"]);
});

test("resolvePytestConfig honours precedence and fills defaults", () => {
  const config = resolvePytestConfig([
    { path: "pyproject.toml", text: '[tool.pytest.ini_options]\npython_files = ["ignored_*.py"]' },
    { path: "pytest.ini", text: "[pytest]\npython_functions = check" },
  ]);
  assert.deepEqual(config.pythonFiles, DEFAULT_PYTEST_CONFIG.pythonFiles);
  assert.deepEqual(config.pythonFunctions, ["check"]);
  assert.deepEqual(config.pythonClasses, DEFAULT_PYTEST_CONFIG.pythonClasses);
});

test("resolvePytestConfig falls back to defaults without config", () => {
  assert.deepEqual(resolvePytestConfig([]), DEFAULT_PYTEST_CONFIG);
});
