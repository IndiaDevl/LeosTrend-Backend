const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDbPool } = require("../config/db");

const PRODUCTS_TABLE = "products";
const productsDataDir = path.join(__dirname, "..", "data");
const productsDataFile = path.join(productsDataDir, "products.fallback.json");

let productStoreReadyPromise = null;

const hasDatabaseConnection = () => Boolean(getDbPool());

const ensureProductsFile = () => {
  if (!fs.existsSync(productsDataDir)) {
    fs.mkdirSync(productsDataDir, { recursive: true });
  }

  if (!fs.existsSync(productsDataFile)) {
    fs.writeFileSync(productsDataFile, "[]", "utf8");
  }
};

const loadProductsFromFile = () => {
  ensureProductsFile();

  try {
    const raw = fs.readFileSync(productsDataFile, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Failed to read products fallback store:", error.message);
    return [];
  }
};

const saveProductsToFile = (products) => {
  ensureProductsFile();
  fs.writeFileSync(productsDataFile, JSON.stringify(products, null, 2), "utf8");
};

const parseCsvField = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeImageUrlValue = (value) => {
  if (!value) return "";

  const raw = String(value).trim();
  if (!raw) return "";

  if (
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("data:") ||
    raw.startsWith("blob:")
  ) {
    return raw;
  }

  const normalizedSlashes = raw.replace(/\\/g, "/");
  const uploadsIndex = normalizedSlashes.toLowerCase().indexOf("/uploads/");
  if (uploadsIndex >= 0) {
    return normalizedSlashes.slice(uploadsIndex);
  }

  if (normalizedSlashes.startsWith("uploads/")) {
    return `/${normalizedSlashes}`;
  }

  return raw;
};

const parseGalleryField = (value) => {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeImageUrlValue(item)).filter(Boolean);
  }

  const raw = String(value || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => normalizeImageUrlValue(item)).filter(Boolean);
    }
  } catch {
    // Fall back to newline/comma separated parsing below.
  }

  return raw
    .split(/[\n,]/)
    .map((item) => normalizeImageUrlValue(item))
    .filter(Boolean);
};

const normalizeUploadedFile = (file) => {
  if (!file) return "";

  if (file.filename) {
    return `/uploads/products/${file.filename}`;
  }

  return normalizeImageUrlValue(file.path);
};

const normalizePayload = (body, files, { requireImage = false } = {}) => {
  const payload = {};

  if (body.name !== undefined) payload.name = body.name;
  if (body.price !== undefined) payload.price = Number(body.price);
  if (body.mrp !== undefined && body.mrp !== "") payload.mrp = Number(body.mrp);
  if (body.category !== undefined) payload.category = body.category;
  if (body.sizes !== undefined) payload.sizes = parseCsvField(body.sizes);
  if (body.colors !== undefined) payload.colors = parseCsvField(body.colors);
  if (body.description !== undefined) payload.description = body.description;
  if (body.stock !== undefined) payload.stock = Number(body.stock);
  if (body.brand !== undefined) payload.brand = body.brand;
  if (body.rating !== undefined) payload.rating = body.rating;
  if (body.material !== undefined) payload.material = body.material;
  if (body.fit !== undefined) payload.fit = body.fit;
  if (body.careInstructions !== undefined) payload.careInstructions = body.careInstructions;
  if (body.sku !== undefined) payload.sku = body.sku;

  const primaryFile = files?.image?.[0];
  const galleryFiles = Array.isArray(files?.galleryImages) ? files.galleryImages : [];

  if (primaryFile?.path || primaryFile?.filename) {
    payload.imageUrl = normalizeUploadedFile(primaryFile);
  } else if (body.imageUrl) {
    payload.imageUrl = normalizeImageUrlValue(body.imageUrl);
  } else if (body.image) {
    payload.imageUrl = normalizeImageUrlValue(body.image);
  }

  const galleryFromBody = parseGalleryField(body.galleryImages);
  const galleryFromFiles = galleryFiles.map((file) => normalizeUploadedFile(file)).filter(Boolean);

  if (galleryFromBody !== undefined || galleryFromFiles.length > 0) {
    payload.galleryImages = [...new Set([...(galleryFromBody || []), ...galleryFromFiles])];
  }

  if (requireImage && !payload.imageUrl) {
    const error = new Error("Product image is required");
    error.statusCode = 400;
    throw error;
  }

  return payload;
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error("PRODUCT CONTROLLER ERROR:");
    console.error(error);

    const statusCode = Number(error.statusCode) || 500;

    return res.status(statusCode).json({
      message: error.message || "Unexpected server error",
    });
  }
};

const sortProductsDesc = (items = []) => {
  return [...items].sort((a, b) => {
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });
};

const normalizeStoredProduct = (product) => {
  const safeImageUrl = normalizeImageUrlValue(product.imageUrl || product.image);
  const safeGalleryImages = [...new Set(
    (Array.isArray(product.galleryImages) ? product.galleryImages : [])
      .map((image) => normalizeImageUrlValue(image))
      .filter(Boolean)
  )];
  const mergedImages = [...new Set([safeImageUrl, ...safeGalleryImages].filter(Boolean))];

  return {
    ...product,
    imageUrl: safeImageUrl || mergedImages[0] || "",
    image: safeImageUrl || mergedImages[0] || "",
    images: mergedImages,
    galleryImages: mergedImages.slice(1),
    additionalImages: mergedImages.slice(1),
    gallery: mergedImages.slice(1),
  };
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

const mapRowToProduct = (row) => {
  return normalizeStoredProduct({
    _id: row.id,
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
    galleryImages: parseJsonArray(row.gallery_images),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
};

const insertProductRecord = async (connection, product) => {
  await connection.query(
    `
      INSERT INTO ${PRODUCTS_TABLE} (
        id,
        name,
        price,
        mrp,
        category,
        sizes,
        colors,
        description,
        stock,
        brand,
        rating,
        material,
        fit,
        care_instructions,
        sku,
        image_url,
        gallery_images,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      product._id,
      product.name || "",
      Number(product.price || 0),
      product.mrp === undefined || product.mrp === null || product.mrp === "" ? null : Number(product.mrp),
      product.category || "",
      JSON.stringify(Array.isArray(product.sizes) ? product.sizes : []),
      JSON.stringify(Array.isArray(product.colors) ? product.colors : []),
      product.description || "",
      Number(product.stock || 0),
      product.brand || "",
      product.rating || "",
      product.material || "",
      product.fit || "",
      product.careInstructions || "",
      product.sku || "",
      product.imageUrl || "",
      JSON.stringify(Array.isArray(product.galleryImages) ? product.galleryImages : []),
      product.createdAt,
      product.updatedAt,
    ]
  );
};

const ensureProductStore = async () => {
  if (productStoreReadyPromise) {
    return productStoreReadyPromise;
  }

  productStoreReadyPromise = (async () => {
    if (!hasDatabaseConnection()) {
      ensureProductsFile();
      return;
    }

    const pool = getPoolOrThrow();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${PRODUCTS_TABLE} (
        id CHAR(36) NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10, 2) NOT NULL DEFAULT 0,
        mrp DECIMAL(10, 2) NULL,
        category VARCHAR(120) NOT NULL,
        sizes JSON NOT NULL,
        colors JSON NOT NULL,
        description TEXT NULL,
        stock INT NOT NULL DEFAULT 0,
        brand VARCHAR(120) NULL,
        rating VARCHAR(64) NULL,
        material VARCHAR(255) NULL,
        fit VARCHAR(120) NULL,
        care_instructions TEXT NULL,
        sku VARCHAR(120) NULL,
        image_url TEXT NOT NULL,
        gallery_images JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_products_created_at (created_at),
        INDEX idx_products_category (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [stockColumns] = await pool.query(`SHOW COLUMNS FROM ${PRODUCTS_TABLE} LIKE 'stock'`);
    if (!Array.isArray(stockColumns) || stockColumns.length === 0) {
      await pool.query(`
        ALTER TABLE ${PRODUCTS_TABLE}
        ADD COLUMN stock INT NOT NULL DEFAULT 0 AFTER description
      `);
    }
  })();

  try {
    await productStoreReadyPromise;
  } catch (error) {
    productStoreReadyPromise = null;
    throw error;
  }
};

const readProductsFromStore = async () => {
  await ensureProductStore();

  if (!hasDatabaseConnection()) {
    return sortProductsDesc(loadProductsFromFile()).map(normalizeStoredProduct);
  }

  const pool = getPoolOrThrow();
  const [rows] = await pool.query(`SELECT * FROM ${PRODUCTS_TABLE} ORDER BY created_at DESC`);
  return rows.map(mapRowToProduct);
};

const findProductById = async (productId) => {
  const normalizedId = String(productId || "").trim();
  if (!normalizedId) return null;

  await ensureProductStore();

  if (!hasDatabaseConnection()) {
    const products = loadProductsFromFile().map(normalizeStoredProduct);
    return products.find((product) => String(product._id) === normalizedId) || null;
  }

  const pool = getPoolOrThrow();
  const [rows] = await pool.query(`SELECT * FROM ${PRODUCTS_TABLE} WHERE id = ? LIMIT 1`, [normalizedId]);
  return rows[0] ? mapRowToProduct(rows[0]) : null;
};

const reserveProductStockInFile = async (items) => {
  const products = loadProductsFromFile().map(normalizeStoredProduct);
  const productMap = new Map(products.map((product) => [String(product._id), product]));

  for (const item of Array.isArray(items) ? items : []) {
    const productId = String(item?.id || item?._id || "").trim();
    const quantity = Math.trunc(Number(item?.quantity || 0));

    if (!productId) {
      const error = new Error("Each order item must include a product id");
      error.statusCode = 400;
      throw error;
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      const error = new Error(`Invalid quantity for product ${productId}`);
      error.statusCode = 400;
      throw error;
    }

    const product = productMap.get(productId);
    if (!product) {
      const error = new Error(`${String(item?.name || 'Product').trim() || 'Product'} is no longer available`);
      error.statusCode = 404;
      throw error;
    }

    const availableStock = Number(product.stock || 0);
    if (availableStock <= 0) {
      const error = new Error(`${product.name || item.name} is out of stock`);
      error.statusCode = 409;
      throw error;
    }

    if (availableStock < quantity) {
      const error = new Error(`Only ${availableStock} left for ${product.name || item.name}`);
      error.statusCode = 409;
      throw error;
    }

    product.stock = availableStock - quantity;
    product.updatedAt = new Date().toISOString();
  }

  saveProductsToFile(products);
};

exports.addProduct = asyncHandler(async (req, res) => {
  await ensureProductStore();
  const payload = normalizePayload(req.body, req.files, { requireImage: true });
  const timestamp = new Date().toISOString();

  const product = normalizeStoredProduct({
    _id: crypto.randomUUID(),
    ...payload,
    image: payload.imageUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  if (!hasDatabaseConnection()) {
    const products = sortProductsDesc(loadProductsFromFile().map(normalizeStoredProduct));
    products.unshift(product);
    saveProductsToFile(products);
    return res.status(201).json(product);
  }

  const pool = getPoolOrThrow();
  await insertProductRecord(pool, product);
  return res.status(201).json(product);
});

exports.getProducts = asyncHandler(async (_req, res) => {
  return res.json(await readProductsFromStore());
});

exports.updateProduct = asyncHandler(async (req, res) => {
  await ensureProductStore();
  const payload = normalizePayload(req.body, req.files);

  if (!payload.imageUrl) {
    delete payload.imageUrl;
  }

  const existing = await findProductById(req.params.id);

  if (!existing) {
    return res.status(404).json({ message: "Product not found" });
  }

  const updatedProduct = normalizeStoredProduct({
    ...existing,
    ...payload,
    image: payload.imageUrl || existing.image || existing.imageUrl,
    galleryImages:
      payload.galleryImages !== undefined
        ? payload.galleryImages
        : existing.galleryImages || existing.images?.slice(1) || [],
    updatedAt: new Date().toISOString(),
  });

  if (!hasDatabaseConnection()) {
    const products = loadProductsFromFile().map(normalizeStoredProduct);
    const nextProducts = products.map((product) =>
      String(product._id) === String(req.params.id) ? updatedProduct : product
    );
    saveProductsToFile(nextProducts);
    return res.json(updatedProduct);
  }

  const pool = getPoolOrThrow();
  await pool.query(
    `
      UPDATE ${PRODUCTS_TABLE}
      SET
        name = ?,
        price = ?,
        mrp = ?,
        category = ?,
        sizes = ?,
        colors = ?,
        description = ?,
        stock = ?,
        brand = ?,
        rating = ?,
        material = ?,
        fit = ?,
        care_instructions = ?,
        sku = ?,
        image_url = ?,
        gallery_images = ?,
        updated_at = ?
      WHERE id = ?
    `,
    [
      updatedProduct.name || "",
      Number(updatedProduct.price || 0),
      updatedProduct.mrp === undefined || updatedProduct.mrp === null || updatedProduct.mrp === "" ? null : Number(updatedProduct.mrp),
      updatedProduct.category || "",
      JSON.stringify(Array.isArray(updatedProduct.sizes) ? updatedProduct.sizes : []),
      JSON.stringify(Array.isArray(updatedProduct.colors) ? updatedProduct.colors : []),
      updatedProduct.description || "",
      Number(updatedProduct.stock || 0),
      updatedProduct.brand || "",
      updatedProduct.rating || "",
      updatedProduct.material || "",
      updatedProduct.fit || "",
      updatedProduct.careInstructions || "",
      updatedProduct.sku || "",
      updatedProduct.imageUrl || "",
      JSON.stringify(Array.isArray(updatedProduct.galleryImages) ? updatedProduct.galleryImages : []),
      updatedProduct.updatedAt,
      req.params.id,
    ]
  );

  return res.json(updatedProduct);
});

exports.deleteProduct = asyncHandler(async (req, res) => {
  await ensureProductStore();

  if (!hasDatabaseConnection()) {
    const products = loadProductsFromFile().map(normalizeStoredProduct);
    const nextProducts = products.filter((product) => String(product._id) !== String(req.params.id));

    if (nextProducts.length === products.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    saveProductsToFile(nextProducts);
    return res.json({ message: "Product deleted successfully" });
  }

  const pool = getPoolOrThrow();
  const [result] = await pool.query(`DELETE FROM ${PRODUCTS_TABLE} WHERE id = ?`, [req.params.id]);

  if (result.affectedRows === 0) {
    return res.status(404).json({ message: "Product not found" });
  }

  return res.json({ message: "Product deleted successfully" });
});

exports.ensureProductStore = ensureProductStore;
exports.findProductById = findProductById;
exports.reserveProductStockInFile = reserveProductStockInFile;
