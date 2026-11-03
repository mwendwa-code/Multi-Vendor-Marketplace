const express = require("express");
const shopController = require("../controllers/shopController");
const { redirectSellerFromShopping } = require("../middleware/auth");

const router = express.Router();

router.get("/cart", redirectSellerFromShopping, shopController.viewCart);
router.post("/cart/add", redirectSellerFromShopping, shopController.addToCart);
router.post("/cart/remove/:id", redirectSellerFromShopping, shopController.removeItem);
router.post("/cart/update/:id", redirectSellerFromShopping, shopController.updateItem);
router.post("/cart/checkout", redirectSellerFromShopping, shopController.checkout);
router.get("/products/:id", shopController.getProduct);

module.exports = router;
