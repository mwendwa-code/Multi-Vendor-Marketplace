const session = require("express-session");

class PostgresSessionStore extends session.Store {
    constructor(pool) {
        super();
        this.pool = pool;
        this.ready = pool.query(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                session_id TEXT PRIMARY KEY,
                session_data JSONB NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL
            )
        `);

        this.cleanupTimer = setInterval(() => {
            this.pool.query("DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP")
                .catch((error) => console.error("Session cleanup error:", error.message));
        }, 15 * 60 * 1000);
        this.cleanupTimer.unref();
    }

    get(sessionId, callback) {
        this.pool.query(
            `SELECT session_data
             FROM user_sessions
             WHERE session_id = $1 AND expires_at > CURRENT_TIMESTAMP`,
            [sessionId]
        ).then(({ rows }) => {
            if (!rows[0]) return callback(null, null);
            const value = rows[0].session_data;
            return callback(null, typeof value === "string" ? JSON.parse(value) : value);
        }).catch(callback);
    }

    set(sessionId, sessionData, callback = () => {}) {
        this.pool.query(
            `INSERT INTO user_sessions (session_id, session_data, expires_at)
             VALUES ($1, $2::jsonb, $3)
             ON CONFLICT(session_id) DO UPDATE SET
                session_data = EXCLUDED.session_data,
                expires_at = EXCLUDED.expires_at`,
            [sessionId, JSON.stringify(sessionData), this.getExpiry(sessionData)]
        ).then(() => callback()).catch(callback);
    }

    touch(sessionId, sessionData, callback = () => {}) {
        this.pool.query(
            "UPDATE user_sessions SET expires_at = $1 WHERE session_id = $2",
            [this.getExpiry(sessionData), sessionId]
        ).then(() => callback()).catch(callback);
    }

    destroy(sessionId, callback = () => {}) {
        this.pool.query("DELETE FROM user_sessions WHERE session_id = $1", [sessionId])
            .then(() => callback()).catch(callback);
    }

    getExpiry(sessionData) {
        const cookieExpiry = sessionData.cookie?.expires;
        const parsedExpiry = cookieExpiry ? Date.parse(cookieExpiry) : NaN;
        return Number.isFinite(parsedExpiry)
            ? new Date(parsedExpiry)
            : new Date(Date.now() + Number(sessionData.cookie?.maxAge || 12 * 60 * 60 * 1000));
    }
}

module.exports = PostgresSessionStore;
