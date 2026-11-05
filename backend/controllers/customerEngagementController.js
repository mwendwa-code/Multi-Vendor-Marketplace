const db = require("../database/db");
const engagement = require("../services/customerEngagement");
const { recordAuditEvent } = require("../database/audit");
const { currentPriceSql, currentPromotionDiscountSql } = require("../services/productPricing");

function customerId(req) {
    return req.session.user.id;
}

function validId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

exports.getDashboardData = async (customer) => {
    const id = customer.id;
    await engagement.refreshWishlistAlerts(id, customer.email, customer.name);
    const loyalty = await engagement.refreshMissionsAndBadges(id);

    const [preferencesRows] = await db.execute(
        "SELECT favorite_category_id, shopping_style FROM customer_preferences WHERE customer_id = ?",
        [id]
    );
    const preferences = preferencesRows[0] || {};
    const [recommendations] = await db.execute(
        `WITH category_signals AS (
            SELECT p.category_id, SUM(signal.weight) AS score
            FROM (
                SELECT product_id, 3 AS weight FROM customer_product_views WHERE customer_id = ?
                UNION ALL
                SELECT product_id, 4 AS weight FROM wishlists WHERE customer_id = ?
                UNION ALL
                SELECT oi.product_id, 5 AS weight
                FROM order_items oi JOIN orders o ON o.id = oi.order_id
                WHERE o.customer_id = ?
            ) signal
            JOIN products p ON p.id = signal.product_id
            WHERE p.category_id IS NOT NULL
            GROUP BY p.category_id
        )
        SELECT p.id, p.name, ${currentPriceSql("p")} AS price,
               p.price AS original_price, ${currentPromotionDiscountSql("p")} AS current_promotion_discount_percent,
               p.image, p.stock, p.category_id,
               c.name AS category_name, sp.business_name,
               COALESCE(cs.score, 0) +
                 CASE WHEN p.category_id = ? THEN 10 ELSE 0 END +
                 CASE WHEN f.seller_id IS NOT NULL THEN 4 ELSE 0 END AS relevance
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
        LEFT JOIN category_signals cs ON cs.category_id = p.category_id
        LEFT JOIN customer_seller_follows f
          ON f.customer_id = ? AND f.seller_id = p.seller_id
        LEFT JOIN (
            SELECT product_id, AVG(rating) AS average_rating
            FROM reviews GROUP BY product_id
        ) rr ON rr.product_id = p.id
        WHERE p.moderation_status = 'approved'
          AND NOT EXISTS (
              SELECT 1 FROM customer_product_views v
              WHERE v.customer_id = ? AND v.product_id = p.id
          )
        ORDER BY CASE WHEN ? = 'value' THEN ${currentPriceSql("p")} END ASC,
                 CASE WHEN ? = 'quality' THEN COALESCE(rr.average_rating, 0) END DESC,
                 CASE WHEN ? = 'trending' THEN COALESCE(cs.score, 0) END DESC,
                 CASE WHEN ? = 'local' AND f.seller_id IS NOT NULL THEN 0 ELSE 1 END,
                 relevance DESC, p.created_at DESC
        LIMIT 12`,
        [
            id, id, id, preferences.favorite_category_id || 0, id, id,
            preferences.shopping_style || "", preferences.shopping_style || "",
            preferences.shopping_style || "", preferences.shopping_style || ""
        ]
    );
    const [recentlyViewed] = await db.execute(
        `SELECT p.id, p.name, ${currentPriceSql("p")} AS price, p.price AS original_price,
                ${currentPromotionDiscountSql("p")} AS current_promotion_discount_percent,
                p.image, p.stock, c.name AS category_name,
                sp.business_name, v.viewed_at
         FROM customer_product_views v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
         WHERE v.customer_id = ? AND p.moderation_status = 'approved'
         ORDER BY v.viewed_at DESC
         LIMIT 12`,
        [id]
    );
    const [followedSellers] = await db.execute(
        `SELECT u.id AS seller_id, COALESCE(sp.business_name, u.name) AS seller_name,
                sp.business_description,
                (SELECT COUNT(*) FROM products p
                 WHERE p.seller_id = u.id AND p.moderation_status = 'approved'
                   AND p.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS new_products
         FROM customer_seller_follows f
         JOIN users u ON u.id = f.seller_id
         LEFT JOIN seller_profiles sp ON sp.user_id = u.id
         WHERE f.customer_id = ? AND sp.status = 'approved'
         ORDER BY f.created_at DESC`,
        [id]
    );
    const [sellerSuggestions] = await db.execute(
        `SELECT u.id AS seller_id, COALESCE(sp.business_name, u.name) AS seller_name
         FROM users u
         JOIN seller_profiles sp ON sp.user_id = u.id
         WHERE u.role = 'seller' AND sp.status = 'approved'
           AND NOT EXISTS (
             SELECT 1 FROM customer_seller_follows f
             WHERE f.customer_id = ? AND f.seller_id = u.id
           )
         ORDER BY sp.business_name ASC
         LIMIT 12`,
        [id]
    );
    const [followedProducts] = await db.execute(
        `SELECT p.id, p.name, p.description, ${currentPriceSql("p")} AS price,
                p.price AS original_price, ${currentPromotionDiscountSql("p")} AS current_promotion_discount_percent,
                p.image, p.stock,
                COALESCE(sp.business_name, u.name) AS business_name,
                p.created_at, f.seller_id
         FROM customer_seller_follows f
         JOIN products p ON p.seller_id = f.seller_id
         JOIN users u ON u.id = f.seller_id
         LEFT JOIN seller_profiles sp ON sp.user_id = u.id
         WHERE f.customer_id = ? AND p.moderation_status = 'approved'
           AND p.created_at >= CURRENT_TIMESTAMP - INTERVAL '90 days'
         ORDER BY p.created_at DESC
         LIMIT 12`,
        [id]
    );
    const [sellerUpdates] = await db.execute(
        `SELECT u.id, u.product_id, u.update_type, u.message, u.emailed_at, u.created_at,
                p.name AS product_name, COALESCE(sp.business_name, s.name) AS seller_name
         FROM customer_seller_updates u
         JOIN products p ON p.id = u.product_id
         JOIN users s ON s.id = u.seller_id
         LEFT JOIN seller_profiles sp ON sp.user_id = s.id
         WHERE u.customer_id = ?
         ORDER BY u.created_at DESC
         LIMIT 20`,
        [id]
    );
    const [collections] = await db.execute(
        `SELECT c.id, c.name, c.created_at,
                p.id AS product_id, p.name AS product_name, p.image,
                ${currentPriceSql("p")} AS price, p.price AS original_price,
                ${currentPromotionDiscountSql("p")} AS current_promotion_discount_percent
         FROM customer_collections c
         LEFT JOIN customer_collection_items ci ON ci.collection_id = c.id
         LEFT JOIN products p ON p.id = ci.product_id AND p.moderation_status = 'approved'
         WHERE c.customer_id = ?
         ORDER BY c.created_at DESC, ci.created_at DESC`,
        [id]
    );
    const collectionMap = new Map();
    for (const row of collections) {
        if (!collectionMap.has(row.id)) {
            collectionMap.set(row.id, {
                id: row.id,
                name: row.name,
                created_at: row.created_at,
                products: []
            });
        }
        if (row.product_id) {
            collectionMap.get(row.id).products.push({
                id: row.product_id,
                name: row.product_name,
                image: row.image,
                price: row.price
            });
        }
    }
    const [categories] = await db.execute("SELECT id, name FROM categories ORDER BY name ASC");
    const [wishlistAlerts] = await db.execute(
        `SELECT a.id, a.product_id, a.alert_type, a.message, a.created_at, a.emailed_at,
                p.name AS product_name
         FROM customer_wishlist_alerts a
         JOIN products p ON p.id = a.product_id
         WHERE a.customer_id = ?
         ORDER BY a.created_at DESC
         LIMIT 20`,
        [id]
    );
    const [pointsHistory] = await db.execute(
        `SELECT points, reason, created_at
         FROM customer_points_ledger
         WHERE customer_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
        [id]
    );
    const [referralRows] = await db.execute(
        `SELECT u.referral_code,
                (SELECT COUNT(*) FROM customer_referrals r WHERE r.referrer_id = u.id) AS referral_count,
                (SELECT COUNT(*) FROM customer_referrals r WHERE r.referrer_id = u.id AND r.status = 'first_order') AS first_order_count
         FROM users u WHERE u.id = ?`,
        [id]
    );
    const [referrals] = await db.execute(
        `SELECT r.status, r.created_at, u.name AS customer_name
         FROM customer_referrals r
         JOIN users u ON u.id = r.referred_customer_id
         WHERE r.referrer_id = ?
         ORDER BY r.created_at DESC
         LIMIT 20`,
        [id]
    );
    const referralCode = referralRows[0]?.referral_code;
    const referralUrl = new URL(
        "/register",
        process.env.APP_BASE_URL ||
            process.env.RENDER_EXTERNAL_URL ||
            `http://localhost:${process.env.PORT || 3000}`
    );
    if (referralCode) referralUrl.searchParams.set("ref", referralCode);

    return {
        preferences,
        recommendations,
        recentlyViewed,
        followedSellers,
        sellerSuggestions,
        followedProducts,
        sellerUpdates,
        collections: [...collectionMap.values()],
        categories,
        wishlistAlerts,
        loyalty,
        pointsHistory,
        referralUrl: referralUrl.toString(),
        referralSummary: referralRows[0] || { referral_count: 0, first_order_count: 0 },
        referrals
    };
};

exports.followSeller = async (req, res) => {
    const sellerId = validId(req.params.sellerId);
    if (!sellerId || sellerId === customerId(req)) return res.status(400).send("Choose a valid seller.");
    try {
        const [sellers] = await db.execute(
            `SELECT u.id FROM users u
             JOIN seller_profiles sp ON sp.user_id = u.id
             WHERE u.id = ? AND u.role = 'seller' AND sp.status = 'approved'`,
            [sellerId]
        );
        if (!sellers.length) return res.status(404).send("Seller not found.");
        await db.transaction(async (connection) => {
            const [followResult] = await connection.execute(
                `INSERT INTO customer_seller_follows (customer_id, seller_id)
                 VALUES (?, ?) ON CONFLICT(customer_id, seller_id) DO NOTHING`,
                [customerId(req), sellerId]
            );
            if (followResult.rowsAffected > 0) {
                await connection.execute(
                    `INSERT INTO customer_wishlist_watch_state
                        (customer_id, product_id, last_price, last_stock)
                     SELECT ?, p.id, p.price, p.stock
                     FROM products p
                     WHERE p.seller_id = ? AND p.moderation_status = 'approved'
                     ON CONFLICT(customer_id, product_id) DO UPDATE SET
                       last_price = excluded.last_price,
                       last_stock = excluded.last_stock,
                       updated_at = CURRENT_TIMESTAMP`,
                    [customerId(req), sellerId]
                );
            }
        });
        return res.redirect("/customer?follow=updated#seller-follows");
    } catch (error) {
        console.error("Seller follow error:", error.message);
        return res.status(500).send("Could not follow this seller.");
    }
};

exports.unfollowSeller = async (req, res) => {
    const sellerId = validId(req.params.sellerId);
    if (!sellerId) return res.status(400).send("Choose a valid seller.");
    try {
        await db.execute("DELETE FROM customer_seller_follows WHERE customer_id = ? AND seller_id = ?", [customerId(req), sellerId]);
        return res.redirect("/customer?follow=updated#seller-follows");
    } catch (error) {
        console.error("Seller unfollow error:", error.message);
        return res.status(500).send("Could not unfollow this seller.");
    }
};

exports.updatePreferences = async (req, res) => {
    const categoryId = req.body?.favoriteCategoryId ? validId(req.body.favoriteCategoryId) : null;
    const style = req.body?.shoppingStyle;
    const allowedStyles = ["value", "quality", "trending", "local"];
    if (req.body?.favoriteCategoryId && !categoryId) return res.status(400).send("Choose a valid category.");
    if (style && !allowedStyles.includes(style)) return res.status(400).send("Choose a valid shopping preference.");

    try {
        await db.execute(
            `INSERT INTO customer_preferences (customer_id, favorite_category_id, shopping_style)
             VALUES (?, ?, ?)
             ON CONFLICT(customer_id) DO UPDATE SET
               favorite_category_id = excluded.favorite_category_id,
               shopping_style = excluded.shopping_style,
               updated_at = CURRENT_TIMESTAMP`,
            [customerId(req), categoryId, style || null]
        );
        await recordAuditEvent(customerId(req), "customer_discovery_preferences_updated");
        return res.redirect("/customer?quiz=updated#for-you");
    } catch (error) {
        console.error("Customer preference update error:", error.message);
        return res.status(500).send("Could not save your preferences.");
    }
};

exports.createCollection = async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
        return res.status(400).send("Enter a collection name up to 60 characters.");
    }
    try {
        await db.execute(
            "INSERT INTO customer_collections (customer_id, name) VALUES (?, ?)",
            [customerId(req), name]
        );
        return res.redirect("/customer?collection=created#collections");
    } catch (error) {
        if (error.code === "23505" || error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).send("You already have a collection with that name.");
        console.error("Collection creation error:", error.message);
        return res.status(500).send("Could not create your collection.");
    }
};

exports.addCollectionItem = async (req, res) => {
    const collectionId = validId(req.params.collectionId || req.body?.collectionId);
    const productId = validId(req.params.productId || req.body?.productId);
    if (!collectionId || !productId) return res.status(400).send("Choose a valid collection and product.");
    try {
        const [collections] = await db.execute(
            "SELECT id FROM customer_collections WHERE id = ? AND customer_id = ?",
            [collectionId, customerId(req)]
        );
        const [products] = await db.execute(
            "SELECT id FROM products WHERE id = ? AND moderation_status = 'approved'",
            [productId]
        );
        if (!collections.length || !products.length) return res.status(404).send("Collection or product not found.");
        await db.execute(
            `INSERT INTO customer_collection_items (collection_id, product_id)
             VALUES (?, ?) ON CONFLICT(collection_id, product_id) DO NOTHING`,
            [collectionId, productId]
        );
        return res.redirect("/customer?collection=added#collections");
    } catch (error) {
        console.error("Collection item save error:", error.message);
        return res.status(500).send("Could not save this product to your collection.");
    }
};

exports.removeCollectionItem = async (req, res) => {
    const collectionId = validId(req.params.collectionId);
    const productId = validId(req.params.productId);
    if (!collectionId || !productId) return res.status(400).send("Choose a valid collection and product.");
    try {
        const [result] = await db.execute(
            `DELETE FROM customer_collection_items
             WHERE collection_id = ? AND product_id = ?
               AND EXISTS (SELECT 1 FROM customer_collections WHERE id = ? AND customer_id = ?)`,
            [collectionId, productId, collectionId, customerId(req)]
        );
        if (result.rowsAffected === 0) return res.status(404).send("Saved product not found in your collection.");
        return res.redirect("/customer?collection=removed#collections");
    } catch (error) {
        console.error("Collection item removal error:", error.message);
        return res.status(500).send("Could not remove this product from the collection.");
    }
};

exports.updateWishlistAlerts = async (req, res) => {
    const productId = validId(req.params.productId);
    if (!productId) return res.status(400).send("Choose a valid product.");
    const alertPriceDrop = req.body?.alertPriceDrop === "on" ? 1 : 0;
    const alertBackInStock = req.body?.alertBackInStock === "on" ? 1 : 0;
    try {
        const [result] = await db.execute(
            `UPDATE wishlists SET alert_price_drop = ?, alert_back_in_stock = ?
             WHERE customer_id = ? AND product_id = ?`,
            [alertPriceDrop, alertBackInStock, customerId(req), productId]
        );
        if (!result.rowsAffected) return res.status(404).send("Saved item not found.");
        return res.redirect("/customer?alerts=updated#saved-items");
    } catch (error) {
        console.error("Wishlist alert settings error:", error.message);
        return res.status(500).send("Could not update wishlist alert settings.");
    }
};

exports.deleteCollection = async (req, res) => {
    const collectionId = validId(req.params.collectionId);
    if (!collectionId) return res.status(400).send("Choose a valid collection.");
    try {
        await db.execute("DELETE FROM customer_collections WHERE id = ? AND customer_id = ?", [collectionId, customerId(req)]);
        return res.redirect("/customer?collection=deleted#collections");
    } catch (error) {
        console.error("Collection deletion error:", error.message);
        return res.status(500).send("Could not delete this collection.");
    }
};
