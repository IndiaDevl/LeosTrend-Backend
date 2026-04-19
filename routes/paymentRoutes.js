const express = require('express');
const router = express.Router();
const { getRazorpayClient, getRazorpayConfig } = require('../lib/razorpay');

// Debug route to verify correct backend instance

// POST /api/payment/razorpay/order
router.post('/razorpay/order', async (req, res) => {
  try {
    const razorpay = getRazorpayClient();
    const { keyId } = getRazorpayConfig();
    const { amount, currency = 'INR', receipt = `order_rcptid_${Date.now()}` } = req.body;
    if (!amount) {
      return res.status(400).json({ error: 'Amount is required' });
    }
    const options = {
      amount: Math.round(Number(amount)), // amount in paise
      currency,
      receipt,
      payment_capture: 1,
    };
    const order = await razorpay.orders.create(options);
    res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: keyId,
      receipt: order.receipt,
      status: order.status
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(err.statusCode || 500).json({ error: 'Failed to create Razorpay order', details: err.message });
  }
});

module.exports = router;
