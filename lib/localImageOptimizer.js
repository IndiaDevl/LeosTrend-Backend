const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OPTIMIZED_DIR_NAME = "_optimized";
const MAX_DIMENSION = 2400;

const normalizeDimension = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.min(MAX_DIMENSION, Math.round(parsed));
};

const normalizeQuality = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 82;
  }

  return Math.max(35, Math.min(90, Math.round(parsed)));
};

const sanitizeRelativeUploadPath = (value) => {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^uploads\//i, "");

  if (!normalized) {
    return "";
  }

  const safePath = path.posix.normalize(normalized);
  if (!safePath || safePath.startsWith("..") || safePath.includes("../")) {
    return "";
  }

  return safePath;
};

const ensureDirectory = (targetDir) => {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
};

const getOptimizedLocalImage = async (uploadsDir, relativeUploadPath, options = {}) => {
  const safeRelativePath = sanitizeRelativeUploadPath(relativeUploadPath);
  if (!safeRelativePath) {
    return null;
  }

  const sourcePath = path.resolve(uploadsDir, safeRelativePath);
  const uploadsRoot = path.resolve(uploadsDir);

  if (!sourcePath.startsWith(uploadsRoot)) {
    return null;
  }

  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return null;
  }

  const width = normalizeDimension(options.width);
  const height = normalizeDimension(options.height);
  const quality = normalizeQuality(options.quality);
  const sourceStats = fs.statSync(sourcePath);
  const parsedPath = path.parse(safeRelativePath);
  const optimizedDir = path.join(uploadsDir, OPTIMIZED_DIR_NAME, parsedPath.dir);
  const optimizedName = `${parsedPath.name}-w${width || "auto"}-h${height || "auto"}-q${quality}.webp`;
  const optimizedPath = path.join(optimizedDir, optimizedName);

  ensureDirectory(optimizedDir);

  if (fs.existsSync(optimizedPath)) {
    const optimizedStats = fs.statSync(optimizedPath);
    if (optimizedStats.mtimeMs >= sourceStats.mtimeMs) {
      return { filePath: optimizedPath, mimeType: "image/webp" };
    }
  }

  let pipeline = sharp(sourcePath, { failOn: "none" }).rotate();

  if (width || height) {
    pipeline = pipeline.resize({
      width: width || undefined,
      height: height || undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  await pipeline.webp({ quality }).toFile(optimizedPath);

  return { filePath: optimizedPath, mimeType: "image/webp" };
};

module.exports = {
  getOptimizedLocalImage,
  sanitizeRelativeUploadPath,
};