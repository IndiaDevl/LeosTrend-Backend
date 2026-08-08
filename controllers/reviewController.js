const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDbPool } = require("../config/db");
const {
  ensureProductStore,
  findProductById,
  updateProductReviewStats,
} = require("./productController");

const REVIEWS_TABLE = "reviews";
const ORDERS_TABLE = "orders";
const reviewsDataDir = path.join(__dirname, "..", "data");
const reviewsDataFile = path.join(reviewsDataDir, "reviews.fallback.json");

let reviewStoreReadyPromise = null;

const hasDatabaseConnection = () => Boolean(getDbPool());

const ensureReviewsFile = () => {
  if (!fs.existsSync(reviewsDataDir)) {
    fs.mkdirSync(reviewsDataDir, { recursive: true });
  }

  if (!fs.existsSync(reviewsDataFile)) {
    fs.writeFileSync(reviewsDataFile, "[]", "utf8");
  }
};

const loadReviewsFromFile = () => {
  ensureReviewsFile();

  try {
    const raw = fs.readFileSync(reviewsDataFile, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Failed to read reviews fallback store:", error.message);
    return [];
  }
};

const saveReviewsToFile = (reviews) => {
  ensureReviewsFile();
  fs.writeFileSync(reviewsDataFile, JSON.stringify(reviews, null, 2), "utf8");
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const normalizePhone = (value) => String(value || "").replace(/\D/g, "").slice(-10);
const sanitizeText = (value) => String(value || "").trim();

const toIsoString = (value) => {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    return res.status(statusCode).json({ message: error.message || "Unexpected server error" });
  }
};

const createHttpError = (message, statusCode = 500) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const getPoolOrThrow = () => {
  const pool = getDbPool();
  if (!pool) {
    throw createHttpError("MySQL pool is not initialized", 503);
  }
  return pool;
};

const mapReviewRow = (row) => ({
  id: row.id,
  productId: row.product_id,
  customerName: row.customer_name,
  customerEmail: normalizeEmail(row.customer_email),
  customerPhone: row.customer_phone || "",
  rating: Number(row.rating || 0),
  title: row.title || "",
  comment: row.comment || "",
  isVerifiedBuyer: row.is_verified_buyer === 1 || row.is_verified_buyer === true,
  isHidden: row.is_hidden === 1 || row.is_hidden === true,
  createdAt: toIsoString(row.created_at),
  updatedAt: toIsoString(row.updated_at),
});

const ensureReviewStore = async () => {
  if (reviewStoreReadyPromise) {
    return reviewStoreReadyPromise;
  }

  reviewStoreReadyPromise = (async () => {
    await ensureProductStore();

    if (!hasDatabaseConnection()) {
      ensureReviewsFile();
      return;
    }

    const pool = getPoolOrThrow();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${REVIEWS_TABLE} (
        id CHAR(36) NOT NULL PRIMARY KEY,
        product_id CHAR(36) NOT NULL,
        customer_name VARCHAR(120) NOT NULL,
        customer_email VARCHAR(191) NULL,
        customer_phone VARCHAR(32) NULL,
        rating TINYINT NOT NULL,
        title VARCHAR(160) NULL,
        comment TEXT NOT NULL,
        is_verified_buyer TINYINT(1) NOT NULL DEFAULT 0,
        is_hidden TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_reviews_product_created (product_id, created_at),
        INDEX idx_reviews_product_hidden (product_id, is_hidden),
        INDEX idx_reviews_rating (rating),
        CONSTRAINT fk_reviews_product
          FOREIGN KEY (product_id) REFERENCES products(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  })();

  try {
    await reviewStoreReadyPromise;
  } catch (error) {
    reviewStoreReadyPromise = null;
    throw error;
  }
};

const hasOrderedProductByIdentityInFile = ({ productId, email, phone }) => {
  const ordersDataFile = path.join(__dirname, "..", "data", "orders.fallback.json");
  if (!fs.existsSync(ordersDataFile)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(ordersDataFile, "utf8");
    const orders = JSON.parse(raw || "[]");
    if (!Array.isArray(orders)) {
      return false;
    }

    return orders.some((order) => {
      const orderEmail = normalizeEmail(order?.email);
      const orderPhone = normalizePhone(order?.phoneNormalized || order?.phone);
      const identityMatches = (email && orderEmail === email) || (phone && orderPhone === phone);
      if (!identityMatches) {
        return false;
      }

      const items = Array.isArray(order?.items) ? order.items : [];
      return items.some((item) => String(item?.id || item?._id || "").trim() === productId);
    });
  } catch {
    return false;
  }
};

const hasOrderedProductByIdentity = async ({ productId, email, phone }) => {
  if (!email && !phone) {
    return false;
  }

  if (!hasDatabaseConnection()) {
    return hasOrderedProductByIdentityInFile({ productId, email, phone });
  }

  const pool = getPoolOrThrow();
  const clauses = [];
  const params = [];

  if (email) {
    clauses.push("LOWER(email) = ?");
    params.push(email);
  }

  if (phone) {
    clauses.push("phone_normalized = ?");
    params.push(phone);
  }

  if (clauses.length === 0) {
    return false;
  }

  const [rows] = await pool.query(
    `
      SELECT items
      FROM ${ORDERS_TABLE}
      WHERE ${clauses.join(" OR ")}
      ORDER BY created_at DESC
      LIMIT 80
    `,
    params
  );

  return rows.some((row) => {
    let parsedItems = [];

    try {
      parsedItems = typeof row.items === "string" ? JSON.parse(row.items || "[]") : row.items;
    } catch {
      parsedItems = [];
    }

    if (!Array.isArray(parsedItems)) {
      return false;
    }

    return parsedItems.some((item) => String(item?.id || item?._id || "").trim() === productId);
  });
};

const getReviewStatsForProduct = async (productId) => {
  await ensureReviewStore();

  if (!hasDatabaseConnection()) {
    const reviews = loadReviewsFromFile().filter(
      (review) => String(review.productId) === String(productId) && !review.isHidden
    );

    const reviewCount = reviews.length;
    const averageRating = reviewCount
      ? Number((reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviewCount).toFixed(2))
      : 0;

    return { reviewCount, averageRating };
  }

  const pool = getPoolOrThrow();
  const [rows] = await pool.query(
    `
      SELECT COUNT(*) AS reviewCount, COALESCE(AVG(rating), 0) AS averageRating
      FROM ${REVIEWS_TABLE}
      WHERE product_id = ? AND is_hidden = 0
    `,
    [String(productId)]
  );

  return {
    reviewCount: Number(rows?.[0]?.reviewCount || 0),
    averageRating: Number(Number(rows?.[0]?.averageRating || 0).toFixed(2)),
  };
};

const syncProductReviewStats = async (productId) => {
  const stats = await getReviewStatsForProduct(productId);
  await updateProductReviewStats(productId, stats);
  return stats;
};

const listPublicReviews = async ({ productId, page = 1, limit = 8 }) => {
  await ensureReviewStore();
  const safePage = Math.max(1, Math.trunc(Number(page) || 1));
  const safeLimit = Math.min(20, Math.max(1, Math.trunc(Number(limit) || 8)));

  if (!hasDatabaseConnection()) {
    const source = loadReviewsFromFile()
      .filter((review) => String(review.productId) === String(productId) && !review.isHidden)
      .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());

    const total = source.length;
    const offset = (safePage - 1) * safeLimit;
    const reviews = source.slice(offset, offset + safeLimit);

    return { reviews, total, page: safePage, limit: safeLimit };
  }

  const pool = getPoolOrThrow();
  const offset = (safePage - 1) * safeLimit;

  const [[countRow], rows] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS total FROM ${REVIEWS_TABLE} WHERE product_id = ? AND is_hidden = 0`,
      [String(productId)]
    ).then((result) => result[0]),
    pool.query(
      `
        SELECT *
        FROM ${REVIEWS_TABLE}
        WHERE product_id = ? AND is_hidden = 0
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      [String(productId), safeLimit, offset]
    ).then((result) => result[0]),
  ]);

  return {
    reviews: rows.map(mapReviewRow),
    total: Number(countRow?.total || 0),
    page: safePage,
    limit: safeLimit,
  };
};

const listAdminReviews = async ({ page = 1, limit = 20, productId = "", search = "", status = "all" }) => {
  await ensureReviewStore();
  const safePage = Math.max(1, Math.trunc(Number(page) || 1));
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)));
  const normalizedProductId = String(productId || "").trim();
  const normalizedSearch = String(search || "").trim().toLowerCase();
  const normalizedStatus = String(status || "all").trim().toLowerCase();

  const statusFilter = (review) => {
    if (normalizedStatus === "hidden") return Boolean(review.isHidden);
    if (normalizedStatus === "visible") return !review.isHidden;
    return true;
  };

  if (!hasDatabaseConnection()) {
    const source = loadReviewsFromFile()
      .filter((review) => (normalizedProductId ? String(review.productId) === normalizedProductId : true))
      .filter((review) => statusFilter(review))
      .filter((review) => {
        if (!normalizedSearch) return true;
        const haystack = [review.customerName, review.customerEmail, review.title, review.comment]
          .map((value) => String(value || "").toLowerCase())
          .join(" ");
        return haystack.includes(normalizedSearch);
      })
      .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());

    const total = source.length;
    const offset = (safePage - 1) * safeLimit;
    const reviews = source.slice(offset, offset + safeLimit);

    return { reviews, total, page: safePage, limit: safeLimit };
  }

  const pool = getPoolOrThrow();
  const clauses = [];
  const params = [];

  if (normalizedProductId) {
    clauses.push("product_id = ?");
    params.push(normalizedProductId);
  }

  if (normalizedStatus === "hidden") {
    clauses.push("is_hidden = 1");
  } else if (normalizedStatus === "visible") {
    clauses.push("is_hidden = 0");
  }

  if (normalizedSearch) {
    clauses.push("(LOWER(customer_name) LIKE ? OR LOWER(customer_email) LIKE ? OR LOWER(title) LIKE ? OR LOWER(comment) LIKE ?)");
    const likeQuery = `%${normalizedSearch}%`;
    params.push(likeQuery, likeQuery, likeQuery, likeQuery);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (safePage - 1) * safeLimit;

  const [[countRow], rows] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total FROM ${REVIEWS_TABLE} ${whereClause}`, params).then((result) => result[0]),
    pool.query(
      `
        SELECT *
        FROM ${REVIEWS_TABLE}
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      [...params, safeLimit, offset]
    ).then((result) => result[0]),
  ]);

  return {
    reviews: rows.map(mapReviewRow),
    total: Number(countRow?.total || 0),
    page: safePage,
    limit: safeLimit,
  };
};

const createReviewInFile = async (payload) => {
  const reviews = loadReviewsFromFile();
  reviews.push(payload);
  saveReviewsToFile(reviews);
  await syncProductReviewStats(payload.productId);
  return payload;
};

const createReviewInDb = async (payload) => {
  const pool = getPoolOrThrow();
  await pool.query(
    `
      INSERT INTO ${REVIEWS_TABLE} (
        id,
        product_id,
        customer_name,
        customer_email,
        customer_phone,
        rating,
        title,
        comment,
        is_verified_buyer,
        is_hidden,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      payload.id,
      payload.productId,
      payload.customerName,
      payload.customerEmail || null,
      payload.customerPhone || null,
      payload.rating,
      payload.title || null,
      payload.comment,
      payload.isVerifiedBuyer ? 1 : 0,
      payload.isHidden ? 1 : 0,
      payload.createdAt,
      payload.updatedAt,
    ]
  );

  await syncProductReviewStats(payload.productId);
  return payload;
};

exports.getProductReviews = asyncHandler(async (req, res) => {
  const productId = String(req.params.productId || "").trim();
  if (!productId) {
    return res.status(400).json({ message: "Product id is required" });
  }

  const product = await findProductById(productId);
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 8);
  const result = await listPublicReviews({ productId, page, limit });
  const stats = await getReviewStatsForProduct(productId);

  return res.json({
    reviews: result.reviews,
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / result.limit)),
    stats,
  });
});

exports.addProductReview = asyncHandler(async (req, res) => {
  await ensureReviewStore();

  const productId = String(req.params.productId || "").trim();
  const customerName = sanitizeText(req.body.customerName);
  const customerEmail = normalizeEmail(req.body.customerEmail);
  const customerPhone = normalizePhone(req.body.customerPhone);
  const title = sanitizeText(req.body.title).slice(0, 160);
  const comment = sanitizeText(req.body.comment);
  const rating = Math.trunc(Number(req.body.rating || 0));

  if (!productId) {
    return res.status(400).json({ message: "Product id is required" });
  }

  if (!customerName || customerName.length < 2) {
    return res.status(400).json({ message: "Customer name is required" });
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5" });
  }

  if (!comment || comment.length < 8) {
    return res.status(400).json({ message: "Review comment must be at least 8 characters" });
  }

  if (!customerEmail && !customerPhone) {
    return res.status(400).json({ message: "Email or phone is required" });
  }

  const product = await findProductById(productId);
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const isVerifiedBuyer = await hasOrderedProductByIdentity({
    productId,
    email: customerEmail,
    phone: customerPhone,
  });

  const payload = {
    id: crypto.randomUUID(),
    productId,
    customerName,
    customerEmail,
    customerPhone,
    rating,
    title,
    comment,
    isVerifiedBuyer,
    isHidden: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const review = hasDatabaseConnection()
    ? await createReviewInDb(payload)
    : await createReviewInFile(payload);

  const stats = await getReviewStatsForProduct(productId);

  return res.status(201).json({
    message: isVerifiedBuyer ? "Review added successfully" : "Review added. Verified-buyer badge is shown only for matched orders.",
    review,
    stats,
  });
});

exports.getAdminReviews = asyncHandler(async (req, res) => {
  await ensureReviewStore();

  const result = await listAdminReviews({
    page: Number(req.query.page || 1),
    limit: Number(req.query.limit || 20),
    productId: req.query.productId,
    search: req.query.search,
    status: req.query.status,
  });

  return res.json({
    reviews: result.reviews,
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / result.limit)),
  });
});

exports.toggleReviewVisibility = asyncHandler(async (req, res) => {
  await ensureReviewStore();

  const reviewId = String(req.params.id || "").trim();
  const shouldHide = Boolean(req.body?.isHidden);

  if (!reviewId) {
    return res.status(400).json({ message: "Review id is required" });
  }

  if (!hasDatabaseConnection()) {
    const reviews = loadReviewsFromFile();
    const index = reviews.findIndex((review) => String(review.id) === reviewId);
    if (index === -1) {
      return res.status(404).json({ message: "Review not found" });
    }

    reviews[index] = {
      ...reviews[index],
      isHidden: shouldHide,
      updatedAt: new Date().toISOString(),
    };
    saveReviewsToFile(reviews);
    await syncProductReviewStats(reviews[index].productId);

    return res.json({ message: shouldHide ? "Review hidden" : "Review visible", review: reviews[index] });
  }

  const pool = getPoolOrThrow();
  const [existingRows] = await pool.query(
    `SELECT product_id AS productId FROM ${REVIEWS_TABLE} WHERE id = ? LIMIT 1`,
    [reviewId]
  );

  if (!Array.isArray(existingRows) || existingRows.length === 0) {
    return res.status(404).json({ message: "Review not found" });
  }

  const productId = String(existingRows[0].productId || "");

  await pool.query(
    `UPDATE ${REVIEWS_TABLE} SET is_hidden = ?, updated_at = ? WHERE id = ?`,
    [shouldHide ? 1 : 0, new Date().toISOString(), reviewId]
  );

  await syncProductReviewStats(productId);

  const [rows] = await pool.query(`SELECT * FROM ${REVIEWS_TABLE} WHERE id = ? LIMIT 1`, [reviewId]);
  return res.json({
    message: shouldHide ? "Review hidden" : "Review visible",
    review: rows[0] ? mapReviewRow(rows[0]) : null,
  });
});

exports.deleteReview = asyncHandler(async (req, res) => {
  await ensureReviewStore();

  const reviewId = String(req.params.id || "").trim();
  if (!reviewId) {
    return res.status(400).json({ message: "Review id is required" });
  }

  if (!hasDatabaseConnection()) {
    const reviews = loadReviewsFromFile();
    const target = reviews.find((review) => String(review.id) === reviewId);
    if (!target) {
      return res.status(404).json({ message: "Review not found" });
    }

    const nextReviews = reviews.filter((review) => String(review.id) !== reviewId);
    saveReviewsToFile(nextReviews);
    await syncProductReviewStats(target.productId);

    return res.json({ message: "Review deleted successfully" });
  }

  const pool = getPoolOrThrow();
  const [existingRows] = await pool.query(
    `SELECT product_id AS productId FROM ${REVIEWS_TABLE} WHERE id = ? LIMIT 1`,
    [reviewId]
  );

  if (!Array.isArray(existingRows) || existingRows.length === 0) {
    return res.status(404).json({ message: "Review not found" });
  }

  const productId = String(existingRows[0].productId || "");

  await pool.query(`DELETE FROM ${REVIEWS_TABLE} WHERE id = ?`, [reviewId]);
  await syncProductReviewStats(productId);

  return res.json({ message: "Review deleted successfully" });
});
