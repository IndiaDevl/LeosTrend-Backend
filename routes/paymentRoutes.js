const express = require('express');
const Razorpay = require('razorpay');
const router = express.Router();

// Debug route to verify correct backend instance

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// POST /api/payment/razorpay/order
router.post('/razorpay/order', async (req, res) => {
  try {
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
      key_id: process.env.RAZORPAY_KEY_ID,
      receipt: order.receipt,
      status: order.status
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ error: 'Failed to create Razorpay order', details: err.message });
  }
});

module.exports = router;
