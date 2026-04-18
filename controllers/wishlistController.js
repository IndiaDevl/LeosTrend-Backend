const { getDbPool } = require("../config/db");
const { ensureProductStore } = require("./productController");

const WISHLIST_TABLE = "wishlist";
const PRODUCTS_TABLE = "products";

let wishlistStoreReadyPromise = null;

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
  const pool = getPoolOrThrow();
  const userId = String(req.customer?.id || req.body.user_id || req.body.userId || "").trim();
  const productId = String(req.body.product_id || req.body.productId || "").trim();

  if (!userId || !productId) {
    return res.status(400).json({ message: "user_id and product_id are required" });
  }

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
  const pool = getPoolOrThrow();
  const userId = String(req.customer?.id || req.params.userId || "").trim();

  if (!userId) {
    return res.status(400).json({ message: "userId is required" });
  }

  const [rows] = await pool.query(
    `${getWishlistSelectSql()} WHERE w.user_id = ? ORDER BY w.created_at DESC`,
    [userId]
  );

  return res.json(rows.map(mapWishlistRow));
});

exports.deleteWishlistItem = asyncHandler(async (req, res) => {
  await ensureWishlistStore();
  const pool = getPoolOrThrow();
  const wishlistId = String(req.params.id || "").trim();
  const userId = String(req.customer?.id || req.query.user_id || req.query.userId || "").trim();
  const productId = String(req.query.product_id || req.query.productId || "").trim();

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
