const bcrypt = require("bcrypt");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

const dbPath = process.env.DB_PATH || path.join(__dirname, "marketplace.db");
const sqliteDb = new sqlite3.Database(dbPath);
const transactionContext = new AsyncLocalStorage();
let operationQueue = Promise.resolve();

function enqueueDatabaseOperation(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
}

class SQLiteConnection {
    constructor(database) {
        this.database = database;
    }

    async execute(sql, params = []) {
        const values = Array.isArray(params) ? params : [params];
        const isWriteQuery = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)\b/i.test(sql);

        if (isWriteQuery) {
            return new Promise((resolve, reject) => {
                this.database.run(sql, values, function runCallback(error) {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve([{
                        insertId: this.lastID,
                        rowsAffected: this.changes,
                        lastID: this.lastID,
                        changes: this.changes
                    }]);
                });
            });
        }

        return new Promise((resolve, reject) => {
            this.database.all(sql, values, (error, rows) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve([rows]);
            });
        });
    }

    async beginTransaction() {
        await this.execute("BEGIN TRANSACTION");
    }

    async commit() {
        await this.execute("COMMIT");
    }

    async rollback() {
        await this.execute("ROLLBACK");
    }

    release() {
        return undefined;
    }
}

function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}

async function repairLegacyUserForeignKeys(connection) {
    const [tables] = await connection.execute(
        `SELECT name, sql
         FROM sqlite_master
        WHERE type = 'table' AND name != 'users_old' AND sql LIKE '%users_old%'
         ORDER BY name`
    );
    if (tables.length === 0) {
        return;
    }

    await connection.execute("PRAGMA legacy_alter_table = ON");
    try {
        for (const table of tables) {
            const temporaryName = `__repair_${crypto.randomBytes(4).toString("hex")}`;
            const quotedName = quoteIdentifier(table.name);
            const quotedTemporaryName = quoteIdentifier(temporaryName);
            const createSql = table.sql.replace(
                new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?["\\[]?${table.name}["\\]]?`, "i"),
                `CREATE TABLE ${quotedTemporaryName}`
            );
            if (createSql === table.sql) {
                throw new Error(`Could not prepare the ${table.name} table migration.`);
            }

            const [columns] = await connection.execute(
                `PRAGMA table_info(${quotedName})`
            );
            const columnList = columns.map((column) => quoteIdentifier(column.name)).join(", ");
            const [secondaryObjects] = await connection.execute(
                `SELECT sql
                 FROM sqlite_master
                 WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`,
                [table.name]
            );

            await connection.execute(createSql.replace(/users_old/g, "users"));
            await connection.execute(
                `INSERT INTO ${quotedTemporaryName} (${columnList})
                 SELECT ${columnList} FROM ${quotedName}`
            );
            await connection.execute(`DROP TABLE ${quotedName}`);
            await connection.execute(
                `ALTER TABLE ${quotedTemporaryName} RENAME TO ${quotedName}`
            );

            for (const object of secondaryObjects) {
                await connection.execute(object.sql.replace(/users_old/g, "users"));
            }
        }
    } finally {
        await connection.execute("PRAGMA legacy_alter_table = OFF");
    }

    const [violations] = await connection.execute("PRAGMA foreign_key_check");
    if (violations.length > 0) {
        throw new Error(
            `SQLite foreign-key repair found ${violations.length} integrity violation(s).`
        );
    }
}

const db = {
    async initialize() {
        await new Promise((resolve, reject) => {
            sqliteDb.exec(
                `
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    password TEXT NOT NULL,
                    email_verified INTEGER NOT NULL DEFAULT 1,
                    role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('buyer', 'customer', 'seller', 'admin', 'manager')),
                    referral_code TEXT UNIQUE,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS seller_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL UNIQUE,
                    business_name TEXT NOT NULL,
                    business_website TEXT,
                    business_description TEXT,
                    business_logo TEXT,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE
                );

                CREATE TABLE IF NOT EXISTS products (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    seller_id INTEGER NOT NULL,
                    category_id INTEGER,
                    name TEXT NOT NULL,
                    description TEXT,
                    price REAL NOT NULL,
                    stock INTEGER NOT NULL DEFAULT 0,
                    image TEXT,
                    moderation_status TEXT NOT NULL DEFAULT 'approved' CHECK(moderation_status IN ('pending', 'approved', 'rejected')),
                    moderation_note TEXT,
                    promotion_discount_percent REAL NOT NULL DEFAULT 0,
                    promotion_starts_at TEXT,
                    promotion_ends_at TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (seller_id) REFERENCES users(id),
                    FOREIGN KEY (category_id) REFERENCES categories(id)
                );

                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NOT NULL,
                    total REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled')),
                    recipient_name TEXT,
                    shipping_address TEXT,
                    shipping_city TEXT,
                    shipping_region TEXT,
                    shipping_postal_code TEXT,
                    recipient_phone TEXT,
                    points_redeemed INTEGER NOT NULL DEFAULT 0,
                    discount_amount REAL NOT NULL DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS order_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    quantity INTEGER NOT NULL,
                    price REAL NOT NULL,
                    promotion_discount_percent REAL NOT NULL DEFAULT 0,
                    FOREIGN KEY (order_id) REFERENCES orders(id),
                    FOREIGN KEY (product_id) REFERENCES products(id),
                    FOREIGN KEY (seller_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS payments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    method TEXT NOT NULL DEFAULT 'pending',
                    transaction_reference TEXT,
                    checkout_request_id TEXT,
                    merchant_request_id TEXT,
                    phone_number TEXT,
                    amount REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'successful', 'failed')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id)
                );

                CREATE TABLE IF NOT EXISTS refund_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL UNIQUE,
                    customer_id INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'refunded')),
                    admin_note TEXT,
                    seller_response TEXT,
                    evidence_key TEXT,
                    reviewed_by INTEGER,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id INTEGER NOT NULL,
                    customer_id INTEGER NOT NULL,
                    rating INTEGER NOT NULL,
                    comment TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (product_id) REFERENCES products(id),
                    FOREIGN KEY (customer_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS seller_review_responses (
                    review_id INTEGER PRIMARY KEY,
                    seller_id INTEGER NOT NULL,
                    response TEXT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS seller_review_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    review_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reviewed', 'dismissed')),
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(review_id, seller_id),
                    FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_profiles (
                    user_id INTEGER PRIMARY KEY,
                    phone TEXT,
                    mpesa_phone TEXT,
                    shipping_address TEXT,
                    shipping_city TEXT,
                    shipping_region TEXT,
                    shipping_postal_code TEXT,
                    email_notifications INTEGER NOT NULL DEFAULT 1,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS wishlists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    alert_price_drop INTEGER NOT NULL DEFAULT 1,
                    alert_back_in_stock INTEGER NOT NULL DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(customer_id, product_id),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS order_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    customer_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    sender_id INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS seller_order_fulfillments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'shipped')),
                    tracking_number TEXT,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(order_id, seller_id),
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS seller_order_decisions (
                    order_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('accepted', 'rejected')),
                    note TEXT,
                    admin_adjustment_status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(admin_adjustment_status IN ('pending', 'handled')),
                    admin_note TEXT,
                    reviewed_by INTEGER,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (order_id, seller_id),
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS seller_stock_movements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    seller_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    previous_stock INTEGER NOT NULL,
                    new_stock INTEGER NOT NULL,
                    change_reason TEXT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS delivery_complaints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    customer_id INTEGER NOT NULL,
                    complaint TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'resolved')),
                    follow_up_note TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(order_id, seller_id),
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS seller_payout_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    seller_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    payout_phone TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'paid')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS commissions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    order_item_id INTEGER,
                    commission_rate REAL NOT NULL DEFAULT 10,
                    commission_flat_fee REAL NOT NULL DEFAULT 0,
                    gross_amount REAL NOT NULL DEFAULT 0,
                    seller_net_amount REAL NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'earned', 'void')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id),
                    FOREIGN KEY (seller_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS marketplace_settings (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    commission_rate REAL NOT NULL DEFAULT 10,
                    commission_flat_fee REAL NOT NULL DEFAULT 0,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS commission_rules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rule_type TEXT NOT NULL CHECK(rule_type IN ('category', 'seller')),
                    target_id INTEGER NOT NULL,
                    commission_rate REAL NOT NULL CHECK(commission_rate >= 0 AND commission_rate <= 50),
                    flat_fee REAL NOT NULL DEFAULT 0 CHECK(flat_fee >= 0),
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(rule_type, target_id)
                );

                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    action TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS email_verification_tokens (
                    user_id INTEGER PRIMARY KEY,
                    token_hash TEXT NOT NULL,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS admin_mfa (
                    user_id INTEGER PRIMARY KEY,
                    secret_ciphertext TEXT NOT NULL,
                    enabled_at DATETIME,
                    last_totp_step INTEGER NOT NULL DEFAULT -1,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS admin_mfa_recovery_codes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    code_hash TEXT NOT NULL,
                    used_at DATETIME,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, code_hash),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_product_views (
                    customer_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    viewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    view_count INTEGER NOT NULL DEFAULT 1,
                    last_activity_date TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (customer_id, product_id),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_activity_days (
                    customer_id INTEGER NOT NULL,
                    activity_date TEXT NOT NULL,
                    PRIMARY KEY (customer_id, activity_date),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_preferences (
                    customer_id INTEGER PRIMARY KEY,
                    favorite_category_id INTEGER,
                    shopping_style TEXT,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (favorite_category_id) REFERENCES categories(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS customer_seller_follows (
                    customer_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (customer_id, seller_id),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(customer_id, name),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_collection_items (
                    collection_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (collection_id, product_id),
                    FOREIGN KEY (collection_id) REFERENCES customer_collections(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_points_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NOT NULL,
                    points INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    event_key TEXT NOT NULL UNIQUE,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_badges (
                    customer_id INTEGER NOT NULL,
                    badge_key TEXT NOT NULL,
                    earned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (customer_id, badge_key),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_referrals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    referrer_id INTEGER NOT NULL,
                    referred_customer_id INTEGER NOT NULL UNIQUE,
                    status TEXT NOT NULL DEFAULT 'joined' CHECK(status IN ('joined', 'first_order')),
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (referred_customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_wishlist_watch_state (
                    customer_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    last_price REAL NOT NULL,
                    last_stock INTEGER NOT NULL,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (customer_id, product_id),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_wishlist_alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    alert_type TEXT NOT NULL CHECK(alert_type IN ('price_drop', 'back_in_stock')),
                    message TEXT NOT NULL,
                    emailed_at DATETIME,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_seller_updates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    update_type TEXT NOT NULL CHECK(update_type IN ('new_product', 'price_drop')),
                    event_key TEXT NOT NULL UNIQUE,
                    message TEXT NOT NULL,
                    emailed_at DATETIME,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );
                `,
                (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve();
                }
            );
        });

        const [schemaRows] = await db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'");
        const userTableSql = schemaRows[0]?.sql || "";
        const hasExpandedRoles = userTableSql.includes("'buyer'") && userTableSql.includes("'manager'");

        const [legacyReferenceRows] = await db.execute(
            `SELECT name
             FROM sqlite_master
            WHERE type = 'table' AND name != 'users_old' AND sql LIKE '%users_old%'`
        );
        if (legacyReferenceRows.length > 0) {
            await db.execute("PRAGMA foreign_keys = OFF");
            try {
                await db.transaction((connection) => repairLegacyUserForeignKeys(connection));
            } finally {
                await db.execute("PRAGMA foreign_keys = ON");
            }
        }

        if (userTableSql && !hasExpandedRoles) {
            await db.execute("PRAGMA foreign_keys = OFF");
            await db.execute("PRAGMA legacy_alter_table = ON");
            try {
                await db.transaction(async (connection) => {
                    const [userColumns] = await connection.execute("PRAGMA table_info(users)");
                    const hasEmailVerified = userColumns.some((column) => column.name === "email_verified");
                    await connection.execute(`
                        CREATE TABLE users_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT NOT NULL,
                            email TEXT NOT NULL UNIQUE,
                            password TEXT NOT NULL,
                            email_verified INTEGER NOT NULL DEFAULT 1,
                            role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('buyer', 'customer', 'seller', 'admin', 'manager')),
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                    `);
                    await connection.execute(
                        `INSERT INTO users_new (id, name, email, password, email_verified, role, created_at)
                         SELECT id, name, email, password, ${hasEmailVerified ? "email_verified" : "1"},
                                CASE role
                                    WHEN 'customer' THEN 'buyer'
                                    WHEN 'seller' THEN 'seller'
                                    WHEN 'admin' THEN 'admin'
                                    WHEN 'manager' THEN 'manager'
                                    ELSE 'buyer'
                                END,
                                created_at
                         FROM users`
                    );
                    await connection.execute("DROP TABLE users");
                    await connection.execute("ALTER TABLE users_new RENAME TO users");
                });
            } finally {
                await db.execute("PRAGMA legacy_alter_table = OFF");
                await db.execute("PRAGMA foreign_keys = ON");
            }
        }

        const [userColumns] = await db.execute("PRAGMA table_info(users)");
        if (!userColumns.some((column) => column.name === "email_verified")) {
            await db.execute("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1");
        }
        if (!userColumns.some((column) => column.name === "referral_code")) {
            await db.execute("ALTER TABLE users ADD COLUMN referral_code TEXT");
        }
        await db.execute(
            "UPDATE users SET referral_code = 'C' || id WHERE referral_code IS NULL OR referral_code = ''"
        );
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL"
        );

        const [wishlistColumns] = await db.execute("PRAGMA table_info(wishlists)");
        for (const [columnName, columnType] of [
            ["alert_price_drop", "INTEGER NOT NULL DEFAULT 1"],
            ["alert_back_in_stock", "INTEGER NOT NULL DEFAULT 1"]
        ]) {
            if (!wishlistColumns.some((column) => column.name === columnName)) {
                await db.execute(`ALTER TABLE wishlists ADD COLUMN ${columnName} ${columnType}`);
            }
        }

        const [orderColumns] = await db.execute("PRAGMA table_info(orders)");
        for (const [columnName, columnType] of [
            ["recipient_name", "TEXT"],
            ["shipping_address", "TEXT"],
            ["shipping_city", "TEXT"],
            ["shipping_region", "TEXT"],
            ["shipping_postal_code", "TEXT"],
            ["recipient_phone", "TEXT"],
            ["points_redeemed", "INTEGER NOT NULL DEFAULT 0"],
            ["discount_amount", "REAL NOT NULL DEFAULT 0"]
        ]) {
            if (!orderColumns.some((column) => column.name === columnName)) {
                await db.execute(`ALTER TABLE orders ADD COLUMN ${columnName} ${columnType}`);
            }
        }

        const [customerProfileColumns] = await db.execute("PRAGMA table_info(customer_profiles)");
        if (!customerProfileColumns.some((column) => column.name === "email_notifications")) {
            await db.execute(
                "ALTER TABLE customer_profiles ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1"
            );
        }

        const [productColumns] = await db.execute("PRAGMA table_info(products)");
        for (const [columnName, columnType] of [
            ["moderation_status", "TEXT NOT NULL DEFAULT 'approved'"],
            ["moderation_note", "TEXT"],
            ["promotion_discount_percent", "REAL NOT NULL DEFAULT 0"],
            ["promotion_starts_at", "TEXT"],
            ["promotion_ends_at", "TEXT"]
        ]) {
            if (!productColumns.some((column) => column.name === columnName)) {
                await db.execute(`ALTER TABLE products ADD COLUMN ${columnName} ${columnType}`);
            }
        }
        const [orderItemColumns] = await db.execute("PRAGMA table_info(order_items)");
        if (!orderItemColumns.some((column) => column.name === "promotion_discount_percent")) {
            await db.execute(
                "ALTER TABLE order_items ADD COLUMN promotion_discount_percent REAL NOT NULL DEFAULT 0"
            );
        }
        const [refundRequestColumns] = await db.execute("PRAGMA table_info(refund_requests)");
        for (const [columnName, columnType] of [
            ["seller_response", "TEXT"],
            ["evidence_key", "TEXT"]
        ]) {
            if (!refundRequestColumns.some((column) => column.name === columnName)) {
                await db.execute(`ALTER TABLE refund_requests ADD COLUMN ${columnName} ${columnType}`);
            }
        }
        const [sellerDecisionColumns] = await db.execute("PRAGMA table_info(seller_order_decisions)");
        for (const [columnName, columnType] of [
            ["admin_adjustment_status", "TEXT NOT NULL DEFAULT 'pending'"],
            ["admin_note", "TEXT"],
            ["reviewed_by", "INTEGER"]
        ]) {
            if (!sellerDecisionColumns.some((column) => column.name === columnName)) {
                await db.execute(`ALTER TABLE seller_order_decisions ADD COLUMN ${columnName} ${columnType}`);
            }
        }
        await db.execute(
            `INSERT OR IGNORE INTO seller_order_decisions (order_id, seller_id, status)
             SELECT order_id, seller_id, 'accepted'
             FROM seller_order_fulfillments
             WHERE status IN ('processing', 'shipped')`
        );

        const [commissionColumns] = await db.execute("PRAGMA table_info(commissions)");
        for (const [columnName, columnType] of [
            ["order_item_id", "INTEGER"],
            ["commission_rate", "REAL NOT NULL DEFAULT 10"],
            ["commission_flat_fee", "REAL NOT NULL DEFAULT 0"],
            ["gross_amount", "REAL NOT NULL DEFAULT 0"],
            ["seller_net_amount", "REAL NOT NULL DEFAULT 0"],
            ["status", "TEXT NOT NULL DEFAULT 'pending'"]
        ]) {
            if (!commissionColumns.some((column) => column.name === columnName)) {
                await db.execute(`ALTER TABLE commissions ADD COLUMN ${columnName} ${columnType}`);
            }
        }
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_commissions_order_item_id ON commissions(order_item_id) WHERE order_item_id IS NOT NULL"
        );
        const [settingsColumns] = await db.execute("PRAGMA table_info(marketplace_settings)");
        if (!settingsColumns.some((column) => column.name === "commission_flat_fee")) {
            await db.execute("ALTER TABLE marketplace_settings ADD COLUMN commission_flat_fee REAL NOT NULL DEFAULT 0");
        }
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
                    ROUND(oi.quantity * oi.price * 0.10, 2),
                    oi.id,
                    10,
                    ROUND(oi.quantity * oi.price, 2),
                    ROUND(oi.quantity * oi.price * 0.90, 2),
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

        const [sellerProfileColumns] = await db.execute("PRAGMA table_info(seller_profiles)");
        for (const columnName of ["business_website", "business_description", "business_logo"]) {
            if (!sellerProfileColumns.some((column) => column.name === columnName)) {
                await db.execute(`ALTER TABLE seller_profiles ADD COLUMN ${columnName} TEXT`);
            }
        }

        const [paymentColumns] = await db.execute("PRAGMA table_info(payments)");
        for (const [columnName, columnType] of [
            ["checkout_request_id", "TEXT"],
            ["merchant_request_id", "TEXT"],
            ["phone_number", "TEXT"]
        ]) {
            if (!paymentColumns.some((column) => column.name === columnName)) {
                await db.execute(`ALTER TABLE payments ADD COLUMN ${columnName} ${columnType}`);
            }
        }
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_checkout_request_id ON payments(checkout_request_id) WHERE checkout_request_id IS NOT NULL"
        );

        await db.execute(`
            CREATE TABLE IF NOT EXISTS password_reset_codes (
                user_id INTEGER PRIMARY KEY,
                code_hash TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        await db.execute("UPDATE users SET role = ? WHERE role IN (?, ?)", [
            "customer",
            "buyer",
            "manager"
        ]);

        const [categories] = await db.execute("SELECT id FROM categories WHERE name = ?", ["Electronics"]);
        if (categories.length === 0) {
            await db.execute("INSERT INTO categories (name) VALUES (?)", ["Electronics"]);
            await db.execute("INSERT INTO categories (name) VALUES (?)", ["Clothing"]);
            await db.execute("INSERT INTO categories (name) VALUES (?)", ["Home and Living"]);
        }

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
            await db.execute(
                "UPDATE users SET password = ? WHERE id = ?",
                [unusablePassword, legacyAdminUsers[0].id]
            );
        }

        const [legacyManagerUsers] = await db.execute(
            "SELECT id, password FROM users WHERE email = ?",
            ["manager@marketplace.com"]
        );
        if (legacyManagerUsers.length > 0 && await bcrypt.compare("Manager123!", legacyManagerUsers[0].password)) {
            const unusablePassword = await bcrypt.hash(crypto.randomBytes(48).toString("hex"), 12);
            await db.execute(
                "UPDATE users SET password = ? WHERE id = ?",
                [unusablePassword, legacyManagerUsers[0].id]
            );
        }

        const [productRows] = await db.execute("SELECT id FROM products LIMIT 1");
        if (productRows.length === 0) {
            const [sellerRows] = await db.execute("SELECT id FROM users WHERE email = ?", ["admin@marketplace.com"]);
            const sellerId = sellerRows[0]?.id;
            const [categoryRows] = await db.execute("SELECT id FROM categories WHERE name = ?", ["Electronics"]);
            const categoryId = categoryRows[0]?.id;

            if (sellerId && categoryId) {
                await db.execute(
                    "INSERT INTO products (seller_id, category_id, name, description, price, stock, image) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [sellerId, categoryId, "Wireless Headphones", "Comfortable wireless headphones for daily use.", 3999.00, 12, "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=900&q=80"]
                );
            }
        }
    },

    async execute(sql, params = []) {
        const connection = new SQLiteConnection(sqliteDb);
        if (transactionContext.getStore() === sqliteDb) {
            return connection.execute(sql, params);
        }

        return enqueueDatabaseOperation(() => connection.execute(sql, params));
    },

    async transaction(callback) {
        if (transactionContext.getStore() === sqliteDb) {
            throw new Error("Nested database transactions are not supported.");
        }

        return enqueueDatabaseOperation(async () => {
            const connection = new SQLiteConnection(sqliteDb);
            await connection.execute("BEGIN IMMEDIATE");

            try {
                const result = await transactionContext.run(
                    sqliteDb,
                    () => callback(connection)
                );
                await connection.commit();
                return result;
            } catch (error) {
                try {
                    await connection.rollback();
                } catch (rollbackError) {
                    console.error("Database transaction rollback error:", rollbackError.message);
                }

                throw error;
            }
        });
    },

    async backup(destination) {
        return enqueueDatabaseOperation(() => new Promise((resolve, reject) => {
            const backup = sqliteDb.backup(destination);
            backup.step(-1, (error) => {
                if (error) {
                    reject(error);
                } else if (backup.failed || !backup.completed) {
                    reject(new Error("SQLite backup did not complete successfully."));
                } else {
                    resolve();
                }
            });
        }));
    }
};

module.exports = db;