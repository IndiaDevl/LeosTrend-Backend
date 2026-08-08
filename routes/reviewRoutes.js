const express = require("express");
const adminAuth = require("../middleware/adminAuth");
const {
  getProductReviews,
  addProductReview,
  getAdminReviews,
  toggleReviewVisibility,
  deleteReview,
} = require("../controllers/reviewController");

const router = express.Router();

router.get("/products/:productId/reviews", getProductReviews);
router.post("/products/:productId/reviews", addProductReview);

router.get("/admin/reviews", adminAuth, getAdminReviews);
router.patch("/admin/reviews/:id/visibility", adminAuth, toggleReviewVisibility);
router.delete("/admin/reviews/:id", adminAuth, deleteReview);

module.exports = router;
