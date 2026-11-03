const db = require("../database/db");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { recordAuditEvent } = require("../database/audit");
const imageDirectory = path.join(__dirname, "..", "public", "uploads", "products");

exports.getSellerProducts = async (req, res) => {
    return res.redirect("/seller");
};

exports.createProduct = async (req, res) => {
    if (!req.session?.user || req.session.user.role !== "seller") {
        return res.redirect("/login");
    }

    let imageUrl = null;
    try {
        const { name, description, price, stock, categoryId, image } = req.body || {};
        const trimmedName = typeof name === "string" ? name.trim() : "";
        const normalizedPrice = Number(price);
        const normalizedStock = Number(stock);
        const categoryValue = categoryId ? Number(categoryId) : null;
        const trimmedDescription = typeof description === "string" ? description.trim() : "";

        if (
            typeof name !== "string" ||
            !trimmedName ||
            trimmedName.length > 200 ||
            !["string", "number"].includes(typeof price) ||
            !Number.isFinite(normalizedPrice) ||
            normalizedPrice < 0.01 ||
            normalizedPrice > 99999999.99 ||
            !["string", "number"].includes(typeof stock) ||
            String(stock).trim() === "" ||
            (description !== undefined && typeof description !== "string") ||
            (categoryId !== undefined && categoryId !== "" && !["string", "number"].includes(typeof categoryId)) ||
            (image !== undefined && typeof image !== "string")
        ) {
            return res.status(400).send("Please provide valid product details.");
        }

        if (!Number.isInteger(normalizedStock) || normalizedStock < 0 || normalizedStock > 1000000) {
            return res.status(400).send("Please provide a valid stock quantity.");
        }

        if (trimmedDescription.length > 5000) {
            return res.status(400).send("Product descriptions must be 5,000 characters or fewer.");
        }

        if (categoryValue !== null && (!Number.isInteger(categoryValue) || categoryValue <= 0)) {
            return res.status(400).send("Please select a valid category.");
        }

        if (categoryValue !== null) {
            const [existingCategory] = await db.execute("SELECT id FROM categories WHERE id = ?", [categoryValue]);
            if (existingCategory.length === 0) {
                return res.status(400).send("Selected category does not exist.");
            }
        }

        if (req.file) {
            let safeImage;
            try {
                safeImage = await sharp(req.file.buffer, {
                    failOn: "error",
                    limitInputPixels: 16_000_000
                })
                    .rotate()
                    .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
                    .webp({ quality: 85 })
                    .toBuffer();
            } catch (error) {
                console.warn("Rejected invalid product image:", error.message);
                return res.status(400).send("The uploaded file could not be decoded as a supported image.");
            }

            const fileName = `${crypto.randomBytes(16).toString("hex")}.webp`;
            await fs.mkdir(imageDirectory, { recursive: true });
            await fs.writeFile(path.join(imageDirectory, fileName), safeImage, { flag: "wx" });
            imageUrl = `/uploads/products/${fileName}`;
        }

        await db.transaction(async (connection) => {
            const [result] = await connection.execute(
                `INSERT INTO products
                    (seller_id, category_id, name, description, price, stock, image, moderation_status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [
                    req.session.user.id,
                    categoryValue,
                    trimmedName,
                    trimmedDescription,
                    normalizedPrice,
                    normalizedStock,
                    imageUrl
                ]
            );
            await connection.execute(
                `INSERT INTO seller_stock_movements
                    (seller_id, product_id, previous_stock, new_stock, change_reason)
                 VALUES (?, ?, 0, ?, 'product-created')`,
                [req.session.user.id, result.insertId, normalizedStock]
            );
        });

        return res.redirect("/seller");
    } catch (error) {
        if (imageUrl && imageUrl.startsWith("/uploads/products/")) {
            await fs.unlink(path.join(imageDirectory, path.basename(imageUrl))).catch((cleanupError) => {
                console.error("Product image cleanup error:", cleanupError.message);
            });
        }
        console.error("Create product error:", error.message);
        return res.status(500).send("Could not create the product.");
    }
};

exports.updateProduct = async (req, res) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    let uploadedImageUrl = null;
    let previousImageUrl = null;
    const { name, description, price, stock, categoryId } = req.body || {};
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const normalizedPrice = Number(price);
    const normalizedStock = Number(stock);
    const categoryValue = categoryId ? Number(categoryId) : null;
    const trimmedDescription = typeof description === "string" ? description.trim() : "";

    if (
        !trimmedName ||
        trimmedName.length > 200 ||
        !Number.isFinite(normalizedPrice) ||
        normalizedPrice < 0.01 ||
        normalizedPrice > 99999999.99 ||
        !Number.isInteger(normalizedStock) ||
        normalizedStock < 0 ||
        normalizedStock > 1000000 ||
        trimmedDescription.length > 5000 ||
        (categoryValue !== null && (!Number.isInteger(categoryValue) || categoryValue <= 0))
    ) {
        return res.status(400).send("Please provide valid product details.");
    }

    try {
        const [existingProducts] = await db.execute(
            "SELECT image, stock FROM products WHERE id = ? AND seller_id = ?",
            [productId, req.session.user.id]
        );
        if (existingProducts.length === 0) {
            return res.status(404).send("Product not found.");
        }
        previousImageUrl = existingProducts[0].image;

        if (categoryValue !== null) {
            const [categories] = await db.execute("SELECT id FROM categories WHERE id = ?", [categoryValue]);
            if (categories.length === 0) {
                return res.status(400).send("Selected category does not exist.");
            }
        }

        if (req.file) {
            let safeImage;
            try {
                safeImage = await sharp(req.file.buffer, {
                    failOn: "error",
                    limitInputPixels: 16_000_000
                })
                    .rotate()
                    .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
                    .webp({ quality: 85 })
                    .toBuffer();
            } catch (error) {
                console.warn("Rejected invalid product image:", error.message);
                return res.status(400).send("The uploaded file could not be decoded as a supported image.");
            }

            const fileName = `${crypto.randomBytes(16).toString("hex")}.webp`;
            await fs.mkdir(imageDirectory, { recursive: true });
            await fs.writeFile(path.join(imageDirectory, fileName), safeImage, { flag: "wx" });
            uploadedImageUrl = `/uploads/products/${fileName}`;
        }

        const [result] = await db.transaction(async (connection) => {
            const [updateResult] = await connection.execute(
                `UPDATE products
                 SET name = ?, description = ?, price = ?, stock = ?, category_id = ?,
                     image = COALESCE(?, image), moderation_status = 'pending', moderation_note = NULL,
                     promotion_discount_percent = 0, promotion_starts_at = NULL, promotion_ends_at = NULL
                 WHERE id = ? AND seller_id = ?`,
                [
                    trimmedName,
                    trimmedDescription,
                    normalizedPrice,
                    normalizedStock,
                    categoryValue,
                    uploadedImageUrl,
                    productId,
                    req.session.user.id
                ]
            );
            if (updateResult.rowsAffected && Number(existingProducts[0].stock) !== normalizedStock) {
                await connection.execute(
                    `INSERT INTO seller_stock_movements
                        (seller_id, product_id, previous_stock, new_stock, change_reason)
                     VALUES (?, ?, ?, ?, 'seller-stock-update')`,
                    [req.session.user.id, productId, Number(existingProducts[0].stock), normalizedStock]
                );
            }
            return [updateResult];
        });

        if (result.rowsAffected === 0) {
            if (uploadedImageUrl) {
                await fs.unlink(path.join(imageDirectory, path.basename(uploadedImageUrl))).catch((cleanupError) => {
                    console.error("Product image cleanup error:", cleanupError.message);
                });
            }
            return res.status(404).send("Product not found.");
        }

        if (
            uploadedImageUrl &&
            typeof previousImageUrl === "string" &&
            previousImageUrl.startsWith("/uploads/products/")
        ) {
            await fs.unlink(path.join(imageDirectory, path.basename(previousImageUrl))).catch((error) => {
                if (error.code !== "ENOENT") {
                    console.error("Replaced product image cleanup error:", error.message);
                }
            });
        }

        return res.redirect("/seller");
    } catch (error) {
        if (uploadedImageUrl) {
            await fs.unlink(path.join(imageDirectory, path.basename(uploadedImageUrl))).catch((cleanupError) => {
                console.error("Product image cleanup error:", cleanupError.message);
            });
        }
        console.error("Update product error:", error.message);
        return res.status(500).send("Could not update the product.");
    }
};

exports.updatePromotion = async (req, res) => {
    const productId = Number(req.params.id);
    const discountText = typeof req.body?.discountPercent === "string"
        ? req.body.discountPercent.trim()
        : "";
    const startsAt = typeof req.body?.startsAt === "string" ? req.body.startsAt.trim() : "";
    const endsAt = typeof req.body?.endsAt === "string" ? req.body.endsAt.trim() : "";

    if (!Number.isSafeInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    let discountPercent = 0;
    let startForDatabase = null;
    let endForDatabase = null;
    if (discountText !== "0") {
        discountPercent = Number(discountText);
        const validDateTime = (value) =>
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) &&
            !Number.isNaN(new Date(value).getTime());
        if (
            !Number.isFinite(discountPercent) ||
            discountPercent < 1 ||
            discountPercent > 80 ||
            !validDateTime(startsAt) ||
            !validDateTime(endsAt) ||
            startsAt >= endsAt
        ) {
            return res.status(400).send("Set a 1–80% discount and valid East Africa start/end times, or enter 0 to clear the promotion.");
        }
        startForDatabase = `${startsAt.replace("T", " ")}:00`;
        endForDatabase = `${endsAt.replace("T", " ")}:00`;
    }

    try {
        const [result] = await db.execute(
            `UPDATE products
             SET promotion_discount_percent = ?, promotion_starts_at = ?, promotion_ends_at = ?
             WHERE id = ? AND seller_id = ? AND moderation_status = 'approved'`,
            [discountPercent, startForDatabase, endForDatabase, productId, req.session.user.id]
        );
        if (!result.rowsAffected) {
            return res.status(404).send("Approved product not found.");
        }
        await recordAuditEvent(req.session.user.id, `seller_product_promotion_updated:${productId}`);
        return res.redirect("/seller?promotion=updated#seller-promotions");
    } catch (error) {
        console.error("Seller promotion update error:", error.message);
        return res.status(500).send("Could not update the product promotion.");
    }
};

exports.deleteProduct = async (req, res) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    try {
        const [products] = await db.execute(
            "SELECT image FROM products WHERE id = ? AND seller_id = ?",
            [productId, req.session.user.id]
        );

        if (products.length === 0) {
            return res.status(404).send("Product not found.");
        }

        const [result] = await db.execute(
            "DELETE FROM products WHERE id = ? AND seller_id = ?",
            [productId, req.session.user.id]
        );

        if (result.rowsAffected === 0) {
            return res.status(404).send("Product not found.");
        }

        const imagePath = products[0].image;
        if (typeof imagePath === "string" && imagePath.startsWith("/uploads/products/")) {
            await fs.unlink(path.join(imageDirectory, path.basename(imagePath))).catch((error) => {
                if (error.code !== "ENOENT") {
                    console.error("Deleted product image cleanup error:", error.message);
                }
            });
        }

        return res.redirect("/seller");
    } catch (error) {
        console.error("Delete product error:", error.message);
        return res.status(500).send("Could not delete the product.");
    }
};
