const express = require("express");
const paymentController = require("../controllers/paymentController");
const { createRateLimiter } = require("../middleware/rateLimit");
const { redirectSellerFromShopping } = require("../middleware/auth");

const router = express.Router();
const stkPushLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Too many M-Pesa payment attempts. Please try again later."
});

router.post("/mpesa/stk-push", redirectSellerFromShopping, stkPushLimiter, paymentController.startMpesaCheckout);
router.post(
    "/mpesa/retry/:orderId",
    redirectSellerFromShopping,
    stkPushLimiter,
    paymentController.retryMpesaPayment
);

module.exports = router;
