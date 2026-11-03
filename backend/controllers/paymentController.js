const crypto = require("crypto");
const db = require("../database/db");
const {
    createCheckoutOrder,
    createMpesaRetryAttempt,
    failPendingPayment,
    normalizeCart,
    validateCheckoutDetails
} = require("../services/checkoutService");
const { awardDeliveredOrderPoints } = require("../services/customerRewards");
const { awardReferralForFirstOrder } = require("../services/customerEngagement");

const mpesaHosts = {
    sandbox: "https://sandbox.safaricom.co.ke",
    production: "https://api.safaricom.co.ke"
};

function getMpesaConfig() {
    const {
        MPESA_ENV,
        MPESA_CONSUMER_KEY,
        MPESA_CONSUMER_SECRET,
        MPESA_SHORTCODE,
        MPESA_PASSKEY,
        MPESA_CALLBACK_URL,
        MPESA_CALLBACK_TOKEN
    } = process.env;

    if (
        !MPESA_CONSUMER_KEY ||
        !MPESA_CONSUMER_SECRET ||
        !MPESA_SHORTCODE ||
        !MPESA_PASSKEY ||
        !MPESA_CALLBACK_URL ||
        !MPESA_CALLBACK_TOKEN
    ) {
        throw Object.assign(new Error("M-Pesa is not fully configured."), { code: "MPESA_NOT_CONFIGURED" });
    }

    const environment = MPESA_ENV || "sandbox";
    if (!Object.hasOwn(mpesaHosts, environment)) {
        throw Object.assign(new Error("MPESA_ENV must be sandbox or production."), { code: "MPESA_CONFIG_INVALID" });
    }

    if (!/^[A-Za-z0-9_-]{32,}$/.test(MPESA_CALLBACK_TOKEN)) {
        throw Object.assign(new Error("MPESA_CALLBACK_TOKEN must contain at least 32 URL-safe characters."), {
            code: "MPESA_CONFIG_INVALID"
        });
    }

    let callbackBase;
    try {
        callbackBase = new URL(MPESA_CALLBACK_URL);
    } catch (error) {
        throw Object.assign(new Error("MPESA_CALLBACK_URL must be a valid public HTTPS URL."), {
            code: "MPESA_CONFIG_INVALID"
        });
    }

    const callbackHostname = callbackBase.hostname.toLowerCase();
    if (
        callbackBase.protocol !== "https:" ||
        callbackBase.username ||
        callbackBase.password ||
        callbackBase.search ||
        callbackBase.hash ||
        callbackHostname === "localhost" ||
        callbackHostname.endsWith(".localhost") ||
        callbackHostname.endsWith(".example") ||
        callbackHostname === "example.com" ||
        callbackBase.pathname.replace(/\/+$/, "") !== "/api/payments/mpesa/callback"
    ) {
        throw Object.assign(new Error(
            "MPESA_CALLBACK_URL must be the public HTTPS URL ending in /api/payments/mpesa/callback."
        ), { code: "MPESA_CONFIG_INVALID" });
    }

    const transactionType = process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline";
    if (!["CustomerPayBillOnline", "CustomerBuyGoodsOnline"].includes(transactionType)) {
        throw Object.assign(new Error(
            "MPESA_TRANSACTION_TYPE must be CustomerPayBillOnline or CustomerBuyGoodsOnline."
        ), { code: "MPESA_CONFIG_INVALID" });
    }

    return {
        environment,
        host: mpesaHosts[environment],
        consumerKey: MPESA_CONSUMER_KEY,
        consumerSecret: MPESA_CONSUMER_SECRET,
        shortCode: MPESA_SHORTCODE,
        passKey: MPESA_PASSKEY,
        transactionType,
        callbackUrl: `${callbackBase.origin}${callbackBase.pathname.replace(/\/+$/, "")}/${MPESA_CALLBACK_TOKEN}`,
        callbackToken: MPESA_CALLBACK_TOKEN
    };
}

function isMpesaConfigured() {
    try {
        getMpesaConfig();
        return true;
    } catch (error) {
        if (error.code === "MPESA_NOT_CONFIGURED" || error.code === "MPESA_CONFIG_INVALID") {
            return false;
        }
        throw error;
    }
}

function normalizePhoneNumber(phone) {
    if (typeof phone !== "string") return null;
    const compact = phone.trim().replace(/[\s()-]/g, "");
    let normalized = compact;
    if (/^0[17]\d{8}$/.test(compact)) {
        normalized = `254${compact.slice(1)}`;
    } else if (/^\+254[17]\d{8}$/.test(compact)) {
        normalized = compact.slice(1);
    }
    return /^254[17]\d{8}$/.test(normalized) ? normalized : null;
}

function getMpesaTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

async function readProviderJson(response, action) {
    let body;
    try {
        body = await response.json();
    } catch (error) {
        throw new Error(`${action} returned an invalid response.`);
    }
    if (!response.ok) {
        throw new Error(`${action} failed with HTTP ${response.status}.`);
    }
    return body;
}

async function getAccessToken(config) {
    const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
    const response = await fetch(
        `${config.host}/oauth/v1/generate?grant_type=client_credentials`,
        {
            headers: { Authorization: `Basic ${credentials}` },
            signal: AbortSignal.timeout(15000)
        }
    );
    const body = await readProviderJson(response, "M-Pesa authentication");
    if (typeof body.access_token !== "string" || !body.access_token) {
        throw new Error("M-Pesa authentication did not return an access token.");
    }
    return body.access_token;
}

async function requestStkPush(config, accessToken, { orderId, amount, phoneNumber }) {
    const timestamp = getMpesaTimestamp();
    const password = Buffer.from(`${config.shortCode}${config.passKey}${timestamp}`).toString("base64");
    const response = await fetch(`${config.host}/mpesa/stkpush/v1/processrequest`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
            BusinessShortCode: config.shortCode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: config.transactionType,
            Amount: amount,
            PartyA: phoneNumber,
            PartyB: config.shortCode,
            PhoneNumber: phoneNumber,
            CallBackURL: config.callbackUrl,
            AccountReference: `ORD${orderId}`,
            TransactionDesc: `Marketplace order ${orderId}`
        })
    });
    return readProviderJson(response, "M-Pesa STK Push");
}

function getCallbackItems(callback) {
    const items = callback?.Body?.stkCallback?.CallbackMetadata?.Item;
    if (!Array.isArray(items)) return null;
    return Object.fromEntries(
        items
            .filter((item) => item && typeof item.Name === "string")
            .map((item) => [item.Name, item.Value])
    );
}

function callbackResponse(res, status, resultCode, resultDesc) {
    return res.status(status).json({ ResultCode: resultCode, ResultDesc: resultDesc });
}

async function submitMpesaAttempt(config, accessToken, attempt, phoneNumber) {
    const result = await requestStkPush(config, accessToken, {
        orderId: attempt.orderId,
        amount: attempt.total,
        phoneNumber
    });
    if (String(result.ResponseCode) !== "0") {
        await failPendingPayment(attempt.paymentId);
        console.error(
            "M-Pesa rejected STK Push:",
            result.ResponseDescription || result.errorMessage || "Unknown response"
        );
        return false;
    }
    if (
        typeof result.CheckoutRequestID !== "string" ||
        typeof result.MerchantRequestID !== "string"
    ) {
        throw new Error("M-Pesa accepted the request without returning confirmation references.");
    }

    const [updateResult] = await db.execute(
        `UPDATE payments
         SET checkout_request_id = ?, merchant_request_id = ?
         WHERE id = ? AND method = ? AND status = ?`,
        [result.CheckoutRequestID, result.MerchantRequestID, attempt.paymentId, "mpesa", "pending"]
    );
    if (updateResult.rowsAffected === 0) {
        throw new Error("The M-Pesa attempt was no longer pending after Safaricom accepted it.");
    }
    return true;
}

exports.startMpesaCheckout = async (req, res) => {
    if (!req.session.user) {
        return res.redirect("/register?checkout=required");
    }

    const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
    if (!phoneNumber) {
        return res.status(400).send("Enter a valid Kenyan M-Pesa phone number.");
    }

    let checkoutDetails;
    try {
        checkoutDetails = validateCheckoutDetails(req.body);
    } catch (error) {
        if (error.code === "INVALID_DELIVERY_DETAILS") {
            return res.status(400).send(error.message);
        }
        console.error("M-Pesa checkout detail validation error:", error.message);
        return res.status(500).send("Could not validate your delivery details.");
    }

    const cart = normalizeCart(req.session.cart);
    if (cart.length === 0) {
        return res.redirect("/cart");
    }
    const rawPointsToRedeem = req.body?.pointsToRedeem;
    if (
        rawPointsToRedeem !== undefined &&
        rawPointsToRedeem !== "" &&
        (typeof rawPointsToRedeem !== "string" || !/^\d+$/.test(rawPointsToRedeem) ||
            !Number.isSafeInteger(Number(rawPointsToRedeem)))
    ) {
        return res.status(400).send("Enter a valid number of reward points.");
    }
    const pointsToRedeem = rawPointsToRedeem ? Number(rawPointsToRedeem) : 0;

    let config;
    let accessToken;
    try {
        config = getMpesaConfig();
        accessToken = await getAccessToken(config);
    } catch (error) {
        if (error.code === "MPESA_NOT_CONFIGURED" || error.code === "MPESA_CONFIG_INVALID") {
            console.error("M-Pesa configuration error:", error.message);
            return res.status(503).send("M-Pesa payments are not configured correctly.");
        }
        console.error("M-Pesa authentication error:", error.message);
        return res.status(502).send("Could not connect to M-Pesa. Please try again later.");
    }

    let order;
    try {
        order = await createCheckoutOrder({
            cart,
            userId: req.session.user.id,
            paymentMethod: "mpesa",
            phoneNumber,
            ...checkoutDetails,
            pointsToRedeem
        });
    } catch (error) {
        if (error.code === "MPESA_PAYMENT_IN_PROGRESS" || error.code === "MPESA_PAYMENT_RETRY_AVAILABLE") {
            return res.redirect("/customer?payment=retry#wallet");
        }
        if ([
            "PRODUCT_UNAVAILABLE",
            "INSUFFICIENT_STOCK",
            "INVALID_MPESA_AMOUNT",
            "INVALID_DELIVERY_DETAILS",
            "INVALID_REWARD_POINTS",
            "INSUFFICIENT_REWARD_POINTS",
            "REWARD_DISCOUNT_LIMIT"
        ].includes(error.code)) {
            return res.status(409).send(error.message);
        }
        console.error("M-Pesa order creation error:", error.message);
        return res.status(500).send("Could not prepare your M-Pesa checkout.");
    }

    try {
        const accepted = await submitMpesaAttempt(config, accessToken, order, phoneNumber);
        if (!accepted) {
            req.session.cart = cart;
            return res.redirect("/cart?payment=failed");
        }
        req.session.cart = [];
        return res.redirect("/cart?payment=prompt");
    } catch (error) {
        console.error("M-Pesa STK Push error:", error.message);
        req.session.cart = [];
        return res.status(502).send(
            "We could not confirm the M-Pesa request. Check your phone and your order status before trying again."
        );
    }
};

exports.retryMpesaPayment = async (req, res) => {
    const customer = req.session?.user;
    if (!customer) {
        return res.redirect("/login");
    }
    if (!["buyer", "customer"].includes(customer.role)) {
        return res.status(403).send("Only customers can retry order payments.");
    }

    const orderId = Number(req.params.orderId);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
        return res.status(400).send("Invalid order.");
    }
    const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
    if (!phoneNumber) {
        return res.status(400).send("Enter a valid Kenyan M-Pesa phone number.");
    }

    let config;
    let accessToken;
    try {
        config = getMpesaConfig();
        accessToken = await getAccessToken(config);
    } catch (error) {
        if (error.code === "MPESA_NOT_CONFIGURED" || error.code === "MPESA_CONFIG_INVALID") {
            console.error("M-Pesa configuration error:", error.message);
            return res.status(503).send("M-Pesa payments are not configured correctly.");
        }
        console.error("M-Pesa authentication error:", error.message);
        return res.status(502).send("Could not connect to M-Pesa. Please try again later.");
    }

    let attempt;
    try {
        attempt = await createMpesaRetryAttempt({
            orderId,
            customerId: customer.id,
            phoneNumber
        });
    } catch (error) {
        if (error.code === "ORDER_NOT_FOUND") {
            return res.status(404).send(error.message);
        }
        if (error.code === "MPESA_PAYMENT_IN_PROGRESS") {
            return res.redirect("/customer?payment=pending#wallet");
        }
        if (error.code === "ORDER_NOT_RETRYABLE") {
            return res.status(409).send(error.message);
        }
        console.error("M-Pesa retry preparation error:", error.message);
        return res.status(500).send("Could not prepare your M-Pesa retry.");
    }

    try {
        const accepted = await submitMpesaAttempt(config, accessToken, attempt, phoneNumber);
        if (!accepted) {
            return res.redirect("/customer?payment=failed#wallet");
        }
        return res.redirect("/customer?payment=prompt#order-history");
    } catch (error) {
        console.error("M-Pesa retry error:", error.message);
        return res.status(502).send(
            "We could not confirm the M-Pesa request. Check your phone and payment history before retrying."
        );
    }
};

exports.handleMpesaCallback = async (req, res) => {
    let config;
    try {
        config = getMpesaConfig();
    } catch (error) {
        console.error("M-Pesa callback configuration error:", error.message);
        return res.status(503).send("M-Pesa callback is not configured.");
    }

    const submittedToken = req.params.token;
    const expectedToken = config.callbackToken;
    const submittedBuffer = Buffer.from(typeof submittedToken === "string" ? submittedToken : "");
    const expectedBuffer = Buffer.from(expectedToken);
    if (
        submittedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(submittedBuffer, expectedBuffer)
    ) {
        return res.status(404).send("Not found.");
    }

    const stkCallback = req.body?.Body?.stkCallback;
    const checkoutRequestId = stkCallback?.CheckoutRequestID;
    const merchantRequestId = stkCallback?.MerchantRequestID;
    const rawResultCode = stkCallback?.ResultCode;
    const resultCode =
        typeof rawResultCode === "number"
            ? rawResultCode
            : typeof rawResultCode === "string" && /^\d+$/.test(rawResultCode)
                ? Number(rawResultCode)
                : NaN;
    if (
        typeof checkoutRequestId !== "string" ||
        !checkoutRequestId ||
        typeof merchantRequestId !== "string" ||
        !Number.isInteger(resultCode)
    ) {
        return callbackResponse(res, 400, 1, "Invalid callback payload.");
    }

    try {
        await db.transaction(async (connection) => {
            const [payments] = await connection.execute(
                `SELECT p.id, p.order_id, p.amount, p.status, p.phone_number,
                        p.checkout_request_id, p.merchant_request_id, o.status AS order_status,
                        o.customer_id
                 FROM payments p
                 JOIN orders o ON o.id = p.order_id
                 WHERE p.checkout_request_id = ?`,
                [checkoutRequestId]
            );
            const payment = payments[0];
            if (!payment) {
                throw Object.assign(new Error("M-Pesa callback did not match a pending payment."), {
                    code: "PAYMENT_NOT_FOUND"
                });
            }
            if (payment.status !== "pending" || payment.order_status !== "pending") {
                return;
            }

            if (
                payment.merchant_request_id &&
                payment.merchant_request_id !== merchantRequestId
            ) {
                throw Object.assign(new Error("M-Pesa callback merchant request ID did not match."), {
                    code: "CALLBACK_MISMATCH"
                });
            }

            if (resultCode === 0) {
                const metadata = getCallbackItems({ Body: { stkCallback } });
                const amount = Number(metadata?.Amount);
                const receipt = metadata?.MpesaReceiptNumber;
                const callbackPhone = normalizePhoneNumber(String(metadata?.PhoneNumber ?? ""));
                if (
                    !metadata ||
                    !Number.isSafeInteger(amount) ||
                    amount !== Number(payment.amount) ||
                    typeof receipt !== "string" ||
                    !/^[A-Z0-9]{6,20}$/.test(receipt) ||
                    !callbackPhone ||
                    callbackPhone !== payment.phone_number
                ) {
                    throw Object.assign(new Error("M-Pesa callback payment details did not match the order."), {
                        code: "CALLBACK_MISMATCH"
                    });
                }

                await connection.execute(
                    "UPDATE payments SET status = ?, transaction_reference = ? WHERE id = ? AND status = ?",
                    ["successful", receipt, payment.id, "pending"]
                );
                await connection.execute(
                    "UPDATE orders SET status = ? WHERE id = ? AND status = ?",
                    ["paid", payment.order_id, "pending"]
                );
                await connection.execute(
                    "UPDATE commissions SET status = 'earned' WHERE order_id = ? AND status = 'pending'",
                    [payment.order_id]
                );
                await awardDeliveredOrderPoints(connection, payment.order_id);
                await awardReferralForFirstOrder(connection, payment.customer_id);
            } else {
                await connection.execute(
                    "UPDATE payments SET status = ? WHERE id = ? AND status = ?",
                    ["failed", payment.id, "pending"]
                );
            }
        });

        return callbackResponse(res, 200, 0, "Accepted");
    } catch (error) {
        if (error.code === "PAYMENT_NOT_FOUND" || error.code === "CALLBACK_MISMATCH") {
            console.error("M-Pesa callback rejected:", error.message);
            return callbackResponse(res, 400, 1, "Payment could not be verified.");
        }
        console.error("M-Pesa callback processing error:", error.message);
        return callbackResponse(res, 500, 1, "Callback processing failed.");
    }
};

exports.normalizePhoneNumber = normalizePhoneNumber;
exports.getMpesaTimestamp = getMpesaTimestamp;
exports.isMpesaConfigured = isMpesaConfigured;
