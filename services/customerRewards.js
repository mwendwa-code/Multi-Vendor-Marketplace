async function getAvailablePoints(connection, customerId) {
    const [rows] = await connection.execute(
        "SELECT COALESCE(SUM(points), 0) AS balance FROM customer_points_ledger WHERE customer_id = ?",
        [customerId]
    );
    return Number(rows[0]?.balance || 0);
}

async function redeemPoints(connection, customerId, orderId, points) {
    if (!points) return;

    await connection.execute(
        `INSERT INTO customer_points_ledger (customer_id, points, reason, event_key)
         VALUES (?, ?, ?, ?)`,
        [customerId, -points, `Checkout reward redemption for order #${orderId}`, `checkout-redemption:order:${orderId}`]
    );
}

async function refundOrderRedemption(connection, orderId) {
    const [orders] = await connection.execute(
        "SELECT customer_id, points_redeemed FROM orders WHERE id = ?",
        [orderId]
    );
    const order = orders[0];
    const points = Number(order?.points_redeemed || 0);
    if (!order || points <= 0) return false;

    const [refunds] = await connection.execute(
        "SELECT id FROM customer_points_ledger WHERE event_key = ?",
        [`checkout-refund:order:${orderId}`]
    );
    if (refunds.length) return false;

    await connection.execute(
        `INSERT INTO customer_points_ledger (customer_id, points, reason, event_key)
         VALUES (?, ?, ?, ?)`,
        [order.customer_id, points, `Refunded reward points for cancelled order #${orderId}`, `checkout-refund:order:${orderId}`]
    );
    return true;
}

async function awardDeliveredOrderPoints(connection, orderId) {
    const [orders] = await connection.execute(
        `SELECT o.customer_id, o.total, o.status
         FROM orders o
         WHERE o.id = ?
           AND o.status = 'delivered'
           AND EXISTS (
               SELECT 1 FROM payments p
               WHERE p.order_id = o.id AND p.status = 'successful'
           )`,
        [orderId]
    );
    const order = orders[0];
    if (!order) return 0;

    const points = Math.floor(Number(order.total) / 100);
    if (points <= 0) return 0;

    const [result] = await connection.execute(
        `INSERT INTO customer_points_ledger (customer_id, points, reason, event_key)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(event_key) DO NOTHING`,
        [order.customer_id, points, `Purchase reward for delivered order #${orderId}`, `delivered-order:${orderId}`]
    );
    return result.rowsAffected ? points : 0;
}

module.exports = {
    awardDeliveredOrderPoints,
    getAvailablePoints,
    redeemPoints,
    refundOrderRedemption
};
