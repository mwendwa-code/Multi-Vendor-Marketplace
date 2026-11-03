const crypto = require("crypto");
const db = require("../database/db");

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const totpPeriodSeconds = 30;

function getEncryptionKey() {
    const key = process.env.MFA_ENCRYPTION_KEY;
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/i.test(key)) {
        throw Object.assign(
            new Error("Set MFA_ENCRYPTION_KEY to a 32-byte hexadecimal key."),
            { code: "MFA_CONFIG_INVALID" }
        );
    }
    return Buffer.from(key, "hex");
}

function encodeBase32(buffer) {
    let bits = 0;
    let value = 0;
    let result = "";
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            result += base32Alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        result += base32Alphabet[(value << (5 - bits)) & 31];
    }
    return result;
}

function decodeBase32(value) {
    const normalized = value.replace(/[\s=-]/g, "").toUpperCase();
    let bits = 0;
    let buffer = 0;
    const bytes = [];
    for (const character of normalized) {
        const index = base32Alphabet.indexOf(character);
        if (index < 0) throw new Error("The stored authenticator secret is invalid.");
        buffer = (buffer << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((buffer >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function encryptSecret(secret) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(secret, "utf8"),
        cipher.final()
    ]);
    return [
        iv.toString("hex"),
        cipher.getAuthTag().toString("hex"),
        ciphertext.toString("hex")
    ].join(".");
}

function decryptSecret(encrypted) {
    const [ivHex, tagHex, ciphertextHex] = encrypted.split(".");
    if (
        !/^[a-f0-9]{24}$/i.test(ivHex || "") ||
        !/^[a-f0-9]{32}$/i.test(tagHex || "") ||
        !/^[a-f0-9]+$/i.test(ciphertextHex || "")
    ) {
        throw new Error("The stored authenticator secret is invalid.");
    }
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        getEncryptionKey(),
        Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextHex, "hex")),
        decipher.final()
    ]).toString("utf8");
}

function generateTotp(secret, timestamp = Date.now()) {
    const step = Math.floor(timestamp / 1000 / totpPeriodSeconds);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    const binary =
        ((digest[offset] & 127) << 24) |
        ((digest[offset + 1] & 255) << 16) |
        ((digest[offset + 2] & 255) << 8) |
        (digest[offset + 3] & 255);
    return {
        code: String(binary % 1000000).padStart(6, "0"),
        step
    };
}

function verifyTotp(secret, submittedCode, lastAcceptedStep = -1, timestamp = Date.now()) {
    if (typeof submittedCode !== "string" || !/^\d{6}$/.test(submittedCode)) {
        return null;
    }
    const currentStep = Math.floor(timestamp / 1000 / totpPeriodSeconds);
    for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
        if (step <= lastAcceptedStep) continue;
        const expected = generateTotp(secret, step * totpPeriodSeconds * 1000).code;
        const submittedBuffer = Buffer.from(submittedCode);
        const expectedBuffer = Buffer.from(expected);
        if (crypto.timingSafeEqual(submittedBuffer, expectedBuffer)) return step;
    }
    return null;
}

function createRecoveryCodes() {
    return Array.from({ length: 10 }, () => {
        const rawCode = crypto.randomBytes(5).toString("hex").toUpperCase();
        return `${rawCode.slice(0, 5)}-${rawCode.slice(5)}`;
    });
}

function hashRecoveryCode(code) {
    const normalized = code.replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-F0-9]{10}$/.test(normalized)) return null;
    return crypto.createHash("sha256").update(normalized).digest("hex");
}

async function prepareAdminMfa(userId) {
    const [rows] = await db.execute(
        "SELECT enabled_at FROM admin_mfa WHERE user_id = ?",
        [userId]
    );
    if (rows.length) {
        getEncryptionKey();
        return { enrolled: Boolean(rows[0].enabled_at) };
    }

    const secret = encodeBase32(crypto.randomBytes(20));
    await db.execute(
        `INSERT INTO admin_mfa (user_id, secret_ciphertext)
         VALUES (?, ?)
         ON CONFLICT(user_id) DO NOTHING`,
        [userId, encryptSecret(secret)]
    );
    return { enrolled: false };
}

async function getPendingSecret(userId) {
    const [rows] = await db.execute(
        "SELECT secret_ciphertext, enabled_at FROM admin_mfa WHERE user_id = ?",
        [userId]
    );
    if (!rows.length || rows[0].enabled_at) return null;
    return decryptSecret(rows[0].secret_ciphertext);
}

function getAuthenticatorUri(secret, email) {
    const issuer = "The Marketplace";
    const label = `${issuer}:${email}`;
    const parameters = new URLSearchParams({
        secret,
        issuer,
        algorithm: "SHA1",
        digits: "6",
        period: String(totpPeriodSeconds)
    });
    return `otpauth://totp/${encodeURIComponent(label)}?${parameters.toString()}`;
}

async function enableAdminMfa(userId, submittedCode) {
    return db.transaction(async (connection) => {
        const [rows] = await connection.execute(
            "SELECT secret_ciphertext, enabled_at, last_totp_step FROM admin_mfa WHERE user_id = ?",
            [userId]
        );
        const enrollment = rows[0];
        if (!enrollment || enrollment.enabled_at) {
            return null;
        }

        const secret = decryptSecret(enrollment.secret_ciphertext);
        const step = verifyTotp(secret, submittedCode, Number(enrollment.last_totp_step ?? -1));
        if (step === null) return null;

        const recoveryCodes = createRecoveryCodes();
        for (const code of recoveryCodes) {
            await connection.execute(
                "INSERT INTO admin_mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)",
                [userId, hashRecoveryCode(code)]
            );
        }
        await connection.execute(
            "UPDATE admin_mfa SET enabled_at = CURRENT_TIMESTAMP, last_totp_step = ? WHERE user_id = ?",
            [step, userId]
        );
        return recoveryCodes;
    });
}

async function verifyAdminMfa(userId, submittedCode) {
    return db.transaction(async (connection) => {
        const [rows] = await connection.execute(
            "SELECT secret_ciphertext, enabled_at, last_totp_step FROM admin_mfa WHERE user_id = ?",
            [userId]
        );
        const enrollment = rows[0];
        if (!enrollment || !enrollment.enabled_at) return false;

        const secret = decryptSecret(enrollment.secret_ciphertext);
        const step = verifyTotp(
            secret,
            typeof submittedCode === "string" ? submittedCode.trim() : "",
            Number(enrollment.last_totp_step ?? -1)
        );
        if (step !== null) {
            const [result] = await connection.execute(
                "UPDATE admin_mfa SET last_totp_step = ? WHERE user_id = ? AND last_totp_step < ?",
                [step, userId, step]
            );
            return result.rowsAffected === 1;
        }

        if (typeof submittedCode !== "string") return false;
        const codeHash = hashRecoveryCode(submittedCode);
        if (!codeHash) return false;
        const [recoveryCodes] = await connection.execute(
            `SELECT id FROM admin_mfa_recovery_codes
             WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
            [userId, codeHash]
        );
        if (!recoveryCodes.length) return false;
        const [result] = await connection.execute(
            "UPDATE admin_mfa_recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL",
            [recoveryCodes[0].id]
        );
        return result.rowsAffected === 1;
    });
}

module.exports = {
    enableAdminMfa,
    generateTotp,
    getAuthenticatorUri,
    getPendingSecret,
    hashRecoveryCode,
    prepareAdminMfa,
    verifyAdminMfa
};
