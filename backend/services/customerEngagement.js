const nodemailer = require("nodemailer");
const db = require("../database/db");

let missingMailerWarningLogged = false;

function getMailer() {
    const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD } = process.env;
    const port = Number(process.env.SMTP_PORT || 587);
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }

    return nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE === "true",
        auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    })[character]);
}

exports.recordProductView = async (customerId, productId) => {
    const [dayRows] = await db.execute(
        "SELECT TO_CHAR((CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours')::date, 'YYYY-MM-DD') AS activity_date"
    );
    const activityDate = dayRows[0].activity_date;

    await db.transaction(async (connection) => {
        await connection.execute(
            `INSERT INTO customer_product_views
                (customer_id, product_id, viewed_at, view_count, last_activity_date)
             VALUES (?, ?, CURRENT_TIMESTAMP, 1, ?)
             ON CONFLICT(customer_id, product_id) DO UPDATE SET
                viewed_at = CURRENT_TIMESTAMP,
                view_count = customer_product_views.view_count + 1,
                last_activity_date = excluded.last_activity_date`,
            [customerId, productId, activityDate]
        );
        await connection.execute(
            `INSERT INTO customer_activity_days (customer_id, activity_date)
             VALUES (?, ?)
             ON CONFLICT(customer_id, activity_date) DO NOTHING`,
            [customerId, activityDate]
        );
    });
};

exports.initializeWishlistWatch = async (customerId, productId, product) => {
    await db.execute(
        `INSERT INTO customer_wishlist_watch_state (customer_id, product_id, last_price, last_stock)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(customer_id, product_id) DO NOTHING`,
        [customerId, productId, Number(product.price), Number(product.stock)]
    );
};

exports.refreshWishlistAlerts = async (customerId, email, name) => {
    await db.transaction(async (connection) => {
        const [watchedItems] = await connection.execute(
            `SELECT p.id AS product_id,
                    CASE WHEN f.seller_id IS NOT NULL THEN 1 ELSE COALESCE(w.alert_price_drop, 0) END AS alert_price_drop,
                    COALESCE(w.alert_back_in_stock, 0) AS alert_back_in_stock,
                    CASE WHEN f.seller_id IS NOT NULL THEN 1 ELSE 0 END AS followed_by_customer,
                    p.seller_id,
                    p.name, p.price, p.stock, s.last_price, s.last_stock
             FROM products p
             LEFT JOIN wishlists w
               ON w.customer_id = ? AND w.product_id = p.id
             LEFT JOIN customer_seller_follows f
               ON f.customer_id = ? AND f.seller_id = p.seller_id
             LEFT JOIN customer_wishlist_watch_state s
               ON s.customer_id = ? AND s.product_id = p.id
             WHERE (w.customer_id IS NOT NULL OR f.seller_id IS NOT NULL)
               AND p.moderation_status = 'approved'`,
            [customerId, customerId, customerId]
        );

        for (const item of watchedItems) {
            if (item.last_price === null || item.last_price === undefined) {
                await connection.execute(
                    `INSERT INTO customer_wishlist_watch_state
                        (customer_id, product_id, last_price, last_stock)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(customer_id, product_id) DO UPDATE SET
                        last_price = excluded.last_price, last_stock = excluded.last_stock`,
                    [customerId, item.product_id, Number(item.price), Number(item.stock)]
                );
                continue;
            }

            if (item.alert_price_drop && Number(item.price) < Number(item.last_price)) {
                const message = `${item.name} dropped in price from KSh ${Number(item.last_price).toLocaleString("en-KE")} to KSh ${Number(item.price).toLocaleString("en-KE")}.`;
                if (item.followed_by_customer) {
                    await connection.execute(
                        `INSERT INTO customer_seller_updates
                            (customer_id, seller_id, product_id, update_type, event_key, message)
                         VALUES (?, ?, ?, 'price_drop', ?, ?)
                         ON CONFLICT(event_key) DO NOTHING`,
                        [
                            customerId,
                            item.seller_id,
                            item.product_id,
                            `price-drop:${customerId}:${item.product_id}:${Date.now()}`,
                            message
                        ]
                    );
                } else {
                    await connection.execute(
                        `INSERT INTO customer_wishlist_alerts
                            (customer_id, product_id, alert_type, message)
                         VALUES (?, ?, 'price_drop', ?)`,
                        [customerId, item.product_id, message]
                    );
                }
            }

            if (item.alert_back_in_stock && Number(item.last_stock) <= 0 && Number(item.stock) > 0) {
                const message = `${item.name} is back in stock.`;
                await connection.execute(
                    `INSERT INTO customer_wishlist_alerts
                        (customer_id, product_id, alert_type, message)
                     VALUES (?, ?, 'back_in_stock', ?)`,
                    [customerId, item.product_id, message]
                );
            }

            await connection.execute(
                `UPDATE customer_wishlist_watch_state
                 SET last_price = ?, last_stock = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE customer_id = ? AND product_id = ?`,
                [Number(item.price), Number(item.stock), customerId, item.product_id]
            );
        }

        await connection.execute(
            `INSERT INTO customer_seller_updates
                (customer_id, seller_id, product_id, update_type, event_key, message)
             SELECT f.customer_id, f.seller_id, p.id, 'new_product',
                    'new-product:' || f.customer_id || ':' || p.id,
                    p.name || ' is now available from ' || COALESCE(sp.business_name, u.name) || '.'
             FROM customer_seller_follows f
             JOIN products p ON p.seller_id = f.seller_id
             JOIN users u ON u.id = f.seller_id
             LEFT JOIN seller_profiles sp ON sp.user_id = u.id
             WHERE f.customer_id = ?
               AND p.moderation_status = 'approved'
               AND p.created_at > f.created_at
             ON CONFLICT(event_key) DO NOTHING`,
            [customerId]
        );
    });

    const [notificationRows] = await db.execute(
        "SELECT email_notifications FROM customer_profiles WHERE user_id = ?",
        [customerId]
    );
    if (email && Number(notificationRows[0]?.email_notifications ?? 1) === 1) {
        const [pendingAlerts] = await db.execute(
            `SELECT id, message
             FROM customer_wishlist_alerts
             WHERE customer_id = ? AND emailed_at IS NULL
             ORDER BY created_at ASC
             LIMIT 20`,
            [customerId]
        );
        const [sellerUpdates] = await db.execute(
            `SELECT id, message
             FROM customer_seller_updates
             WHERE customer_id = ? AND emailed_at IS NULL
             ORDER BY created_at ASC
             LIMIT 20`,
            [customerId]
        );

        if (pendingAlerts.length || sellerUpdates.length) {
            const mailer = getMailer();
            if (!mailer) {
                if (!missingMailerWarningLogged) {
                    console.warn("Customer alert emails are pending because SMTP_HOST, SMTP_USER, and SMTP_PASSWORD are not configured.");
                    missingMailerWarningLogged = true;
                }
            } else {
                const from = process.env.SMTP_FROM || process.env.SMTP_USER;
                if (pendingAlerts.length) {
                    try {
                        await mailer.sendMail({
                            from,
                            to: email,
                            subject: "An update on your saved marketplace items",
                            text: `Hello ${name},\n\n${pendingAlerts.map((alert) => `- ${alert.message}`).join("\n")}\n\nVisit your customer dashboard to see your saved items.`,
                            html: `<p>Hello ${escapeHtml(name)},</p><ul>${pendingAlerts.map((alert) => `<li>${escapeHtml(alert.message)}</li>`).join("")}</ul><p>Visit your customer dashboard to see your saved items.</p>`
                        });
                        const ids = pendingAlerts.map((alert) => alert.id);
                        const placeholders = ids.map(() => "?").join(", ");
                        await db.execute(
                            `UPDATE customer_wishlist_alerts
                             SET emailed_at = CURRENT_TIMESTAMP
                             WHERE customer_id = ? AND id IN (${placeholders})`,
                            [customerId, ...ids]
                        );
                    } catch (error) {
                        console.error("Wishlist alert email error:", error.message);
                    }
                }
                if (sellerUpdates.length) {
                    try {
                        await mailer.sendMail({
                            from,
                            to: email,
                            subject: "New products and price drops from shops you follow",
                            text: `Hello ${name},\n\n${sellerUpdates.map((update) => `- ${update.message}`).join("\n")}\n\nVisit your customer dashboard to see updates from shops you follow.`,
                            html: `<p>Hello ${escapeHtml(name)},</p><ul>${sellerUpdates.map((update) => `<li>${escapeHtml(update.message)}</li>`).join("")}</ul><p>Visit your customer dashboard to see updates from shops you follow.</p>`
                        });
                        const ids = sellerUpdates.map((update) => update.id);
                        const placeholders = ids.map(() => "?").join(", ");
                        await db.execute(
                            `UPDATE customer_seller_updates
                             SET emailed_at = CURRENT_TIMESTAMP
                             WHERE customer_id = ? AND id IN (${placeholders})`,
                            [customerId, ...ids]
                        );
                    } catch (error) {
                        console.error("Followed-shop update email error:", error.message);
                    }
                }
            }
        }
    }
};

exports.awardReferralForFirstOrder = async (connection, referredCustomerId) => {
    await connection.execute(
        `UPDATE customer_referrals
         SET status = 'first_order'
         WHERE referred_customer_id = ? AND status = 'joined'
           AND EXISTS (
               SELECT 1 FROM orders o
               JOIN payments p ON p.order_id = o.id
               WHERE o.customer_id = ? AND o.status != 'cancelled'
                 AND p.status = 'successful'
           )`,
        [referredCustomerId, referredCustomerId]
    );
    await connection.execute(
        `INSERT INTO customer_points_ledger (customer_id, points, reason, event_key)
         SELECT r.referrer_id, 100,
                'Referral reward for customer #' || r.referred_customer_id || ' first successful order',
                'referral-first-order:' || r.referred_customer_id
         FROM customer_referrals r
         WHERE r.referred_customer_id = ? AND r.status = 'first_order'
           AND EXISTS (
               SELECT 1 FROM orders o
               JOIN payments p ON p.order_id = o.id
               WHERE o.customer_id = r.referred_customer_id AND o.status != 'cancelled'
                 AND p.status = 'successful'
           )
         ON CONFLICT(event_key) DO NOTHING`,
        [referredCustomerId]
    );
};

exports.refreshMissionsAndBadges = async (customerId) => {
    const [activityRows] = await db.execute(
        `SELECT TO_CHAR((CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours')::date, 'YYYY-MM-DD') AS today,
                (SELECT COUNT(*) FROM customer_product_views
                 WHERE customer_id = ? AND last_activity_date = TO_CHAR((CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours')::date, 'YYYY-MM-DD')) AS viewed_today,
                (SELECT COUNT(*) FROM wishlists
                 WHERE customer_id = ? AND (created_at + INTERVAL '3 hours')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours')::date) AS saved_today,
                (SELECT COUNT(*) FROM reviews
                 WHERE customer_id = ? AND (created_at + INTERVAL '3 hours')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours' - INTERVAL '6 days')::date) AS reviewed_this_week`,
        [customerId, customerId, customerId]
    );
    const activity = activityRows[0];
    const missions = [
        {
            key: "browse-3-products",
            title: "Explore 3 products today",
            progress: Math.min(Number(activity.viewed_today), 3),
            target: 3,
            points: 10,
            period: activity.today,
            completed: Number(activity.viewed_today) >= 3
        },
        {
            key: "save-3-items",
            title: "Save 3 products today",
            progress: Math.min(Number(activity.saved_today), 3),
            target: 3,
            points: 15,
            period: activity.today,
            completed: Number(activity.saved_today) >= 3
        },
        {
            key: "review-a-purchase",
            title: "Review a purchase this week",
            progress: Math.min(Number(activity.reviewed_this_week), 1),
            target: 1,
            points: 50,
            period: activity.today,
            completed: Number(activity.reviewed_this_week) > 0
        }
    ];

    for (const mission of missions) {
        if (!mission.completed) continue;
        await db.execute(
            `INSERT INTO customer_points_ledger (customer_id, points, reason, event_key)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(event_key) DO NOTHING`,
            [customerId, mission.points, mission.title, `mission:${customerId}:${mission.key}:${mission.period}`]
        );
    }

    await db.execute(
        `INSERT INTO customer_badges (customer_id, badge_key)
         SELECT ?, 'first-purchase'
         WHERE EXISTS (
            SELECT 1 FROM orders
            WHERE customer_id = ? AND status != 'cancelled'
         )
         ON CONFLICT(customer_id, badge_key) DO NOTHING`,
        [customerId, customerId]
    );
    await db.execute(
        `INSERT INTO customer_badges (customer_id, badge_key)
         SELECT ?, 'local-supporter'
         WHERE (SELECT COUNT(*) FROM customer_seller_follows WHERE customer_id = ?) >= 3
         ON CONFLICT(customer_id, badge_key) DO NOTHING`,
        [customerId, customerId]
    );
    await db.execute(
        `INSERT INTO customer_badges (customer_id, badge_key)
         SELECT ?, 'top-reviewer'
         WHERE (SELECT COUNT(*) FROM reviews WHERE customer_id = ?) >= 5
         ON CONFLICT(customer_id, badge_key) DO NOTHING`,
        [customerId, customerId]
    );
    await db.execute(
        `INSERT INTO customer_badges (customer_id, badge_key)
         SELECT ?, 'trendsetter'
         WHERE (SELECT COUNT(*) FROM customer_collections WHERE customer_id = ?) >= 3
         ON CONFLICT(customer_id, badge_key) DO NOTHING`,
        [customerId, customerId]
    );
    await db.transaction(async (connection) => {
        const [referrals] = await connection.execute(
            "SELECT referred_customer_id FROM customer_referrals WHERE referrer_id = ? AND status = 'joined'",
            [customerId]
        );
        for (const referral of referrals) {
            await exports.awardReferralForFirstOrder(connection, referral.referred_customer_id);
        }
    });

    const [pointsRows] = await db.execute(
        "SELECT COALESCE(SUM(points), 0) AS points FROM customer_points_ledger WHERE customer_id = ?",
        [customerId]
    );
    const [badgeRows] = await db.execute(
        "SELECT badge_key, earned_at FROM customer_badges WHERE customer_id = ? ORDER BY earned_at DESC",
        [customerId]
    );
    const [streakRows] = await db.execute(
        `SELECT activity_date FROM customer_activity_days
         WHERE customer_id = ? AND activity_date >= TO_CHAR((CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '3 hours' - INTERVAL '60 days')::date, 'YYYY-MM-DD')
         ORDER BY activity_date DESC`,
        [customerId]
    );

    const todayDate = new Date(`${activity.today}T00:00:00Z`);
    const activityDates = new Set(streakRows.map((row) => row.activity_date));
    const todayHasActivity = activityDates.has(activity.today);
    const streakStart = new Date(todayDate);
    if (!todayHasActivity) streakStart.setUTCDate(streakStart.getUTCDate() - 1);
    let streak = 0;
    for (let offset = 0; offset < 60; offset += 1) {
        const date = new Date(streakStart);
        date.setUTCDate(date.getUTCDate() - offset);
        if (!activityDates.has(date.toISOString().slice(0, 10))) break;
        streak += 1;
    }

    const totalPoints = Number(pointsRows[0]?.points || 0);
    const tiers = [
        { name: "Bronze", points: 0 },
        { name: "Silver", points: 250 },
        { name: "Gold", points: 750 },
        { name: "Platinum", points: 1500 }
    ];
    const tier = tiers.slice().reverse().find((item) => totalPoints >= item.points) || tiers[0];
    const nextTier = tiers.find((item) => item.points > tier.points) || null;

    return {
        missions,
        totalPoints,
        tier: tier.name,
        nextTier,
        pointsToNextTier: nextTier ? nextTier.points - totalPoints : 0,
        streak,
        badges: badgeRows
    };
};
