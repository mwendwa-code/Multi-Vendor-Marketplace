
const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const { createRateLimiter } = require("../middleware/rateLimit");

const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many sign-in attempts. Please try again later."
});
const registrationLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: "Too many registration attempts. Please try again later."
});
const passwordResetLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Too many password recovery attempts. Please try again later."
});
router.post("/register", registrationLimiter, authController.register);
router.post("/login", loginLimiter, authController.login);
router.get("/verify-email", authController.verifyEmail);
router.get("/logout", authController.logout);
router.post("/logout", authController.logout);
router.get("/google", authController.startGoogleLogin);
router.get("/google/callback", authController.completeGoogleLogin);
router.post("/forgot-password", passwordResetLimiter, authController.requestPasswordReset);
router.post("/reset-password", passwordResetLimiter, authController.resetPassword);

module.exports = router;
