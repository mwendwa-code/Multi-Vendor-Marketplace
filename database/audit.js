const db = require("./db");

async function recordAuditEvent(userId, action) {
    if (typeof action !== "string" || action.length === 0 || action.length > 255) {
        throw new Error("Audit action must be between 1 and 255 characters.");
    }

    await db.execute(
        "INSERT INTO audit_logs (user_id, action) VALUES (?, ?)",
        [Number.isInteger(userId) ? userId : null, action]
    );
}

module.exports = { recordAuditEvent };
