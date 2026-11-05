-- PostgreSQL schema for the marketplace.
CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    password TEXT NOT NULL,
                    email_verified INTEGER NOT NULL DEFAULT 1,
                    role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('buyer', 'customer', 'seller', 'admin', 'manager')),
                    referral_code TEXT UNIQUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS seller_profiles (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL UNIQUE,
                    business_name TEXT NOT NULL,
                    business_website TEXT,
                    business_description TEXT,
                    business_logo TEXT,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS categories (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE
                );

                CREATE TABLE IF NOT EXISTS products (
                    id SERIAL PRIMARY KEY,
                    seller_id INTEGER NOT NULL,
                    category_id INTEGER,
                    name TEXT NOT NULL,
                    description TEXT,
                    price DOUBLE PRECISION NOT NULL,
                    stock INTEGER NOT NULL DEFAULT 0,
                    image TEXT,
                    moderation_status TEXT NOT NULL DEFAULT 'approved' CHECK(moderation_status IN ('pending', 'approved', 'rejected')),
                    moderation_note TEXT,
                    promotion_discount_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
                    promotion_starts_at TIMESTAMP,
                    promotion_ends_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (seller_id) REFERENCES users(id),
                    FOREIGN KEY (category_id) REFERENCES categories(id)
                );

                CREATE TABLE IF NOT EXISTS orders (
                    id SERIAL PRIMARY KEY,
                    customer_id INTEGER NOT NULL,
                    total DOUBLE PRECISION NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled')),
                    recipient_name TEXT,
                    shipping_address TEXT,
                    shipping_city TEXT,
                    shipping_region TEXT,
                    shipping_postal_code TEXT,
                    recipient_phone TEXT,
                    points_redeemed INTEGER NOT NULL DEFAULT 0,
                    discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS order_items (
                    id SERIAL PRIMARY KEY,
                    order_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    quantity INTEGER NOT NULL,
                    price DOUBLE PRECISION NOT NULL,
                    promotion_discount_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
                    FOREIGN KEY (order_id) REFERENCES orders(id),
                    FOREIGN KEY (product_id) REFERENCES products(id),
                    FOREIGN KEY (seller_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS payments (
                    id SERIAL PRIMARY KEY,
                    order_id INTEGER NOT NULL,
                    method TEXT NOT NULL DEFAULT 'pending',
                    transaction_reference TEXT,
                    checkout_request_id TEXT,
                    merchant_request_id TEXT,
                    phone_number TEXT,
                    amount DOUBLE PRECISION NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'successful', 'failed')),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id)
                );

                CREATE TABLE IF NOT EXISTS refund_requests (
                    id SERIAL PRIMARY KEY,
                    order_id INTEGER NOT NULL UNIQUE,
                    customer_id INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'refunded')),
                    admin_note TEXT,
                    seller_response TEXT,
                    evidence_key TEXT,
                    reviewed_by INTEGER,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS reviews (
                    id SERIAL PRIMARY KEY,
                    product_id INTEGER NOT NULL,
                    customer_id INTEGER NOT NULL,
                    rating INTEGER NOT NULL,
                    comment TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (product_id) REFERENCES products(id),
                    FOREIGN KEY (customer_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS seller_review_responses (
                    review_id INTEGER PRIMARY KEY,
                    seller_id INTEGER NOT NULL,
                    response TEXT NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS seller_review_reports (
                    id SERIAL PRIMARY KEY,
                    review_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reviewed', 'dismissed')),
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(review_id, seller_id),
                    FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_profiles (
                    user_id INTEGER PRIMARY KEY,
                    phone TEXT,
                    mpesa_phone TEXT,
                    shipping_address TEXT,
                    shipping_city TEXT,
                    shipping_region TEXT,
                    shipping_postal_code TEXT,
                    email_notifications INTEGER NOT NULL DEFAULT 1,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS wishlists (
                    id SERIAL PRIMARY KEY,
                    customer_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    alert_price_drop INTEGER NOT NULL DEFAULT 1,
                    alert_back_in_stock INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(customer_id, product_id),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS order_messages (
                    id SERIAL PRIMARY KEY,
                    order_id INTEGER NOT NULL,
                    customer_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    sender_id INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS seller_order_fulfillments (
                    id SERIAL PRIMARY KEY,
                    order_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'shipped')),
                    tracking_number TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(order_id, seller_id),
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS seller_order_decisions (
                    order_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('accepted', 'rejected')),
                    note TEXT,
                    admin_adjustment_status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(admin_adjustment_status IN ('pending', 'handled')),
                    admin_note TEXT,
                    reviewed_by INTEGER,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (order_id, seller_id),
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS seller_stock_movements (
                    id SERIAL PRIMARY KEY,
                    seller_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    previous_stock INTEGER NOT NULL,
                    new_stock INTEGER NOT NULL,
                    change_reason TEXT NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS delivery_complaints (
                    id SERIAL PRIMARY KEY,
                    order_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    customer_id INTEGER NOT NULL,
                    complaint TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'resolved')),
                    follow_up_note TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(order_id, seller_id),
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS seller_payout_requests (
                    id SERIAL PRIMARY KEY,
                    seller_id INTEGER NOT NULL,
                    amount DOUBLE PRECISION NOT NULL,
                    payout_phone TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'paid')),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS commissions (
                    id SERIAL PRIMARY KEY,
                    order_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    amount DOUBLE PRECISION NOT NULL,
                    order_item_id INTEGER,
                    commission_rate DOUBLE PRECISION NOT NULL DEFAULT 10,
                    commission_flat_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
                    gross_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
                    seller_net_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'earned', 'void')),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id),
                    FOREIGN KEY (seller_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS marketplace_settings (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    commission_rate DOUBLE PRECISION NOT NULL DEFAULT 10,
                    commission_flat_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS commission_rules (
                    id SERIAL PRIMARY KEY,
                    rule_type TEXT NOT NULL CHECK(rule_type IN ('category', 'seller')),
                    target_id INTEGER NOT NULL,
                    commission_rate DOUBLE PRECISION NOT NULL CHECK(commission_rate >= 0 AND commission_rate <= 50),
                    flat_fee DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(flat_fee >= 0),
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(rule_type, target_id)
                );

                CREATE TABLE IF NOT EXISTS audit_logs (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER,
                    action TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS email_verification_tokens (
                    user_id INTEGER PRIMARY KEY,
                    token_hash TEXT NOT NULL,
                    expires_at TIMESTAMP NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS admin_mfa (
                    user_id INTEGER PRIMARY KEY,
                    secret_ciphertext TEXT NOT NULL,
                    enabled_at TIMESTAMP,
                    last_totp_step INTEGER NOT NULL DEFAULT -1,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS admin_mfa_recovery_codes (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    code_hash TEXT NOT NULL,
                    used_at TIMESTAMP,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, code_hash),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_product_views (
                    customer_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    viewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    view_count INTEGER NOT NULL DEFAULT 1,
                    last_activity_date TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (customer_id, product_id),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_activity_days (
                    customer_id INTEGER NOT NULL,
                    activity_date TEXT NOT NULL,
                    PRIMARY KEY (customer_id, activity_date),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_preferences (
                    customer_id INTEGER PRIMARY KEY,
                    favorite_category_id INTEGER,
                    shopping_style TEXT,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (favorite_category_id) REFERENCES categories(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS customer_seller_follows (
                    customer_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (customer_id, seller_id),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_collections (
                    id SERIAL PRIMARY KEY,
                    customer_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(customer_id, name),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_collection_items (
                    collection_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (collection_id, product_id),
                    FOREIGN KEY (collection_id) REFERENCES customer_collections(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_points_ledger (
                    id SERIAL PRIMARY KEY,
                    customer_id INTEGER NOT NULL,
                    points INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    event_key TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_badges (
                    customer_id INTEGER NOT NULL,
                    badge_key TEXT NOT NULL,
                    earned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (customer_id, badge_key),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_referrals (
                    id SERIAL PRIMARY KEY,
                    referrer_id INTEGER NOT NULL,
                    referred_customer_id INTEGER NOT NULL UNIQUE,
                    status TEXT NOT NULL DEFAULT 'joined' CHECK(status IN ('joined', 'first_order')),
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (referred_customer_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_wishlist_watch_state (
                    customer_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    last_price DOUBLE PRECISION NOT NULL,
                    last_stock INTEGER NOT NULL,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (customer_id, product_id),
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_wishlist_alerts (
                    id SERIAL PRIMARY KEY,
                    customer_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    alert_type TEXT NOT NULL CHECK(alert_type IN ('price_drop', 'back_in_stock')),
                    message TEXT NOT NULL,
                    emailed_at TIMESTAMP,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS customer_seller_updates (
                    id SERIAL PRIMARY KEY,
                    customer_id INTEGER NOT NULL,
                    seller_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    update_type TEXT NOT NULL CHECK(update_type IN ('new_product', 'price_drop')),
                    event_key TEXT NOT NULL UNIQUE,
                    message TEXT NOT NULL,
                    emailed_at TIMESTAMP,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
                );


ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE wishlists ADD COLUMN IF NOT EXISTS alert_price_drop INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wishlists ADD COLUMN IF NOT EXISTS alert_back_in_stock INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_city TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_region TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_postal_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redeemed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS email_notifications INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE products ADD COLUMN IF NOT EXISTS moderation_note TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promotion_discount_percent DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promotion_starts_at TIMESTAMP;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promotion_ends_at TIMESTAMP;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS promotion_discount_percent DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS seller_response TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS evidence_key TEXT;
ALTER TABLE seller_order_decisions ADD COLUMN IF NOT EXISTS admin_adjustment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE seller_order_decisions ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE seller_order_decisions ADD COLUMN IF NOT EXISTS reviewed_by INTEGER;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS order_item_id INTEGER;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS commission_rate DOUBLE PRECISION NOT NULL DEFAULT 10;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS commission_flat_fee DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS gross_amount DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS seller_net_amount DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE marketplace_settings ADD COLUMN IF NOT EXISTS commission_flat_fee DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS business_website TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS business_description TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS business_logo TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_request_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS merchant_request_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS phone_number TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
    ON users(referral_code) WHERE referral_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_commissions_order_item_id
    ON commissions(order_item_id) WHERE order_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_checkout_request_id
    ON payments(checkout_request_id) WHERE checkout_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS password_reset_codes (
    user_id INTEGER PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
