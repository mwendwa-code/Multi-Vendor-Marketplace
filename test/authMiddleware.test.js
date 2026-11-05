const assert = require("node:assert/strict");
const test = require("node:test");
const { requireRole } = require("../backend/middleware/auth");

test("allows an authenticated administrator without an MFA session flag", () => {
    const req = { session: { user: { id: 1, role: "admin" } } };
    const res = {
        redirect() {
            assert.fail("Authenticated administrator should not be redirected.");
        },
        status(statusCode) {
            assert.fail(`Authenticated administrator received status ${statusCode}.`);
        }
    };
    let nextCalled = false;

    requireRole("admin")(req, res, (error) => {
        assert.ifError(error);
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
});
