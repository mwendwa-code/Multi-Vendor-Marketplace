const express = require("express");
const productController = require("../controllers/productController");
const { requireRole } = require("../middleware/auth");
const csrfProtection = require("../middleware/csrf");
const imageUpload = require("../middleware/uploadProductImage");
const db = require("../database/db");

const router = express.Router();

async function requireApprovedSeller(req, res, next) {
    try {
        const [profiles] = await db.execute(
            "SELECT status FROM seller_profiles WHERE user_id = ?",
            [req.session.user.id]
        );
        if (profiles[0]?.status !== "approved") {
            return res.status(403).send("Your seller account must be approved before managing products.");
        }
        return next();
    } catch (error) {
        console.error("Seller approval check error:", error.message);
        return res.status(500).send("Could not verify your seller account.");
    }
}

router.get("/", requireRole("seller"), requireApprovedSeller, csrfProtection, productController.getSellerProducts);
router.post("/", requireRole("seller"), requireApprovedSeller, imageUpload.single, csrfProtection, productController.createProduct);
router.post("/:id/promotion", requireRole("seller"), requireApprovedSeller, csrfProtection, productController.updatePromotion);
router.post("/:id/update", requireRole("seller"), requireApprovedSeller, imageUpload.single, csrfProtection, productController.updateProduct);
router.post("/:id/delete", requireRole("seller"), requireApprovedSeller, csrfProtection, productController.deleteProduct);

module.exports = router;
