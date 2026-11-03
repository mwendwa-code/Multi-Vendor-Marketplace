const db = require("../database/db");
const {
    createCheckoutOrder,
    normalizeCart,
    validateCheckoutDetails
} = require("../services/checkoutService");
const { isMpesaConfigured } = require("./paymentController");
const customerEngagement = require("../services/customerEngagement");
const { currentPriceSql } = require("../services/productPricing");

async function getCartProducts(cart) {
    const normalized = normalizeCart(cart);
    if (normalized.length === 0) {
        return [];
    }

    const productIds = normalized.map((item) => item.productId);
    const placeholders = productIds.map(() => "?").join(", ");
    const [products] = await db.execute(
        `SELECT p.*, c.name AS category_name,
                ${currentPriceSql("p")} AS current_price,
                CASE
                    WHEN datetime('now', '+3 hours') >= datetime(p.promotion_starts_at)
                     AND datetime('now', '+3 hours') < datetime(p.promotion_ends_at)
                    THEN p.promotion_discount_percent ELSE 0
                END AS current_promotion_discount_percent
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.id IN (${placeholders}) AND p.moderation_status = 'approved'`,
        productIds
    );

    return normalized.map((item) => {
        const product = products.find((entry) => entry.id === item.productId);
        if (!product) return null;
        return {
            ...product,
            originalPrice: Number(product.price),
            price: Number(product.current_price),
            quantity: item.quantity,
            lineTotal: Number(product.current_price) * item.quantity
        };
    }).filter(Boolean);
}

exports.getProduct = async (req, res) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    try {
        const [products] = await db.execute(
            `SELECT p.*, c.name AS category_name,
                    ${currentPriceSql("p")} AS current_price,
                    CASE
                        WHEN datetime('now', '+3 hours') >= datetime(p.promotion_starts_at)
                         AND datetime('now', '+3 hours') < datetime(p.promotion_ends_at)
                        THEN p.promotion_discount_percent ELSE 0
                    END AS current_promotion_discount_percent,
                    sp.business_name, sp.business_website,
                    sp.business_description, sp.business_logo
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
             WHERE p.id = ? AND p.moderation_status = 'approved'`,
            [productId]
        );

        if (products.length === 0) {
            return res.status(404).send("Product not found.");
        }

        if (req.session.user && ["customer", "buyer"].includes(req.session.user.role)) {
            await customerEngagement.recordProductView(req.session.user.id, productId);
        }

        const [productReviews] = await db.execute(
            `SELECT r.rating, r.comment, r.created_at, u.name AS customer_name,
                    sr.response AS seller_response
             FROM reviews r
             JOIN users u ON u.id = r.customer_id
             LEFT JOIN seller_review_responses sr
               ON sr.review_id = r.id AND sr.seller_id = ?
             WHERE r.product_id = ?
             ORDER BY r.created_at DESC
             LIMIT 30`,
            [products[0].seller_id, productId]
        );
        return res.render("product", {
            user: req.session.user || null,
            product: products[0],
            productReviews
        });
    } catch (error) {
        console.error("Product detail error:", error.message);
        return res.status(500).send("Could not load product details.");
    }
};

exports.addToCart = async (req, res) => {
    const productId = Number(req.body?.productId);
    const quantity = Number(req.body?.quantity || 1);

    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product selection.");
    }

    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000000) {
        return res.status(400).send("Please choose a valid quantity.");
    }

    try {
        const [products] = await db.execute(
            `SELECT id, name, stock, price
             FROM products
             WHERE id = ? AND moderation_status = 'approved'`,
            [productId]
        );

        if (products.length === 0) {
            return res.status(404).send("Product not found.");
        }

        const product = products[0];
        if (product.stock < quantity) {
            return res.status(400).send("Not enough stock for that quantity.");
        }

        req.session.cart = normalizeCart(req.session.cart || []);
        const existingItem = req.session.cart.find((item) => item.productId === productId);

        if (existingItem) {
            const newQuantity = existingItem.quantity + quantity;
            if (newQuantity > product.stock) {
                return res.status(400).send("The requested quantity exceeds current stock.");
            }
            existingItem.quantity = newQuantity;
        } else {
            req.session.cart.push({ productId, quantity });
        }

        if (req.accepts("json")) {
            const cartCount = req.session.cart.reduce((total, item) => total + item.quantity, 0);
            return res.json({ success: true, cartCount, itemName: product.name, quantity });
        }

        return res.redirect("/cart");
    } catch (error) {
        console.error("Add to cart error:", error.message);
        return res.status(500).send("Could not add the item to your cart.");
    }
};

exports.viewCart = async (req, res) => {
    const cart = normalizeCart(req.session.cart || []);
    const cartItems = await getCartProducts(cart);
    const total = cartItems.reduce((sum, item) => sum + Number(item.lineTotal), 0);
    let savedMpesaPhone = "";
    let customerProfile = {};
    let rewardPoints = 0;
    if (req.session.user) {
        const [[customerProfiles], [pointsRows]] = await Promise.all([
            db.execute(
                `SELECT mpesa_phone, shipping_address, shipping_city,
                        shipping_region, shipping_postal_code
                 FROM customer_profiles WHERE user_id = ?`,
                [req.session.user.id]
            ),
            db.execute(
                "SELECT COALESCE(SUM(points), 0) AS balance FROM customer_points_ledger WHERE customer_id = ?",
                [req.session.user.id]
            )
        ]);
        customerProfile = customerProfiles[0] || {};
        savedMpesaPhone = customerProfile.mpesa_phone || "";
        rewardPoints = Math.max(0, Number(pointsRows[0]?.balance || 0));
    }
    const subtotalCents = Math.round(total * 100);
    const maxRedeemPoints = Math.min(
        rewardPoints - (rewardPoints % 100),
        Math.floor(Math.floor(subtotalCents * 20 / 100) / 5000) * 100
    );

    return res.render("cart", {
        user: req.session.user || null,
        cartItems,
        total,
        empty: cartItems.length === 0,
        mpesaConfigured: isMpesaConfigured(),
        savedMpesaPhone,
        customerProfile,
        rewardPoints,
        maxRedeemPoints,
        payment: typeof req.query.payment === "string" ? req.query.payment : "",
        checkout: typeof req.query.checkout === "string" ? req.query.checkout : ""
    });
};

exports.removeItem = async (req, res) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    req.session.cart = normalizeCart(req.session.cart || []).filter((item) => item.productId !== productId);
    return res.redirect("/cart");
};

exports.updateItem = async (req, res) => {
    const productId = Number(req.params.id);
    const quantity = Number(req.body?.quantity || 1);

    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).send("Invalid product.");
    }

    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000000) {
        return res.status(400).send("Quantity must be at least 1.");
    }

    try {
        const [products] = await db.execute(
            "SELECT stock FROM products WHERE id = ? AND moderation_status = 'approved'",
            [productId]
        );
        if (products.length === 0) {
            return res.status(404).send("Product not found.");
        }

        if (quantity > products[0].stock) {
            return res.status(400).send("Requested quantity exceeds available stock.");
        }

        req.session.cart = normalizeCart(req.session.cart || []).map((item) => {
            if (item.productId === productId) {
                return { ...item, quantity };
            }
            return item;
        });

        return res.redirect("/cart");
    } catch (error) {
        console.error("Update cart error:", error.message);
        return res.status(500).send("Could not update your cart.");
    }
};

exports.checkout = async (req, res) => {
    if (!req.session.user) {
        return res.redirect("/register?checkout=required");
    }

    const cart = normalizeCart(req.session.cart || []);
    if (cart.length === 0) {
        return res.redirect("/cart");
    }

    let checkoutDetails;
    try {
        checkoutDetails = validateCheckoutDetails(req.body);
    } catch (error) {
        if (error.code === "INVALID_DELIVERY_DETAILS") {
            return res.status(400).send(error.message);
        }
        console.error("Checkout detail validation error:", error.message);
        return res.status(500).send("Could not validate your delivery details.");
    }

    try {
        await createCheckoutOrder({
            cart,
            userId: req.session.user.id,
            paymentMethod: "cash_on_delivery",
            ...checkoutDetails,
            pointsToRedeem: parsePointsToRedeem(req.body?.pointsToRedeem)
        });

        req.session.cart = [];
        return res.redirect("/cart?checkout=success");
    } catch (error) {
        if ([
            "PRODUCT_UNAVAILABLE",
            "INSUFFICIENT_STOCK",
            "INVALID_DELIVERY_DETAILS",
            "INVALID_REWARD_POINTS",
            "INSUFFICIENT_REWARD_POINTS",
            "REWARD_DISCOUNT_LIMIT"
        ].includes(error.code)) {
            return res.status(409).send(error.message);
        }
        console.error("Checkout error:", error.message);
        return res.status(500).send("Could not complete checkout.");
    }
};

function parsePointsToRedeem(rawPoints) {
    if (rawPoints === undefined || rawPoints === null || rawPoints === "") return 0;
    if (typeof rawPoints !== "string" || !/^\d+$/.test(rawPoints)) {
        const error = new Error("Enter a valid number of reward points.");
        error.code = "INVALID_REWARD_POINTS";
        throw error;
    }
    const points = Number(rawPoints);
    if (!Number.isSafeInteger(points)) {
        const error = new Error("Enter a valid number of reward points.");
        error.code = "INVALID_REWARD_POINTS";
        throw error;
    }
    return points;
}
