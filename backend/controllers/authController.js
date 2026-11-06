const bcrypt = require("bcrypt");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const db = require("../database/db");
const { normalizeCart } = require("../services/checkoutService");
const { normalizeBusinessWebsite } = require("../services/businessWebsite");
const { recordAuditEvent } = require("../database/audit");

function getGoogleOAuthClient() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
    const redirectBaseUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
        (redirectBaseUrl ? new URL("/auth/google/callback", redirectBaseUrl).toString() : "");
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !redirectUri) {
        return null;
    }

    return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

function getDashboardPath(role) {
    if (role === "admin") return "/admin";
    if (role === "seller") return "/seller";
    return "/customer";
}

function establishSession(req, res, user, onSuccess) {
    const cart = normalizeCart(req.session.cart || []);
    req.session.regenerate((error) => {
        if (error) {
            console.error("Session error:", error.message);
            return res.status(500).send("Could not start your session.");
        }

        req.session.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role
        };
        req.session.cart = cart;
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");

        req.session.save((saveError) => {
            if (saveError) {
                console.error("Session error:", saveError.message);
                return res.status(500).send("Could not start your session.");
            }

            return onSuccess();
        });
    });
}

function getMailer() {
    const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD } = process.env;
    const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !Number.isInteger(SMTP_PORT) || SMTP_PORT < 1 || SMTP_PORT > 65535) {
        return null;
    }

    return nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: process.env.SMTP_SECURE === "true",
        auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
    });
}

function getAppBaseUrl() {
    const configuredUrl = process.env.APP_BASE_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        `http://localhost:${process.env.PORT || 3000}`;
    const parsedUrl = new URL(configuredUrl);
    if (
        !["http:", "https:"].includes(parsedUrl.protocol) ||
        (process.env.NODE_ENV === "production" && parsedUrl.protocol !== "https:") ||
        parsedUrl.username ||
        parsedUrl.password
    ) {
        throw new Error("APP_BASE_URL must be a URL without embedded credentials and use HTTPS in production.");
    }
    return parsedUrl.origin;
}

async function createVerificationToken(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.execute(
        `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
            token_hash = excluded.token_hash,
            expires_at = excluded.expires_at,
            created_at = CURRENT_TIMESTAMP`,
        [userId, tokenHash, expiresAt]
    );
    return token;
}

function getVerificationUrl(token) {
    const verificationUrl = new URL("/auth/verify-email", getAppBaseUrl());
    verificationUrl.searchParams.set("token", token);
    return verificationUrl.toString();
}

async function sendVerificationEmail(email, name, token) {
    const transporter = getMailer();
    const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!transporter || !fromAddress) {
        throw new Error("Email verification is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM.");
    }

    const verificationUrl = getVerificationUrl(token);
    await transporter.sendMail({
        from: fromAddress,
        to: email,
        subject: "Verify your marketplace email",
        text: `Hello ${name},\n\nVerify your email address by opening this link within 24 hours:\n${verificationUrl.toString()}`,
        html: `<p>Hello ${escapeHtml(name)},</p><p><a href="${escapeHtml(verificationUrl.toString())}">Verify your email address</a>. This link expires in 24 hours.</p>`
    });
}

async function deliverVerification(email, name, token) {
    if (getMailer()) {
        await sendVerificationEmail(email, name, token);
        return { deliveryMode: "sent", verificationUrl: null };
    }

    if (process.env.NODE_ENV === "production") {
        throw new Error("Email verification is not configured.");
    }

    return {
        deliveryMode: "local",
        verificationUrl: getVerificationUrl(token)
    };
}

async function saveLocalVerificationUrl(req, verificationUrl) {
    if (!verificationUrl) {
        return;
    }

    req.session.localVerificationUrl = verificationUrl;
    await new Promise((resolve, reject) => {
        req.session.save((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

// Register a new customer or seller
exports.register = async (req, res) => {
    try {
        const { name, email, password, role, businessName, businessWebsite, referralCode } = req.body || {};
        const normalizedEmail =
            typeof email === "string" ? email.trim().toLowerCase() : "";
        const normalizedRole = role === "buyer" ? "customer" : role;

        if (
            typeof name !== "string" ||
            typeof email !== "string" ||
            typeof password !== "string" ||
            typeof role !== "string" ||
            !name.trim() ||
            !normalizedEmail ||
            !password
        ) {
            return res.status(400).send("Please fill in all required fields.");
        }

        if (
            name.trim().length > 100 ||
            /[\u0000-\u001f\u007f]/.test(name) ||
            normalizedEmail.length > 150 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
        ) {
            return res.status(400).send("Enter a valid name and email address.");
        }

        if (!["customer", "seller"].includes(normalizedRole)) {
            return res.status(400).send("Invalid account type.");
        }
        let referrerId = null;
        if (referralCode !== undefined && referralCode !== "") {
            if (normalizedRole !== "customer" || typeof referralCode !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(referralCode)) {
                return res.status(400).send("Invalid referral code.");
            }
            const [referrers] = await db.execute(
                "SELECT id FROM users WHERE referral_code = ? AND role IN ('customer', 'buyer')",
                [referralCode.trim().toUpperCase()]
            );
            if (!referrers.length) return res.status(400).send("This referral link is not valid.");
            referrerId = referrers[0].id;
        }

        if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
            return res.status(400).send("Password must be 8 to 72 bytes long.");
        }

        if (
            normalizedRole === "seller" &&
            (typeof businessName !== "string" ||
                !businessName.trim() ||
                businessName.trim().length > 150)
        ) {
            return res.status(400).send("Please enter your business name.");
        }

        let normalizedBusinessWebsite = null;
        if (normalizedRole === "seller") {
            try {
                normalizedBusinessWebsite = normalizeBusinessWebsite(businessWebsite);
            } catch (error) {
                return res.status(400).send(error.message);
            }
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const userId = await db.transaction(async (connection) => {
            const [existingUsers] = await connection.execute(
                "SELECT id FROM users WHERE email = ?",
                [normalizedEmail]
            );

            if (existingUsers.length > 0) {
                return null;
            }

            const [result] = await connection.execute(
                "INSERT INTO users (name, email, password, role, email_verified, referral_code) VALUES (?, ?, ?, ?, 1, ?) RETURNING id",
                [
                    name.trim(),
                    normalizedEmail,
                    hashedPassword,
                    normalizedRole,
                    normalizedRole === "customer"
                        ? crypto.randomBytes(8).toString("hex").toUpperCase()
                        : null
                ]
            );

            if (normalizedRole === "seller") {
                await connection.execute(
                    "INSERT INTO seller_profiles (user_id, business_name, business_website, status) VALUES (?, ?, ?, ?)",
                    [result.insertId, businessName.trim(), normalizedBusinessWebsite, "pending"]
                );
            } else if (referrerId) {
                await connection.execute(
                    "INSERT INTO customer_referrals (referrer_id, referred_customer_id) VALUES (?, ?)",
                    [referrerId, result.insertId]
                );
            }

            await recordAuditEvent(result.insertId, "account_registered");
            return result.insertId;
        });

        if (!userId) {
            return res.status(409).send("An account with this email already exists.");
        }

        return res.redirect("/login?registered=success");
    } catch (error) {
        if (
            error.code === "23505" ||
            error.code === "ER_DUP_ENTRY" ||
            error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
            (error.code === "SQLITE_CONSTRAINT" && error.message.includes("users.email"))
        ) {
            return res.status(409).send("An account with this email already exists.");
        }

        console.error("Registration error:", error.message);
        return res.status(500).send("Registration failed. Please try again.");
    }
};

// Log in an existing customer, seller, manager, or administrator
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body || {};

        if (
            typeof email !== "string" ||
            typeof password !== "string" ||
            !email.trim() ||
            !password
        ) {
            return res.redirect(303, "/login?error=required");
        }

        const [users] = await db.execute(
            "SELECT id, name, email, password, role, email_verified FROM users WHERE email = ?",
            [email.trim().toLowerCase()]
        );

        if (users.length === 0) {
            return res.redirect(303, "/login?error=invalid");
        }

        const user = users[0];
        if (Buffer.byteLength(password, "utf8") > 72) {
            return res.redirect(303, "/login?error=invalid");
        }
        const passwordMatches = await bcrypt.compare(password, user.password);

        if (!passwordMatches) {
            return res.redirect(303, "/login?error=invalid");
        }

        if (!user.email_verified) {
            if (process.env.NODE_ENV !== "production" && !getMailer()) {
                await db.transaction(async (connection) => {
                    await connection.execute(
                        "UPDATE users SET email_verified = 1 WHERE id = ?",
                        [user.id]
                    );
                    await connection.execute(
                        "DELETE FROM email_verification_tokens WHERE user_id = ?",
                        [user.id]
                    );
                });
                user.email_verified = 1;
                await recordAuditEvent(user.id, "email_verified_local_development");
            } else {
                const verificationToken = await createVerificationToken(user.id);
                try {
                    const delivery = await deliverVerification(
                        user.email,
                        user.name,
                        verificationToken
                    );
                    await recordAuditEvent(user.id, "email_verification_resent");
                    await saveLocalVerificationUrl(req, delivery.verificationUrl);
                    return res.redirect(`/login?verify=${delivery.deliveryMode}`);
                } catch (verificationError) {
                    console.error("Login verification error:", verificationError.message);
                    return res.redirect(303, "/login?error=verification-unavailable");
                }
            }
        }

        await recordAuditEvent(user.id, "login_success");
        return establishSession(req, res, user, () => res.redirect(
            req.session.cart.length > 0 ? "/cart" : getDashboardPath(user.role)
        ));
    } catch (error) {
        console.error("Login error:", error.message);
        return res.redirect(303, "/login?error=unavailable");
    }
};

exports.startGoogleLogin = (req, res) => {
    const oauthClient = getGoogleOAuthClient();
    if (!oauthClient) {
        return res.status(503).send(
            "Google sign-in is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI."
        );
    }

    let referrerId = null;
    if (req.query.ref !== undefined) {
        if (typeof req.query.ref !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(req.query.ref)) {
            return res.status(400).send("This referral link is not valid.");
        }
        db.execute(
            "SELECT id FROM users WHERE referral_code = ? AND role IN ('customer', 'buyer')",
            [req.query.ref.trim().toUpperCase()]
        ).then(([referrers]) => {
            if (!referrers.length) {
                return res.status(400).send("This referral link is not valid.");
            }
            req.session.googleOAuthReferrerId = referrers[0].id;
            return continueGoogleLogin(req, res, oauthClient);
        }).catch((error) => {
            console.error("Google referral lookup error:", error.message);
            return res.status(500).send("Could not start Google sign-in.");
        });
        return;
    }

    req.session.googleOAuthReferrerId = null;
    return continueGoogleLogin(req, res, oauthClient);
};

function continueGoogleLogin(req, res, oauthClient) {
    const state = crypto.randomBytes(32).toString("hex");
    req.session.googleOAuthState = state;
    req.session.save((error) => {
        if (error) {
            console.error("Google sign-in session error:", error.message);
            return res.status(500).send("Could not start Google sign-in.");
        }

        const authorizationUrl = oauthClient.generateAuthUrl({
            access_type: "online",
            scope: ["openid", "email", "profile"],
            state,
            prompt: "select_account"
        });
        return res.redirect(authorizationUrl);
    });
};

exports.completeGoogleLogin = async (req, res) => {
    const oauthClient = getGoogleOAuthClient();
    if (!oauthClient) {
        return res.status(503).send("Google sign-in is not configured.");
    }

    const expectedState = req.session.googleOAuthState;
    const referralReferrerId = req.session.googleOAuthReferrerId;
    delete req.session.googleOAuthState;
    delete req.session.googleOAuthReferrerId;

    if (
        typeof req.query.state !== "string" ||
        typeof expectedState !== "string" ||
        req.query.state !== expectedState
    ) {
        return res.status(400).send("Google sign-in could not be verified. Please try again.");
    }

    if (typeof req.query.code !== "string") {
        return res.status(400).send("Google sign-in was not completed.");
    }

    try {
        const { tokens } = await oauthClient.getToken(req.query.code);
        if (!tokens.id_token) {
            return res.status(401).send("Google did not provide a verified identity.");
        }

        const ticket = await oauthClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();

        if (
            !payload ||
            payload.email_verified !== true ||
            typeof payload.email !== "string" ||
            typeof payload.sub !== "string"
        ) {
            return res.status(401).send("Google did not provide a verified email address.");
        }

        const email = payload.email.trim().toLowerCase();
        if (email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(401).send("Google did not provide a valid email address.");
        }
        const [existingUsers] = await db.execute(
            "SELECT id, name, email, role, email_verified FROM users WHERE email = ?",
            [email]
        );

        let user = existingUsers[0];
        if (user && !user.email_verified) {
            await db.execute("UPDATE users SET email_verified = 1 WHERE id = ?", [user.id]);
            user.email_verified = 1;
            await db.execute("DELETE FROM email_verification_tokens WHERE user_id = ?", [user.id]);
        }
        if (!user) {
            const randomPassword = crypto.randomBytes(48).toString("hex");
            const hashedPassword = await bcrypt.hash(randomPassword, 12);
            const displayName =
                typeof payload.name === "string" && payload.name.trim()
                    ? payload.name.trim().slice(0, 100)
                    : email;
            const userId = await db.transaction(async (connection) => {
                const [result] = await connection.execute(
                    "INSERT INTO users (name, email, password, role, email_verified, referral_code) VALUES (?, ?, ?, ?, 1, ?) RETURNING id",
                    [displayName, email, hashedPassword, "customer", crypto.randomBytes(8).toString("hex").toUpperCase()]
                );
                if (Number.isInteger(referralReferrerId) && referralReferrerId !== result.insertId) {
                    await connection.execute(
                        "INSERT INTO customer_referrals (referrer_id, referred_customer_id) VALUES (?, ?)",
                        [referralReferrerId, result.insertId]
                    );
                }
                return result.insertId;
            });
            user = {
                id: userId,
                name: displayName,
                email,
                role: "customer",
                email_verified: 1
            };
        }

        await recordAuditEvent(user.id, "google_login_success");
        return establishSession(req, res, user, () => res.redirect(
            req.session.cart.length > 0 ? "/cart" : getDashboardPath(user.role)
        ));
    } catch (error) {
        console.error("Google sign-in error:", error.message);
        return res.status(401).send("Google sign-in failed. Please try again.");
    }
};

exports.verifyEmail = async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!/^[a-f0-9]{64}$/.test(token)) {
        return res.redirect("/login?verify=invalid");
    }

    try {
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const [tokens] = await db.execute(
            `SELECT user_id, expires_at
             FROM email_verification_tokens
             WHERE token_hash = ?`,
            [tokenHash]
        );
        const verification = tokens[0];
        if (!verification || Date.parse(verification.expires_at) <= Date.now()) {
            return res.redirect("/login?verify=invalid");
        }

        await db.execute("UPDATE users SET email_verified = 1 WHERE id = ?", [verification.user_id]);
        await db.execute("DELETE FROM email_verification_tokens WHERE user_id = ?", [verification.user_id]);
        await recordAuditEvent(verification.user_id, "email_verified");
        return res.redirect("/login?verify=success");
    } catch (error) {
        console.error("Email verification error:", error.message);
        return res.status(500).send("Could not verify the email address. Please try again.");
    }
};

exports.resendVerification = async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) {
        return res.status(400).send("Enter a valid email address.");
    }

    try {
        const [users] = await db.execute(
            "SELECT id, name, email_verified FROM users WHERE email = ?",
            [email]
        );

        if (users.length > 0 && !users[0].email_verified) {
            const token = await createVerificationToken(users[0].id);
            const delivery = await deliverVerification(
                users[0].email,
                users[0].name,
                token
            );
            await recordAuditEvent(users[0].id, "email_verification_resent");
            await saveLocalVerificationUrl(req, delivery.verificationUrl);
            return res.redirect(`/login?verify=${delivery.deliveryMode}`);
        }

        return res.redirect("/login?verify=sent");
    } catch (error) {
        console.error("Verification resend error:", error.message);
        return res.status(503).send("Could not send a verification email right now. Please try again later.");
    }
};

exports.requestPasswordReset = async (req, res) => {
    const email =
        typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) {
        return res.status(400).render("forgot-password", {
            message: "Enter a valid email address.",
            email
        });
    }

    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const smtpUser = process.env.SMTP_USER;
    const smtpPassword = process.env.SMTP_PASSWORD;
    const fromAddress = process.env.SMTP_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !smtpPassword || !fromAddress) {
        return res.status(503).render("forgot-password", {
            message: "Password reset email is not configured yet. Set the SMTP settings in the app environment.",
            email
        });
    }

    try {
        const [users] = await db.execute(
            "SELECT id, name, email FROM users WHERE email = ?",
            [email]
        );

        if (users.length > 0) {
            const user = users[0];
            const [recentCodes] = await db.execute(
                `SELECT created_at FROM password_reset_codes
                 WHERE user_id = ?
                   AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
                [user.id]
            );

            if (recentCodes.length === 0) {
                const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
                const codeHash = crypto.createHash("sha256").update(code).digest("hex");
                const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

                await db.execute(
                    `INSERT INTO password_reset_codes (user_id, code_hash, expires_at, attempts, created_at)
                     VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
                     ON CONFLICT(user_id) DO UPDATE SET
                        code_hash = excluded.code_hash,
                        expires_at = excluded.expires_at,
                        attempts = 0,
                        created_at = CURRENT_TIMESTAMP`,
                    [user.id, codeHash, expiresAt]
                );

                const transporter = nodemailer.createTransport({
                    host: smtpHost,
                    port: smtpPort,
                    secure: process.env.SMTP_SECURE === "true",
                    auth: {
                        user: smtpUser,
                        pass: smtpPassword
                    }
                });
                await transporter.sendMail({
                    from: fromAddress,
                    to: user.email,
                    subject: "Your marketplace password reset code",
                    text: `Hello ${user.name},\n\nYour password reset code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
                    html: `<p>Hello ${escapeHtml(user.name)},</p><p>Your marketplace password reset code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>`
                });
                await recordAuditEvent(user.id, "password_reset_requested");
            }
        }

        return res.render("forgot-password", {
            message: "If an account exists for that email, a reset code has been sent. Check your inbox and spam folder.",
            email
        });
    } catch (error) {
        console.error("Password reset email error:", error.message);
        return res.status(503).render("forgot-password", {
            message: "We could not send a reset code right now. Check the email configuration and try again.",
            email
        });
    }
};

exports.resetPassword = async (req, res) => {
    const email =
        typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !/^\d{6}$/.test(code) ||
        password.length < 8 ||
        Buffer.byteLength(password, "utf8") > 72
    ) {
        return res.status(400).render("forgot-password", {
            message: "Enter the email, six-digit code, and a password of 8 to 72 bytes.",
            email
        });
    }

    try {
        const [users] = await db.execute("SELECT id FROM users WHERE email = ?", [email]);
        if (users.length === 0) {
            return res.status(400).render("forgot-password", {
                message: "The reset code is invalid or expired. Request a new code and try again.",
                email
            });
        }

        const [resetCodes] = await db.execute(
            `SELECT code_hash, expires_at, attempts
             FROM password_reset_codes
             WHERE user_id = ?`,
            [users[0].id]
        );
        const reset = resetCodes[0];
        const suppliedHash = crypto.createHash("sha256").update(code).digest("hex");
        const validHash =
            reset &&
            typeof reset.code_hash === "string" &&
            crypto.timingSafeEqual(
                Buffer.from(suppliedHash, "hex"),
                Buffer.from(reset.code_hash, "hex")
            );
        const notExpired = reset && Date.parse(reset.expires_at) > Date.now();

        if (!reset || !notExpired || reset.attempts >= 5 || !validHash) {
            if (reset) {
                if (reset.attempts >= 4 || !notExpired) {
                    await db.execute("DELETE FROM password_reset_codes WHERE user_id = ?", [users[0].id]);
                } else {
                    await db.execute(
                        "UPDATE password_reset_codes SET attempts = attempts + 1 WHERE user_id = ?",
                        [users[0].id]
                    );
                }
            }

            return res.status(400).render("forgot-password", {
                message: "The reset code is invalid or expired. Request a new code and try again.",
                email
            });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        await db.execute(
            "UPDATE users SET password = ?, email_verified = 1 WHERE id = ?",
            [hashedPassword, users[0].id]
        );
        await db.execute("DELETE FROM password_reset_codes WHERE user_id = ?", [users[0].id]);
        await recordAuditEvent(users[0].id, "password_reset_completed");
        return res.redirect("/login?reset=success");
    } catch (error) {
        console.error("Password reset error:", error.message);
        return res.status(500).render("forgot-password", {
            message: "Could not reset the password. Please try again.",
            email
        });
    }
};

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    })[character]);
}

// Log out
exports.logout = (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).send("Could not log out.");
        }

        const sessionCookieName = req.app?.locals?.sessionCookieName || "marketplace.sid";
        res.clearCookie(sessionCookieName);
        return res.redirect("/login");
    });
};