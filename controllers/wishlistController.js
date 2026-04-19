const fs = require("fs");
const path = require("path");
const { getDbPool } = require("../config/db");
const { ensureProductStore, findProductById } = require("./productController");

const WISHLIST_TABLE = "wishlist";
const PRODUCTS_TABLE = "products";
const wishlistDataDir = path.join(__dirname, "..", "data");
const wishlistDataFile = path.join(wishlistDataDir, "wishlist.fallback.json");

let wishlistStoreReadyPromise = null;

const hasDatabaseConnection = () => Boolean(getDbPool());

const ensureWishlistFile = () => {
  if (!fs.existsSync(wishlistDataDir)) {
    fs.mkdirSync(wishlistDataDir, { recursive: true });
  }

  if (!fs.existsSync(wishlistDataFile)) {
    fs.writeFileSync(wishlistDataFile, "[]", "utf8");
  }
};

const loadWishlistFromFile = () => {
  ensureWishlistFile();

  try {
    const raw = fs.readFileSync(wishlistDataFile, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Failed to read wishlist fallback store:", error.message);
    return [];
  }
};

const saveWishlistToFile = (items) => {
  ensureWishlistFile();
  fs.writeFileSync(wishlistDataFile, JSON.stringify(items, null, 2), "utf8");
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    return res.status(statusCode).json({
      message: error.message || "Unexpected server error",
    });
  }
};

const getPoolOrThrow = () => {
  const pool = getDbPool();

  if (!pool) {
    const error = new Error("MySQL pool is not initialized");
    error.statusCode = 503;
    throw error;
  }

  return pool;
};

const parseJsonArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);

  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
};

const toIsoString = (value) => {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const mapWishlistRow = (row) => ({
  wishlistId: Number(row.wishlist_id),
  userId: row.user_id,
  id: row.product_id,
  _id: row.product_id,
  productId: row.product_id,
  name: row.name,
  price: row.price === null ? null : Number(row.price),
  mrp: row.mrp === null ? null : Number(row.mrp),
  category: row.category,
  sizes: parseJsonArray(row.sizes),
  colors: parseJsonArray(row.colors),
  description: row.description,
  stock: row.stock === null ? 0 : Number(row.stock),
  brand: row.brand,
  rating: row.rating,
  material: row.material,
  fit: row.fit,
  careInstructions: row.care_instructions,
  sku: row.sku,
  imageUrl: row.image_url,
  image: row.image_url,
  galleryImages: parseJsonArray(row.gallery_images),
  createdAt: toIsoString(row.created_at),
  updatedAt: toIsoString(row.updated_at),
  wishlistCreatedAt: toIsoString(row.wishlist_created_at),
});

const getWishlistSelectSql = () => `
  SELECT
    w.id AS wishlist_id,
    w.user_id,
    w.product_id,
    w.created_at AS wishlist_created_at,
    p.id,
    p.name,
    p.price,
    p.mrp,
    p.category,
    p.sizes,
    p.colors,
    p.description,
    p.stock,
    p.brand,
    p.rating,
    p.material,
    p.fit,
    p.care_instructions,
    p.sku,
    p.image_url,
    p.gallery_images,
    p.created_at,
    p.updated_at
  FROM ${WISHLIST_TABLE} w
  INNER JOIN ${PRODUCTS_TABLE} p ON p.id = w.product_id
`;

const ensureWishlistStore = async () => {
  if (wishlistStoreReadyPromise) {
    return wishlistStoreReadyPromise;
  }

  wishlistStoreReadyPromise = (async () => {
    await ensureProductStore();

    if (!hasDatabaseConnection()) {
      ensureWishlistFile();
      return;
    }

    const pool = getPoolOrThrow();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${WISHLIST_TABLE} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(191) NOT NULL,
        product_id CHAR(36) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wishlist_user_product (user_id, product_id),
        INDEX idx_wishlist_user_created (user_id, created_at),
        CONSTRAINT fk_wishlist_product
          FOREIGN KEY (product_id) REFERENCES ${PRODUCTS_TABLE}(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  })();

  try {
    await wishlistStoreReadyPromise;
  } catch (error) {
    wishlistStoreReadyPromise = null;
    throw error;
  }
};

exports.addWishlistItem = asyncHandler(async (req, res) => {
  await ensureWishlistStore();
  const userId = String(req.customer?.id || req.body.user_id || req.body.userId || "").trim();
  const productId = String(req.body.product_id || req.body.productId || "").trim();

  if (!userId || !productId) {
    return res.status(400).json({ message: "user_id and product_id are required" });
  }

  if (!hasDatabaseConnection()) {
    const product = await findProductById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const wishlistItems = loadWishlistFromFile();
    const existing = wishlistItems.find(
      (item) => String(item.userId) === userId && String(item.productId) === productId
    );
    const wishlistItem = existing || {
      wishlistId: Date.now(),
      userId,
      productId,
      createdAt: new Date().toISOString(),
    };

    if (!existing) {
      wishlistItems.push(wishlistItem);
      saveWishlistToFile(wishlistItems);
    }

    return res.status(existing ? 200 : 201).json({
      ...product,
      wishlistId: wishlistItem.wishlistId,
      userId,
      productId,
      wishlistCreatedAt: wishlistItem.createdAt,
    });
  }

  const pool = getPoolOrThrow();
  const [productRows] = await pool.query(
    `SELECT id FROM ${PRODUCTS_TABLE} WHERE id = ? LIMIT 1`,
    [productId]
  );

  if (!Array.isArray(productRows) || productRows.length === 0) {
    return res.status(404).json({ message: "Product not found" });
  }

  await pool.query(
    `
      INSERT INTO ${WISHLIST_TABLE} (user_id, product_id)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE id = id
    `,
    [userId, productId]
  );

  const [rows] = await pool.query(
    `${getWishlistSelectSql()} WHERE w.user_id = ? AND w.product_id = ? LIMIT 1`,
    [userId, productId]
  );

  return res.status(201).json(mapWishlistRow(rows[0]));
});

exports.getWishlistItems = asyncHandler(async (req, res) => {
  await ensureWishlistStore();
  const userId = String(req.customer?.id || req.params.userId || "").trim();

  if (!userId) {
    return res.status(400).json({ message: "userId is required" });
  }

  if (!hasDatabaseConnection()) {
    const wishlistItems = loadWishlistFromFile()
      .filter((item) => String(item.userId) === userId)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

    const products = await Promise.all(
      wishlistItems.map(async (item) => {
        const product = await findProductById(item.productId);
        return product
          ? {
              ...product,
              wishlistId: item.wishlistId,
              userId: item.userId,
              productId: item.productId,
              wishlistCreatedAt: item.createdAt,
            }
          : null;
      })
    );

    return res.json(products.filter(Boolean));
  }

  const pool = getPoolOrThrow();
  const [rows] = await pool.query(
    `${getWishlistSelectSql()} WHERE w.user_id = ? ORDER BY w.created_at DESC`,
    [userId]
  );

  return res.json(rows.map(mapWishlistRow));
});

exports.deleteWishlistItem = asyncHandler(async (req, res) => {
  await ensureWishlistStore();
  const wishlistId = String(req.params.id || "").trim();
  const userId = String(req.customer?.id || req.query.user_id || req.query.userId || "").trim();
  const productId = String(req.query.product_id || req.query.productId || "").trim();

  if (!hasDatabaseConnection()) {
    const wishlistItems = loadWishlistFromFile();
    const nextItems = wishlistItems.filter((item) => {
      if (userId && productId) {
        return !(String(item.userId) === userId && String(item.productId) === productId);
      }

      return !(String(item.wishlistId) === wishlistId && String(item.userId) === userId);
    });

    if (nextItems.length === wishlistItems.length) {
      return res.status(404).json({ message: "Wishlist item not found" });
    }

    saveWishlistToFile(nextItems);
    return res.json({ message: "Wishlist item removed successfully" });
  }

  const pool = getPoolOrThrow();
  let result;

  if (userId && productId) {
    [result] = await pool.query(
      `DELETE FROM ${WISHLIST_TABLE} WHERE user_id = ? AND product_id = ?`,
      [userId, productId]
    );
  } else {
    [result] = await pool.query(
      `DELETE FROM ${WISHLIST_TABLE} WHERE id = ? AND user_id = ?`,
      [wishlistId, userId]
    );
  }

  if (!result || result.affectedRows === 0) {
    return res.status(404).json({ message: "Wishlist item not found" });
  }

  return res.json({ message: "Wishlist item removed successfully" });
});

exports.ensureWishlistStore = ensureWishlistStore;
