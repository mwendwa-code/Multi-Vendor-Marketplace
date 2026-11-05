const bcrypt = require("bcrypt");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { Pool, types } = require("pg");
const { toPostgresSql } = require("./postgresSql");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    throw new Error("Set DATABASE_URL to connect to the PostgreSQL database.");
}

types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined
});
const transactionContext = new AsyncLocalStorage();

async function query(executor, sql, params = []) {
    const converted = toPostgresSql(sql);
    const values = Array.isArray(params) ? params : [params];
    if (converted.parameterCount !== values.length) {
        throw new Error(
            `SQL parameter count mismatch: expected ${converted.parameterCount}, received ${values.length}.`
        );
    }

    return executor.query(converted.text, values);
}

class PostgresConnection {
    constructor(client) {
        this.client = client;
    }

    async execute(sql, params = []) {
        const result = await query(this.client, sql, params);
        if (result.command === "SELECT" || result.command === "SHOW") {
            return [result.rows];
        }

        return [{
            insertId: result.rows[0]?.id ?? null,
            rowsAffected: result.rowCount ?? 0,
            lastID: result.rows[0]?.id ?? null,
            changes: result.rowCount ?? 0,
            rows: result.rows
        }];
    }
}

const db = {
    pool,

    async initialize({ seed = true } = {}) {
        const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
        await pool.query(schema);
        if (!seed) return;

        await db.execute(
            "UPDATE users SET role = ? WHERE role = ?",
            ["customer", "buyer"]
        );
        await db.execute(
            "UPDATE users SET referral_code = 'C' || id WHERE referral_code IS NULL OR referral_code = ''"
        );

        const [categories] = await db.execute("SELECT id FROM categories WHERE name = ?", ["Electronics"]);
        if (categories.length === 0) {
            await db.execute("INSERT INTO categories (name) VALUES (?)", ["Electronics"]);
            await db.execute("INSERT INTO categories (name) VALUES (?)", ["Clothing"]);
            await db.execute("INSERT INTO categories (name) VALUES (?)", ["Home and Living"]);
        }

        await db.execute(
            `INSERT INTO seller_order_decisions (order_id, seller_id, status)
             SELECT order_id, seller_id, 'accepted'
             FROM seller_order_fulfillments
             WHERE status IN ('processing', 'shipped')
             ON CONFLICT(order_id, seller_id) DO NOTHING`
        );
        await db.execute(
            `INSERT INTO marketplace_settings (id, commission_rate)
             VALUES (1, 10)
             ON CONFLICT(id) DO NOTHING`
        );
        await db.execute(
            `INSERT INTO commissions
                (order_id, seller_id, amount, order_item_id, commission_rate,
                 gross_amount, seller_net_amount, status)
             SELECT oi.order_id, oi.seller_id,
                    ROUND((oi.quantity * oi.price * 0.10)::numeric, 2),
                    oi.id,
                    10,
                    ROUND((oi.quantity * oi.price)::numeric, 2),
                    ROUND((oi.quantity * oi.price * 0.90)::numeric, 2),
                    CASE
                        WHEN o.status = 'cancelled' THEN 'void'
                        WHEN EXISTS (
                            SELECT 1 FROM payments p
                            WHERE p.order_id = o.id AND p.status = 'successful'
                        ) THEN 'earned'
                        ELSE 'pending'
                    END
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE NOT EXISTS (
                 SELECT 1 FROM commissions c WHERE c.order_item_id = oi.id
             )`
        );

        const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
        const adminPassword = process.env.ADMIN_PASSWORD;
        if (Boolean(adminEmail) !== Boolean(adminPassword)) {
            throw new Error("Set both ADMIN_EMAIL and ADMIN_PASSWORD to bootstrap an administrator.");
        }

        if (adminEmail && adminPassword) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminPassword.length < 12) {
                throw new Error("ADMIN_EMAIL must be valid and ADMIN_PASSWORD must be at least 12 characters.");
            }

            const [adminUsers] = await db.execute(
                "SELECT id, role, password FROM users WHERE email = ?",
                [adminEmail]
            );
            if (adminUsers.length === 0) {
                const hashedAdminPassword = await bcrypt.hash(adminPassword, 12);
                await db.execute(
                    "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
                    ["Administrator", adminEmail, hashedAdminPassword, "admin"]
                );
            } else if (adminUsers[0].role !== "admin") {
                const hashedAdminPassword = await bcrypt.hash(adminPassword, 12);
                await db.execute(
                    "UPDATE users SET role = ?, password = ?, email_verified = 1 WHERE id = ?",
                    ["admin", hashedAdminPassword, adminUsers[0].id]
                );
            } else if (await bcrypt.compare("Admin123!", adminUsers[0].password)) {
                const hashedAdminPassword = await bcrypt.hash(adminPassword, 12);
                await db.execute("UPDATE users SET password = ? WHERE id = ?", [
                    hashedAdminPassword,
                    adminUsers[0].id
                ]);
            }
        }

        const [legacyAdminUsers] = await db.execute(
            "SELECT id, password FROM users WHERE email = ? AND role = ?",
            ["admin@marketplace.com", "admin"]
        );
        if (legacyAdminUsers.length > 0 && await bcrypt.compare("Admin123!", legacyAdminUsers[0].password)) {
            const unusablePassword = await bcrypt.hash(crypto.randomBytes(48).toString("hex"), 12);
            await db.execute("UPDATE users SET password = ? WHERE id = ?", [
                unusablePassword,
                legacyAdminUsers[0].id
            ]);
        }

        const [legacyManagerUsers] = await db.execute(
            "SELECT id, password FROM users WHERE email = ?",
            ["manager@marketplace.com"]
        );
        if (legacyManagerUsers.length > 0 && await bcrypt.compare("Manager123!", legacyManagerUsers[0].password)) {
            const unusablePassword = await bcrypt.hash(crypto.randomBytes(48).toString("hex"), 12);
            await db.execute("UPDATE users SET password = ? WHERE id = ?", [
                unusablePassword,
                legacyManagerUsers[0].id
            ]);
        }

        const [productRows] = await db.execute("SELECT id FROM products LIMIT 1");
        if (productRows.length === 0) {
            const [sellerRows] = await db.execute(
                "SELECT id FROM users WHERE email = ?",
                ["admin@marketplace.com"]
            );
            const sellerId = sellerRows[0]?.id;
            const [categoryRows] = await db.execute(
                "SELECT id FROM categories WHERE name = ?",
                ["Electronics"]
            );
            const categoryId = categoryRows[0]?.id;

            if (sellerId && categoryId) {
                await db.execute(
                    `INSERT INTO products
                        (seller_id, category_id, name, description, price, stock, image)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        sellerId,
                        categoryId,
                        "Wireless Headphones",
                        "Comfortable wireless headphones for daily use.",
                        3999.00,
                        12,
                        "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=900&q=80"
                    ]
                );
            }
        }
    },

    async execute(sql, params = []) {
        const client = transactionContext.getStore();
        const result = await query(client || pool, sql, params);
        if (result.command === "SELECT" || result.command === "SHOW") {
            return [result.rows];
        }

        return [{
            insertId: result.rows[0]?.id ?? null,
            rowsAffected: result.rowCount ?? 0,
            lastID: result.rows[0]?.id ?? null,
            changes: result.rowCount ?? 0,
            rows: result.rows
        }];
    },

    async transaction(callback) {
        if (transactionContext.getStore()) {
            throw new Error("Nested database transactions are not supported.");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await transactionContext.run(
                client,
                () => callback(new PostgresConnection(client))
            );
            await client.query("COMMIT");
            return result;
        } catch (error) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Database transaction rollback error:", rollbackError.message);
            }
            throw error;
        } finally {
            client.release();
        }
    },

    async backup(destination) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            const { rows: tableRows } = await client.query(
                `SELECT tablename
                 FROM pg_tables
                 WHERE schemaname = 'public' AND tablename != 'user_sessions'
                 ORDER BY tablename`
            );
            const tables = {};
            for (const { tablename } of tableRows) {
                const safeTableName = `"${tablename.replace(/"/g, '""')}"`;
                const { rows } = await client.query(`SELECT * FROM public.${safeTableName}`);
                tables[tablename] = rows;
            }
            await fs.writeFile(
                destination,
                `${JSON.stringify({
                    format: "marketplace-postgresql-backup-v1",
                    createdAt: new Date().toISOString(),
                    tables
                })}\n`,
                { encoding: "utf8", flag: "wx", mode: 0o600 }
            );
            await client.query("COMMIT");
        } catch (error) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Database backup rollback error:", rollbackError.message);
            }
            throw error;
        } finally {
            client.release();
        }
    }
};

module.exports = db;
