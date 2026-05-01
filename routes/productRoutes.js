const express = require("express");
const {
  addProduct,
  getProducts,
  updateProduct,
  deleteProduct,
} = require("../controllers/productController");
const adminAuth = require("../middleware/adminAuth");
const uploadImage = require("../middleware/uploadImage.cloudinary");

const router = express.Router();

const productImageUpload = uploadImage.fields([
  { name: "image", maxCount: 1 },
  { name: "galleryImages", maxCount: 8 },
]);

router.post("/", adminAuth, productImageUpload, addProduct);
router.get("/", getProducts);
router.put("/:id", adminAuth, productImageUpload, updateProduct);
router.delete("/:id", adminAuth, deleteProduct);

module.exports = router;
