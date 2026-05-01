const jwt = require("jsonwebtoken");

const revokedAdminTokenIds = new Set();

const getTokenFromRequest = (req) => {
  const authHeader = req.headers.authorization || "";

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  const legacyHeader = req.headers["x-admin-token"];
  if (legacyHeader) {
    return String(legacyHeader).trim();
  }

  return "";
};

const verifyAdminToken = (token) => {
  const secret = process.env.ADMIN_JWT_SECRET;

  if (!token) {
    return { valid: false, reason: "missing" };
  }

  if (!secret) {
    const fallback = process.env.ADMIN_TOKEN;
    if (fallback && token === fallback) {
      return {
        valid: true,
        payload: { role: "admin", sub: "legacy-admin", jti: "legacy" },
      };
    }

    return { valid: false, reason: "secret-missing" };
  }

  try {
    const payload = jwt.verify(token, secret);

    if (payload?.jti && revokedAdminTokenIds.has(payload.jti)) {
      return { valid: false, reason: "revoked" };
    }

    if (payload?.role !== "admin") {
      return { valid: false, reason: "invalid-role" };
    }

    return { valid: true, payload };
  } catch (error) {
    return { valid: false, reason: "invalid" };
  }
};

const adminAuth = (req, res, next) => {
  const token = getTokenFromRequest(req);
  const verification = verifyAdminToken(token);

  if (!verification.valid) {
    return res.status(401).json({ message: "Admin access denied" });
  }

  req.admin = verification.payload;
  req.adminToken = token;
  next();
};

const revokeAdminTokenById = (jti) => {
  if (jti) revokedAdminTokenIds.add(jti);
};

module.exports = adminAuth;
module.exports.getTokenFromRequest = getTokenFromRequest;
module.exports.verifyAdminToken = verifyAdminToken;
module.exports.revokeAdminTokenById = revokeAdminTokenById;
