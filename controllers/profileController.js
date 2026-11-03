const db = require("../database/db");
const bcrypt = require("bcrypt");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { normalizeBusinessWebsite } = require("../services/businessWebsite");
const { recordAuditEvent } = require("../database/audit");

const logoDirectory = path.join(__dirname, "..", "public", "uploads", "seller-logos");

exports.getProfile = async (req, res) => {
    if (!req.session?.user) {
        return res.redirect("/login");
    }

    try {
        const [users] = await db.execute(
            `SELECT id, name, email, role, created_at
             FROM users
             WHERE id = ?`,
            [req.session.user.id]
        );

        if (users.length === 0) {
            return res.redirect("/login");
        }

        const user = users[0];
        let profileExtra = null;

        if (user.role === "seller") {
            const [sellerProfiles] = await db.execute(
                `SELECT business_name, status
                 FROM seller_profiles
                 WHERE user_id = ?`,
                [user.id]
            );
            profileExtra = sellerProfiles[0] || null;
        }

        return res.render("profile", {
            user: req.session.user,
            profile: user,
            profileExtra,
            passwordUpdated: req.query.password === "updated"
        });
    } catch (error) {
        console.error("Profile load error:", error.message);
        return res.status(500).send("Could not load your profile.");
    }
};

exports.updateProfile = async (req, res) => {
    if (!req.session?.user) {
        return res.redirect("/login");
    }

    try {
        const { name, email, businessName } = req.body || {};
        const trimmedName = typeof name === "string" ? name.trim() : "";
        const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

        if (
            typeof name !== "string" ||
            typeof email !== "string" ||
            !trimmedName ||
            trimmedName.length > 100 ||
            /[\u0000-\u001f\u007f]/.test(name) ||
            !normalizedEmail ||
            normalizedEmail.length > 150 ||
            (businessName !== undefined && typeof businessName !== "string")
        ) {
            return res.status(400).send("Name and email are required.");
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            return res.status(400).send("Please enter a valid email address.");
        }

        if (
            typeof businessName === "string" &&
            businessName.trim().length > 150
        ) {
            return res.status(400).send("Business names must be 150 characters or fewer.");
        }

        const updated = await db.transaction(async (connection) => {
            const [existingUsers] = await connection.execute(
                "SELECT id FROM users WHERE email = ? AND id != ?",
                [normalizedEmail, req.session.user.id]
            );

            if (existingUsers.length > 0) {
                return false;
            }

            await connection.execute(
                "UPDATE users SET name = ?, email = ? WHERE id = ?",
                [trimmedName, normalizedEmail, req.session.user.id]
            );

            if (req.session.user.role === "seller" && typeof businessName === "string" && businessName.trim()) {
                await connection.execute(
                    `INSERT INTO seller_profiles (user_id, business_name, status)
                     VALUES (?, ?, 'pending')
                     ON CONFLICT(user_id) DO UPDATE SET business_name = excluded.business_name, status = 'pending'`,
                    [req.session.user.id, businessName.trim()]
                );
            }

            return true;
        });

        if (!updated) {
            return res.status(409).send("An account with this email already exists.");
        }

        req.session.user.name = trimmedName;
        req.session.user.email = normalizedEmail;

        return res.redirect("/profile");
    } catch (error) {
        console.error("Profile update error:", error.message);
        return res.status(500).send("Could not update your profile.");
    }
};

exports.updatePassword = async (req, res) => {
    if (!req.session?.user) return res.redirect("/login");

    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    const confirmPassword = typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "";
    if (
        Buffer.byteLength(currentPassword, "utf8") > 72 ||
        newPassword.length < 8 ||
        Buffer.byteLength(newPassword, "utf8") > 72 ||
        newPassword !== confirmPassword
    ) {
        return res.status(400).send("Enter your current password and matching new passwords of 8 to 72 bytes.");
    }

    try {
        const [users] = await db.execute("SELECT password FROM users WHERE id = ?", [req.session.user.id]);
        if (!users.length) return res.redirect("/login");
        if (!await bcrypt.compare(currentPassword, users[0].password)) {
            return res.status(400).send("Your current password is incorrect.");
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await db.execute("UPDATE users SET password = ? WHERE id = ?", [passwordHash, req.session.user.id]);
        await recordAuditEvent(req.session.user.id, "account_password_changed");
        return res.redirect("/profile?password=updated");
    } catch (error) {
        console.error("Password update error:", error.message);
        return res.status(500).send("Could not update your password.");
    }
};

exports.updateSellerBusinessProfile = async (req, res) => {
    let logoUrl = null;
    let profileUpdated = false;

    try {
        const { businessWebsite, businessDescription, removeLogo } = req.body || {};
        let normalizedWebsite;
        try {
            normalizedWebsite = normalizeBusinessWebsite(businessWebsite);
        } catch (error) {
            return res.status(400).send(error.message);
        }

        if (
            typeof businessDescription !== "string" ||
            businessDescription.trim().length > 1000 ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(businessDescription)
        ) {
            return res.status(400).send("Business descriptions must be 1,000 characters or fewer.");
        }

        if (removeLogo !== undefined && removeLogo !== "true") {
            return res.status(400).send("Invalid logo removal request.");
        }
        if (req.file && removeLogo === "true") {
            return res.status(400).send("Choose a new logo or remove the current logo, not both.");
        }

        const [sellerProfiles] = await db.execute(
            "SELECT business_logo FROM seller_profiles WHERE user_id = ?",
            [req.session.user.id]
        );
        if (sellerProfiles.length === 0) {
            return res.status(404).send("Seller business profile not found.");
        }

        if (req.file) {
            let safeLogo;
            try {
                safeLogo = await sharp(req.file.buffer, {
                    failOn: "error",
                    limitInputPixels: 16_000_000
                })
                    .rotate()
                    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
                    .webp({ quality: 85 })
                    .toBuffer();
            } catch (error) {
                console.warn("Rejected invalid seller logo:", error.message);
                return res.status(400).send("The uploaded file could not be decoded as a supported image.");
            }

            const fileName = `${crypto.randomBytes(16).toString("hex")}.webp`;
            await fs.mkdir(logoDirectory, { recursive: true });
            await fs.writeFile(path.join(logoDirectory, fileName), safeLogo, { flag: "wx" });
            logoUrl = `/uploads/seller-logos/${fileName}`;
        }

        const oldLogoUrl = sellerProfiles[0].business_logo;
        const updatedLogoUrl = logoUrl || (removeLogo === "true" ? null : oldLogoUrl);
        const [result] = await db.execute(
            `UPDATE seller_profiles
             SET business_website = ?, business_description = ?, business_logo = ?
             WHERE user_id = ?`,
            [
                normalizedWebsite,
                businessDescription.trim() || null,
                updatedLogoUrl,
                req.session.user.id
            ]
        );
        if (result.rowsAffected === 0) {
            if (logoUrl) {
                await fs.unlink(path.join(logoDirectory, path.basename(logoUrl))).catch((error) => {
                    console.error("Unused seller logo cleanup error:", error.message);
                });
                logoUrl = null;
            }
            return res.status(404).send("Seller business profile not found.");
        }
        profileUpdated = true;

        await recordAuditEvent(
            req.session.user.id,
            "seller_business_profile_updated"
        );

        if (
            oldLogoUrl &&
            oldLogoUrl !== updatedLogoUrl &&
            oldLogoUrl.startsWith("/uploads/seller-logos/")
        ) {
            await fs.unlink(path.join(logoDirectory, path.basename(oldLogoUrl))).catch((error) => {
                console.error("Previous seller logo cleanup error:", error.message);
            });
        }

        return res.redirect("/seller?profile=updated");
    } catch (error) {
        if (logoUrl && !profileUpdated) {
            await fs.unlink(path.join(logoDirectory, path.basename(logoUrl))).catch((cleanupError) => {
                console.error("Seller logo cleanup error:", cleanupError.message);
            });
        }
        console.error("Seller business profile update error:", error.message);
        return res.status(500).send("Could not update your business profile.");
    }
};
