// NOTE: This file is now used for local/dev only. Production image uploads use uploadImage.cloudinary.js
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const uploadsDir = path.join(__dirname, "..", "uploads", "products");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});
console.log("Using storage: Local Disk");

const fileFilter = (_req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("Only image files are allowed"));
  }

  cb(null, true);
};

const uploadImage = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

// Patch: Add middleware to set file.path to URL for local uploads (to match Cloudinary behavior)
function withLocalFileUrl(req, res, next) {
  if (req.files) {
    Object.values(req.files).flat().forEach(file => {
      if (file && !file.path.startsWith('http')) {
        // Set file.path to the URL that will be served by Express static
        file.path = `/uploads/products/${file.filename}`;
      }
    });
  }
  next();
}

// Export as a function that applies both multer and the patch
const uploadImageWithUrl = (...args) => [uploadImage.fields(...args), withLocalFileUrl];
uploadImage.withLocalFileUrl = withLocalFileUrl;
uploadImage.withUrl = uploadImageWithUrl;

module.exports = uploadImage;