const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const dotenv = require("dotenv");

dotenv.config({
  path: [path.join(__dirname, ".env"), path.join(__dirname, "..", ".env")]
});

if (
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  !process.env.GOOGLE_REDIRECT_URI
) {
  process.env.GOOGLE_REDIRECT_URI = `http://localhost:${process.env.PORT || 3000}/auth/google/callback`;
}

const db = require("./database/db");
const SQLiteSessionStore = require("./middleware/sqliteSessionStore");
const authRoutes = require("./routes/authRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const paymentController = require("./controllers/paymentController");
const profileRoutes = require("./routes/profileRoutes");
const productRoutes = require("./routes/productRoutes");
const shopRoutes = require("./routes/shopRoutes");
const orderController = require("./controllers/orderController");
const customerController = require("./controllers/customerController");
const customerEngagementController = require("./controllers/customerEngagementController");
const managerController = require("./controllers/managerController");
const profileController = require("./controllers/profileController");
const sellerHubController = require("./controllers/sellerHubController");
const { requireLogin, requireRole } = require("./middleware/auth");
const csrfProtection = require("./middleware/csrf");
const sellerLogoUpload = require("./middleware/uploadSellerLogo");
const refundEvidenceUpload = require("./middleware/uploadRefundEvidence");
const { recordAuditEvent } = require("./database/audit");
const { normalizeBusinessWebsite } = require("./services/businessWebsite");
const { currentPriceSql } = require("./services/productPricing");
const backupDirectory = path.resolve(
  process.env.BACKUP_DIR || path.join(__dirname, "database", "backups")
);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const sessionCookieName = `marketplace.sid.${PORT}`;
app.locals.sessionCookieName = sessionCookieName;
app.locals.productImage = (product) => {
  if (product.image) return product.image;
  const productName = String(product.name || "").toLowerCase();
  if (/\b(shoe|shoes|sneaker|sneakers)\b/.test(productName)) {
    return "/images/product-shoes.jpg";
  }
  if (product.category_name === "Clothing") return "/images/product-clothing.jpg";
  if (product.category_name === "Home and Living") return "/images/product-home.jpg";
  return "/images/product-electronics.jpg";
};
const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessionStore = new SQLiteSessionStore(
  process.env.SESSION_DB_PATH || path.join(__dirname, "database", "sessions.sqlite")
);

if (isProduction && (!process.env.SESSION_SECRET || sessionSecret.length < 32)) {
  throw new Error("Set SESSION_SECRET to a value of at least 32 characters in production.");
}

if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "https:"]
    }
  }
}));

app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    name: sessionCookieName,
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);
app.post("/api/payments/mpesa/callback/:token", paymentController.handleMpesaCallback);
app.use("/seller/products", productRoutes);
app.post(
  "/seller/business-profile",
  requireLogin,
  requireRole("seller"),
  sellerLogoUpload.single,
  csrfProtection,
  profileController.updateSellerBusinessProfile
);
app.use(csrfProtection);

app.use((req, res, next) => {
  req.session.cart = Array.isArray(req.session.cart) ? req.session.cart : [];
  res.locals.user = req.session?.user || null;
  res.locals.cartCount = req.session.cart.reduce((total, item) => total + Number(item.quantity || 0), 0);
  next();
});

app.get("/", async (req, res) => {
  if (req.session?.user?.role === "seller") {
    return res.redirect("/seller");
  }

  let products = [];
  let databaseError = false;

  try {
    const searchQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const categoryFilter = Number(req.query.categoryId);
    const params = [];
    let sql = `SELECT p.*, c.name AS category_name,
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
      WHERE p.moderation_status = 'approved'`;

    if (searchQuery) {
      sql += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
      const likeTerm = `%${searchQuery}%`;
      params.push(likeTerm, likeTerm);
    }

    if (Number.isInteger(categoryFilter) && categoryFilter > 0) {
      sql += ` AND p.category_id = ?`;
      params.push(categoryFilter);
    }

    sql += ` ORDER BY p.created_at DESC LIMIT 12`;

    const [rows] = await db.execute(sql, params);
    const [categories] = await db.execute("SELECT id, name FROM categories ORDER BY name ASC");
    products = rows;
    res.render("index", {
      user: req.session.user || null,
      products,
      databaseError,
      categories,
      searchQuery,
      selectedCategoryId: Number.isInteger(categoryFilter) && categoryFilter > 0 ? categoryFilter : ""
    });
  } catch (error) {
    console.error("Failed to load products:", error.message);
    databaseError = true;
    const [categories] = await db.execute("SELECT id, name FROM categories ORDER BY name ASC");
    res.render("index", {
      user: req.session.user || null,
      products: [],
      databaseError,
      categories,
      searchQuery: "",
      selectedCategoryId: ""
    });
  }
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === "admin") return res.redirect("/admin");
    if (req.session.user.role === "seller") return res.redirect("/seller");
    return res.redirect("/customer");
  }

  const localVerificationUrl =
    process.env.NODE_ENV !== "production" &&
    typeof req.session.localVerificationUrl === "string"
      ? req.session.localVerificationUrl
      : "";
  delete req.session.localVerificationUrl;

  res.render("login", {
    passwordReset: req.query.reset === "success",
    csrfExpired: req.query.csrf === "expired",
    loginError: typeof req.query.error === "string" ? req.query.error : "",
    mfaMessage: typeof req.query.mfa === "string" ? req.query.mfa : "",
    verify: typeof req.query.verify === "string" ? req.query.verify : "",
    localVerificationUrl,
    googleConfigured: Boolean(
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REDIRECT_URI
    )
  });
});

app.get("/forgot-password", (req, res) => {
  res.render("forgot-password", { message: null, email: "" });
});

app.get("/register", (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === "admin") return res.redirect("/admin");
    if (req.session.user.role === "seller") return res.redirect("/seller");
    return res.redirect("/customer");
  }

  res.render("register", {
    checkoutRequired: req.query.checkout === "required",
    referralCode: typeof req.query.ref === "string" && /^[A-Za-z0-9-]{1,32}$/.test(req.query.ref)
      ? req.query.ref.trim().toUpperCase()
      : "",
    googleConfigured: Boolean(
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REDIRECT_URI
    )
  });
});

app.get("/admin", requireLogin, requireRole("admin"), async (req, res) => {
  try {
    const vendorStatusFilter = ["all", "pending", "approved", "rejected"].includes(req.query.vendorStatus)
      ? req.query.vendorStatus
      : "all";
    const [sellerApplications] = await db.execute(
      `SELECT sp.id, sp.business_name, sp.business_website,
              sp.business_description, sp.status, u.name, u.email, u.created_at
       FROM seller_profiles sp
       JOIN users u ON u.id = sp.user_id
       WHERE (? = 'all' OR sp.status = ?)
       ORDER BY u.created_at DESC, sp.id DESC
       LIMIT 100`,
      [vendorStatusFilter, vendorStatusFilter]
    );

    const [auditLogs] = await db.execute(
      `SELECT a.action, a.created_at, u.name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC
       LIMIT 20`
    );

    const payoutStatusFilter = ["all", "pending", "completed", "failed"].includes(req.query.payoutStatus)
      ? req.query.payoutStatus
      : "all";
    const payoutPageSize = 25;
    const requestedPayoutPage = Number.parseInt(req.query.payoutPage, 10);
    const payoutPage = Number.isSafeInteger(requestedPayoutPage) && requestedPayoutPage > 0
      ? requestedPayoutPage
      : 1;
    const payoutFilterSql = `(? = 'all'
        OR (? = 'pending' AND r.status IN ('pending', 'approved'))
        OR (? = 'completed' AND r.status = 'paid')
        OR (? = 'failed' AND r.status = 'rejected'))`;
    const payoutFilterParams = [payoutStatusFilter, payoutStatusFilter, payoutStatusFilter, payoutStatusFilter];
    const [payoutCountRows] = await db.execute(
      `SELECT COUNT(*) AS total_rows
       FROM seller_payout_requests r
       WHERE ${payoutFilterSql}`,
      payoutFilterParams
    );
    const payoutTotalRows = Number(payoutCountRows[0]?.total_rows || 0);
    const payoutTotalPages = Math.max(1, Math.ceil(payoutTotalRows / payoutPageSize));
    const currentPayoutPage = Math.min(payoutPage, payoutTotalPages);
    const [payoutRequests] = await db.execute(
      `SELECT r.id, r.seller_id, r.amount, r.payout_phone, r.status, r.created_at, r.updated_at,
              u.name AS seller_name, u.email AS seller_email,
              sp.business_name,
              MAX(0, COALESCE((SELECT SUM(c.seller_net_amount) FROM commissions c
                               WHERE c.seller_id = r.seller_id AND c.status = 'earned'), 0)
                  - COALESCE((SELECT SUM(pr.amount) FROM seller_payout_requests pr
                              WHERE pr.seller_id = r.seller_id
                                AND pr.status IN ('pending', 'approved', 'paid')), 0)) AS available_balance
       FROM seller_payout_requests r
       JOIN users u ON u.id = r.seller_id
       LEFT JOIN seller_profiles sp ON sp.user_id = r.seller_id
       WHERE ${payoutFilterSql}
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                r.created_at DESC, r.id DESC
       LIMIT ? OFFSET ?`,
      [...payoutFilterParams, payoutPageSize, (currentPayoutPage - 1) * payoutPageSize]
    );
    const [payoutStatsRows] = await db.execute(
      `SELECT
          COALESCE((SELECT SUM(amount) FROM seller_payout_requests
                    WHERE status IN ('pending', 'approved')), 0) AS pending_amount,
          (SELECT COUNT(*) FROM seller_payout_requests
           WHERE status IN ('pending', 'approved')) AS pending_count,
          (SELECT COUNT(*) FROM seller_payout_requests
           WHERE status = 'paid') AS completed_count,
          (SELECT COUNT(*) FROM seller_payout_requests
           WHERE status = 'rejected') AS failed_count,
          (SELECT COUNT(*) FROM seller_payout_requests) AS all_count,
          COALESCE((SELECT SUM(amount) FROM seller_payout_requests
                    WHERE status = 'paid' AND updated_at >= datetime('now', '-30 days')), 0) AS paid_last_30_days,
          COALESCE((SELECT SUM(amount) FROM seller_payout_requests
                    WHERE status = 'paid'), 0) AS paid_all_time,
          MAX(0, COALESCE((SELECT SUM(seller_net_amount) FROM commissions
                           WHERE status = 'earned'), 0)
              - COALESCE((SELECT SUM(amount) FROM seller_payout_requests
                          WHERE status = 'paid'), 0)) AS outstanding_vendor_payments`
    );
    const payoutStats = Object.fromEntries(
      Object.entries(payoutStatsRows[0] || {}).map(([key, value]) => [key, Number(value || 0)])
    );

    const [marketplaceStatsRows] = await db.execute(
      `SELECT
          (SELECT COUNT(*) FROM users WHERE role IN ('buyer', 'customer')) AS customer_count,
          (SELECT COUNT(*) FROM seller_profiles WHERE status = 'approved') AS approved_seller_count,
          (SELECT COUNT(*) FROM seller_profiles WHERE status = 'pending') AS pending_seller_count,
          (SELECT COUNT(*) FROM orders) AS order_count,
          (SELECT COUNT(*) FROM orders o
             WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered')
               AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'successful')) AS paid_order_count,
          (SELECT COALESCE(SUM(o.total), 0) FROM orders o
             WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered')
               AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'successful')) AS gross_revenue,
          (SELECT COALESCE(SUM(o.total), 0) FROM orders o
             WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered')
               AND o.created_at >= datetime('now', '-30 days')
               AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'successful')) AS revenue_last_30_days,
          (SELECT COUNT(*) FROM products WHERE moderation_status = 'approved') AS live_product_count,
          (SELECT COUNT(*) FROM products WHERE moderation_status = 'pending') AS pending_product_count,
          (SELECT COALESCE(SUM(amount), 0) FROM commissions WHERE status = 'earned') AS earned_commission,
          (SELECT COALESCE(SUM(amount), 0) FROM commissions WHERE status = 'pending') AS pending_commission,
          (SELECT COALESCE(SUM(amount), 0) FROM seller_payout_requests
             WHERE status IN ('pending', 'approved')) AS outstanding_payouts,
          (SELECT COUNT(DISTINCT o.id) FROM orders o
             WHERE o.status IN ('paid', 'processing')
               AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'successful')) AS orders_to_dispatch,
          (SELECT COUNT(*) FROM seller_order_fulfillments WHERE status = 'shipped') AS orders_in_transit`
    );
    const [commissionSettingsRows] = await db.execute(
      "SELECT commission_rate, commission_flat_fee FROM marketplace_settings WHERE id = 1"
    );
    const [commissionCategoryRules] = await db.execute(
      `SELECT c.id, c.name, r.id AS rule_id, r.commission_rate, r.flat_fee
       FROM categories c
       LEFT JOIN commission_rules r ON r.rule_type = 'category' AND r.target_id = c.id
       ORDER BY c.name`
    );
    const [commissionSellerRules] = await db.execute(
      `SELECT u.id, u.name, u.email, sp.business_name,
              r.id AS rule_id, r.commission_rate, r.flat_fee
       FROM users u
       LEFT JOIN seller_profiles sp ON sp.user_id = u.id
       LEFT JOIN commission_rules r ON r.rule_type = 'seller' AND r.target_id = u.id
       WHERE u.role = 'seller'
       ORDER BY COALESCE(sp.business_name, u.name)`
    );
    const productModerationFilter = ["pending", "approved", "rejected"].includes(req.query.productStatus)
      ? req.query.productStatus
      : "pending";
    const [moderationProducts] = await db.execute(
      `SELECT p.id, p.name, p.description, p.price, p.stock, p.image,
              p.moderation_status, p.moderation_note, p.created_at,
              c.name AS category_name, u.name AS seller_name, u.email AS seller_email,
              sp.business_name
       FROM products p
       JOIN users u ON u.id = p.seller_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
       WHERE p.moderation_status = ?
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [productModerationFilter]
    );
    const [financialLedger] = await db.execute(
      `SELECT entry_type, entry_id, order_id, seller_name, gross_amount,
              commission_amount, commission_rate, commission_flat_fee,
              seller_net_amount, status, ledger_status, payment_status, payment_method,
              payout_phone, created_at
       FROM (
           SELECT 'commission' AS entry_type, c.id AS entry_id, c.order_id,
                  u.name AS seller_name, c.gross_amount,
                  c.amount AS commission_amount, c.commission_rate,
                  c.commission_flat_fee, c.seller_net_amount,
                  c.status,
                  CASE c.status WHEN 'earned' THEN 'completed' WHEN 'void' THEN 'cancelled' ELSE 'pending' END AS ledger_status,
                  COALESCE((SELECT p.status FROM payments p
                            WHERE p.order_id = c.order_id
                            ORDER BY p.created_at DESC LIMIT 1), 'unpaid') AS payment_status,
                  COALESCE((SELECT p.method FROM payments p
                            WHERE p.order_id = c.order_id
                            ORDER BY p.created_at DESC LIMIT 1), '—') AS payment_method,
                  NULL AS payout_phone, c.created_at
           FROM commissions c
           JOIN users u ON u.id = c.seller_id
           WHERE c.order_item_id IS NOT NULL
           UNION ALL
           SELECT 'payout' AS entry_type, r.id AS entry_id, NULL AS order_id,
                  u.name AS seller_name, NULL AS gross_amount,
                  NULL AS commission_amount, NULL AS commission_rate,
                  NULL AS commission_flat_fee, r.amount AS seller_net_amount,
                  r.status,
                  CASE r.status WHEN 'paid' THEN 'completed' WHEN 'rejected' THEN 'cancelled' ELSE 'pending' END AS ledger_status,
                  NULL AS payment_status, 'Payout' AS payment_method, r.payout_phone, r.created_at
           FROM seller_payout_requests r
           JOIN users u ON u.id = r.seller_id
       ) ledger
       ORDER BY created_at DESC
       LIMIT 150`
    );
    const [financialLedgerStatsRows] = await db.execute(
      `SELECT
          COALESCE((SELECT SUM(amount) FROM commissions WHERE status = 'earned'), 0) AS platform_earnings,
          (SELECT COUNT(*) FROM commissions WHERE status = 'earned')
            + (SELECT COUNT(*) FROM seller_payout_requests WHERE status = 'paid') AS completed_count,
          (SELECT COUNT(*) FROM commissions WHERE status = 'pending')
            + (SELECT COUNT(*) FROM seller_payout_requests WHERE status IN ('pending', 'approved')) AS pending_count,
          (SELECT COUNT(*) FROM commissions WHERE status = 'void')
            + (SELECT COUNT(*) FROM seller_payout_requests WHERE status = 'rejected') AS cancelled_count`
    );
    const logisticsStatus = ["all", "pending", "paid", "processing", "shipped", "delivered", "cancelled", "delayed", "issues"]
      .includes(req.query.deliveryStatus)
      ? req.query.deliveryStatus
      : "all";
    const deliveryPageSize = 25;
    const requestedDeliveryPage = Number.parseInt(req.query.deliveryPage, 10);
    const deliveryPage = Number.isSafeInteger(requestedDeliveryPage) && requestedDeliveryPage > 0
      ? requestedDeliveryPage
      : 1;
    const deliveryFilterSql = `(? = 'all' OR o.status = ?
          OR (? = 'delayed' AND o.status NOT IN ('delivered', 'cancelled')
              AND julianday('now') - julianday(COALESCE(f.updated_at, o.created_at)) >= 7)
          OR (? = 'issues' AND ((dc.id IS NOT NULL AND dc.status != 'resolved') OR o.status = 'cancelled'
              OR EXISTS (SELECT 1 FROM payments failed_payment
                         WHERE failed_payment.order_id = o.id AND failed_payment.status = 'failed'))))`;
    const deliveryFilterParams = [logisticsStatus, logisticsStatus, logisticsStatus, logisticsStatus];
    const [deliveryCountRows] = await db.execute(
      `SELECT COUNT(*) AS total_rows
       FROM (
           SELECT o.id, oi.seller_id
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           LEFT JOIN seller_order_fulfillments f
             ON f.order_id = o.id AND f.seller_id = oi.seller_id
           LEFT JOIN delivery_complaints dc
             ON dc.order_id = o.id AND dc.seller_id = oi.seller_id
           WHERE ${deliveryFilterSql}
           GROUP BY o.id, oi.seller_id
       ) delivery_rows`,
      deliveryFilterParams
    );
    const deliveryTotalRows = Number(deliveryCountRows[0]?.total_rows || 0);
    const deliveryTotalPages = Math.max(1, Math.ceil(deliveryTotalRows / deliveryPageSize));
    const currentDeliveryPage = Math.min(deliveryPage, deliveryTotalPages);
    const [deliveryMonitor] = await db.execute(
      `SELECT o.id AS order_id, o.status AS order_status, o.total, o.created_at,
              o.shipping_address, o.shipping_city, o.shipping_region,
              o.shipping_postal_code, o.recipient_phone,
              COALESCE(o.recipient_name, c.name) AS customer_name,
              (SELECT p.method FROM payments p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1) AS payment_method,
              (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1) AS payment_status,
              oi.seller_id, COALESCE(sp.business_name, s.name) AS business_name,
              GROUP_CONCAT(DISTINCT p.name) AS product_names,
              COALESCE(f.status, 'pending') AS fulfillment_status,
              f.tracking_number, f.updated_at AS fulfillment_updated_at,
              dc.id AS complaint_id, dc.complaint, dc.status AS complaint_status,
              dc.follow_up_note, dc.created_at AS complaint_created_at,
              CASE WHEN o.status NOT IN ('delivered', 'cancelled')
                         AND julianday('now') - julianday(COALESCE(f.updated_at, o.created_at)) >= 7
                   THEN 1 ELSE 0 END AS is_delayed,
              CASE WHEN o.status = 'cancelled'
                         OR (dc.id IS NOT NULL AND dc.status != 'resolved')
                         OR EXISTS (SELECT 1 FROM payments failed_payment
                                    WHERE failed_payment.order_id = o.id AND failed_payment.status = 'failed')
                   THEN 1 ELSE 0 END AS has_delivery_issue
       FROM orders o
       JOIN users c ON c.id = o.customer_id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p ON p.id = oi.product_id
       JOIN users s ON s.id = oi.seller_id
       LEFT JOIN seller_profiles sp ON sp.user_id = s.id
       LEFT JOIN seller_order_fulfillments f
         ON f.order_id = o.id AND f.seller_id = oi.seller_id
       LEFT JOIN delivery_complaints dc
         ON dc.order_id = o.id AND dc.seller_id = oi.seller_id
       WHERE ${deliveryFilterSql}
       GROUP BY o.id, o.status, o.total, o.created_at, o.shipping_address,
                o.shipping_city, o.shipping_region, o.shipping_postal_code,
                o.recipient_phone, o.recipient_name, c.name, oi.seller_id, sp.business_name,
                s.name, f.status, f.tracking_number, f.updated_at,
                dc.id, dc.complaint, dc.status, dc.follow_up_note, dc.created_at
       ORDER BY CASE o.status
                  WHEN 'pending' THEN 0 WHEN 'paid' THEN 1
                  WHEN 'processing' THEN 2 WHEN 'shipped' THEN 3 ELSE 4
                END,
                o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...deliveryFilterParams, deliveryPageSize, (currentDeliveryPage - 1) * deliveryPageSize]
    );
    const [deliveryStatsRows] = await db.execute(
      `SELECT
          (SELECT COUNT(*) FROM orders WHERE status IN ('pending', 'paid', 'processing')) AS pending_count,
          (SELECT COUNT(*) FROM orders WHERE status = 'shipped') AS dispatched_count,
          (SELECT COUNT(*) FROM orders WHERE status = 'delivered') AS delivered_count,
          (SELECT COUNT(*) FROM (
             SELECT o.id, oi.seller_id
             FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN seller_order_fulfillments f
               ON f.order_id = o.id AND f.seller_id = oi.seller_id
             WHERE o.status NOT IN ('delivered', 'cancelled')
               AND julianday('now') - julianday(COALESCE(f.updated_at, o.created_at)) >= 7
             GROUP BY o.id, oi.seller_id
          )) AS delayed_count,
          (SELECT COUNT(*) FROM delivery_complaints WHERE status != 'resolved') AS open_complaint_count`
    );
    const deliveryStats = Object.fromEntries(
      Object.entries(deliveryStatsRows[0] || {}).map(([key, value]) => [key, Number(value || 0)])
    );
    const [analyticsTrend] = await db.execute(
      `SELECT strftime('%Y-%m', created_at) AS month,
              COUNT(*) AS order_count, SUM(total) AS gross_revenue
       FROM orders o
       WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered')
         AND o.created_at >= datetime('now', '-6 months')
         AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'successful')
       GROUP BY strftime('%Y-%m', o.created_at)
       ORDER BY month DESC`
    );
    const [refundRequests] = await db.execute(
      `SELECT r.id, r.order_id, r.customer_id, r.reason, r.status, r.admin_note,
              r.seller_response, r.evidence_key,
              r.created_at, r.updated_at, u.name AS customer_name, u.email AS customer_email,
              o.total AS order_total
       FROM refund_requests r
       JOIN users u ON u.id = r.customer_id
       JOIN orders o ON o.id = r.order_id
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                r.created_at DESC
       LIMIT 100`
    );
    const [sellerReviewReports] = await db.execute(
      `SELECT r.id, r.reason, r.status, r.created_at, u.name AS seller_name,
              p.name AS product_name, rv.rating, rv.comment, c.name AS customer_name
       FROM seller_review_reports r
       JOIN users u ON u.id = r.seller_id
       JOIN reviews rv ON rv.id = r.review_id
       JOIN products p ON p.id = rv.product_id
       JOIN users c ON c.id = rv.customer_id
       ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC
       LIMIT 100`
    );
    const [sellerOrderRejections] = await db.execute(
      `SELECT d.order_id, d.seller_id, d.note AS rejection_reason,
              d.admin_adjustment_status, d.admin_note, d.updated_at,
              s.name AS seller_name, c.name AS customer_name, c.email AS customer_email,
              GROUP_CONCAT(p.name, ', ') AS rejected_products,
              SUM(oi.quantity * oi.price) AS item_amount
       FROM seller_order_decisions d
       JOIN orders o ON o.id = d.order_id
       JOIN users s ON s.id = d.seller_id
       JOIN users c ON c.id = o.customer_id
       JOIN order_items oi ON oi.order_id = d.order_id AND oi.seller_id = d.seller_id
       JOIN products p ON p.id = oi.product_id
       WHERE d.status = 'rejected'
       GROUP BY d.order_id, d.seller_id, d.note, d.admin_adjustment_status, d.admin_note,
                d.updated_at, s.name, c.name, c.email
       ORDER BY CASE d.admin_adjustment_status WHEN 'pending' THEN 0 ELSE 1 END, d.updated_at DESC
       LIMIT 100`
    );

    res.render("admin/dashboard", {
      user: req.session.user,
      sellerApplications,
      vendorStatusFilter,
      auditLogs,
      payoutRequests,
      payoutUpdated: req.query.payout === "updated",
      payoutStatusFilter,
      payoutStats,
      payoutTotalRows,
      payoutTotalPages,
      currentPayoutPage,
      codPaymentRecorded: req.query.codPayment === "recorded",
      marketplaceStats: Object.fromEntries(
        Object.entries(marketplaceStatsRows[0] || {}).map(([key, value]) => [key, Number(value || 0)])
      ),
      commissionRate: Number(commissionSettingsRows[0]?.commission_rate ?? 10),
      commissionFlatFee: Number(commissionSettingsRows[0]?.commission_flat_fee ?? 0),
      commissionCategoryRules,
      commissionSellerRules,
      commissionUpdated: req.query.commission === "updated",
      moderationProducts,
      productModerationFilter,
      productModerationUpdated: ["updated", "bulk-updated"].includes(req.query.productModeration),
      financialLedger,
      financialLedgerStats: Object.fromEntries(
        Object.entries(financialLedgerStatsRows[0] || {}).map(([key, value]) => [key, Number(value || 0)])
      ),
      deliveryMonitor,
      logisticsStatus,
      deliveryStats,
      deliveryTotalRows,
      deliveryTotalPages,
      currentDeliveryPage,
      deliveryComplaintUpdated: req.query.deliveryComplaint === "updated",
      refundRequests,
      refundUpdated: req.query.refund === "updated",
      sellerReviewReports,
      sellerReviewReportUpdated: req.query.reviewReport === "updated",
      sellerOrderRejections,
      sellerOrderRejectionUpdated: req.query.sellerOrderRejection === "updated",
      analyticsTrend,
      backupFile: typeof req.query.backup === "string" &&
        /^marketplace-\d{8}T\d{6}Z-[a-f0-9]{8}\.sqlite$/.test(req.query.backup)
        ? req.query.backup
        : null
    });
  } catch (error) {
    console.error("Admin dashboard load error:", error.message);
    res.status(500).send("Could not load the admin dashboard.");
  }
});

app.post("/admin/refunds/:id/status", requireLogin, requireRole("admin"), async (req, res) => {
  const requestId = Number(req.params.id);
  const status = req.body?.status;
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!Number.isSafeInteger(requestId) || requestId <= 0 ||
      !["approved", "rejected", "refunded"].includes(status)) {
    return res.status(400).send("Choose a valid refund request action.");
  }
  if (note.length > 500 || /[\u0000-\u0008\u000b\u000c-\u001f\u007f]/.test(note)) {
    return res.status(400).send("Refund notes must be 500 characters or fewer.");
  }
  if (!note) {
    return res.status(400).send("Add a review note before updating the refund request.");
  }

  try {
    const allowedPreviousStatuses = status === "refunded" ? ["approved"] : ["pending"];
    const placeholders = allowedPreviousStatuses.map(() => "?").join(", ");
    const [result] = await db.execute(
      `UPDATE refund_requests
       SET status = ?, admin_note = ?, reviewed_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN (${placeholders})`,
      [status, note || null, req.session.user.id, requestId, ...allowedPreviousStatuses]
    );
    if (result.rowsAffected === 0) {
      return res.status(409).send("This refund request has already changed. Refresh the dashboard and try again.");
    }
    await recordAuditEvent(req.session.user.id, `refund_request:${requestId}:${status}`);
    return res.redirect("/admin?refund=updated#refund-requests");
  } catch (error) {
    console.error("Refund review error:", error.message);
    return res.status(500).send("Could not update the refund request.");
  }
});

app.post("/admin/review-reports/:id/status", requireLogin, requireRole("admin"), async (req, res) => {
  const reportId = Number(req.params.id);
  const status = req.body?.status;
  if (!Number.isSafeInteger(reportId) || reportId <= 0 ||
      !["reviewed", "dismissed"].includes(status)) {
    return res.status(400).send("Choose a valid seller review report action.");
  }
  try {
    const [result] = await db.execute(
      `UPDATE seller_review_reports
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [status, reportId]
    );
    if (!result.rowsAffected) return res.status(409).send("This report has already been reviewed.");
    await recordAuditEvent(req.session.user.id, `seller_review_report_${status}:${reportId}`);
    return res.redirect("/admin?reviewReport=updated#seller-review-reports");
  } catch (error) {
    console.error("Seller review report moderation error:", error.message);
    return res.status(500).send("Could not update the seller review report.");
  }
});

app.post("/admin/seller-order-rejections/:orderId/:sellerId/status", requireLogin, requireRole("admin"), async (req, res) => {
  const orderId = Number(req.params.orderId);
  const sellerId = Number(req.params.sellerId);
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!Number.isSafeInteger(orderId) || orderId <= 0 ||
      !Number.isSafeInteger(sellerId) || sellerId <= 0 ||
      !note || note.length > 500 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
    return res.status(400).send("Record the admin’s payment-adjustment action in a note of up to 500 characters.");
  }
  try {
    const [result] = await db.execute(
      `UPDATE seller_order_decisions
       SET admin_adjustment_status = 'handled', admin_note = ?, reviewed_by = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE order_id = ? AND seller_id = ? AND status = 'rejected'
         AND admin_adjustment_status = 'pending'`,
      [note, req.session.user.id, orderId, sellerId]
    );
    if (!result.rowsAffected) return res.status(409).send("This seller order rejection is already handled.");
    await recordAuditEvent(req.session.user.id, `seller_order_rejection_handled:${orderId}:${sellerId}`);
    return res.redirect("/admin?sellerOrderRejection=updated#seller-order-rejections");
  } catch (error) {
    console.error("Seller order rejection review error:", error.message);
    return res.status(500).send("Could not save the payment-adjustment note.");
  }
});

app.post("/admin/sellers/:id/approve", requireLogin, requireRole("admin"), async (req, res) => {
  try {
    const sellerId = Number(req.params.id);
    if (!Number.isInteger(sellerId) || sellerId <= 0) {
      return res.status(400).send("Invalid seller request.");
    }

    const [result] = await db.execute(
      "UPDATE seller_profiles SET status = ? WHERE id = ?",
      ["approved", sellerId]
    );
    if (result.rowsAffected === 0) {
      return res.status(404).send("Seller application not found.");
    }
    await recordAuditEvent(req.session.user.id, `seller_application_approved:${sellerId}`);
    return res.redirect("/admin");
  } catch (error) {
    console.error("Approve seller error:", error.message);
    return res.status(500).send("Could not approve seller.");
  }
});

app.post("/admin/sellers/:id/reject", requireLogin, requireRole("admin"), async (req, res) => {
  try {
    const sellerId = Number(req.params.id);
    if (!Number.isInteger(sellerId) || sellerId <= 0) {
      return res.status(400).send("Invalid seller request.");
    }

    const [result] = await db.execute(
      "UPDATE seller_profiles SET status = ? WHERE id = ?",
      ["rejected", sellerId]
    );
    if (result.rowsAffected === 0) {
      return res.status(404).send("Seller application not found.");
    }
    await recordAuditEvent(req.session.user.id, `seller_application_rejected:${sellerId}`);
    return res.redirect("/admin");
  } catch (error) {
    console.error("Reject seller error:", error.message);
    return res.status(500).send("Could not reject seller.");
  }
});

app.post("/admin/products/:id/moderation", requireLogin, requireRole("admin"), async (req, res) => {
  const productId = Number(req.params.id);
  const status = req.body?.status;
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).send("Invalid product.");
  }
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).send("Choose approve or reject.");
  }
  if (note.length > 500 || /[\u0000-\u0008\u000b\u000c-\u001f\u007f]/.test(note)) {
    return res.status(400).send("Moderation notes must be 500 characters or fewer.");
  }
  if (status === "rejected" && !note) {
    return res.status(400).send("Give the seller a reason for rejecting this listing.");
  }

  try {
    const [result] = await db.execute(
      `UPDATE products
       SET moderation_status = ?, moderation_note = ?
       WHERE id = ?`,
      [status, status === "rejected" ? (note || null) : null, productId]
    );
    if (result.rowsAffected === 0) {
      return res.status(404).send("Product not found.");
    }
    await recordAuditEvent(req.session.user.id, `product_moderation:${productId}:${status}`);
    return res.redirect("/admin?productStatus=pending&productModeration=updated#product-moderation");
  } catch (error) {
    console.error("Product moderation error:", error.message);
    return res.status(500).send("Could not update product moderation.");
  }
});

app.post("/admin/products/moderation/bulk-approve", requireLogin, requireRole("admin"), async (req, res) => {
  const rawIds = Array.isArray(req.body?.productIds)
    ? req.body.productIds
    : typeof req.body?.productIds === "string"
      ? [req.body.productIds]
      : [];
  const productIds = [...new Set(rawIds.map((value) => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return NaN;
    return Number(value);
  }))];
  if (!productIds.length || productIds.length > 100 || productIds.some((id) => !Number.isSafeInteger(id))) {
    return res.status(400).send("Select between 1 and 100 valid products to approve.");
  }

  try {
    const placeholders = productIds.map(() => "?").join(", ");
    await db.transaction(async (connection) => {
      const [selectedProducts] = await connection.execute(
        `SELECT id FROM products
         WHERE id IN (${placeholders}) AND moderation_status != 'approved'`,
        productIds
      );
      if (selectedProducts.length !== productIds.length) {
        const conflict = new Error("One or more selected products could not be approved. Refresh the list and try again.");
        conflict.statusCode = 409;
        throw conflict;
      }
      const [result] = await connection.execute(
        `UPDATE products
         SET moderation_status = 'approved', moderation_note = NULL
         WHERE id IN (${placeholders}) AND moderation_status != 'approved'`,
        productIds
      );
      if (result.rowsAffected !== productIds.length) {
        throw new Error("Bulk product approval did not update all selected products.");
      }
    });
    for (const productId of productIds) {
      await recordAuditEvent(req.session.user.id, `product_moderation:${productId}:approved`);
    }
    return res.redirect("/admin?productStatus=pending&productModeration=bulk-updated#product-moderation");
  } catch (error) {
    if (error.statusCode === 409) {
      return res.status(409).send(error.message);
    }
    console.error("Bulk product moderation error:", error.message);
    return res.status(500).send("Could not approve the selected products.");
  }
});

app.post("/admin/commission-rules", requireLogin, requireRole("admin"), async (req, res) => {
  const rawRate = req.body?.commissionRate;
  const rateText = typeof rawRate === "string" ? rawRate.trim() : "";
  const commissionRate = Number(rateText);
  const rawFlatFee = req.body?.flatFee;
  const flatFeeText = typeof rawFlatFee === "string" ? rawFlatFee.trim() : "";
  const flatFee = Number(flatFeeText);
  if (
    !/^(?:\d{1,2})(?:\.\d{1,2})?$/.test(rateText) ||
    !Number.isFinite(commissionRate) || commissionRate > 50 ||
    !/^(?:\d{1,8})(?:\.\d{1,2})?$/.test(flatFeeText) ||
    !Number.isFinite(flatFee) || flatFee < 0
  ) {
    return res.status(400).send("Enter a commission percentage from 0% to 50% and a non-negative flat fee with up to two decimal places.");
  }

  try {
    await db.execute(
      `INSERT INTO marketplace_settings (id, commission_rate, commission_flat_fee, updated_at)
       VALUES (1, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
           commission_rate = excluded.commission_rate,
           commission_flat_fee = excluded.commission_flat_fee,
           updated_at = CURRENT_TIMESTAMP`,
      [commissionRate, flatFee]
    );
    await recordAuditEvent(
      req.session.user.id,
      `marketplace_commission_rule_updated:${commissionRate}%+${flatFee}`
    );
    return res.redirect("/admin?commission=updated#commission-rules");
  } catch (error) {
    console.error("Commission rule update error:", error.message);
    return res.status(500).send("Could not update commission rules.");
  }
});

app.post("/admin/commission-rules/overrides", requireLogin, requireRole("admin"), async (req, res) => {
  const targetKey = typeof req.body?.targetKey === "string" ? req.body.targetKey : "";
  const targetMatch = /^(category|seller):([1-9]\d*)$/.exec(targetKey);
  const ruleType = targetMatch?.[1];
  const targetId = Number(targetMatch?.[2]);
  const rateText = typeof req.body?.commissionRate === "string" ? req.body.commissionRate.trim() : "";
  const flatFeeText = typeof req.body?.flatFee === "string" ? req.body.flatFee.trim() : "";
  const commissionRate = Number(rateText);
  const flatFee = Number(flatFeeText);

  if (
    !ruleType ||
    !Number.isInteger(targetId) || targetId <= 0 ||
    !/^(?:\d{1,2})(?:\.\d{1,2})?$/.test(rateText) ||
    !Number.isFinite(commissionRate) || commissionRate > 50 ||
    !/^(?:\d{1,8})(?:\.\d{1,2})?$/.test(flatFeeText) ||
    !Number.isFinite(flatFee) || flatFee < 0
  ) {
    return res.status(400).send("Provide a valid category or seller and commission amounts.");
  }

  try {
    const targetTable = ruleType === "category" ? "categories" : "users";
    const targetWhere = ruleType === "seller" ? "id = ? AND role = 'seller'" : "id = ?";
    const [targets] = await db.execute(
      `SELECT id FROM ${targetTable} WHERE ${targetWhere}`,
      [targetId]
    );
    if (targets.length === 0) {
      return res.status(400).send(`The selected ${ruleType} does not exist.`);
    }

    await db.execute(
      `INSERT INTO commission_rules
          (rule_type, target_id, commission_rate, flat_fee, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(rule_type, target_id) DO UPDATE SET
           commission_rate = excluded.commission_rate,
           flat_fee = excluded.flat_fee,
           updated_at = CURRENT_TIMESTAMP`,
      [ruleType, targetId, commissionRate, flatFee]
    );
    await recordAuditEvent(
      req.session.user.id,
      `commission_override_updated:${ruleType}:${targetId}:${commissionRate}%+${flatFee}`
    );
    return res.redirect("/admin?commission=updated#commission-rules");
  } catch (error) {
    console.error("Commission override update error:", error.message);
    return res.status(500).send("Could not save the commission override.");
  }
});

app.post("/admin/commission-rules/overrides/:id/delete", requireLogin, requireRole("admin"), async (req, res) => {
  const ruleId = Number(req.params.id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return res.status(400).send("Invalid commission override.");
  }

  try {
    const [result] = await db.execute("DELETE FROM commission_rules WHERE id = ?", [ruleId]);
    if (result.rowsAffected === 0) {
      return res.status(404).send("Commission override not found.");
    }
    await recordAuditEvent(req.session.user.id, `commission_override_deleted:${ruleId}`);
    return res.redirect("/admin?commission=updated#commission-rules");
  } catch (error) {
    console.error("Commission override removal error:", error.message);
    return res.status(500).send("Could not remove the commission override.");
  }
});

app.post("/admin/payouts/:id/status", requireLogin, requireRole("admin"), sellerHubController.reviewPayoutRequest);
app.post("/admin/backups", requireLogin, requireRole("admin"), async (req, res, next) => {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const fileName = `marketplace-${timestamp}-${crypto.randomBytes(4).toString("hex")}.sqlite`;
  const destination = path.join(backupDirectory, fileName);

  try {
    await fs.mkdir(backupDirectory, { recursive: true });
    await db.backup(destination);
    await recordAuditEvent(req.session.user.id, `database_backup_created:${fileName}`);
    return res.redirect(`/admin?backup=${encodeURIComponent(fileName)}`);
  } catch (error) {
    console.error("Database backup error:", error.message);
    await fs.unlink(destination).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") {
        console.error("Failed backup cleanup error:", cleanupError.message);
      }
    });
    return next(error);
  }
});

app.get("/admin/backups/:filename", requireLogin, requireRole("admin"), (req, res, next) => {
  if (!/^marketplace-\d{8}T\d{6}Z-[a-f0-9]{8}\.sqlite$/.test(req.params.filename)) {
    return res.status(400).send("Invalid backup file.");
  }

  const destination = path.join(backupDirectory, req.params.filename);
  res.set("Cache-Control", "private, no-store");
  return res.download(destination, req.params.filename, (error) => {
    if (!error) return;
    if (error.code === "ENOENT") return res.status(404).send("Backup file not found.");
    return next(error);
  });
});

app.get("/buyer", requireLogin, requireRole("customer"), orderController.getCustomerDashboard);
app.get("/customer", requireLogin, requireRole("customer"), orderController.getCustomerDashboard);
app.post("/customer/orders/:id/cancel", requireLogin, requireRole("customer"), orderController.cancelCustomerOrder);
app.post("/customer/orders/:id/refunds", requireLogin, requireRole("customer"), orderController.requestRefund);
app.post("/customer/profile", requireLogin, requireRole("customer"), customerController.updateCustomerProfile);
app.post("/customer/wishlist/:productId", requireLogin, requireRole("customer"), customerController.addWishlistItem);
app.post("/customer/wishlist/:productId/remove", requireLogin, requireRole("customer"), customerController.removeWishlistItem);
app.post("/customer/wishlist/:productId/cart", requireLogin, requireRole("customer"), customerController.moveWishlistItemToCart);
app.post("/customer/wishlist/:productId/alerts", requireLogin, requireRole("customer"), customerEngagementController.updateWishlistAlerts);
app.post("/customer/sellers/:sellerId/follow", requireLogin, requireRole("customer"), customerEngagementController.followSeller);
app.post("/customer/sellers/:sellerId/unfollow", requireLogin, requireRole("customer"), customerEngagementController.unfollowSeller);
app.post("/customer/preferences", requireLogin, requireRole("customer"), customerEngagementController.updatePreferences);
app.post("/customer/collections", requireLogin, requireRole("customer"), customerEngagementController.createCollection);
app.post("/customer/collections/:collectionId/delete", requireLogin, requireRole("customer"), customerEngagementController.deleteCollection);
app.post("/customer/collections/items", requireLogin, requireRole("customer"), customerEngagementController.addCollectionItem);
app.post("/customer/collections/:collectionId/products/:productId", requireLogin, requireRole("customer"), customerEngagementController.addCollectionItem);
app.post("/customer/collections/:collectionId/products/:productId/remove", requireLogin, requireRole("customer"), customerEngagementController.removeCollectionItem);
app.post("/customer/orders/:id/messages", requireLogin, requireRole("customer"), customerController.sendOrderMessage);
app.post("/customer/products/:productId/reviews", requireLogin, requireRole("customer"), customerController.submitReview);
app.post("/customer/products/:productId/reviews/update", requireLogin, requireRole("customer"), customerController.updateReview);
app.get("/manager", requireLogin, requireRole("admin"), managerController.getManagerDashboard);
app.post("/manager/orders/:id/status", requireLogin, requireRole("admin"), managerController.updateOrderStatus);
app.post("/admin/orders/:id/record-cod-payment", requireLogin, requireRole("admin"), managerController.recordCashOnDeliveryPayment);
app.post("/admin/orders/:id/delivery-complaint", requireLogin, requireRole("admin"), async (req, res) => {
  const orderId = Number(req.params.id);
  const sellerIdText = typeof req.body?.sellerId === "string" ? req.body.sellerId : "";
  const sellerId = Number(sellerIdText);
  const action = req.body?.action;
  const complaint = typeof req.body?.complaint === "string" ? req.body.complaint.trim() : "";
  const followUpNote = typeof req.body?.followUpNote === "string" ? req.body.followUpNote.trim() : "";
  const status = req.body?.status;
  const deliveryStatus = ["all", "pending", "paid", "processing", "shipped", "delivered", "cancelled", "delayed", "issues"]
    .includes(req.body?.deliveryStatus)
    ? req.body.deliveryStatus
    : "all";
  const requestedPage = Number.parseInt(req.body?.deliveryPage, 10);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const redirectUrl = `/admin?deliveryStatus=${encodeURIComponent(deliveryStatus)}&deliveryPage=${page}&deliveryComplaint=updated#delivery-monitor`;

  if (!Number.isSafeInteger(orderId) || orderId <= 0 || !Number.isSafeInteger(sellerId) || sellerId <= 0) {
    return res.status(400).send("Select a valid order and seller shipment.");
  }
  if (!["log", "update"].includes(action)) {
    return res.status(400).send("Choose whether to log a complaint or update its follow-up.");
  }
  if (action === "log" && (!complaint || complaint.length > 2000)) {
    return res.status(400).send("Enter a complaint summary of 1–2,000 characters.");
  }
  if (action === "update" && (!["open", "investigating", "resolved"].includes(status) || followUpNote.length > 1000)) {
    return res.status(400).send("Choose a valid complaint status and keep follow-up notes under 1,000 characters.");
  }
  if (/[\u0000-\u0008\u000b\u000c-\u001f\u007f]/.test(complaint + followUpNote)) {
    return res.status(400).send("Complaint and follow-up notes contain unsupported control characters.");
  }

  try {
    const [shipments] = await db.execute(
      `SELECT o.customer_id FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = ? AND oi.seller_id = ?
       LIMIT 1`,
      [orderId, sellerId]
    );
    if (!shipments.length) {
      return res.status(404).send("Order shipment not found.");
    }

    if (action === "log") {
      await db.execute(
        `INSERT INTO delivery_complaints (order_id, seller_id, customer_id, complaint)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(order_id, seller_id) DO UPDATE SET
           customer_id = excluded.customer_id,
           complaint = excluded.complaint,
           status = 'open',
           follow_up_note = NULL,
           updated_at = CURRENT_TIMESTAMP`,
        [orderId, sellerId, shipments[0].customer_id, complaint]
      );
    } else {
      const [result] = await db.execute(
        `UPDATE delivery_complaints
         SET status = ?, follow_up_note = ?, updated_at = CURRENT_TIMESTAMP
         WHERE order_id = ? AND seller_id = ?`,
        [status, followUpNote || null, orderId, sellerId]
      );
      if (result.rowsAffected === 0) {
        return res.status(404).send("Delivery complaint not found. Log it before adding follow-up.");
      }
    }
    await recordAuditEvent(req.session.user.id, `delivery_complaint:${orderId}:${sellerId}:${action}`);
    return res.redirect(redirectUrl);
  } catch (error) {
    console.error("Delivery complaint update error:", error.message);
    return res.status(500).send("Could not save the delivery complaint update.");
  }
});
app.post("/seller/messages", requireLogin, requireRole("seller"), customerController.replyToSellerMessage);
app.post("/seller/orders/:id/fulfillment", requireLogin, requireRole("seller"), sellerHubController.updateFulfillment);
app.post("/seller/orders/:id/decision", requireLogin, requireRole("seller"), sellerHubController.updateOrderDecision);
app.post("/seller/refunds/:id/response", requireLogin, requireRole("seller"), refundEvidenceUpload.single, csrfProtection, sellerHubController.respondToRefund);
app.get("/seller/refunds/:id/evidence", requireLogin, requireRole("seller"), sellerHubController.downloadRefundEvidence);
app.get("/admin/refunds/:id/evidence", requireLogin, requireRole("admin"), sellerHubController.downloadRefundEvidence);
app.post("/seller/reviews/:id/respond", requireLogin, requireRole("seller"), sellerHubController.respondToReview);
app.post("/seller/reviews/:id/report", requireLogin, requireRole("seller"), sellerHubController.reportReview);
app.post("/seller/payouts", requireLogin, requireRole("seller"), sellerHubController.requestPayout);

app.post("/seller/business-website", requireLogin, requireRole("seller"), async (req, res) => {
  let businessWebsite;
  try {
    businessWebsite = normalizeBusinessWebsite(req.body?.businessWebsite);
  } catch (error) {
    return res.status(400).send(error.message);
  }

  try {
    const [result] = await db.execute(
      "UPDATE seller_profiles SET business_website = ? WHERE user_id = ?",
      [businessWebsite, req.session.user.id]
    );
    if (result.rowsAffected === 0) {
      return res.status(404).send("Seller business profile not found.");
    }

    await recordAuditEvent(req.session.user.id, "seller_business_website_updated");
    return res.redirect("/seller?website=updated");
  } catch (error) {
    console.error("Seller business website update error:", error.message);
    return res.status(500).send("Could not update your business website.");
  }
});

app.get("/seller", requireLogin, requireRole("seller"), async (req, res) => {
  try {
    const [products] = await db.execute(
      `SELECT p.*, c.name AS category_name,
              (SELECT COALESCE(SUM(oi.quantity), 0)
               FROM order_items oi JOIN orders o ON o.id = oi.order_id
               LEFT JOIN seller_order_decisions sd
                 ON sd.order_id = o.id AND sd.seller_id = oi.seller_id
               WHERE oi.product_id = p.id AND oi.seller_id = p.seller_id
                 AND oi.promotion_discount_percent > 0
                 AND COALESCE(sd.status, 'accepted') != 'rejected'
                 AND o.status IN ('paid', 'processing', 'shipped', 'delivered')
                 AND EXISTS (SELECT 1 FROM payments pay
                             WHERE pay.order_id = o.id AND pay.status = 'successful')) AS promotion_units_sold,
              (SELECT COALESCE(SUM(oi.quantity * oi.price), 0)
               FROM order_items oi JOIN orders o ON o.id = oi.order_id
               LEFT JOIN seller_order_decisions sd
                 ON sd.order_id = o.id AND sd.seller_id = oi.seller_id
               WHERE oi.product_id = p.id AND oi.seller_id = p.seller_id
                 AND oi.promotion_discount_percent > 0
                 AND COALESCE(sd.status, 'accepted') != 'rejected'
                 AND o.status IN ('paid', 'processing', 'shipped', 'delivered')
                 AND EXISTS (SELECT 1 FROM payments pay
                             WHERE pay.order_id = o.id AND pay.status = 'successful')) AS promotion_gross_sales
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.seller_id = ?
       ORDER BY p.created_at DESC`,
      [req.session.user.id]
    );

    const [categories] = await db.execute("SELECT id, name FROM categories ORDER BY name ASC");
    const [sellerProfiles] = await db.execute(
      `SELECT business_name, business_website, business_description, business_logo, status
       FROM seller_profiles WHERE user_id = ?`,
      [req.session.user.id]
    );
    const [sellerAccountRows] = await db.execute(
      "SELECT email_verified FROM users WHERE id = ?",
      [req.session.user.id]
    );
    const [todayOverviewRows] = await db.execute(
      `SELECT COUNT(DISTINCT o.id) AS orders,
              COALESCE(SUM(oi.quantity * oi.price), 0) AS sales,
              COALESCE(SUM(CASE WHEN cm.status = 'earned' THEN cm.seller_net_amount ELSE 0 END), 0) AS net_earnings
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN commissions cm ON cm.order_item_id = oi.id
       LEFT JOIN seller_order_decisions sd
         ON sd.order_id = o.id AND sd.seller_id = oi.seller_id
       WHERE oi.seller_id = ?
         AND COALESCE(sd.status, 'accepted') != 'rejected'
         AND date(o.created_at, '+3 hours') = date('now', '+3 hours')
         AND o.status IN ('paid', 'processing', 'shipped', 'delivered')
         AND EXISTS (
           SELECT 1 FROM payments p
           WHERE p.order_id = o.id AND p.status = 'successful'
         )`,
      [req.session.user.id]
    );
    const [sellerAnalyticsRows] = await db.execute(
      `SELECT COUNT(DISTINCT CASE
                  WHEN o.status IN ('paid', 'processing', 'shipped', 'delivered') THEN o.id
              END) AS completed_orders,
              COALESCE(SUM(CASE
                  WHEN o.status IN ('paid', 'processing', 'shipped', 'delivered')
                  THEN oi.quantity * oi.price ELSE 0
              END), 0) AS gross_revenue,
              COALESCE(SUM(CASE
                  WHEN o.status IN ('paid', 'processing', 'shipped', 'delivered')
                   AND o.created_at >= datetime('now', '-30 days')
                  THEN oi.quantity * oi.price ELSE 0
              END), 0) AS revenue_last_30_days,
              COALESCE(SUM(CASE
                  WHEN o.status IN ('paid', 'processing', 'shipped', 'delivered')
                   AND o.created_at >= datetime('now', '-30 days')
                  THEN oi.quantity ELSE 0
              END), 0) AS units_last_30_days,
              COALESCE(SUM(CASE
                  WHEN o.status IN ('paid', 'processing', 'shipped', 'delivered')
                   AND o.created_at >= datetime('now', '-7 days')
                  THEN oi.quantity * oi.price ELSE 0
              END), 0) AS revenue_last_7_days,
              COUNT(DISTINCT CASE WHEN o.status = 'cancelled' THEN o.id END) AS cancelled_orders
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN seller_order_decisions sd
         ON sd.order_id = o.id AND sd.seller_id = oi.seller_id
       WHERE oi.seller_id = ?
         AND COALESCE(sd.status, 'accepted') != 'rejected'
         AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'successful')`,
      [req.session.user.id]
    );
    const [monthlyRevenue] = await db.execute(
      `SELECT strftime('%Y-%m', o.created_at) AS month,
              SUM(oi.quantity * oi.price) AS revenue,
              COUNT(DISTINCT o.id) AS orders
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN seller_order_decisions sd
         ON sd.order_id = o.id AND sd.seller_id = oi.seller_id
       WHERE oi.seller_id = ?
         AND COALESCE(sd.status, 'accepted') != 'rejected'
         AND o.status IN ('paid', 'processing', 'shipped', 'delivered')
         AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'successful')
         AND o.created_at >= datetime('now', '-6 months')
       GROUP BY strftime('%Y-%m', o.created_at)
       ORDER BY month DESC`,
      [req.session.user.id]
    );
    const [inventorySummary] = await db.execute(
      `SELECT COUNT(*) AS product_count,
              COALESCE(SUM(stock), 0) AS units_in_stock,
              COALESCE(SUM(CASE WHEN stock <= 5 THEN 1 ELSE 0 END), 0) AS low_stock_count,
              COALESCE(SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count
       FROM products WHERE seller_id = ?`,
      [req.session.user.id]
    );
    const [pendingFulfillmentRows] = await db.execute(
      `SELECT COUNT(DISTINCT o.id) AS order_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN seller_order_fulfillments f
         ON f.order_id = o.id AND f.seller_id = oi.seller_id
       LEFT JOIN seller_order_decisions d
         ON d.order_id = o.id AND d.seller_id = oi.seller_id
       WHERE oi.seller_id = ?
         AND o.status IN ('paid', 'processing')
         AND EXISTS (SELECT 1 FROM payments p
                     WHERE p.order_id = o.id AND p.status = 'successful')
         AND COALESCE(f.status, 'pending') IN ('pending', 'processing')
         AND COALESCE(d.status, 'pending') != 'rejected'`,
      [req.session.user.id]
    );
    const [sellerEarningsRows] = await db.execute(
      `SELECT COALESCE(SUM(seller_net_amount), 0) AS earned,
              COALESCE(SUM(gross_amount), 0) AS gross,
              COALESCE(SUM(amount), 0) AS commission
       FROM commissions
       WHERE seller_id = ? AND status = 'earned'`,
      [req.session.user.id]
    );
    const [payoutRequests] = await db.execute(
      `SELECT id, amount, payout_phone, status, created_at, updated_at
       FROM seller_payout_requests
       WHERE seller_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.session.user.id]
    );
    const [payoutReservedRows] = await db.execute(
      `SELECT COALESCE(SUM(CASE WHEN status IN ('pending', 'approved') THEN amount ELSE 0 END), 0) AS reserved,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_out
       FROM seller_payout_requests
       WHERE seller_id = ? AND status IN ('pending', 'approved', 'paid')`,
      [req.session.user.id]
    );
    const [pendingCommissionRows] = await db.execute(
      `SELECT COALESCE(SUM(seller_net_amount), 0) AS pending
       FROM commissions
       WHERE seller_id = ? AND status = 'pending'`,
      [req.session.user.id]
    );
    const earned = Number(sellerEarningsRows[0]?.earned || 0);
    const reserved = Number(payoutReservedRows[0]?.reserved || 0);
    const paidOut = Number(payoutReservedRows[0]?.paid_out || 0);
    const pendingBalance = Number(pendingCommissionRows[0]?.pending || 0);
    const availableBalance = Math.max(0, Math.round((earned - reserved - paidOut) * 100) / 100);
    const [fulfillmentOrders] = await db.execute(
      `SELECT DISTINCT o.id AS order_id, o.status AS order_status, o.created_at,
              o.shipping_address, o.shipping_city, o.shipping_region,
              COALESCE(o.recipient_name, c.name) AS customer_name,
              COALESCE(f.status, 'pending') AS fulfillment_status,
              d.status AS seller_decision, d.note AS decision_note,
              f.tracking_number, f.updated_at AS fulfillment_updated_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN users c ON c.id = o.customer_id
       LEFT JOIN seller_order_fulfillments f
         ON f.order_id = o.id AND f.seller_id = oi.seller_id
       LEFT JOIN seller_order_decisions d
         ON d.order_id = o.id AND d.seller_id = oi.seller_id
       WHERE oi.seller_id = ?
         AND o.status IN ('paid', 'processing', 'shipped', 'delivered')
         AND EXISTS (SELECT 1 FROM payments p
                     WHERE p.order_id = o.id AND p.status = 'successful')
       ORDER BY o.created_at DESC
       LIMIT 50`,
      [req.session.user.id]
    );
    const [sellerReviews] = await db.execute(
      `SELECT r.id, r.rating, r.comment, r.created_at,
              sr.response AS seller_response, sr.created_at AS response_at,
              srr.status AS report_status,
              p.id AS product_id, p.name AS product_name, u.name AS customer_name
       FROM reviews r
       JOIN products p ON p.id = r.product_id
       JOIN users u ON u.id = r.customer_id
       LEFT JOIN seller_review_responses sr
         ON sr.review_id = r.id AND sr.seller_id = p.seller_id
       LEFT JOIN seller_review_reports srr
         ON srr.review_id = r.id AND srr.seller_id = p.seller_id
       WHERE p.seller_id = ?
       ORDER BY r.created_at DESC
       LIMIT 30`,
      [req.session.user.id]
    );
    const [recentSales] = await db.execute(
      `SELECT o.id AS order_id, o.status, o.created_at,
              p.id AS product_id, p.name AS product_name, p.image,
              oi.quantity, oi.price,
              (oi.quantity * oi.price) AS line_total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN seller_order_decisions sd
         ON sd.order_id = o.id AND sd.seller_id = oi.seller_id
       WHERE oi.seller_id = ? AND COALESCE(sd.status, 'accepted') != 'rejected'
       ORDER BY o.created_at DESC
       LIMIT 8`,
      [req.session.user.id]
    );
    const [sellerLedger] = await db.execute(
      `SELECT c.id, c.order_id, c.gross_amount, c.amount AS commission_amount,
              c.seller_net_amount, c.status, c.created_at,
              o.status AS order_status,
              COALESCE((SELECT p.status FROM payments p
                        WHERE p.order_id = c.order_id
                        ORDER BY p.created_at DESC LIMIT 1), 'unpaid') AS payment_status
       FROM commissions c
       JOIN orders o ON o.id = c.order_id
       WHERE c.seller_id = ?
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT 50`,
      [req.session.user.id]
    );
    const [bestSellingProducts] = await db.execute(
      `SELECT p.id, p.name, SUM(oi.quantity) AS units_sold,
              SUM(oi.quantity * oi.price) AS gross_sales
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN seller_order_decisions sd
         ON sd.order_id = o.id AND sd.seller_id = oi.seller_id
       WHERE oi.seller_id = ? AND o.status IN ('paid', 'processing', 'shipped', 'delivered')
         AND COALESCE(sd.status, 'accepted') != 'rejected'
         AND EXISTS (SELECT 1 FROM payments pay
                     WHERE pay.order_id = o.id AND pay.status = 'successful')
       GROUP BY p.id, p.name
       ORDER BY units_sold DESC, gross_sales DESC
       LIMIT 5`,
      [req.session.user.id]
    );
    const [stockMovements] = await db.execute(
      `SELECT m.product_id, p.name AS product_name, m.previous_stock, m.new_stock,
              m.change_reason, m.created_at
       FROM seller_stock_movements m
       JOIN products p ON p.id = m.product_id
       WHERE m.seller_id = ?
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 30`,
      [req.session.user.id]
    );
    const [sellerRefunds] = await db.execute(
      `SELECT DISTINCT r.id, r.order_id, r.reason, r.status, r.admin_note,
              r.seller_response, r.evidence_key, r.created_at, r.updated_at,
              c.name AS customer_name, o.status AS order_status,
              COALESCE(MAX(f.status), 'pending') AS seller_fulfillment_status,
              MAX(f.tracking_number) AS tracking_number,
              GROUP_CONCAT(p.name, ', ') AS seller_products
       FROM refund_requests r
       JOIN orders o ON o.id = r.order_id
       JOIN users c ON c.id = r.customer_id
       JOIN order_items oi ON oi.order_id = o.id AND oi.seller_id = ?
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN seller_order_fulfillments f
         ON f.order_id = o.id AND f.seller_id = oi.seller_id
       GROUP BY r.id, r.order_id, r.reason, r.status, r.admin_note, r.seller_response,
                r.evidence_key, r.created_at, r.updated_at, c.name, o.status
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [req.session.user.id]
    );
    const [sellerMessages] = await db.execute(
      `SELECT m.order_id, m.customer_id, m.sender_id, m.message, m.created_at,
              u.name AS sender_name,
              CASE WHEN m.sender_id = m.seller_id THEN 1 ELSE 0 END AS sent_by_seller
       FROM order_messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.seller_id = ?
       ORDER BY m.created_at DESC
       LIMIT 40`,
      [req.session.user.id]
    );
    const [recentBuyerMessages] = await db.execute(
      `SELECT m.order_id, m.message, m.created_at, u.name AS sender_name
       FROM order_messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.seller_id = ? AND m.sender_id = m.customer_id
       ORDER BY m.created_at DESC
       LIMIT 3`,
      [req.session.user.id]
    );
    const [recentReviewAlerts] = await db.execute(
      `SELECT r.rating, r.comment, r.created_at,
              p.id AS product_id, p.name AS product_name, u.name AS customer_name
       FROM reviews r
       JOIN products p ON p.id = r.product_id
       JOIN users u ON u.id = r.customer_id
       WHERE p.seller_id = ?
       ORDER BY r.created_at DESC
       LIMIT 3`,
      [req.session.user.id]
    );

    res.render("seller/dashboard", {
      user: req.session.user,
      products,
      categories,
      sellerProfile: sellerProfiles[0] || {
        business_name: "",
        business_website: "",
        business_description: "",
        business_logo: "",
        status: "pending"
      },
      sellerAccount: sellerAccountRows[0] || { email_verified: 0 },
      sellerHome: {
        today: todayOverviewRows[0] || {},
        pendingFulfillmentOrders: Number(pendingFulfillmentRows[0]?.order_count || 0),
        pendingBalance,
        reservedBalance: reserved,
        paidOutBalance: paidOut,
        availableBalance,
        recentBuyerMessages,
        recentReviewAlerts,
        nextPayoutDate: null
      },
      websiteUpdated: req.query.website === "updated",
      profileUpdated: req.query.profile === "updated",
      messageSent: req.query.message === "sent",
      fulfillmentUpdated: req.query.fulfillment === "updated",
      payoutRequested: req.query.payout === "requested",
      promotionUpdated: req.query.promotion === "updated",
      orderDecision: ["accepted", "rejected"].includes(req.query.orderDecision) ? req.query.orderDecision : "",
      refundResponseUpdated: req.query.refund === "updated",
      reviewAction: ["responded", "reported"].includes(req.query.review) ? req.query.review : "",
      shoppingDisabled: req.query.shopping === "disabled",
      sellerAnalytics: {
        completedOrders: Number(sellerAnalyticsRows[0]?.completed_orders || 0),
        grossRevenue: Number(sellerAnalyticsRows[0]?.gross_revenue || 0),
        revenueLast30Days: Number(sellerAnalyticsRows[0]?.revenue_last_30_days || 0),
        revenueLast7Days: Number(sellerAnalyticsRows[0]?.revenue_last_7_days || 0),
        cancelledOrders: Number(sellerAnalyticsRows[0]?.cancelled_orders || 0),
        unitsLast30Days: Number(sellerAnalyticsRows[0]?.units_last_30_days || 0),
        inventory: inventorySummary[0] || {},
        earnings: earned,
        earningsGross: Number(sellerEarningsRows[0]?.gross || 0),
        commissionPaid: Number(sellerEarningsRows[0]?.commission || 0),
        reservedPayouts: reserved + paidOut,
        availablePayout: availableBalance
      },
      monthlyRevenue,
      fulfillmentOrders,
      payoutRequests,
      sellerLedger,
      bestSellingProducts,
      stockMovements,
      sellerRefunds,
      sellerReviews,
      recentSales,
      sellerMessages
    });
  } catch (error) {
    console.error("Seller dashboard load error:", error.message);
    res.status(500).send("Could not load your dashboard.");
  }
});

app.use("/profile", profileRoutes);
app.use(shopRoutes);
app.use("/auth", authRoutes);
app.use("/payments", paymentRoutes);

app.use((error, req, res, next) => {
  console.error("Unhandled application error:", error);
  res.status(500).send("Something went wrong on the server.");
});

async function startServer() {
  try {
    await sessionStore.ready;
    await db.initialize();
    app.listen(PORT, () => {
      console.log(`The Marketplace app running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to initialize the marketplace database:", error.message);
    process.exit(1);
  }
}

startServer();
