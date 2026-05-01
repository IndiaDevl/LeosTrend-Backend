
// Phone OTP logic removed. Only email OTP is supported now.


// Middleware to protect orders route
function requireOtpSession(req, res, next) {
  const token = req.headers['x-otp-session'] || req.query.sessionToken;
  if (!token || !otpStore[token] || otpStore[token].expires < Date.now()) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  req.otpSession = otpStore[token];
  next();
}

module.exports = { router, requireOtpSession };