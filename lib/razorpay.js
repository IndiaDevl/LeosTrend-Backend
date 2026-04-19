const Razorpay = require('razorpay');

const getRazorpayConfig = () => ({
  keyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
  keySecret: String(process.env.RAZORPAY_KEY_SECRET || '').trim(),
});

const isRazorpayConfigured = () => {
  const { keyId, keySecret } = getRazorpayConfig();
  return Boolean(keyId && keySecret);
};

const createRazorpayConfigError = () => {
  const error = new Error('Razorpay is not configured on this server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the deployment environment.');
  error.statusCode = 503;
  return error;
};

const getRazorpayClient = () => {
  const { keyId, keySecret } = getRazorpayConfig();

  if (!keyId || !keySecret) {
    throw createRazorpayConfigError();
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

module.exports = {
  getRazorpayClient,
  getRazorpayConfig,
  isRazorpayConfigured,
  createRazorpayConfigError,
};