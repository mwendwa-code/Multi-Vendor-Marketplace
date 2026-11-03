const db = require("../database/db");
const { recordAuditEvent } = require("../database/audit");
const { normalizePhoneNumber } = require("./paymentController");
const customerEngagement = require("../services/customerEngagement");
const { normalizeCart } = require("../services/checkoutService");

function customerId(req) {
    return req.session.user.id;
}

function optionalText(value, maxLength) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return null;
    if (text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
        return false;
    }
    return text;
}

exports.updateCustomerProfile = async (req, res) => {
    const {
        phone,
        mpesaPhone,
        shippingAddress,
        shippingCity,
        shippingRegion,
        shippingPostalCode
    } = req.body || {};
    const profileFields = [
        ["shippingAddress", shippingAddress, 500],
        ["shippingCity", shippingCity, 120],
        ["shippingRegion", shippingRegion, 120],
        ["shippingPostalCode", shippingPostalCode, 30]
    ];

    if ([phone, mpesaPhone, ...profileFields.map((field) => field[1])]
        .some((value) => value !== undefined && typeof value !== "string")) {
        return res.status(400).send("Enter valid contact and delivery details.");
    }

    const normalizedPhone = typeof phone === "string" && phone.trim()
        ? normalizePhoneNumber(phone)
        : null;
    const normalizedMpesaPhone = typeof mpesaPhone === "string" && mpesaPhone.trim()
        ? normalizePhoneNumber(mpesaPhone)
        : null;
    if ((phone?.trim() && !normalizedPhone) || (mpesaPhone?.trim() && !normalizedMpesaPhone)) {
        return res.status(400).send("Enter a valid Kenyan phone number.");
    }

    const normalizedFields = profileFields.map(([, value, maxLength]) =>
        optionalText(value ?? "", maxLength)
    );
    if (normalizedFields.includes(false)) {
        return res.status(400).send("One or more delivery fields are too long or contain invalid characters.");
    }

    try {
        await db.execute(
            `INSERT INTO customer_profiles
                (user_id, phone, mpesa_phone, shipping_address, shipping_city, shipping_region,
                 shipping_postal_code, email_notifications)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
                phone = excluded.phone,
                mpesa_phone = excluded.mpesa_phone,
                shipping_address = excluded.shipping_address,
                shipping_city = excluded.shipping_city,
                shipping_region = excluded.shipping_region,
                shipping_postal_code = excluded.shipping_postal_code,
                email_notifications = excluded.email_notifications`,
            [
                customerId(req),
                normalizedPhone,
                normalizedMpesaPhone,
                ...normalizedFields,
                req.body?.emailNotifications === "on" ? 1 : 0
            ]
        );
        await recordAuditEvent(customerId(req), "customer_shipping_profile_updated");
        return res.redirect("/customer?profile=updated#shipping-profile");
    } catch (error) {
        console.error("Customer profile update error:", error.message);
        return res.status(500).send("Could not save your delivery profile.");
    }
};

exports.addWishlistItem = async (req, res) => {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    try {
        const [products] = await db.execute(
            "SELECT id, price, stock FROM products WHERE id = ? AND moderation_status = 'approved'",
            [productId]
        );
        if (products.length === 0) {
            return res.status(404).send("Product not found.");
        }

        await db.execute(
            "INSERT INTO wishlists (customer_id, product_id) VALUES (?, ?) ON CONFLICT(customer_id, product_id) DO NOTHING",
            [customerId(req), productId]
        );
        await customerEngagement.initializeWishlistWatch(customerId(req), productId, products[0]);
        await recordAuditEvent(customerId(req), `customer_wishlist_item_saved:${productId}`);
        return res.redirect("/customer#saved-items");
    } catch (error) {
        console.error("Wishlist save error:", error.message);
        return res.status(500).send("Could not save this item.");
    }
};

exports.removeWishlistItem = async (req, res) => {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    try {
        await db.execute(
            "DELETE FROM wishlists WHERE customer_id = ? AND product_id = ?",
            [customerId(req), productId]
        );
        await recordAuditEvent(customerId(req), `customer_wishlist_item_removed:${productId}`);
        return res.redirect("/customer#saved-items");
    } catch (error) {
        console.error("Wishlist removal error:", error.message);
        return res.status(500).send("Could not remove this saved item.");
    }
};

exports.moveWishlistItemToCart = async (req, res) => {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    try {
        const [products] = await db.execute(
            `SELECT p.id, p.name, p.stock
             FROM products p
             JOIN wishlists w ON w.product_id = p.id AND w.customer_id = ?
             WHERE p.id = ? AND p.moderation_status = 'approved'`,
            [customerId(req), productId]
        );
        const product = products[0];
        if (!product) return res.status(404).send("Product not found.");
        if (product.stock < 1) return res.status(409).send("This product is currently out of stock.");

        const cart = normalizeCart(req.session.cart);
        const item = cart.find((entry) => Number(entry.productId) === productId);
        if (item) {
            if (Number(item.quantity) + 1 > product.stock) {
                return res.status(409).send("The requested quantity exceeds current stock.");
            }
            item.quantity = Number(item.quantity) + 1;
        } else {
            cart.push({ productId, quantity: 1 });
        }
        req.session.cart = cart;

        await db.execute(
            "DELETE FROM wishlists WHERE customer_id = ? AND product_id = ?",
            [customerId(req), productId]
        );
        await recordAuditEvent(customerId(req), `customer_wishlist_item_moved_to_cart:${productId}`);
        return res.redirect("/customer?saved=cart#saved-items");
    } catch (error) {
        console.error("Move wishlist item to cart error:", error.message);
        return res.status(500).send("Could not move this saved item to your cart.");
    }
};

exports.sendOrderMessage = async (req, res) => {
    const orderId = Number(req.params.id);
    const sellerId = Number(req.body?.sellerId);
    const message = optionalText(req.body?.message, 1000);
    if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isInteger(sellerId) || sellerId <= 0) {
        return res.status(400).send("Invalid order or seller.");
    }
    if (message === false || !message) {
        return res.status(400).send("Write a message of up to 1,000 characters.");
    }

    try {
        const [orders] = await db.execute(
            `SELECT o.id
             FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             WHERE o.id = ? AND o.customer_id = ? AND oi.seller_id = ?
               AND o.status != 'cancelled'
             LIMIT 1`,
            [orderId, customerId(req), sellerId]
        );
        if (orders.length === 0) {
            return res.status(404).send("This seller is not part of that order.");
        }

        await db.execute(
            `INSERT INTO order_messages (order_id, customer_id, seller_id, sender_id, message)
             VALUES (?, ?, ?, ?, ?)`,
            [orderId, customerId(req), sellerId, customerId(req), message]
        );
        await recordAuditEvent(customerId(req), `customer_order_message_sent:${orderId}`);
        return res.redirect("/customer?message=sent#communication-hub");
    } catch (error) {
        console.error("Customer order message error:", error.message);
        return res.status(500).send("Could not send your message.");
    }
};

exports.replyToSellerMessage = async (req, res) => {
    const orderId = Number(req.body?.orderId);
    const customer = Number(req.body?.customerId);
    const message = optionalText(req.body?.message, 1000);
    if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isInteger(customer) || customer <= 0) {
        return res.status(400).send("Invalid order or customer.");
    }
    if (message === false || !message) {
        return res.status(400).send("Write a message of up to 1,000 characters.");
    }

    try {
        const [orders] = await db.execute(
            `SELECT o.id
             FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             WHERE o.id = ? AND o.customer_id = ? AND oi.seller_id = ?
             LIMIT 1`,
            [orderId, customer, customerId(req)]
        );
        if (orders.length === 0) {
            return res.status(404).send("You are not a seller on that order.");
        }

        await db.execute(
            `INSERT INTO order_messages (order_id, customer_id, seller_id, sender_id, message)
             VALUES (?, ?, ?, ?, ?)`,
            [orderId, customer, customerId(req), customerId(req), message]
        );
        await recordAuditEvent(customerId(req), `seller_order_message_replied:${orderId}`);
        return res.redirect("/seller?message=sent#seller-messages");
    } catch (error) {
        console.error("Seller order message reply error:", error.message);
        return res.status(500).send("Could not send your reply.");
    }
};

exports.submitReview = async (req, res) => {
    const productId = Number(req.params.productId);
    const rating = Number(req.body?.rating);
    const comment = optionalText(req.body?.comment ?? "", 1000);
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).send("Choose a rating from 1 to 5 stars.");
    }
    if (comment === false) {
        return res.status(400).send("Review comments must be 1,000 characters or fewer.");
    }

    try {
        const [purchases] = await db.execute(
            `SELECT oi.id
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE oi.product_id = ? AND o.customer_id = ? AND o.status != 'cancelled'
               AND EXISTS (SELECT 1 FROM payments p
                           WHERE p.order_id = o.id AND p.status = 'successful')
             LIMIT 1`,
            [productId, customerId(req)]
        );
        if (purchases.length === 0) {
            return res.status(403).send("You can review products only after purchasing them.");
        }

        const [existingReviews] = await db.execute(
            "SELECT id FROM reviews WHERE product_id = ? AND customer_id = ?",
            [productId, customerId(req)]
        );
        if (existingReviews.length > 0) return res.status(409).send("You have already reviewed this product.");
        await db.execute(
            "INSERT INTO reviews (product_id, customer_id, rating, comment) VALUES (?, ?, ?, ?)",
            [productId, customerId(req), rating, comment || null]
        );
        await recordAuditEvent(customerId(req), `customer_product_review_submitted:${productId}`);
        return res.redirect("/customer?review=submitted#reviews-panel");
    } catch (error) {
        console.error("Customer review submission error:", error.message);
        return res.status(500).send("Could not submit your review.");
    }
};

exports.updateReview = async (req, res) => {
    const productId = Number(req.params.productId);
    const rating = Number(req.body?.rating);
    const comment = optionalText(req.body?.comment ?? "", 1000);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).send("Invalid product.");
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).send("Choose a rating from 1 to 5 stars.");
    }
    if (comment === false) return res.status(400).send("Review comments must be 1,000 characters or fewer.");

    try {
        const [result] = await db.execute(
            `UPDATE reviews SET rating = ?, comment = ?, created_at = CURRENT_TIMESTAMP
             WHERE product_id = ? AND customer_id = ?
               AND EXISTS (
                   SELECT 1 FROM order_items oi
                   JOIN orders o ON o.id = oi.order_id
                   WHERE oi.product_id = reviews.product_id
                     AND o.customer_id = reviews.customer_id
                     AND o.status != 'cancelled'
                     AND EXISTS (SELECT 1 FROM payments p
                                 WHERE p.order_id = o.id AND p.status = 'successful')
               )`,
            [rating, comment || null, productId, customerId(req)]
        );
        if (!result.rowsAffected) return res.status(404).send("Review not found or purchase no longer eligible.");
        await recordAuditEvent(customerId(req), `customer_product_review_updated:${productId}`);
        return res.redirect("/customer?review=updated#reviews-panel");
    } catch (error) {
        console.error("Customer review update error:", error.message);
        return res.status(500).send("Could not update your review.");
    }
};
