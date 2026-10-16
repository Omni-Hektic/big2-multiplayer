const test = require("node:test");
const assert = require("node:assert/strict");
// The server's rules functions are currently internal; this smoke test validates the package setup.
// Extracting the rules engine into a module is recommended before extending automated rule coverage.
test("project test runner is configured", () => {
  assert.equal(2 + 2, 4);
});
