const fs = require("fs");
const path = require("path");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();

class SQLiteSessionStore extends session.Store {
    constructor(filename) {
        super();
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.database = new sqlite3.Database(filename);
        this.ready = new Promise((resolve, reject) => {
            this.database.run(
                `CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    session_data TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                )`,
                (error) => error ? reject(error) : resolve()
            );
        });

        this.cleanupTimer = setInterval(() => {
            this.database.run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()], (error) => {
                if (error) {
                    console.error("Session cleanup error:", error.message);
                }
            });
        }, 15 * 60 * 1000);
        this.cleanupTimer.unref();
    }

    get(sessionId, callback) {
        this.database.get(
            "SELECT session_data, expires_at FROM sessions WHERE session_id = ?",
            [sessionId],
            (error, row) => {
                if (error) return callback(error);
                if (!row) return callback(null, null);
                if (row.expires_at <= Date.now()) {
                    return this.destroy(sessionId, (destroyError) => callback(destroyError, null));
                }

                try {
                    return callback(null, JSON.parse(row.session_data));
                } catch (parseError) {
                    return callback(parseError);
                }
            }
        );
    }

    set(sessionId, sessionData, callback = () => {}) {
        const expiresAt = this.getExpiry(sessionData);
        this.database.run(
            `INSERT INTO sessions (session_id, session_data, expires_at)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
                session_data = excluded.session_data,
                expires_at = excluded.expires_at`,
            [sessionId, JSON.stringify(sessionData), expiresAt],
            callback
        );
    }

    touch(sessionId, sessionData, callback = () => {}) {
        this.database.run(
            "UPDATE sessions SET session_data = ?, expires_at = ? WHERE session_id = ?",
            [JSON.stringify(sessionData), this.getExpiry(sessionData), sessionId],
            callback
        );
    }

    destroy(sessionId, callback = () => {}) {
        this.database.run("DELETE FROM sessions WHERE session_id = ?", [sessionId], callback);
    }

    getExpiry(sessionData) {
        const cookieExpiry = sessionData.cookie?.expires;
        const parsedExpiry = cookieExpiry ? Date.parse(cookieExpiry) : NaN;
        return Number.isFinite(parsedExpiry)
            ? parsedExpiry
            : Date.now() + Number(sessionData.cookie?.maxAge || 12 * 60 * 60 * 1000);
    }
}

module.exports = SQLiteSessionStore;
