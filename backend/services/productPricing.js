function currentPriceSql(alias = "p") {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
        throw new Error("Invalid product table alias.");
    }

    return `CASE
        WHEN ${alias}.promotion_discount_percent > 0
         AND (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours') >= ${alias}.promotion_starts_at
         AND (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours') < ${alias}.promotion_ends_at
        THEN ROUND((${alias}.price * (1 - ${alias}.promotion_discount_percent / 100.0))::numeric, 2)
        ELSE ${alias}.price
    END`;
}

function currentPromotionDiscountSql(alias = "p") {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
        throw new Error("Invalid product table alias.");
    }

    return `CASE
        WHEN ${alias}.promotion_discount_percent > 0
         AND (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours') >= ${alias}.promotion_starts_at
         AND (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours') < ${alias}.promotion_ends_at
        THEN ${alias}.promotion_discount_percent
        ELSE 0
    END`;
}

module.exports = { currentPriceSql, currentPromotionDiscountSql };
