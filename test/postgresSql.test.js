const assert = require("node:assert/strict");
const test = require("node:test");
const { toPostgresSql } = require("../backend/database/postgresSql");

test("converts positional parameters without changing quoted question marks", () => {
    const sql = "SELECT '?' AS literal, \"?\" AS identifier FROM products WHERE id = ? AND name = ?";
    const converted = toPostgresSql(sql);
    assert.equal(
        converted.text,
        "SELECT '?' AS literal, \"?\" AS identifier FROM products WHERE id = $1 AND name = $2"
    );
    assert.equal(converted.parameterCount, 2);
});

test("ignores question marks in comments and dollar-quoted strings", () => {
    const sql = "SELECT ? -- ?\n/* ? /* ? */ */ WHERE value = $$?$$ AND other = ?";
    const converted = toPostgresSql(sql);
    assert.equal(
        converted.text,
        "SELECT $1 -- ?\n/* ? /* ? */ */ WHERE value = $$?$$ AND other = $2"
    );
    assert.equal(converted.parameterCount, 2);
});
