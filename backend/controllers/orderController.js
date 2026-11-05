const db = require("../database/db");
const { recordAuditEvent } = require("../database/audit");
const customerEngagementController = require("./customerEngagementController");
const { refundOrderRedemption } = require("../services/customerRewards");
const { currentPriceSql, currentPromotionDiscountSql } = require("../services/productPricing");
const { adjustProductStock } = require("../services/inventory");

function addOrderItemImageFallback(item) {
    const name = item.product_name.toLowerCase();
    if (name.includes("toothpick")) {
        return {
            ...item,
            image: item.image || "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bb/2023_Wyka%C5%82aczki_%281%29.jpg/500px-2023_Wyka%C5%82aczki_%281%29.jpg",
            imageAttribution: item.image
                ? null
                : {
                    author: "Jacek Halicki",
                    sourceUrl: "https://commons.wikimedia.org/wiki/File:2023_Wyka%C5%82aczki_(1).jpg",
                    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/"
                }
        };
    }

    if (name.includes("jordan")) {
        return {
            ...item,
            image: item.image || "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=80",
            imageAttribution: null
        };
    }

    return { ...item, imageAttribution: null };
}

exports.getCustomerDashboard = async (req, res) => {
    if (!req.session?.user || (req.session.user.role !== "buyer" && req.session.user.role !== "customer")) {
        return res.redirect("/login");
    }

    try {
        const [orders] = await db.execute(
            `SELECT o.id, o.total, o.status, o.created_at, o.recipient_name,
                    o.shipping_address, o.shipping_city, o.shipping_region,
                    o.shipping_postal_code, o.recipient_phone,
                    COALESCE(SUM(oi.quantity), 0) AS item_count,
                    rr.status AS refund_status, rr.reason AS refund_reason,
                    CASE
                        WHEN o.status = 'pending'
                         AND NOT EXISTS (
                             SELECT 1 FROM payments p
                             WHERE p.order_id = o.id
                               AND p.method = 'mpesa'
                               AND p.status = 'pending'
                         )
                        THEN 1 ELSE 0
                    END AS can_cancel,
                    CASE
                        WHEN o.status = 'delivered'
                         AND EXISTS (SELECT 1 FROM payments p
                                     WHERE p.order_id = o.id AND p.status = 'successful')
                         AND rr.id IS NULL
                        THEN 1 ELSE 0
                    END AS can_request_refund
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN refund_requests rr ON rr.order_id = o.id
             WHERE o.customer_id = ?
             GROUP BY o.id, o.total, o.status, o.created_at, rr.status, rr.reason, rr.id,
                      o.recipient_name, o.shipping_address, o.shipping_city, o.shipping_region,
                      o.shipping_postal_code, o.recipient_phone
             ORDER BY o.created_at DESC`,
            [req.session.user.id]
        );
        const [refundRequests] = await db.execute(
            `SELECT id, order_id, reason, status, admin_note, created_at, updated_at
             FROM refund_requests
             WHERE customer_id = ?
             ORDER BY created_at DESC`,
            [req.session.user.id]
        );

        const [featuredProducts] = await db.execute(
            `SELECT p.id, p.name, p.description, p.price AS original_price,
                    ${currentPriceSql("p")} AS price,
                    ${currentPromotionDiscountSql("p")} AS current_promotion_discount_percent,
                    p.image, p.stock,
                    c.name AS category_name, sp.business_name
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
             WHERE p.moderation_status = 'approved'
             ORDER BY p.created_at DESC, p.id DESC
             LIMIT 12`
        );

        const orderIds = orders.map((order) => order.id);
        let orderItems = [];

        if (orderIds.length > 0) {
            const placeholders = orderIds.map(() => "?").join(", ");
            [orderItems] = await db.execute(
                `SELECT oi.order_id, oi.product_id, p.name AS product_name, p.image,
                        oi.quantity, oi.price,
                        (oi.quantity * oi.price) AS line_total,
                        COALESCE(f.status, 'pending') AS seller_fulfillment_status,
                        d.status AS seller_decision, d.note AS seller_decision_note,
                        f.tracking_number
                 FROM order_items oi
                 JOIN products p ON p.id = oi.product_id
                 LEFT JOIN seller_order_fulfillments f
                   ON f.order_id = oi.order_id AND f.seller_id = oi.seller_id
                 LEFT JOIN seller_order_decisions d
                   ON d.order_id = oi.order_id AND d.seller_id = oi.seller_id
                 WHERE oi.order_id IN (${placeholders})
                 ORDER BY oi.order_id DESC, p.name ASC`,
                orderIds
            );
        }

        const itemsByOrder = orderItems.map(addOrderItemImageFallback).reduce((acc, item) => {
            if (!acc[item.order_id]) {
                acc[item.order_id] = [];
            }
            acc[item.order_id].push(item);
            return acc;
        }, {});

        const [customerProfiles] = await db.execute(
            `SELECT phone, mpesa_phone, shipping_address, shipping_city, shipping_region,
                    shipping_postal_code, email_notifications
             FROM customer_profiles WHERE user_id = ?`,
            [req.session.user.id]
        );
        const [payments] = await db.execute(
            `SELECT p.id, p.order_id, p.method, p.amount, p.status,
                    p.transaction_reference, p.phone_number, p.created_at,
                    CASE
                        WHEN p.method = 'mpesa'
                         AND p.status = 'failed'
                         AND o.status = 'pending'
                         AND p.id = (
                             SELECT MAX(retry.id)
                             FROM payments retry
                             WHERE retry.order_id = p.order_id AND retry.method = 'mpesa'
                         )
                         AND NOT EXISTS (
                             SELECT 1 FROM payments active
                             WHERE active.order_id = p.order_id
                               AND active.method = 'mpesa'
                               AND active.status = 'pending'
                         )
                        THEN 1 ELSE 0
                    END AS can_retry
             FROM payments p
             JOIN orders o ON o.id = p.order_id
             WHERE o.customer_id = ?
             ORDER BY p.created_at DESC
             LIMIT 20`,
            [req.session.user.id]
        );
        const [savedItems] = await db.execute(
            `SELECT p.id, p.name, p.price AS original_price,
                    ${currentPriceSql("p")} AS price,
                    ${currentPromotionDiscountSql("p")} AS current_promotion_discount_percent,
                    p.image, p.stock, w.created_at,
                    w.alert_price_drop, w.alert_back_in_stock,
                    sp.business_name
             FROM wishlists w
             JOIN products p ON p.id = w.product_id
             LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
             WHERE w.customer_id = ? AND p.moderation_status = 'approved'
             ORDER BY w.created_at DESC`,
            [req.session.user.id]
        );
        const [reviewableProducts] = await db.execute(
            `SELECT DISTINCT p.id, p.name, p.image
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             JOIN products p ON p.id = oi.product_id
             WHERE o.customer_id = ? AND o.status != 'cancelled'
               AND EXISTS (SELECT 1 FROM payments p
                           WHERE p.order_id = o.id AND p.status = 'successful')
               AND NOT EXISTS (
                   SELECT 1 FROM reviews r
                   WHERE r.product_id = p.id AND r.customer_id = ?
               )
             ORDER BY p.name ASC`,
            [req.session.user.id, req.session.user.id]
        );
        const [customerReviews] = await db.execute(
            `SELECT r.product_id, r.rating, r.comment, r.created_at, p.name AS product_name
             FROM reviews r
             JOIN products p ON p.id = r.product_id
             WHERE r.customer_id = ?
             ORDER BY r.created_at DESC
             LIMIT 20`,
            [req.session.user.id]
        );
        const [messageRecipients] = await db.execute(
            `SELECT DISTINCT o.id AS order_id, o.status AS order_status,
                    oi.seller_id, COALESCE(sp.business_name, su.name) AS seller_name
             FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             JOIN users su ON su.id = oi.seller_id
             LEFT JOIN seller_profiles sp ON sp.user_id = su.id
             WHERE o.customer_id = ? AND o.status != 'cancelled'
             ORDER BY o.id DESC`,
            [req.session.user.id]
        );
        const [messages] = await db.execute(
            `SELECT m.id, m.order_id, m.customer_id, m.seller_id, m.sender_id, m.message, m.created_at,
                    u.name AS sender_name,
                    CASE WHEN m.sender_id = m.customer_id THEN 1 ELSE 0 END AS sent_by_customer
             FROM order_messages m
             JOIN users u ON u.id = m.sender_id
             WHERE m.customer_id = ?
             ORDER BY m.created_at DESC
             LIMIT 80`,
            [req.session.user.id]
        );
        const engagementDashboard = await customerEngagementController.getDashboardData(req.session.user);

        return res.render("customer/dashboard", {
            user: req.session.user,
            orders,
            featuredProducts,
            itemsByOrder,
            orderCancelled: req.query.order === "cancelled",
            paymentNotice: ["pending", "retry", "failed", "prompt"].includes(req.query.payment)
                ? req.query.payment
                : "",
            savedItemMovedToCart: req.query.saved === "cart",
            refundSubmitted: req.query.refund === "submitted",
            refundRequests,
            customerProfile: customerProfiles[0] || {},
            payments,
            savedItems,
            reviewableProducts,
            customerReviews,
            engagementDashboard,
            messageRecipients,
            messages,
            profileUpdated: req.query.profile === "updated",
            messageSent: req.query.message === "sent",
            reviewSubmitted: ["submitted", "updated"].includes(req.query.review),
            reviewAction: req.query.review,
            quizUpdated: req.query.quiz === "updated",
            followUpdated: req.query.follow === "updated",
            collectionUpdated: ["created", "added", "removed", "deleted"].includes(req.query.collection),
            collectionAction: req.query.collection,
            alertsUpdated: req.query.alerts === "updated"
        });
    } catch (error) {
        console.error("Customer dashboard error:", error.message);
        return res.status(500).send("Could not load your orders.");
    }
};

exports.addOrderItemImageFallback = addOrderItemImageFallback;

exports.requestRefund = async (req, res) => {
    const orderId = Number(req.params.id);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!Number.isSafeInteger(orderId) || orderId <= 0 || !reason || reason.length > 1000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
        return res.status(400).send("Provide a valid order and refund reason (up to 1,000 characters).");
    }

    try {
        const result = await db.transaction(async (connection) => {
            const [orders] = await connection.execute(
                `SELECT o.id
                 FROM orders o
                 WHERE o.id = ? AND o.customer_id = ? AND o.status = 'delivered'
                   AND EXISTS (SELECT 1 FROM payments p
                               WHERE p.order_id = o.id AND p.status = 'successful')`,
                [orderId, req.session.user.id]
            );
            if (!orders.length) return "INELIGIBLE";
            try {
                await connection.execute(
                    "INSERT INTO refund_requests (order_id, customer_id, reason) VALUES (?, ?, ?)",
                    [orderId, req.session.user.id, reason]
                );
            } catch (error) {
                if (
                    error.code === "23505" ||
                    (error.code === "SQLITE_CONSTRAINT" && /UNIQUE constraint failed/.test(error.message))
                ) {
                    return "EXISTS";
                }
                throw error;
            }
            return "CREATED";
        });
        if (result === "INELIGIBLE") return res.status(400).send("Refund requests are available for delivered, successfully paid orders only.");
        if (result === "EXISTS") return res.status(409).send("A refund request already exists for this order.");

        await recordAuditEvent(req.session.user.id, `refund_requested:${orderId}`);
        return res.redirect("/customer?refund=submitted#order-history");
    } catch (error) {
        console.error("Refund request error:", error.message);
        return res.status(500).send("Could not submit your refund request.");
    }
};

exports.cancelCustomerOrder = async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).send("Invalid order.");
    }

    try {
        const cancellation = await db.transaction(async (connection) => {
            const [orders] = await connection.execute(
                "SELECT id, status FROM orders WHERE id = ? AND customer_id = ?",
                [orderId, req.session.user.id]
            );
            const order = orders[0];
            if (!order) {
                return { error: "ORDER_NOT_FOUND" };
            }
            if (order.status !== "pending") {
                return { error: "ORDER_NOT_CANCELLABLE" };
            }

            const [pendingMpesaPayments] = await connection.execute(
                "SELECT id FROM payments WHERE order_id = ? AND method = ? AND status = ?",
                [orderId, "mpesa", "pending"]
            );
            if (pendingMpesaPayments.length > 0) {
                return { error: "PAYMENT_IN_PROGRESS" };
            }

            const [result] = await connection.execute(
                "UPDATE orders SET status = ? WHERE id = ? AND customer_id = ? AND status = ?",
                ["cancelled", orderId, req.session.user.id, "pending"]
            );
            if (result.rowsAffected === 0) {
                return { error: "ORDER_NOT_CANCELLABLE" };
            }

            const [items] = await connection.execute(
                "SELECT product_id, quantity FROM order_items WHERE order_id = ?",
                [orderId]
            );
            for (const item of items) {
                await adjustProductStock(
                    connection,
                    Number(item.product_id),
                    Number(item.quantity),
                    "customer-order-cancelled"
                );
            }
            await connection.execute(
                "UPDATE payments SET status = ? WHERE order_id = ? AND method = ? AND status = ?",
                ["failed", orderId, "cash_on_delivery", "pending"]
            );
            await connection.execute(
                "UPDATE commissions SET status = 'void' WHERE order_id = ? AND status = 'pending'",
                [orderId]
            );
            await refundOrderRedemption(connection, orderId);
            await recordAuditEvent(req.session.user.id, `customer_order_cancelled:${orderId}`);

            return { cancelled: true };
        });

        if (cancellation.error === "ORDER_NOT_FOUND") {
            return res.status(404).send("Order not found.");
        }
        if (cancellation.error === "PAYMENT_IN_PROGRESS") {
            return res.status(409).send("This order cannot be cancelled while an M-Pesa payment is in progress.");
        }
        if (cancellation.error) {
            return res.status(409).send("This order can no longer be cancelled.");
        }

        return res.redirect("/customer?order=cancelled");
    } catch (error) {
        console.error("Customer order cancellation error:", error.message);
        return res.status(500).send("Could not cancel the order.");
    }
};

exports.getSellerSales = async (req, res) => {
    if (!req.session?.user || req.session.user.role !== "seller") {
        return res.redirect("/login");
    }

    try {
        const [salesSummary] = await db.execute(
            `SELECT COUNT(DISTINCT order_id) AS total_orders,
                    SUM(quantity * price) AS total_sales
             FROM order_items
             WHERE seller_id = ?`,
            [req.session.user.id]
        );

        const [recentSales] = await db.execute(
            `SELECT o.id AS order_id, o.status, o.created_at,
                    p.name AS product_name, oi.quantity, oi.price,
                    (oi.quantity * oi.price) AS line_total
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             JOIN products p ON p.id = oi.product_id
             WHERE oi.seller_id = ?
             ORDER BY o.created_at DESC
             LIMIT 8`,
            [req.session.user.id]
        );

        const summary = salesSummary[0] || { total_orders: 0, total_sales: 0 };

        return res.render("seller/dashboard", {
            user: req.session.user,
            products: req.session?.sellerProducts || [],
            categories: req.session?.sellerCategories || [],
            salesSummary: {
                totalOrders: Number(summary.total_orders || 0),
                totalSales: Number(summary.total_sales || 0)
            },
            recentSales
        });
    } catch (error) {
        console.error("Seller sales load error:", error.message);
        return res.status(500).send("Could not load seller sales.");
    }
};
