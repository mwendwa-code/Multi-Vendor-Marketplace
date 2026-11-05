const assert = require("node:assert/strict");
const test = require("node:test");
const csrfProtection = require("../backend/middleware/csrf");

function createResponse() {
    const headers = {};
    return {
        headers,
        locals: {},
        set(name, value) {
            headers[name.toLowerCase()] = value;
            return this;
        },
        redirect(status, location) {
            this.redirected = { status, location };
            return this;
        },
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        }
    };
}

test("disables caching for responses containing session-bound CSRF tokens", () => {
    const req = { method: "GET", session: {}, path: "/login" };
    const res = createResponse();
    let nextCalled = false;

    csrfProtection(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.headers["cache-control"], "no-store, private");
    assert.equal(res.locals.csrfToken, req.session.csrfToken);
});

test("rejects a stale login token without processing the login", () => {
    const req = {
        method: "POST",
        path: "/auth/login",
        session: { csrfToken: "current-token" },
        body: { _csrf: "stale-token" },
        get: () => undefined,
        is: () => false
    };
    const res = createResponse();
    let nextCalled = false;

    csrfProtection(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.deepEqual(res.redirected, { status: 303, location: "/login?csrf=expired" });
    assert.equal(res.headers["cache-control"], "no-store, private");
});
