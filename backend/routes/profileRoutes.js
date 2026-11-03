const express = require("express");
const profileController = require("../controllers/profileController");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireLogin, profileController.getProfile);
router.post("/", requireLogin, profileController.updateProfile);
router.post("/password", requireLogin, profileController.updatePassword);

module.exports = router;
