const db = require("../database/db");
const { recordAuditEvent } = require("../database/audit");
const { awardDeliveredOrderPoints, refundOrderRedemption } = require("../services/customerRewards");
const { awardReferralForFirstOrder } = require("../services/customerEngagement");
const { adjustProductStock } = require("../services/inventory");

const ORDER_STATUS_TRANSITIONS = {
    pending: ["processing", "cancelled"],
    paid: ["processing", "cancelled"],
    processing: ["shipped", "cancelled"],
    shipped: ["delivered"],
    delivered: [],
    cancelled: []
};

exports.getManagerDashboard = async (req, res) => {
    if (!req.session?.user || req.session.user.role !== "admin") {
        return res.redirect("/login");
    }

    try {
        const [userStats] = await db.execute(`
            SELECT
                SUM(CASE WHEN role IN ('buyer', 'customer') THEN 1 ELSE 0 END) AS buyers,
                SUM(CASE WHEN role = 'seller' THEN 1 ELSE 0 END) AS sellers,
                SUM(CASE WHEN role = 'manager' THEN 1 ELSE 0 END) AS managers,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins
            FROM users
        `);

        const [productStats] = await db.execute(`
            SELECT COUNT(*) AS total_products,
                   COALESCE(SUM(stock), 0) AS total_inventory
            FROM products
        `);

        const [orderStats] = await db.execute(`
            SELECT COUNT(*) AS total_orders,
                   COALESCE(SUM(total), 0) AS gross_revenue
            FROM orders
        `);

        const [sellerApplications] = await db.execute(`
            SELECT sp.id, sp.business_name, sp.status, u.name, u.email
            FROM seller_profiles sp
            JOIN users u ON u.id = sp.user_id
            ORDER BY sp.id DESC
            LIMIT 5
        `);

        const [recentOrders] = await db.execute(`
            SELECT o.id, o.status, o.total, o.created_at, u.name AS buyer_name
            FROM orders o
            JOIN users u ON u.id = o.customer_id
            ORDER BY o.created_at DESC
            LIMIT 10
        `);

        const [lowStockProducts] = await db.execute(`
            SELECT p.id, p.name, p.stock, u.name AS seller_name
            FROM products p
            JOIN users u ON u.id = p.seller_id
            WHERE p.stock <= 5
            ORDER BY p.stock ASC, p.name ASC
            LIMIT 10
        `);

        const stats = userStats[0] || {};
        const products = productStats[0] || {};
        const orders = orderStats[0] || {};

        return res.render("manager/dashboard", {
            user: req.session.user,
            stats: {
                buyers: Number(stats.buyers || 0),
                sellers: Number(stats.sellers || 0),
                managers: Number(stats.managers || 0),
                admins: Number(stats.admins || 0),
                totalProducts: Number(products.total_products || 0),
                totalInventory: Number(products.total_inventory || 0),
                totalOrders: Number(orders.total_orders || 0),
                grossRevenue: Number(orders.gross_revenue || 0)
            },
            sellerApplications,
            recentOrders,
            lowStockProducts,
            orderStatusTransitions: ORDER_STATUS_TRANSITIONS
        });
    } catch (error) {
        console.error("Manager dashboard error:", error.message);
        return res.status(500).send("Could not load the manager dashboard.");
    }
};

exports.updateOrderStatus = async (req, res) => {
    if (!req.session?.user || req.session.user.role !== "admin") {
        return res.redirect("/login");
    }

    const orderId = Number(req.params.id);
    const newStatus = req.body?.status;

    if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).send("Invalid order.");
    }

    try {
        const statusUpdate = await db.transaction(async (connection) => {
            const [orders] = await connection.execute(
                "SELECT status FROM orders WHERE id = ?",
                [orderId]
            );
            if (!orders.length) return "not_found";

            const currentStatus = orders[0].status;
            const allowedTransitions = ORDER_STATUS_TRANSITIONS[currentStatus];
            if (!allowedTransitions || !allowedTransitions.includes(newStatus)) {
                return "invalid_transition";
            }

            await connection.execute(
                "UPDATE orders SET status = ? WHERE id = ?",
                [newStatus, orderId]
            );
            if (newStatus === "delivered") {
                await awardDeliveredOrderPoints(connection, orderId);
            } else if (newStatus === "cancelled") {
                await connection.execute(
                    "UPDATE commissions SET status = 'void' WHERE order_id = ? AND status = 'pending'",
                    [orderId]
                );
                await connection.execute(
                    "UPDATE payments SET status = 'failed' WHERE order_id = ? AND status = 'pending'",
                    [orderId]
                );
                await refundOrderRedemption(connection, orderId);
                const [items] = await connection.execute(
                    "SELECT product_id, quantity FROM order_items WHERE order_id = ?",
                    [orderId]
                );
                for (const item of items) {
                    await adjustProductStock(
                        connection,
                        Number(item.product_id),
                        Number(item.quantity),
                        "admin-order-cancelled"
                    );
                }
            }
            return "updated";
        });

        if (statusUpdate === "not_found") return res.status(404).send("Order not found.");
        if (statusUpdate === "invalid_transition") {
            return res.status(400).send("That order status change is not allowed.");
        }
        await recordAuditEvent(req.session.user.id, `order_status_changed:${orderId}:${newStatus}`);

        return res.redirect("/manager");
    } catch (error) {
        console.error("Manager order update error:", error.message);
        return res.status(500).send("Could not update the order status.");
    }
};

exports.recordCashOnDeliveryPayment = async (req, res) => {
    if (!req.session?.user || req.session.user.role !== "admin") {
        return res.redirect("/login");
    }

    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).send("Invalid order.");
    }

    try {
        const recorded = await db.transaction(async (connection) => {
            const [payments] = await connection.execute(
                `SELECT o.status AS order_status, o.customer_id, p.id, p.method, p.status
                 FROM orders o
                 JOIN payments p ON p.order_id = o.id
                 WHERE o.id = ?
                 ORDER BY p.created_at DESC
                 LIMIT 1`,
                [orderId]
            );
            const payment = payments[0];
            if (!payment) return "not_found";
            if (
                payment.order_status !== "delivered" ||
                payment.method !== "cash_on_delivery" ||
                payment.status !== "pending"
            ) {
                return "not_collectable";
            }

            const reference = `COD-ADMIN-${req.session.user.id}-${Date.now()}`;
            const [updated] = await connection.execute(
                `UPDATE payments
                 SET status = 'successful', transaction_reference = ?
                 WHERE id = ? AND status = 'pending'`,
                [reference, payment.id]
            );
            if (updated.rowsAffected === 0) return "not_collectable";

            await connection.execute(
                "UPDATE commissions SET status = 'earned' WHERE order_id = ? AND status = 'pending'",
                [orderId]
            );
            await awardDeliveredOrderPoints(connection, orderId);
            await awardReferralForFirstOrder(connection, payment.customer_id);
            return "recorded";
        });

        if (recorded === "not_found") return res.status(404).send("Order payment not found.");
        if (recorded === "not_collectable") {
            return res.status(409).send("Only a delivered cash-on-delivery order with a pending payment can be recorded.");
        }

        await recordAuditEvent(req.session.user.id, `cash_on_delivery_payment_recorded:${orderId}`);
        return res.redirect("/admin?codPayment=recorded#financial-ledger");
    } catch (error) {
        console.error("Cash-on-delivery payment record error:", error.message);
        return res.status(500).send("Could not record the cash-on-delivery payment.");
    }
};
