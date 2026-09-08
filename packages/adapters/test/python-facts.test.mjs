import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFunctions, isMockCall } from "../dist/python-facts.js";

const SOURCE = `@pytest.mark.parametrize("value", [1, 2, 3])
def test_boundary(value, limit=10):
    with pytest.raises(ValueError, match="bad"):
        parse(value)
    try:
        risky()
    except (TypeError, KeyError):
        pass
    assert parse(
        value, mode="strict"
    ) == [1, 2]
`;

test("extractFunctions reports decorators, parameters, and calls with structure", () => {
  const [fn] = extractFunctions(SOURCE);
  assert.equal(fn.name, "test_boundary");
  assert.equal(fn.isAsync, false);
  assert.equal(fn.enclosingClass, "");
  assert.deepEqual(fn.parameters, [{ name: "value" }, { name: "limit", default: "10" }]);
  assert.deepEqual(fn.decorators, [
    {
      name: "pytest.mark.parametrize",
      args: ['"value"', "[1, 2, 3]"],
      literals: ["value", [1, 2, 3]],
      text: '@pytest.mark.parametrize("value", [1, 2, 3])',
    },
  ]);
  const parseCall = fn.calls.find((call) => call.name === "parse" && call.args.length === 2);
  assert.deepEqual(parseCall?.args, ["value", 'mode="strict"']);
});

test("assertions survive line breaks", () => {
  const [fn] = extractFunctions(SOURCE);
  assert.equal(fn.assertions.length, 1);
  assert.equal(fn.assertions[0]?.text, 'parse(\n        value, mode="strict"\n    ) == [1, 2]');
  assert.equal(fn.assertions[0]?.lineStart, 9);
  assert.equal(fn.assertions[0]?.lineEnd, 11);
});

test("with blocks and try handlers are captured as facts", () => {
  const [fn] = extractFunctions(SOURCE);
  assert.deepEqual(fn.withBlocks, [
    { call: "pytest.raises", args: ["ValueError", 'match="bad"'], literals: ["bad"], lineStart: 3, lineEnd: 3 },
  ]);
  assert.deepEqual(fn.tryHandlers, [{ exceptionTypes: ["TypeError", "KeyError"], lineStart: 7, lineEnd: 7 }]);
});

test("bare except has no exception types", () => {
  const [fn] = extractFunctions("def test_x():\n    try:\n        pass\n    except:\n        pass");
  assert.deepEqual(fn.tryHandlers, [{ exceptionTypes: [], lineStart: 4, lineEnd: 5 }]);
});

test("class methods report their enclosing class", () => {
  const functions = extractFunctions("class TestGroup:\n    def test_inner(self):\n        assert True\n");
  assert.equal(functions.length, 1);
  assert.equal(functions[0]?.name, "test_inner");
  assert.equal(functions[0]?.enclosingClass, "TestGroup");
  assert.deepEqual(functions[0]?.parameters, []);
});

test("facts of a nested function are not attributed to the outer one", () => {
  const functions = extractFunctions(
    ["def outer():", "    def inner():", "        assert False", "    assert True", ""].join("\n"),
  );
  const outer = functions.find((fn) => fn.name === "outer");
  const inner = functions.find((fn) => fn.name === "inner");
  assert.equal(outer?.assertions.length, 1);
  assert.equal(inner?.assertions.length, 1);
});

test("isMockCall recognises mock helpers", () => {
  assert.equal(isMockCall("patch"), true);
  assert.equal(isMockCall("mock.patch"), true);
  assert.equal(isMockCall("Mock"), true);
  assert.equal(isMockCall("MagicMock"), true);
  assert.equal(isMockCall("parse"), false);
});
