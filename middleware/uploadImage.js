const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

const hasRealCloudinaryConfig = () => {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();

  const placeholders = new Set(["x", "xx", "xxx", "your-cloud-name", "your-cloudinary-api-key", "your-cloudinary-api-secret"]);

  return (
    cloudName &&
    apiKey &&
    apiSecret &&
    !placeholders.has(cloudName.toLowerCase()) &&
    !placeholders.has(apiKey.toLowerCase()) &&
    !placeholders.has(apiSecret.toLowerCase())
  );
};

const uploadsDir = path.join(__dirname, "..", "uploads", "products");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const localDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});

const cloudinaryStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "yantra2/products",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 1200, crop: "limit" }],
  },
});

const storage = hasRealCloudinaryConfig() ? cloudinaryStorage : localDiskStorage;

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

module.exports = uploadImage;