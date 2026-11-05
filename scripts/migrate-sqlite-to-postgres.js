const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const fsSync = require("fs");
const dotenv = require("dotenv");

dotenv.config({
    path: [
        path.join(__dirname, "..", "backend", ".env"),
        path.join(__dirname, "..", ".env"),
        path.join(__dirname, "..", "..", ".env")
    ].filter((envPath) => fsSync.existsSync(envPath))
});

const db = require("../backend/database/db");

const sourcePath = path.resolve(
    process.env.SQLITE_MIGRATION_PATH ||
    path.join(__dirname, "..", "backend", "database", "marketplace.db")
);
const skippedTables = new Set([
    "sessions",
    "user_sessions",
    "admin_mfa",
    "admin_mfa_recovery_codes"
]);

function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function openSourceDatabase(filename) {
    return new Promise((resolve, reject) => {
        const source = new sqlite3.Database(
            filename,
            sqlite3.OPEN_READONLY,
            (error) => error ? reject(error) : resolve(source)
        );
    });
}

function sourceQuery(source, sql, params = []) {
    return new Promise((resolve, reject) => {
        source.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function closeSourceDatabase(source) {
    return new Promise((resolve, reject) => {
        source.close((error) => error ? reject(error) : resolve());
    });
}

async function getMigrationOrder(source, tables) {
    const dependencies = new Map(tables.map((table) => [table, new Set()]));
    for (const table of tables) {
        const foreignKeys = await sourceQuery(
            source,
            `PRAGMA foreign_key_list(${quoteIdentifier(table)})`
        );
        for (const foreignKey of foreignKeys) {
            if (dependencies.has(foreignKey.table)) {
                dependencies.get(table).add(foreignKey.table);
            }
        }
    }

    const ordered = [];
    const visited = new Set();
    const visiting = new Set();
    function visit(table) {
        if (visited.has(table)) return;
        if (visiting.has(table)) {
            throw new Error(`Foreign-key cycle detected while ordering table "${table}".`);
        }
        visiting.add(table);
        for (const dependency of dependencies.get(table)) visit(dependency);
        visiting.delete(table);
        visited.add(table);
        ordered.push(table);
    }
    for (const table of tables) visit(table);
    return ordered;
}

async function migrate() {
    if (process.argv[2] !== "--confirm") {
        throw new Error(
            "This migration writes to PostgreSQL. Re-run with --confirm after verifying DATABASE_URL and SQLITE_MIGRATION_PATH."
        );
    }

    await db.initialize({ seed: false });
    const source = await openSourceDatabase(sourcePath);
    const client = await db.pool.connect();
    let transactionStarted = false;

    try {
        const { rows: targetTables } = await client.query(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        );
        for (const { table_name: tableName } of targetTables) {
            if (skippedTables.has(tableName)) continue;
            const safeTableName = quoteIdentifier(tableName);
            const { rows } = await client.query(`SELECT COUNT(*)::bigint AS row_count FROM public.${safeTableName}`);
            if (Number(rows[0].row_count) > 0) {
                throw new Error(
                    `PostgreSQL table "${tableName}" is not empty. Migration stopped to avoid overwriting existing data.`
                );
            }
        }

        const sourceTables = await sourceQuery(
            source,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );
        const tables = sourceTables
            .map(({ name }) => name)
            .filter((name) => !skippedTables.has(name));
        const targetTableNames = new Set(targetTables.map(({ table_name }) => table_name));
        const unknownTables = tables.filter((table) => !targetTableNames.has(table));
        if (unknownTables.length > 0) {
            throw new Error(`No PostgreSQL destination exists for SQLite table(s): ${unknownTables.join(", ")}.`);
        }

        const order = await getMigrationOrder(source, tables);
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query("SET CONSTRAINTS ALL DEFERRED");

        let totalRows = 0;
        for (const table of order) {
            const sourceColumns = await sourceQuery(
                source,
                `PRAGMA table_info(${quoteIdentifier(table)})`
            );
            const { rows: destinationColumns } = await client.query(
                `SELECT column_name, data_type
                 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = $1
                 ORDER BY ordinal_position`,
                [table]
            );
            const destinationColumnTypes = new Map(
                destinationColumns.map(({ column_name, data_type }) => [column_name, data_type])
            );
            const destinationColumnNames = new Set(destinationColumnTypes.keys());
            const columns = sourceColumns
                .map(({ name }) => name)
                .filter((name) => destinationColumnNames.has(name));
            const omittedColumns = sourceColumns
                .map(({ name }) => name)
                .filter((name) => !destinationColumnNames.has(name));
            if (omittedColumns.length > 0) {
                const omittedValues = await sourceQuery(
                    source,
                    `SELECT ${omittedColumns.map(quoteIdentifier).join(", ")}
                     FROM ${quoteIdentifier(table)}
                     WHERE ${omittedColumns.map((column) => `${quoteIdentifier(column)} IS NOT NULL`).join(" OR ")}
                     LIMIT 1`
                );
                if (omittedValues.length > 0) {
                    throw new Error(
                        `SQLite table "${table}" has non-empty column(s) missing from PostgreSQL: ${omittedColumns.join(", ")}.`
                    );
                }
            }

            const sourceRows = await sourceQuery(
                source,
                `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`
            );
            if (columns.length > 0) {
                const insertSql = `INSERT INTO public.${quoteIdentifier(table)}
                    (${columns.map(quoteIdentifier).join(", ")})
                    VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`;
                for (const row of sourceRows) {
                    const values = columns.map((column) => {
                        const value = row[column];
                        const dataType = destinationColumnTypes.get(column);
                        return value === "" && dataType?.startsWith("timestamp") ? null : value;
                    });
                    await client.query(insertSql, values);
                }
            } else if (sourceRows.length > 0) {
                throw new Error(`SQLite table "${table}" has rows but no compatible columns.`);
            }

            if (destinationColumnNames.has("id")) {
                await client.query(
                    `SELECT setval(
                        pg_get_serial_sequence($1, 'id'),
                        COALESCE(MAX(id), 1),
                        COUNT(*) > 0
                     )
                     FROM public.${quoteIdentifier(table)}`,
                    [`public.${table}`]
                );
            }
            totalRows += sourceRows.length;
            console.log(`Migrated ${sourceRows.length} row(s) from ${table}.`);
        }

        await client.query("COMMIT");
        transactionStarted = false;
        console.log(`Migration completed: ${totalRows} row(s) copied from ${sourcePath}.`);
    } catch (error) {
        if (transactionStarted) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("PostgreSQL migration rollback error:", rollbackError.message);
            }
        }
        throw error;
    } finally {
        client.release();
        await closeSourceDatabase(source);
        await db.pool.end();
    }
}

migrate().catch((error) => {
    console.error("SQLite-to-PostgreSQL migration failed:", error.message);
    process.exitCode = 1;
});
