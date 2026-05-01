const express = require("express");
const { customerAuth } = require("../controllers/customerAuthController");
const {
  addWishlistItem,
  getWishlistItems,
  deleteWishlistItem,
} = require("../controllers/wishlistController");

const router = express.Router();

router.use(customerAuth);
router.post("/", addWishlistItem);
router.get("/", getWishlistItems);
router.delete("/:id", deleteWishlistItem);

module.exports = router;
