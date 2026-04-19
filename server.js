console.log("RUNNING BACKEND FROM:", __filename);

require('dotenv').config();

const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const express = require('express');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { connectDB, getDbPool, getMissingDbEnvVars } = require('./config/db');
const { ensureProductStore } = require('./controllers/productController');
const productRoutes = require('./routes/productRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const { ensureWishlistStore } = require('./controllers/wishlistController');
const wishlistRoutes = require('./routes/wishlistRoutes');
const adminAuth = require('./middleware/adminAuth');
const app = express();

// JSON body
app.use(express.json({ limit: '50mb' }));

// CORS (works perfectly on Render + Node 22)
app.use(cors({
  origin: true,
  credentials: true
}));


const distDir = path.join(__dirname, 'dist');
const distIndexFile = path.join(distDir, 'index.html');
const hasFrontendBuild = fs.existsSync(distIndexFile);

// Serve static frontend files
if (hasFrontendBuild) {
  app.use(express.static(distDir));
}


const PRODUCTS_TABLE = 'products';

const ORDER_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

const ORDER_STATUS_LABELS = {
  [ORDER_STATUS.PENDING]: 'Pending',
  [ORDER_STATUS.CONFIRMED]: 'Confirmed',
  [ORDER_STATUS.SHIPPED]: 'Shipped',
  [ORDER_STATUS.DELIVERED]: 'Delivered',
  [ORDER_STATUS.CANCELLED]: 'Cancelled',
};

const ORDER_STATUS_FLOW = [
  ORDER_STATUS.PENDING,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.DELIVERED,
];

const isValidStatusTransition = (current, next) => {
  if (current === next) return true;
  if (next === ORDER_STATUS.CANCELLED) return current !== ORDER_STATUS.DELIVERED;
  if (current === ORDER_STATUS.CANCELLED || current === ORDER_STATUS.DELIVERED) return false;

  const currentIndex = ORDER_STATUS_FLOW.indexOf(current);
  const nextIndex = ORDER_STATUS_FLOW.indexOf(next);

  if (currentIndex === -1 || nextIndex === -1) return false;
  return nextIndex >= currentIndex;
};

const normalizePhone = (value) => {
  const digitsOnly = String(value || '').replace(/\D/g, '');
  if (!digitsOnly) return '';
  return digitsOnly.length > 10 ? digitsOnly.slice(-10) : digitsOnly;
};

const MAIL_FROM_EMAIL = process.env.MAIL_FROM_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'lt@leostrend.com';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'LeosTrend';
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || process.env.ADMIN_NOTIFICATION_EMAIL || process.env.SENDGRID_FROM_EMAIL || MAIL_FROM_EMAIL;
const ADMIN_NOTIFICATION_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || 'n.sukumar056@gmail.com';
const PUBLIC_BACKEND_URL = String(process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/$/, '');
const parseEmailRecipients = (...values) => {
  const seen = new Set();

  return values
    .flatMap((value) => String(value || '').split(/[;,\s]+/))
    .map((item) => item.trim())
    .filter((item) => /.+@.+\..+/.test(item))
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
};
const ADMIN_RECIPIENTS = parseEmailRecipients(
  ADMIN_NOTIFICATION_EMAIL,
  MAIL_REPLY_TO,
  MAIL_FROM_EMAIL,
  process.env.SENDGRID_FROM_EMAIL
);
const canSendGridEmails = Boolean(process.env.SENDGRID_API_KEY);
const canSendSmtpEmails = Boolean(process.env.SMTP_HOST);
const canSendEmails = canSendGridEmails || canSendSmtpEmails;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true' || smtpPort === 465;
const smtpTransporter = canSendSmtpEmails
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: smtpSecure,
      auth: process.env.SMTP_USER && process.env.SMTP_PASS
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          }
        : undefined,
    })
  : null;

const isLocalDevOrigin = (origin) => {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || '').trim());
};

// JSON body
app.use(express.json({ limit: '50mb' }));

const configuredOrigins = [
  ...String(process.env.CORS_ORIGIN || "")
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const allowedOrigins = [...new Set(configuredOrigins)];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || isLocalDevOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for this origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));
app.use('/api/products', productRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/payment', paymentRoutes);


const INLINE_IMAGE_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

// POST: Admin login (real logic)
app.post('/api/admin/login', (req, res) => {
  const { username, password, rememberMe = false } = req.body;

  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;
  const expectedPassHash = process.env.ADMIN_PASSWORD_HASH;
  const jwtSecret = process.env.ADMIN_JWT_SECRET;
  const fallbackToken = process.env.ADMIN_TOKEN;

  if (!expectedUser || (!expectedPass && !expectedPassHash)) {
    return res.status(500).json({ message: 'Admin credentials are not configured' });
  }

  if (!jwtSecret && !fallbackToken) {
    return res.status(500).json({ message: 'Admin token configuration is missing' });
  }

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  if (username !== expectedUser) {
    return res.status(401).json({ message: 'Invalid admin credentials' });
  }

  let passwordOk = false;

  if (expectedPassHash) {
    passwordOk = bcrypt.compareSync(password, expectedPassHash);
  } else {
    passwordOk = password === expectedPass;
  }

  if (!passwordOk) {
    return res.status(401).json({ message: 'Invalid admin credentials' });
  }

  const expiresIn = rememberMe ? '30d' : '12h';
  const expiresAt = Date.now() + (rememberMe ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000);

  let token;

  if (jwtSecret) {
    token = jwt.sign(
      {
        role: 'admin',
        sub: expectedUser,
        jti: crypto.randomUUID(),
      },
      jwtSecret,
      { expiresIn }
    );
  } else {
    token = fallbackToken;
  }

  return res.json({
    token,
    role: 'admin',
    expiresAt,
  });
});

// GET: Admin login (for testing only)
app.get('/api/admin/login', (req, res) => {
  res.json({ message: 'Admin login endpoint is alive. Use POST for login.' });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  const jti = req.admin?.jti;
  if (jti) {
    adminAuth.revokeAdminTokenById(jti);
  }

  return res.json({ message: 'Logged out successfully' });
});

const ORDERS_TABLE = 'orders';

let ordersStoreReadyPromise = null;
let ordersRevenueColumnPromise = null;

const normalizeOrderId = (value) => String(value ?? '').trim();

const getOrdersPoolOrThrow = () => {
  const pool = getDbPool();

  if (!pool) {
    throw new Error('MySQL pool is not initialized');
  }

  return pool;
};

const parseOrderJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const toIsoValue = (value) => {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

const toSqlDateValue = (value, { allowNull = false } = {}) => {
  if (!value) return allowNull ? null : new Date();

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return allowNull ? null : new Date();
  }

  return date;
};

const createHttpError = (message, statusCode = 500) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const normalizeOrderItemsForStock = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw createHttpError('Order must include at least one item', 400);
  }

  const aggregatedItems = new Map();

  for (const item of items) {
    const productId = String(item?.id || item?._id || '').trim();
    const quantity = Math.trunc(Number(item?.quantity || 0));

    if (!productId) {
      throw createHttpError('Each order item must include a product id', 400);
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw createHttpError(`Invalid quantity for product ${productId}`, 400);
    }

    const existingItem = aggregatedItems.get(productId);
    aggregatedItems.set(productId, {
      productId,
      name: String(item?.name || existingItem?.name || 'Product').trim() || 'Product',
      quantity: (existingItem?.quantity || 0) + quantity,
    });
  }

  return Array.from(aggregatedItems.values());
};

const reserveProductStock = async (connection, items) => {
  const normalizedItems = normalizeOrderItemsForStock(items);
  const productIds = normalizedItems.map((item) => item.productId);
  const placeholders = productIds.map(() => '?').join(', ');

  const [rows] = await connection.query(
    `SELECT id, name, stock FROM ${PRODUCTS_TABLE} WHERE id IN (${placeholders}) FOR UPDATE`,
    productIds
  );

  const productMap = new Map(rows.map((row) => [String(row.id), row]));

  for (const item of normalizedItems) {
    const productRow = productMap.get(item.productId);

    if (!productRow) {
      throw createHttpError(`${item.name} is no longer available`, 404);
    }

    const availableStock = Number(productRow.stock || 0);

    if (availableStock <= 0) {
      throw createHttpError(`${productRow.name || item.name} is out of stock`, 409);
    }

    if (availableStock < item.quantity) {
      throw createHttpError(`Only ${availableStock} left for ${productRow.name || item.name}`, 409);
    }

    const [updateResult] = await connection.query(
      `UPDATE ${PRODUCTS_TABLE} SET stock = stock - ? WHERE id = ? AND stock >= ?`,
      [item.quantity, item.productId, item.quantity]
    );

    if (!updateResult?.affectedRows) {
      throw createHttpError(`${productRow.name || item.name} does not have enough stock`, 409);
    }
  }
};

const mapRowToOrder = (row) => ({
  id: Number(row.id),
  orderNumber: row.order_number,
  date: toIsoValue(row.order_date),
  customer: row.customer,
  phone: row.phone,
  phoneNormalized: row.phone_normalized,
  email: String(row.email || '').trim().toLowerCase(),
  items: Array.isArray(parseOrderJson(row.items, [])) ? parseOrderJson(row.items, []) : [],
  total: Number(row.total || 0),
  shippingAddress: row.shipping_address || '',
  payment: parseOrderJson(row.payment, {}),
  status: row.status,
  statusTimeline: Array.isArray(parseOrderJson(row.status_timeline, [])) ? parseOrderJson(row.status_timeline, []) : [],
  lastUpdatedAt: toIsoValue(row.last_updated_at),
  createdAt: toIsoValue(row.created_at),
  updatedAt: toIsoValue(row.updated_at),
});

const insertOrderRecord = async (connection, order) => {
  await connection.query(
    `
      INSERT INTO ${ORDERS_TABLE} (
        id,
        order_number,
        order_date,
        customer,
        phone,
        phone_normalized,
        email,
        items,
        total,
        shipping_address,
        payment,
        status,
        status_timeline,
        last_updated_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      Number(order.id),
      order.orderNumber,
      toSqlDateValue(order.date),
      order.customer || '',
      order.phone || '',
      normalizePhone(order.phoneNormalized || order.phone),
      String(order.email || '').trim().toLowerCase(),
      JSON.stringify(Array.isArray(order.items) ? order.items : []),
      Number(order.total || 0),
      order.shippingAddress || '',
      JSON.stringify(order.payment || {}),
      order.status || ORDER_STATUS.PENDING,
      JSON.stringify(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
      toSqlDateValue(order.lastUpdatedAt, { allowNull: true }),
      toSqlDateValue(order.createdAt || order.date),
      toSqlDateValue(order.updatedAt || order.lastUpdatedAt || order.date),
    ]
  );
};

const ensureOrdersStore = async () => {
  if (ordersStoreReadyPromise) {
    return ordersStoreReadyPromise;
  }

  ordersStoreReadyPromise = (async () => {
    const pool = getOrdersPoolOrThrow();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${ORDERS_TABLE} (
        id BIGINT NOT NULL PRIMARY KEY,
        order_number VARCHAR(32) NOT NULL,
        order_date DATETIME(3) NOT NULL,
        customer VARCHAR(255) NOT NULL,
        phone VARCHAR(32) NOT NULL,
        phone_normalized VARCHAR(16) NOT NULL,
        email VARCHAR(255) NULL,
        items JSON NOT NULL,
        total DECIMAL(10, 2) NOT NULL DEFAULT 0,
        shipping_address TEXT NULL,
        payment JSON NOT NULL,
        status VARCHAR(32) NOT NULL,
        status_timeline JSON NOT NULL,
        last_updated_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_orders_phone_normalized (phone_normalized),
        INDEX idx_orders_email (email),
        INDEX idx_orders_status (status),
        INDEX idx_orders_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM ${ORDERS_TABLE}`);
    const totalOrders = Number(countRows[0]?.total || 0);

    if (totalOrders > 0) {
      return;
    }
  })();

  try {
    await ordersStoreReadyPromise;
  } catch (error) {
    ordersStoreReadyPromise = null;
    throw error;
  }
};

const fetchOrderById = async (orderId) => {
  await ensureOrdersStore();
  const pool = getOrdersPoolOrThrow();
  const [rows] = await pool.query(`SELECT * FROM ${ORDERS_TABLE} WHERE id = ? LIMIT 1`, [Number(orderId)]);
  return rows[0] ? mapRowToOrder(rows[0]) : null;
};

const fetchOrdersForAdmin = async () => {
  await ensureOrdersStore();
  const pool = getOrdersPoolOrThrow();
  const [rows] = await pool.query(`SELECT * FROM ${ORDERS_TABLE} ORDER BY id DESC`);
  return rows.map(mapRowToOrder);
};

const fetchOrdersForCustomer = async ({ phone, email }) => {
  await ensureOrdersStore();
  const pool = getOrdersPoolOrThrow();
  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!normalizedPhone && !normalizedEmail) {
    return [];
  }

  const whereClauses = [];
  const params = [];

  if (normalizedPhone) {
    whereClauses.push('phone_normalized = ?');
    params.push(normalizedPhone);
  }

  if (normalizedEmail) {
    whereClauses.push('LOWER(email) = ?');
    params.push(normalizedEmail);
  }

  const [rows] = await pool.query(
    `SELECT * FROM ${ORDERS_TABLE} WHERE ${whereClauses.join(' OR ')} ORDER BY id DESC`,
    params
  );

  return rows.map(mapRowToOrder);
};

const updateStoredOrder = async (order) => {
  await ensureOrdersStore();
  const pool = getOrdersPoolOrThrow();
  await pool.query(
    `
      UPDATE ${ORDERS_TABLE}
      SET
        order_number = ?,
        order_date = ?,
        customer = ?,
        phone = ?,
        phone_normalized = ?,
        email = ?,
        items = ?,
        total = ?,
        shipping_address = ?,
        payment = ?,
        status = ?,
        status_timeline = ?,
        last_updated_at = ?,
        updated_at = ?
      WHERE id = ?
    `,
    [
      order.orderNumber,
      toSqlDateValue(order.date),
      order.customer || '',
      order.phone || '',
      normalizePhone(order.phoneNormalized || order.phone),
      String(order.email || '').trim().toLowerCase(),
      JSON.stringify(Array.isArray(order.items) ? order.items : []),
      Number(order.total || 0),
      order.shippingAddress || '',
      JSON.stringify(order.payment || {}),
      order.status || ORDER_STATUS.PENDING,
      JSON.stringify(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
      toSqlDateValue(order.lastUpdatedAt, { allowNull: true }),
      toSqlDateValue(order.updatedAt || order.lastUpdatedAt || order.date),
      Number(order.id),
    ]
  );

  return fetchOrderById(order.id);
};

const getOrdersRevenueColumn = async () => {
  if (ordersRevenueColumnPromise) {
    return ordersRevenueColumnPromise;
  }

  ordersRevenueColumnPromise = (async () => {
    const pool = getOrdersPoolOrThrow();

    const [totalPriceColumns] = await pool.query(`SHOW COLUMNS FROM ${ORDERS_TABLE} LIKE 'total_price'`);
    if (Array.isArray(totalPriceColumns) && totalPriceColumns.length > 0) {
      return 'total_price';
    }

    const [totalColumns] = await pool.query(`SHOW COLUMNS FROM ${ORDERS_TABLE} LIKE 'total'`);
    const revenueColumn = Array.isArray(totalColumns) && totalColumns.length > 0 ? 'total' : '';

    if (!revenueColumn) {
      throw new Error('Orders revenue column not found');
    }

    return revenueColumn;
  })();

  try {
    return await ordersRevenueColumnPromise;
  } catch (error) {
    ordersRevenueColumnPromise = null;
    throw error;
  }
};

const getAdminStatsRangeConfig = (rawRange) => {
  const normalizedRange = String(rawRange || 'all').trim().toLowerCase();

  switch (normalizedRange) {
    case 'today':
      return {
        range: 'today',
        whereClause: 'WHERE created_at >= CURDATE()',
      };
    case '7d':
      return {
        range: '7d',
        whereClause: 'WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)',
      };
    case '30d':
      return {
        range: '30d',
        whereClause: 'WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)',
      };
    case 'all':
    default:
      return {
        range: 'all',
        whereClause: '',
      };
  }
};

const formatOrderItemsText = (items = []) => {
  if (!Array.isArray(items) || items.length === 0) return 'No items';
  return items
    .map((item) => {
      const price = Number(item.price || 0);
      const quantity = Number(item.quantity || 0);
      const imageUrl = getEmailSafeImageUrl(item.image);
      const imageText = imageUrl ? ` | Image: ${imageUrl}` : '';
      return `${item.name} | Size: ${item.size || 'M'} | Qty: ${quantity} | Unit Price: Rs ${price.toFixed(2)} | Line Total: Rs ${(price * quantity).toFixed(2)}${imageText}`;
    })
    .join('\n');
};

const formatOrderItemsHtml = (items = []) => {
  if (!Array.isArray(items) || items.length === 0) return '<tr><td colspan="5">No items</td></tr>';
  return items
    .map((item) => {
      const price = Number(item.price || 0);
      const quantity = Number(item.quantity || 0);
      return `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(item.name || 'Unnamed item')}</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(item.size || 'M')}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${quantity}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">Rs ${price.toFixed(2)}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">Rs ${(price * quantity).toFixed(2)}</td>
        </tr>
      `;
    })
    .join('');
};

const getUploadFilePathFromImage = (image) => {
  const imageValue = String(image || '').trim().replace(/\\/g, '/');
  if (!imageValue) return '';

  let uploadPath = '';
  if (imageValue.startsWith('/uploads/')) {
    uploadPath = imageValue.replace(/^\/uploads\//, '');
  } else if (imageValue.startsWith('uploads/')) {
    uploadPath = imageValue.replace(/^uploads\//, '');
  } else {
    return '';
  }

  const safePath = path.normalize(uploadPath).replace(/^\.\.(\/|\\|$)+/, '');
  const absolutePath = path.resolve(uploadsDir, safePath);

  if (!absolutePath.startsWith(path.resolve(uploadsDir))) {
    return '';
  }

  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    return '';
  }

  return absolutePath;
};

const getMimeTypeForImagePath = (filePath) => {
  const ext = path.extname(filePath || '').toLowerCase();
  return INLINE_IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
};

const resolveOrderItemImageSource = (image, index) => {
  const imageValue = String(image || '').trim();
  if (!imageValue) {
    return { src: '', attachment: null };
  }

  const toInlineAttachment = (localUploadFile) => {
    try {
      const fileName = path.basename(localUploadFile);
      const fileBuffer = fs.readFileSync(localUploadFile);
      const contentType = getMimeTypeForImagePath(localUploadFile);
      const cidHash = crypto
        .createHash('sha1')
        .update(`${fileName}:${index}`)
        .digest('hex');
      const cid = `order-item-${cidHash}@leostrend`;

      console.log(`[Email] Embedding image as CID: ${cid} (${fileName}, ${fileBuffer.length} bytes)`);

      return {
        src: `cid:${cid}`,
        attachment: {
          cid,
          filename: fileName,
          contentType,
          contentBase64: fileBuffer.toString('base64'),
        },
      };
    } catch (readError) {
      console.warn(`[Email] Could not read image file ${localUploadFile}:`, readError.message);
      return null;
    }
  };

  if (imageValue.startsWith('http://') || imageValue.startsWith('https://')) {
    try {
      const parsed = new URL(imageValue);
      const host = String(parsed.hostname || '').toLowerCase();
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      const localUploadFile = isLocalHost ? getUploadFilePathFromImage(parsed.pathname) : '';

      if (localUploadFile) {
        const inlineResult = toInlineAttachment(localUploadFile);
        if (inlineResult) return inlineResult;
      }
    } catch (parseError) {
      console.warn('[Email] Could not parse image URL:', imageValue, parseError.message);
    }

    return { src: imageValue, attachment: null };
  }

  const localUploadFile = getUploadFilePathFromImage(imageValue);

  if (localUploadFile) {
    const inlineResult = toInlineAttachment(localUploadFile);
    if (inlineResult) return inlineResult;
  }

  if (PUBLIC_BACKEND_URL) {
    const normalizedPath = imageValue.startsWith('/') ? imageValue : `/${imageValue}`;
    return { src: `${PUBLIC_BACKEND_URL}${normalizedPath}`, attachment: null };
  }

  return { src: '', attachment: null };
};

const getEmailSafeImageUrl = (image) => {
  const imageValue = String(image || '').trim();
  if (!imageValue) return '';

  if (imageValue.startsWith('http://') || imageValue.startsWith('https://')) {
    return imageValue;
  }

  if (!PUBLIC_BACKEND_URL) {
    return '';
  }

  const normalizedPath = imageValue.startsWith('/') ? imageValue : `/${imageValue}`;
  return `${PUBLIC_BACKEND_URL}${normalizedPath}`;
};

const formatOrderItemsCardsHtml = (items = []) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { html: '<p style="margin:0;color:#64748b;">No items in this order.</p>', inlineImages: [] };
  }

  const inlineImages = [];

  const html = items
    .map((item, index) => {
      const price = Number(item.price || 0);
      const quantity = Number(item.quantity || 0);
      const lineTotal = price * quantity;
      const imagePayload = resolveOrderItemImageSource(item.image, index);
 
      if (imagePayload.attachment) {
        inlineImages.push(imagePayload.attachment);
      }

      const imageMarkup = imagePayload.src
        ? `<img src="${escapeHtml(imagePayload.src)}" alt="${escapeHtml(item.name || 'Product image')}" width="72" height="72" style="display:block;width:72px;height:72px;border-radius:12px;object-fit:cover;border:1px solid #e2e8f0;background:#f8fafc;" />`
        : `<div style="width:72px;height:72px;border-radius:12px;border:1px solid #e2e8f0;background:#f8fafc;color:#94a3b8;font-size:11px;display:grid;place-items:center;">No image</div>`;

      return `
        <tr>
          <td style="padding:0 0 12px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;">
              <tr>
                <td style="padding:12px;width:92px;vertical-align:top;">${imageMarkup}</td>
                <td style="padding:12px 12px 12px 0;vertical-align:top;">
                  <p style="margin:0 0 6px;font-size:15px;line-height:1.3;color:#0f172a;font-weight:700;">${escapeHtml(item.name || 'Unnamed item')}</p>
                  <p style="margin:0 0 4px;font-size:13px;line-height:1.4;color:#475569;">Size: <b>${escapeHtml(item.size || 'M')}</b></p>
                  <p style="margin:0 0 4px;font-size:13px;line-height:1.4;color:#475569;">Qty: <b>${quantity}</b></p>
                  <p style="margin:0;font-size:13px;line-height:1.4;color:#475569;">Unit: <b>${escapeHtml(formatCurrency(price, 'INR'))}</b></p>
                </td>
                <td style="padding:12px;text-align:right;vertical-align:top;white-space:nowrap;">
                  <p style="margin:0;font-size:12px;line-height:1.4;color:#64748b;">Line Total</p>
                  <p style="margin:2px 0 0;font-size:15px;line-height:1.3;color:#0f172a;font-weight:800;">${escapeHtml(formatCurrency(lineTotal, 'INR'))}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `;
    })
    .join('');

  return { html, inlineImages };
};

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatCurrency = (value, currency = 'INR') => {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return `0.00 ${currency}`;

  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

const formatPaymentDetailsText = (payment = {}) => {
  if (!payment || !payment.razorpayPaymentId) {
    return 'Payment details unavailable';
  }

  return [
    `Gateway: ${payment.gateway || 'razorpay'}`,
    `Verified: ${payment.verified ? 'Yes' : 'No'}`,
    `Payment ID: ${payment.razorpayPaymentId || 'N/A'}`,
    `Razorpay Order ID: ${payment.razorpayOrderId || 'N/A'}`,
    `Status: ${payment.status || 'N/A'}`,
    `Method: ${payment.method || 'N/A'}`,
    `Amount: ${formatCurrency(payment.amount || 0, payment.currency || 'INR')}`,
    `Paid At: ${payment.paidAt || 'N/A'}`,
    `Payment Email: ${payment.email || 'N/A'}`,
    `Payment Contact: ${payment.contact || 'N/A'}`,
  ].join('\n');
};

const formatPaymentDetailsHtml = (payment = {}) => {
  if (!payment || !payment.razorpayPaymentId) {
    return '<p><b>Payment Details:</b> Unavailable</p>';
  }

  return `
    <table style="border-collapse: collapse; width: 100%; margin-top: 12px;">
      <tbody>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Gateway</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(payment.gateway || 'razorpay')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Verified</b></td><td style="padding: 8px; border: 1px solid #ddd;">${payment.verified ? 'Yes' : 'No'}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Payment ID</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(payment.razorpayPaymentId || 'N/A')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Razorpay Order ID</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(payment.razorpayOrderId || 'N/A')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Status</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(payment.status || 'N/A')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Method</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(payment.method || 'N/A')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Amount</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(formatCurrency(payment.amount || 0, payment.currency || 'INR'))}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Paid At</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(payment.paidAt || 'N/A')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Payment Email</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(payment.email || 'N/A')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><b>Payment Contact</b></td><td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(payment.contact || 'N/A')}</td></tr>
      </tbody>
    </table>
  `;
};

const buildEmailEnvelope = ({ to, subject, text, html, inlineImages = [] }) => ({
  from: {
    email: MAIL_FROM_EMAIL,
    name: MAIL_FROM_NAME,
  },
  replyTo: MAIL_REPLY_TO,
  headers: {
    'X-Priority': '1',
    'X-MSMail-Priority': 'High',
    Importance: 'High',
  },
  to,
  subject,
  text,
  html,
  inlineImages,
});

const sendViaSendGrid = async (messages) => {
  await Promise.all(
    messages.map((message) => {
      const { inlineImages, ...sendGridPayload } = message;

      const attachments = Array.isArray(inlineImages)
        ? inlineImages.map((asset) => ({
            content: asset.contentBase64,
            filename: asset.filename,
            type: asset.contentType,
            disposition: 'inline',
            content_id: asset.cid,
          }))
        : [];

      return sgMail.send({
        ...sendGridPayload,
        attachments,
      });
    })
  );
};

const sendViaSmtp = async (messages) => {
  if (!smtpTransporter) {
    throw new Error('SMTP transport is not configured');
  }

  await Promise.all(
    messages.map((message) => smtpTransporter.sendMail({
      from: `${MAIL_FROM_NAME} <${MAIL_FROM_EMAIL}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: Array.isArray(message.inlineImages)
        ? message.inlineImages.map((asset) => ({
            filename: asset.filename,
            content: Buffer.from(asset.contentBase64, 'base64'),
            contentType: asset.contentType,
            cid: asset.cid,
            disposition: 'inline',
          }))
        : [],
    }))
  );
};

const sendEmails = async (messages) => {
  const recipientList = messages.map((m) => m.to).join(', ');
  console.log(`[Email] Attempting to send ${messages.length} email(s) to: ${recipientList}`);
  console.log(`[Email] From: ${MAIL_FROM_EMAIL} | SMTP: ${canSendSmtpEmails} | SendGrid: ${canSendGridEmails}`);

  // Try SMTP first — works without domain verification and fully supports CID inline images
  if (canSendSmtpEmails) {
    try {
      await sendViaSmtp(messages);
      console.log('[Email] ✅ Sent successfully via SMTP');
      return;
    } catch (error) {
      console.warn('[Email] SMTP delivery failed:', error.message);
      if (!canSendGridEmails) throw error;
    }
  }

  if (canSendGridEmails) {
    try {
      await sendViaSendGrid(messages);
      console.log('[Email] ✅ Sent successfully via SendGrid');
      return;
    } catch (error) {
      const detail = error.response?.body ? JSON.stringify(error.response.body) : error.message;
      console.error('[Email] ❌ SendGrid delivery failed:', detail);
      console.error('[Email] HINT: Make sure the FROM email is a verified sender in your SendGrid account.');
      console.error('[Email] Verified senders: https://app.sendgrid.com/settings/sender_auth');
      throw error;
    }
  }

  throw new Error('No email transport configured. Add SMTP_HOST/SMTP_USER/SMTP_PASS or SENDGRID_API_KEY to .env');
};

const buildOrderPlacedMessages = (order) => {
  const itemText = formatOrderItemsText(order.items);
  const orderItemsPayload = formatOrderItemsCardsHtml(order.items);
  const itemHtml = orderItemsPayload.html;
  const inlineImages = orderItemsPayload.inlineImages;
  const paymentText = formatPaymentDetailsText(order.payment);
  const paymentHtml = formatPaymentDetailsHtml(order.payment);

  const adminText = `
New paid order received

Order Number: ${order.orderNumber}
Order ID: ${order.id}
Order Date: ${order.date}
Customer: ${order.customer}
Phone: ${order.phone}
Email: ${order.email || 'N/A'}
Shipping Address: ${order.shippingAddress || 'N/A'}
Order Total: ${formatCurrency(order.total || 0, order.payment?.currency || 'INR')}

Payment Details:
${paymentText}

Products:
${itemText}
  `;

  const adminHtml = `
    <div style="background:#f8fafc;padding:18px;border-radius:16px;border:1px solid #e2e8f0;">
      <h2 style="margin:0 0 12px;color:#0f172a;">New Paid Order Received</h2>
      <p style="margin:0 0 4px;"><b>Order Number:</b> ${escapeHtml(order.orderNumber)}</p>
      <p style="margin:0 0 4px;"><b>Order ID:</b> ${escapeHtml(order.id)}</p>
      <p style="margin:0 0 4px;"><b>Order Date:</b> ${escapeHtml(order.date)}</p>
      <p style="margin:0 0 4px;"><b>Customer:</b> ${escapeHtml(order.customer)}</p>
      <p style="margin:0 0 4px;"><b>Phone:</b> ${escapeHtml(order.phone)}</p>
      <p style="margin:0 0 4px;"><b>Email:</b> ${escapeHtml(order.email || 'N/A')}</p>
      <p style="margin:0 0 4px;"><b>Shipping Address:</b> ${escapeHtml(order.shippingAddress || 'N/A')}</p>
      <p style="margin:0;"><b>Order Total:</b> ${escapeHtml(formatCurrency(order.total || 0, order.payment?.currency || 'INR'))}</p>
    </div>
    <h3 style="margin:18px 0 10px;color:#0f172a;">Payment Details</h3>
    ${paymentHtml}
    <h3 style="margin:18px 0 10px;color:#0f172a;">Ordered Products</h3>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
      <tbody>${itemHtml}</tbody>
    </table>
  `;

  const messages = [
    buildEmailEnvelope({
      to: ADMIN_RECIPIENTS.length > 0 ? ADMIN_RECIPIENTS.join(',') : ADMIN_NOTIFICATION_EMAIL,
      subject: `New paid order ${order.orderNumber}`,
      text: adminText,
      html: adminHtml,
      inlineImages,
    }),
  ];

  if (order.email) {
    messages.push(
      buildEmailEnvelope({
        to: order.email,
        subject: `Your LeosTrend order ${order.orderNumber} is confirmed`,
        text: `
Hi ${order.customer},

Your payment was received successfully for order ${order.orderNumber}.

Order Total: ${formatCurrency(order.total || 0, order.payment?.currency || 'INR')}

Payment Details:
${paymentText}

Products:
${itemText}

Shipping Address:
${order.shippingAddress || 'N/A'}
        `,
        html: `
          <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
            <div style="background:linear-gradient(120deg,#111827,#1f2937);padding:20px 18px;">
              <p style="margin:0 0 6px;color:#e2e8f0;font-size:12px;letter-spacing:1.2px;text-transform:uppercase;">LeosTrend</p>
              <h2 style="margin:0;color:#ffffff;font-size:24px;line-height:1.2;">Payment Successful</h2>
              <p style="margin:8px 0 0;color:#cbd5e1;font-size:14px;">Order <b>${escapeHtml(order.orderNumber)}</b> is confirmed.</p>
            </div>
            <div style="padding:18px;">
              <p style="margin:0 0 10px;color:#0f172a;">Hi ${escapeHtml(order.customer)}, thanks for shopping with us.</p>
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin-bottom:14px;">
                <p style="margin:0 0 6px;color:#0f172a;"><b>Order Total:</b> ${escapeHtml(formatCurrency(order.total || 0, order.payment?.currency || 'INR'))}</p>
                <p style="margin:0;color:#334155;"><b>Shipping Address:</b> ${escapeHtml(order.shippingAddress || 'N/A')}</p>
              </div>
              <h3 style="margin:0 0 10px;color:#0f172a;">Payment Details</h3>
              ${paymentHtml}
              <h3 style="margin:16px 0 10px;color:#0f172a;">Your Cart Summary</h3>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <tbody>${itemHtml}</tbody>
              </table>
            </div>
          </div>
        `,
        inlineImages,
      })
    );
  }

  return messages;
};

const sendOrderPlacedEmail = async (order) => {
  if (!canSendEmails) return;
  await sendEmails(buildOrderPlacedMessages(order));
};

const verifyRazorpaySignature = ({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_SECRET is not configured');
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  return expectedSignature === razorpaySignature;
};

const getPaidAtIsoString = (unixTimestamp) => {
  if (!unixTimestamp) return new Date().toISOString();
  return new Date(Number(unixTimestamp) * 1000).toISOString();
};

const buildPaymentDetails = async ({ paymentInput, fallbackAmount, fallbackCurrency, customerEmail, customerPhone }) => {
  const razorpayOrderId = String(paymentInput?.razorpayOrderId || '').trim();
  const razorpayPaymentId = String(paymentInput?.razorpayPaymentId || '').trim();
  const razorpaySignature = String(paymentInput?.razorpaySignature || '').trim();

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw new Error('Missing Razorpay payment details');
  }

  const verified = verifyRazorpaySignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });

  if (!verified) {
    throw new Error('Invalid Razorpay payment signature');
  }

  let razorpayPayment = null;

  try {
    razorpayPayment = await razorpay.payments.fetch(razorpayPaymentId);
  } catch (error) {
    console.warn('Failed to fetch Razorpay payment details:', error.message);
  }

  return {
    gateway: 'razorpay',
    verified,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    amount: Number((razorpayPayment?.amount || 0) / 100) || Number(fallbackAmount || 0),
    currency: String(razorpayPayment?.currency || fallbackCurrency || 'INR').toUpperCase(),
    status: String(razorpayPayment?.status || 'captured').toLowerCase(),
    method: String(razorpayPayment?.method || '').trim(),
    captured: Boolean(razorpayPayment?.captured ?? true),
    email: String(razorpayPayment?.email || customerEmail || '').trim().toLowerCase(),
    contact: String(razorpayPayment?.contact || customerPhone || '').trim(),
    paidAt: getPaidAtIsoString(razorpayPayment?.created_at),
  };
};

const sendOrderStatusEmail = async (order, status) => {
  if (!canSendEmails) return;

  const statusLabel = ORDER_STATUS_LABELS[status] || status;
  const itemText = formatOrderItemsText(order.items);
  const itemHtml = formatOrderItemsHtml(order.items);

  const adminMsg = buildEmailEnvelope({
    to: ADMIN_RECIPIENTS.length > 0 ? ADMIN_RECIPIENTS.join(',') : ADMIN_NOTIFICATION_EMAIL,
    subject: `Order ${order.orderNumber} updated to ${statusLabel}`,
    text: `
Order Status Updated

Order: ${order.orderNumber}
Status: ${statusLabel}
Customer: ${order.customer}
Phone: ${order.phone}
Email: ${order.email || 'N/A'}
Address: ${order.shippingAddress || 'N/A'}

Items:
${itemText}
    `,
    html: `
      <h2>Order Status Updated</h2>
      <p><b>Order:</b> ${escapeHtml(order.orderNumber)}</p>
      <p><b>Status:</b> ${escapeHtml(statusLabel)}</p>
      <p><b>Customer:</b> ${escapeHtml(order.customer)}</p>
      <p><b>Phone:</b> ${escapeHtml(order.phone)}</p>
      <p><b>Email:</b> ${escapeHtml(order.email || 'N/A')}</p>
      <p><b>Address:</b> ${escapeHtml(order.shippingAddress || 'N/A')}</p>
      <h3>Ordered Items</h3>
      <table style="border-collapse: collapse; width: 100%; margin-top: 12px;">
        <thead>
          <tr>
            <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Product</th>
            <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Size</th>
            <th style="padding: 8px; border: 1px solid #ddd; text-align: center;">Qty</th>
            <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Unit Price</th>
            <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Line Total</th>
          </tr>
        </thead>
        <tbody>${itemHtml}</tbody>
      </table>
    `,
  });

  const messages = [adminMsg];

  if (order.email) {
    messages.push(buildEmailEnvelope({
      ...adminMsg,
      to: order.email,
      subject: `Your LeosTrend Order ${order.orderNumber} is now ${statusLabel}`,
      text: `
Hi ${order.customer},

Your order ${order.orderNumber} is now ${statusLabel}.

Items:
${itemText}
      `,
      html: `
        <h2>Hi ${escapeHtml(order.customer)},</h2>
        <p>Your order <b>${escapeHtml(order.orderNumber)}</b> is now <b>${escapeHtml(statusLabel)}</b>.</p>
        <p>We will keep you posted with the next update.</p>
        <h3>Items</h3>
        <table style="border-collapse: collapse; width: 100%; margin-top: 12px;">
          <thead>
            <tr>
              <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Product</th>
              <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Size</th>
              <th style="padding: 8px; border: 1px solid #ddd; text-align: center;">Qty</th>
              <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Unit Price</th>
              <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Line Total</th>
            </tr>
          </thead>
          <tbody>${itemHtml}</tbody>
        </table>
      `,
    }));
  }

  await sendEmails(messages);
};

// Order Placement (WhatsApp notification removed)
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items, total, shippingAddress, phone, email, payment } = req.body;
    const normalizedPhone = normalizePhone(phone);
    
    if (!customer || !items || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const paymentDetails = await buildPaymentDetails({
      paymentInput: payment,
      fallbackAmount: total,
      fallbackCurrency: 'INR',
      customerEmail: email,
      customerPhone: phone,
    });

    // Create order
    const orderNumber = `LT-${Date.now().toString().slice(-8)}`;
    const order = {
      id: Date.now(),
      orderNumber,
      date: new Date().toISOString(),
      customer,
      phone: String(phone || '').trim(),
      phoneNormalized: normalizedPhone,
      email: String(email || paymentDetails.email || '').trim().toLowerCase(),
      items,
      total,
      shippingAddress,
      payment: paymentDetails,
      status: ORDER_STATUS.PENDING,
      statusTimeline: [
        {
          status: ORDER_STATUS.PENDING,
          updatedAt: new Date().toISOString(),
          note: `Order placed after successful ${paymentDetails.gateway} payment`,
        },
      ],
      lastUpdatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await ensureProductStore();
    await ensureOrdersStore();
    const pool = getOrdersPoolOrThrow();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();
      await reserveProductStock(connection, items);
      await insertOrderRecord(connection, order);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const persistedOrder = await fetchOrderById(order.id);

    try {
      await sendOrderPlacedEmail(persistedOrder);
    } catch (emailError) {
      console.warn('Order placement email failed:', emailError.response?.body || emailError.message);
    }

    res.status(201).json({ 
      success: true, 
      orderId: persistedOrder.id,
      orderNumber: persistedOrder.orderNumber,
      order: persistedOrder,
      message: 'Order placed successfully'
    });

  } catch (error) {
    console.error('Order processing error:', error);
    const statusCode = Number(error.statusCode)
      || (error.message === 'Invalid Razorpay payment signature' || error.message === 'Missing Razorpay payment details' ? 400 : 500);
    res.status(statusCode).json({ error: error.message || 'Failed to process order' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const token = adminAuth.getTokenFromRequest(req);
    const verification = adminAuth.verifyAdminToken(token);
    const { phone, email } = req.query;

    if (verification.valid) {
      return res.json(await fetchOrdersForAdmin());
    }

    if (!phone && !email) {
      return res.json([]);
    }

    return res.json(await fetchOrdersForCustomer({ phone, email }));
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load orders' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  const order = await fetchOrderById(req.params.id);

  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  return res.json(order);
});

app.patch('/api/orders/:id/status', adminAuth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const status = String(req.body?.status || '').trim().toLowerCase();

    if (!ORDER_STATUS_LABELS[status]) {
      return res.status(400).json({ message: 'Invalid status value' });
    }

    const existing = await fetchOrderById(orderId);

    if (!existing) {
      return res.status(404).json({ message: 'Order not found' });
    }

    let updatedOrder;

    if (!isValidStatusTransition(existing.status, status)) {
      return res.status(400).json({
        message: `Invalid transition from ${ORDER_STATUS_LABELS[existing.status] || existing.status} to ${ORDER_STATUS_LABELS[status] || status}`,
      });
    }

    const timeline = Array.isArray(existing.statusTimeline) ? existing.statusTimeline : [];
    const alreadyTracked = timeline.some((entry) => entry.status === status);

    updatedOrder = {
      ...existing,
      status,
      statusTimeline: alreadyTracked
        ? timeline
        : [
            ...timeline,
            {
              status,
              updatedAt: new Date().toISOString(),
              note: `Order marked as ${ORDER_STATUS_LABELS[status] || status}`,
              updatedBy: req.admin?.sub || 'admin',
            },
          ],
      lastUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    updatedOrder = await updateStoredOrder(updatedOrder);

    try {
      await sendOrderStatusEmail(updatedOrder, status);
    } catch (emailError) {
      console.warn('Order status email failed:', emailError.response?.body || emailError.message);
    }

    return res.json({ success: true, order: updatedOrder });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update order status' });
  }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    await ensureOrdersStore();

    const pool = getOrdersPoolOrThrow();
    const revenueColumn = await getOrdersRevenueColumn();
    const { range, whereClause } = getAdminStatsRangeConfig(req.query.range);

    const [summaryRowsPromise, recentOrdersPromise, statusCountsPromise] = await Promise.all([
      pool.query(
        `
          SELECT
            COUNT(*) AS totalOrders,
            COALESCE(SUM(${revenueColumn}), 0) AS totalRevenue,
            COALESCE(AVG(${revenueColumn}), 0) AS averageOrderValue
          FROM ${ORDERS_TABLE}
          ${whereClause}
        `
      ),
      pool.query(
        `
          SELECT
            id,
            order_number AS orderNumber,
            customer,
            status,
            ${revenueColumn} AS totalPrice,
            created_at AS createdAt
          FROM ${ORDERS_TABLE}
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT 5
        `
      ),
      pool.query(
        `
          SELECT
            status,
            COUNT(*) AS count
          FROM ${ORDERS_TABLE}
          ${whereClause}
          GROUP BY status
        `
      ),
    ]);

    const summaryRows = summaryRowsPromise[0];
    const recentOrdersRows = recentOrdersPromise[0];
    const statusRows = statusCountsPromise[0];

    const summary = summaryRows[0] || { totalOrders: 0, totalRevenue: 0, averageOrderValue: 0 };
    const statusCounts = statusRows.reduce((accumulator, row) => {
      accumulator[String(row.status || 'unknown')] = Number(row.count || 0);
      return accumulator;
    }, {});
    const totalOrders = Number(summary.totalOrders || 0);
    const statusPercentages = Object.entries(statusCounts).reduce((accumulator, [status, count]) => {
      accumulator[status] = totalOrders > 0 ? Number(((Number(count) / totalOrders) * 100).toFixed(1)) : 0;
      return accumulator;
    }, {});

    return res.json({
      ok: true,
      stats: {
        range,
        totalOrders,
        totalRevenue: Number(summary.totalRevenue || 0),
        averageOrderValue: Number(summary.averageOrderValue || 0),
        recentOrders: recentOrdersRows.map((row) => ({
          id: Number(row.id),
          orderNumber: String(row.orderNumber || ''),
          customer: String(row.customer || ''),
          status: String(row.status || '').toLowerCase(),
          totalPrice: Number(row.totalPrice || 0),
          createdAt: toIsoValue(row.createdAt),
        })),
        statusCounts,
        statusPercentages,
      },
    });
  } catch (error) {
    console.error('Failed to load admin stats:', error.message);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin dashboard stats',
    });
  }
});


// ✅ Set SendGrid API Key when available
if (canSendGridEmails) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

if (!canSendEmails) {
  console.warn('Email delivery is disabled. Configure SENDGRID_API_KEY or SMTP_HOST to send order emails.');
}

// ================= EMAIL API =================
app.post('/api/send-notification', async (req, res) => {
  try {
    const { customer, items, total, phone, email, shippingAddress, payment, orderNumber, orderId } = req.body;

    const mockOrder = {
      id: orderId || Date.now(),
      orderNumber: orderNumber || `LT-${Date.now().toString().slice(-8)}`,
      date: new Date().toISOString(),
      customer: String(customer || '').trim(),
      phone: String(phone || '').trim(),
      email: String(email || '').trim().toLowerCase(),
      shippingAddress: String(shippingAddress || '').trim(),
      items: Array.isArray(items) ? items : [],
      total: Number(total || 0),
      payment: payment || {},
    };

    await sendOrderPlacedEmail(mockOrder);

    console.log('Order notification email sent');
    res.json({ success: true, message: 'Notification email sent' });

  } catch (error) {
    console.error('Email send error:', error.response?.body || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.body || error.message
    });
  }
});

// Test email endpoint — visit http://localhost:1000/api/test-email?to=your@gmail.com
app.get('/api/test-email', async (req, res) => {
  const to = String(req.query.to || ADMIN_NOTIFICATION_EMAIL).trim();
  if (!to || !/.+@.+\..+/.test(to)) {
    return res.status(400).json({ error: 'Provide ?to=your@email.com' });
  }

  const testMsg = buildEmailEnvelope({
    to,
    subject: 'LeosTrend Email Delivery Test',
    text: 'This is a test email from LeosTrend. If you receive this, email delivery is working!',
    html: '<div style="font-family:sans-serif;padding:20px;"><h2 style="color:#0f172a;">LeosTrend Email Test</h2><p style="color:#475569;">If you can read this, email delivery is working correctly!</p><p style="color:#475569;">From: ' + MAIL_FROM_EMAIL + '</p></div>',
  });

  try {
    await sendEmails([testMsg]);
    return res.json({ success: true, message: `Test email sent to ${to}`, from: MAIL_FROM_EMAIL, transport: canSendSmtpEmails ? 'SMTP' : 'SendGrid' });
  } catch (error) {
    const detail = error.response?.body ? JSON.stringify(error.response.body) : error.message;
    console.error('[Test Email] Failed:', detail);
    return res.status(500).json({ success: false, error: detail, from: MAIL_FROM_EMAIL, transport: canSendSmtpEmails ? 'SMTP' : 'SendGrid', hint: canSendGridEmails && !canSendSmtpEmails ? 'SendGrid: verify your FROM email at https://app.sendgrid.com/settings/sender_auth' : 'Check SMTP_HOST/SMTP_USER/SMTP_PASS in .env' });
  }
});


// ...existing code...

app.get('/api/health', async (_req, res) => {
  try {
    const pool = getDbPool();

    if (!pool) {
      return res.status(503).json({
        ok: false,
        dbConnected: false,
        dbProvider: 'mysql',
        productPersistence: 'mysql',
        orderPersistence: 'mysql',
        message: 'MySQL pool is not initialized',
      });
    }

    await pool.query('SELECT 1');

    return res.json({
      ok: true,
      dbConnected: true,
      dbProvider: 'mysql',
      dbName: process.env.DB_NAME,
      sslEnabled: true,
      productPersistence: 'mysql',
      orderPersistence: 'mysql',
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      dbConnected: false,
      dbProvider: 'mysql',
      productPersistence: 'mysql',
      orderPersistence: 'mysql',
      message: error.message,
    });
  }
});

const PORT = process.env.PORT || 1000;
const startServer = async () => {
  try {
    const missingDbEnvVars = getMissingDbEnvVars();

    if (missingDbEnvVars.length > 0) {
      throw new Error(
        `Missing required database environment variables: ${missingDbEnvVars.join(', ')}. ` +
          'Set them in Render Dashboard -> Environment before starting the service.'
      );
    }

    await connectDB();
    await ensureProductStore();
    await ensureWishlistStore();
    console.log(`Database mode: MySQL SSL connected (${process.env.DB_NAME})`);
    console.log('Persistence mode: Products and orders use MySQL');
    console.log('Image mode: Cloudinary URL storage (no image binaries in database)');

    app.listen(PORT, () => {
      console.log(`🚀 LeosTrend T-Shirts backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();

