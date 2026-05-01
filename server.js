
// ...existing code...
console.log("RUNNING BACKEND FROM:", __filename);

require('dotenv').config();

// const nodemailer = require('nodemailer'); // Removed: no longer used
const express = require('express');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getRazorpayClient, isRazorpayConfigured } = require('./lib/razorpay');
const { connectDB, getDbPool, getMissingDbEnvVars } = require('./config/db');
const { ensureProductStore, reserveProductStockInFile } = require('./controllers/productController');
const productRoutes = require('./routes/productRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const nodemailer = require('nodemailer');
// const emailOtpRoutesModule = require('./routes/emailOtpRoutes'); // Removed: no longer used
// const emailOtpRoutes = emailOtpRoutesModule.router;
// const requireEmailOtpSession = emailOtpRoutesModule.requireEmailOtpSession;
const app = express();

// --- CORS config and middleware (must be before any routes) ---
let ordersRevenueColumnPromise = null;
const isLocalDevOrigin = (origin) => {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || '').trim());
};

const normalizeOrigin = (value) => {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    return new URL(input).origin;
  } catch {
    return input.replace(/\/$/, '');
  }
};

const configuredOrigins = [
  ...String(process.env.CORS_ORIGIN || "")
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  normalizeOrigin(process.env.PUBLIC_BACKEND_URL),
  normalizeOrigin(process.env.RENDER_EXTERNAL_URL),
  'https://leostrend.com',
  'https://www.leostrend.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

const allowedOrigins = [...new Set(configuredOrigins)];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
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

// JSON body parser must come BEFORE all routes
app.use(express.json({ limit: '50mb' }));

// app.use('/api/email-otp', emailOtpRoutes); // Removed: no longer used
const { ensureWishlistStore } = require('./controllers/wishlistController');
const wishlistRoutes = require('./routes/wishlistRoutes');
const adminAuth = require('./middleware/adminAuth');
// app.use('/api', otpRoutes); // Removed: phone OTP logic is no longer used


const distDir = path.join(__dirname, 'dist');
const distIndexFile = path.join(distDir, 'index.html');
const hasFrontendBuild = fs.existsSync(distIndexFile);

// Serve static frontend files
if (hasFrontendBuild) {
  app.use(express.static(distDir));
}



const PRODUCTS_TABLE = 'products';
const ORDERS_TABLE = 'orders';

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

const getAdminConfigStatus = () => {
  const hasCredentials = Boolean(process.env.ADMIN_USERNAME || 'siddartha')
    && Boolean(process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD_HASH || 'siddu@1234');
  const hasTokenConfig = Boolean(process.env.ADMIN_JWT_SECRET || process.env.ADMIN_TOKEN);

  return {
    hasCredentials,
    hasTokenConfig,
    configured: hasCredentials && hasTokenConfig,
  };
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
// Email sending logic removed (nodemailer, smtpTransporter, etc.)



const uploadsDir = path.join(__dirname, 'uploads');
const ordersDataDir = path.join(__dirname, 'data');
const ordersDataFile = path.join(ordersDataDir, 'orders.fallback.json');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));
app.use('/api/products', productRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/payment', paymentRoutes);
// app.use('/api/email-otp', emailOtpRoutes); // Removed: no longer used


const INLINE_IMAGE_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};


app.get('/api/test', (req, res) => {
  res.json({ success: true, message: 'Backend is running and reachable!' });
});

// POST: Admin login (real logic)
app.post('/api/admin/login', (req, res) => {
  const { username, password, rememberMe = false } = req.body;

  const expectedUser = process.env.ADMIN_USERNAME || 'siddartha';
  const expectedPass = process.env.ADMIN_PASSWORD || 'siddu@1234';
  const expectedPassHash = process.env.ADMIN_PASSWORD_HASH;
  const jwtSecret = process.env.ADMIN_JWT_SECRET;
  const fallbackToken = process.env.ADMIN_TOKEN;
  const adminConfigStatus = getAdminConfigStatus();

  if (!adminConfigStatus.hasCredentials || !expectedUser || (!expectedPass && !expectedPassHash)) {
    return res.status(500).json({ message: 'Admin credentials are not configured' });
  }

  if (!adminConfigStatus.hasTokenConfig || (!jwtSecret && !fallbackToken)) {
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


    return res.json({ token, expiresAt });
  });

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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      order.id,
      order.orderNumber,
      order.date,
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
    if (!hasDatabaseConnection()) {
      ensureOrdersFile();
      return;
    }

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

  if (!hasDatabaseConnection()) {
    const orders = loadOrdersFromFile();
    return orders.find((order) => Number(order.id) === Number(orderId)) || null;
  }

  const pool = getOrdersPoolOrThrow();
  const [rows] = await pool.query(`SELECT * FROM ${ORDERS_TABLE} WHERE id = ? LIMIT 1`, [Number(orderId)]);
  return rows[0] ? mapRowToOrder(rows[0]) : null;
};

const fetchOrdersForAdmin = async () => {
  await ensureOrdersStore();

  if (!hasDatabaseConnection()) {
    return sortOrdersDesc(loadOrdersFromFile());
  }

  const pool = getOrdersPoolOrThrow();
  const [rows] = await pool.query(`SELECT * FROM ${ORDERS_TABLE} ORDER BY id DESC`);
  return rows.map(mapRowToOrder);
};

const fetchOrdersForCustomer = async ({ phone, email }) => {
  await ensureOrdersStore();
  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!normalizedPhone && !normalizedEmail) {
    return [];
  }

  if (!hasDatabaseConnection()) {
    return sortOrdersDesc(loadOrdersFromFile()).filter((order) => {
      const orderPhone = normalizePhone(order.phoneNormalized || order.phone);
      const orderEmail = String(order.email || '').trim().toLowerCase();
      return (normalizedPhone && orderPhone === normalizedPhone) || (normalizedEmail && orderEmail === normalizedEmail);
    });
  }

  const pool = getOrdersPoolOrThrow();

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

  if (!hasDatabaseConnection()) {
    const orders = loadOrdersFromFile();
    const nextOrders = orders.map((existingOrder) =>
      Number(existingOrder.id) === Number(order.id) ? order : existingOrder
    );
    saveOrdersToFile(nextOrders);
    return fetchOrderById(order.id);
  }

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




const getPaidAtIsoString = (unixTimestamp) => {
  if (!unixTimestamp) return new Date().toISOString();
  return new Date(Number(unixTimestamp) * 1000).toISOString();
};

const buildPaymentDetails = async ({ paymentInput, fallbackAmount, fallbackCurrency, customerEmail, customerPhone }) => {
  const razorpay = getRazorpayClient();
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






// Order Placement (WhatsApp notification removed)
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items, total, shippingAddress, phone, email, payment } = req.body;
    const normalizedPhone = normalizePhone(phone);
    console.log('[ORDER] Incoming order:', { customer, items, total, shippingAddress, phone, email, payment });

    if (!customer || !items || !phone) {
      console.error('[ORDER] Missing required fields');
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Prevent duplicate orders for same payment
    const pool = getOrdersPoolOrThrow();
    const [existing] = await pool.query(
      "SELECT * FROM orders WHERE payment->>'$.razorpayPaymentId' = ? LIMIT 1",
      [payment?.razorpayPaymentId || '']
    );
    if (existing && existing.length > 0) {
      console.warn('[ORDER] Duplicate payment detected, returning existing order:', existing[0].id);
      return res.status(200).json({
        success: true,
        orderId: existing[0].id,
        orderNumber: existing[0].order_number,
        order: existing[0],
        message: 'Order already exists for this payment.'
      });
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
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();
      await reserveProductStock(connection, items);
      await insertOrderRecord(connection, order);
      await connection.commit();
      console.log('[ORDER] Order saved successfully:', order.id);
    } catch (error) {
      await connection.rollback();
      console.error('[ORDER] DB transaction failed:', error);
      throw error;
    } finally {
      connection.release();
    }


    const persistedOrder = await fetchOrderById(order.id);

    // Send advanced order confirmation email
    sendOrderConfirmationEmail(persistedOrder);

    res.status(201).json({ 
      success: true, 
      orderId: persistedOrder.id,
      orderNumber: persistedOrder.orderNumber,
      order: persistedOrder,
      message: 'Order placed successfully'
    });

  } catch (error) {
    console.error('[ORDER] Order processing error:', error);
    const statusCode = Number(error.statusCode)
      || (error.message === 'Invalid Razorpay payment signature' || error.message === 'Missing Razorpay payment details' ? 400 : 500);
    res.status(statusCode).json({ error: error.message || 'Failed to process order' });
  }
});

// app.get('/api/orders', requireEmailOtpSession, async (req, res) => {
//   try {
//     const { key } = req.otpSession;
//     return res.json(await fetchOrdersForCustomer({ email: key }));
//   } catch (error) {
//     return res.status(500).json({ message: 'Failed to load orders' });
//   }
// });

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




app.get('/api/health', async (_req, res) => {
  try {
    const pool = getDbPool();
    const razorpayConfigured = isRazorpayConfigured();
    const adminConfigured = getAdminConfigStatus().configured;

    if (!pool) {
      return res.status(503).json({
        ok: false,
        dbConnected: false,
        dbProvider: 'mysql',
        productPersistence: 'mysql',
        orderPersistence: 'mysql',
        adminConfigured,
        razorpayConfigured,
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
      adminConfigured,
      razorpayConfigured,
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      dbConnected: false,
      dbProvider: 'mysql',
      productPersistence: 'mysql',
      orderPersistence: 'mysql',
      adminConfigured: getAdminConfigStatus().configured,
      razorpayConfigured: isRazorpayConfigured(),
      message: error.message,
    });
  }
});

if (hasFrontendBuild) {
  app.get(/^\/(?!api(?:\/|$)|uploads(?:\/|$)).*/, (_req, res) => {
    res.sendFile(distIndexFile);
  });
}



// Utility: Check if MySQL DB is connected
function hasDatabaseConnection() {
  try {
    const pool = getDbPool && getDbPool();
    return !!pool;
  } catch {
    return false;
  }
}
// Utility: Check if MySQL DB is connected
function hasDatabaseConnection() {
  try {
    const pool = getDbPool && getDbPool();
    return !!pool;
  } catch {
    return false;
  }
}
// --- Razorpay signature verification ---
let ordersStoreReadyPromise = null;
function verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return false;
  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto.createHmac('sha256', keySecret).update(body).digest('hex');
  return expectedSignature === razorpaySignature;
}
// --- SendGrid setup ---




// const transporter = nodemailer.createTransport({
//   service: 'gmail',
//   auth: {
//     user: process.env.GMAIL_USER || 'leostrendlt@gmail.com', // your Gmail address
//     pass: process.env.GMAIL_APP_PASSWORD || 'jyen qvux jhga eiau', // your Gmail App Password
//   },
// });

// const sendOrderConfirmationEmail = async (order) => {
//   if (!order?.email) return;
//   const itemsHtml = (order.items || []).map(item => `
//     <tr>
//       <td>${item.name}</td>
//       <td>${item.size || ''}</td>
//       <td style="text-align:center">${item.quantity}</td>
//       <td style="text-align:right">₹${item.price}</td>
//       <td style="text-align:right">₹${(item.price * item.quantity).toFixed(2)}</td>
//     </tr>
//   `).join('');
//   const html = `
//     <div style="font-family:sans-serif;max-width:600px;margin:auto;">
//       <h2 style="color:#222;">Thank you for your order at LeosTrend!</h2>
//       <p>Hi <b>${order.customer}</b>,<br>Your order <b>${order.orderNumber}</b> has been received and is being processed.</p>
//       <h3>Order Summary</h3>
//       <table style="width:100%;border-collapse:collapse;">
//         <thead>
//           <tr style="background:#f5f5f5;">
//             <th align="left">Product</th><th align="left">Size</th><th>Qty</th><th align="right">Unit Price</th><th align="right">Total</th>
//           </tr>
//         </thead>
//         <tbody>${itemsHtml}</tbody>
//       </table>
//       <p style="margin-top:16px;"><b>Total:</b> ₹${order.total}</p>
//       <h3>Delivery Address</h3>
//       <p>${order.shippingAddress.replace(/\n/g, '<br>')}</p>
//       <p style="margin-top:24px;">We’ll notify you when your order ships.<br>Thank you for shopping with us!</p>
//       <hr><small>LeosTrend | leostrendlt@gmail.com</small>
//     </div>
//   `;
//   console.log(`[EMAIL] Preparing to send order confirmation to ${order.email}`);
//   const mailOptions = {
//     from: '"LeosTrend" <leostrendlt@gmail.com>',
//     to: order.email,
//     subject: `Order Confirmation - ${order.orderNumber}`,
//     html,
//   };
//   try {
//     await transporter.sendMail(mailOptions);
//     console.log(`[EMAIL] Order confirmation sent to ${order.email}`);
//   } catch (err) {
//     console.error('[EMAIL] Gmail error:', err);
//   }
// };


//const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false, // true for 465, false for 587
  auth: {
    user: 'a9ea58001@smtp-brevo.com', // Your Brevo SMTP login (from your screenshot)
    pass: process.env.BREVO_SMTP_KEY,
  },
});

const sendOrderConfirmationEmail = async (order) => {
  if (!order?.email) return;
  const itemsHtml = (order.items || []).map(item => `
    <tr>
      <td>${item.name}</td>
      <td>${item.size || ''}</td>
      <td style="text-align:center">${item.quantity}</td>
      <td style="text-align:right">₹${item.price}</td>
      <td style="text-align:right">₹${(item.price * item.quantity).toFixed(2)}</td>
    </tr>
  `).join('');
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;">
      <h2 style="color:#222;">Thank you for your order at LeosTrend!</h2>
      <p>Hi <b>${order.customer}</b>,<br>Your order <b>${order.orderNumber}</b> has been received and is being processed.</p>
      <h3>Order Summary</h3>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th align="left">Product</th><th align="left">Size</th><th>Qty</th><th align="right">Unit Price</th><th align="right">Total</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <p style="margin-top:16px;"><b>Total:</b> ₹${order.total}</p>
      <h3>Delivery Address</h3>
      <p>${order.shippingAddress.replace(/\n/g, '<br>')}</p>
      <p style="margin-top:24px;">We’ll notify you when your order ships.<br>Thank you for shopping with us!</p>
      <hr><small>LeosTrend | lt@leostrend.com</small>
    </div>
  `;
  console.log(`[EMAIL] Preparing to send order confirmation to ${order.email}`);
  const mailOptions = {
    from: '"LeosTrend" <lt@leostrend.com>',
    to: order.email,
    subject: `Order Confirmation - ${order.orderNumber}`,
    html,
  };
  try {
    await transporter.sendMail(mailOptions);
    console.log(`[EMAIL] Order confirmation sent to ${order.email}`);
  } catch (err) {
    console.error('[EMAIL] Brevo SMTP error:', err);
  }
};

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

