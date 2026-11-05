const db = require("../database/db");
const {
    getAvailablePoints,
    redeemPoints,
    refundOrderRedemption
} = require("./customerRewards");
const { currentPriceSql } = require("./productPricing");
const { adjustProductStock } = require("./inventory");

function normalizeCart(cart) {
    if (!Array.isArray(cart)) return [];
    return cart
        .filter((item) =>
            item &&
            Number.isInteger(Number(item.productId)) &&
            Number(item.productId) > 0 &&
            Number.isInteger(Number(item.quantity)) &&
            Number(item.quantity) > 0 &&
            Number(item.quantity) <= 1000000
        )
        .map((item) => ({
            productId: Number(item.productId),
            quantity: Number(item.quantity)
        }));
}

function createCheckoutError(code, message) {
    return Object.assign(new Error(message), { code });
}

function validateCheckoutDetails(details = {}) {
    function optionalText(value, maxLength) {
        if (value === undefined || value === null) return null;
        if (typeof value !== "string") return false;
        const text = value.trim();
        if (!text) return null;
        if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return false;
        return text;
    }

    const recipientName = optionalText(details.recipientName, 100);
    const shippingAddress = optionalText(details.shippingAddress, 500);
    const shippingCity = optionalText(details.shippingCity, 120);
    const shippingRegion = optionalText(details.shippingRegion, 120);
    const shippingPostalCode = optionalText(details.shippingPostalCode, 30);
    const checkoutFields = [recipientName, shippingAddress, shippingCity, shippingRegion, shippingPostalCode];
    if (
        !recipientName ||
        !shippingAddress ||
        checkoutFields.includes(false)
    ) {
        throw createCheckoutError(
            "INVALID_DELIVERY_DETAILS",
            "Enter a valid recipient name and delivery address."
        );
    }

    return {
        recipientName,
        shippingAddress,
        shippingCity,
        shippingRegion,
        shippingPostalCode
    };
}

async function createCheckoutOrder({
    cart,
    userId,
    paymentMethod,
    phoneNumber = null,
    pointsToRedeem = 0,
    ...deliveryDetails
}) {
    const checkoutDetails = validateCheckoutDetails(deliveryDetails);
    return db.transaction(async (connection) => {
        if (
            !Number.isSafeInteger(pointsToRedeem) ||
            pointsToRedeem < 0 ||
            pointsToRedeem % 100 !== 0
        ) {
            throw createCheckoutError("INVALID_REWARD_POINTS", "Redeem points in increments of 100.");
        }

        if (paymentMethod === "mpesa") {
            const [existingPayments] = await connection.execute(
                `SELECT p.status, o.id AS order_id
                 FROM payments p
                 JOIN orders o ON o.id = p.order_id
                 WHERE o.customer_id = ? AND o.status = 'pending'
                   AND p.method = 'mpesa' AND p.status IN ('pending', 'failed')
                 ORDER BY p.id DESC
                 LIMIT 1`,
                [userId]
            );
            if (existingPayments.length) {
                throw createCheckoutError(
                    existingPayments[0].status === "pending"
                        ? "MPESA_PAYMENT_IN_PROGRESS"
                        : "MPESA_PAYMENT_RETRY_AVAILABLE",
                    "You already have an unpaid M-Pesa order. Retry or cancel it from your customer dashboard before starting another checkout."
                );
            }
        }

        const [settingsRows] = await connection.execute(
            "SELECT commission_rate, commission_flat_fee FROM marketplace_settings WHERE id = 1"
        );
        const commissionRate = Number(settingsRows[0]?.commission_rate ?? 10);
        const commissionFlatFee = Number(settingsRows[0]?.commission_flat_fee ?? 0);
        if (
            !Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 50 ||
            !Number.isFinite(commissionFlatFee) || commissionFlatFee < 0
        ) {
            throw new Error("Marketplace commission settings are invalid.");
        }
        const productIds = cart.map((item) => item.productId);
        const placeholders = productIds.map(() => "?").join(", ");
        const [products] = await connection.execute(
            `SELECT p.*, c.name AS category_name,
                    ${currentPriceSql("p")} AS current_price,
                    CASE
                        WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours') >= p.promotion_starts_at
                         AND (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours') < p.promotion_ends_at
                        THEN p.promotion_discount_percent ELSE 0
                    END AS current_promotion_discount_percent
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.id IN (${placeholders}) AND p.moderation_status = 'approved'`,
            productIds
        );
        const [commissionRules] = await connection.execute(
            "SELECT rule_type, target_id, commission_rate, flat_fee FROM commission_rules"
        );

        let total = 0;
        let totalInCents = 0;
        for (const item of cart) {
            const product = products.find((entry) => entry.id === item.productId);
            if (!product) {
                throw createCheckoutError("PRODUCT_UNAVAILABLE", "One or more products are no longer available.");
            }
            if (item.quantity > product.stock) {
                throw createCheckoutError("INSUFFICIENT_STOCK", `Not enough stock for ${product.name}.`);
            }
            const price = Number(product.current_price);
            total += price * item.quantity;
            totalInCents += Math.round(price * 100) * item.quantity;
        }

        let discountCents = 0;
        if (pointsToRedeem > 0) {
            const availablePoints = await getAvailablePoints(connection, userId);
            if (pointsToRedeem > availablePoints) {
                throw createCheckoutError("INSUFFICIENT_REWARD_POINTS", "You do not have enough points for this redemption.");
            }
            discountCents = (pointsToRedeem / 100) * 5000;
            const maximumDiscountCents = Math.floor(totalInCents * 20 / 100);
            if (discountCents > maximumDiscountCents) {
                throw createCheckoutError("REWARD_DISCOUNT_LIMIT", "Reward points can cover up to 20% of your cart subtotal.");
            }
        }
        totalInCents -= discountCents;
        total = totalInCents / 100;

        if (paymentMethod === "mpesa") {
            if (!Number.isSafeInteger(totalInCents) || totalInCents % 100 !== 0) {
                throw createCheckoutError(
                    "INVALID_MPESA_AMOUNT",
                    "M-Pesa checkout requires a whole-shilling total. Adjust your cart or choose cash on delivery."
                );
            }
            total = totalInCents / 100;
        }

        const [orderResult] = await connection.execute(
            `INSERT INTO orders
                (customer_id, total, status, recipient_name, shipping_address, shipping_city, shipping_region,
                 shipping_postal_code, recipient_phone, points_redeemed, discount_amount)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id`,
            [
                userId,
                total,
                "pending",
                checkoutDetails.recipientName,
                checkoutDetails.shippingAddress,
                checkoutDetails.shippingCity,
                checkoutDetails.shippingRegion,
                checkoutDetails.shippingPostalCode,
                null,
                pointsToRedeem,
                discountCents / 100
            ]
        );
        const orderId = orderResult.insertId;
        await redeemPoints(connection, userId, orderId, pointsToRedeem);

        for (const item of cart) {
            const product = products.find((entry) => entry.id === item.productId);
            const [itemResult] = await connection.execute(
                `INSERT INTO order_items
                    (order_id, product_id, seller_id, quantity, price, promotion_discount_percent)
                 VALUES (?, ?, ?, ?, ?, ?)
                 RETURNING id`,
                [
                    orderId,
                    item.productId,
                    product.seller_id,
                    item.quantity,
                    product.current_price,
                    product.current_promotion_discount_percent
                ]
            );
            const grossCents = Math.round(Number(product.current_price) * 100) * item.quantity;
            const sellerRule = commissionRules.find(
                (rule) => rule.rule_type === "seller" && Number(rule.target_id) === Number(product.seller_id)
            );
            const categoryRule = commissionRules.find(
                (rule) => rule.rule_type === "category" &&
                    Number(rule.target_id) === Number(product.category_id)
            );
            const selectedRule = sellerRule || categoryRule;
            const itemCommissionRate = selectedRule
                ? Number(selectedRule.commission_rate)
                : commissionRate;
            const itemFlatFee = selectedRule
                ? Number(selectedRule.flat_fee)
                : commissionFlatFee;
            if (
                !Number.isFinite(itemCommissionRate) || itemCommissionRate < 0 || itemCommissionRate > 50 ||
                !Number.isFinite(itemFlatFee) || itemFlatFee < 0
            ) {
                throw new Error("A commission override is invalid.");
            }
            const percentageCommissionCents = Math.round(grossCents * itemCommissionRate / 100);
            const flatFeeCents = Math.round(itemFlatFee * 100);
            const commissionCents = Math.min(grossCents, percentageCommissionCents + flatFeeCents);
            await connection.execute(
                `INSERT INTO commissions
                    (order_id, seller_id, amount, order_item_id, commission_rate,
                     commission_flat_fee, gross_amount, seller_net_amount, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orderId,
                    product.seller_id,
                    commissionCents / 100,
                    itemResult.insertId,
                    itemCommissionRate,
                    flatFeeCents / 100,
                    grossCents / 100,
                    (grossCents - commissionCents) / 100,
                    "pending"
                ]
            );
            if (Number(product.stock) < item.quantity) {
                throw createCheckoutError("INSUFFICIENT_STOCK", `Not enough stock for ${product.name}.`);
            }
            await adjustProductStock(connection, item.productId, -item.quantity, "checkout-reserved");
        }

        const [paymentResult] = await connection.execute(
            `INSERT INTO payments
                (order_id, method, transaction_reference, amount, status, phone_number)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING id`,
            [orderId, paymentMethod, null, total, "pending", phoneNumber]
        );

        return {
            orderId,
            paymentId: paymentResult.insertId,
            total,
            discount: discountCents / 100,
            pointsRedeemed: pointsToRedeem
        };
    });
}

async function createMpesaRetryAttempt({ orderId, customerId, phoneNumber }) {
    return db.transaction(async (connection) => {
        const [orders] = await connection.execute(
            "SELECT id, total, status FROM orders WHERE id = ? AND customer_id = ?",
            [orderId, customerId]
        );
        const order = orders[0];
        if (!order) {
            throw createCheckoutError("ORDER_NOT_FOUND", "Order not found.");
        }
        if (order.status !== "pending") {
            throw createCheckoutError("ORDER_NOT_RETRYABLE", "This order is no longer awaiting payment.");
        }

        const [pendingPayments] = await connection.execute(
            "SELECT id FROM payments WHERE order_id = ? AND method = ? AND status = ?",
            [orderId, "mpesa", "pending"]
        );
        if (pendingPayments.length) {
            throw createCheckoutError(
                "MPESA_PAYMENT_IN_PROGRESS",
                "A payment request is already in progress for this order."
            );
        }

        const [latestPayments] = await connection.execute(
            `SELECT status FROM payments
             WHERE order_id = ? AND method = ?
             ORDER BY id DESC LIMIT 1`,
            [orderId, "mpesa"]
        );
        if (!latestPayments.length || latestPayments[0].status !== "failed") {
            throw createCheckoutError(
                "ORDER_NOT_RETRYABLE",
                "Only a confirmed failed M-Pesa payment can be retried."
            );
        }

        const [paymentResult] = await connection.execute(
            `INSERT INTO payments (order_id, method, amount, status, phone_number)
             VALUES (?, ?, ?, ?, ?)
             RETURNING id`,
            [orderId, "mpesa", order.total, "pending", phoneNumber]
        );
        return {
            orderId: order.id,
            paymentId: paymentResult.insertId,
            total: Number(order.total)
        };
    });
}

async function failPendingPayment(paymentId) {
    return db.transaction(async (connection) => {
        const [payments] = await connection.execute(
            `SELECT p.id, p.status, o.status AS order_status
             FROM payments p
             JOIN orders o ON o.id = p.order_id
             WHERE p.id = ? AND p.method = ?`,
            [paymentId, "mpesa"]
        );
        const payment = payments[0];
        if (!payment || payment.status !== "pending" || payment.order_status !== "pending") {
            return false;
        }

        const [result] = await connection.execute(
            "UPDATE payments SET status = ? WHERE id = ? AND status = ?",
            ["failed", payment.id, "pending"]
        );
        if (result.rowsAffected === 0) {
            return false;
        }

        return true;
    });
}

module.exports = {
    createCheckoutOrder,
    createMpesaRetryAttempt,
    failPendingPayment,
    normalizeCart,
    validateCheckoutDetails
};
