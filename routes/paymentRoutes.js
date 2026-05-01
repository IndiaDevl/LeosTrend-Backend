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
// Razorpay Webhook Handler
router.post('/razorpay-webhook', express.json({ type: '*/*' }), async (req, res) => {
  const event = req.body;
  try {
    if (event.event === 'payment.captured' && event.payload && event.payload.payment && event.payload.payment.entity) {
      const payment = event.payload.payment.entity;
      const razorpayOrderId = payment.order_id;
      const razorpayPaymentId = payment.id;

      // Find and update the order in the DB (MySQL) by razorpayOrderId
      const db = require('../config/db');
      const pool = db.getDbPool();
      if (!pool) throw new Error('No DB pool');
      const [rows] = await pool.query('SELECT * FROM orders WHERE payment->>\'$.razorpayOrderId\' = ?', [razorpayOrderId]);
      if (rows.length > 0) {
        const order = rows[0];
        // Update payment status and details
        const updatedPayment = {
          ...order.payment,
          status: 'captured',
          razorpayPaymentId,
        };
        await pool.query('UPDATE orders SET status = ?, payment = ? WHERE id = ?', ['confirmed', JSON.stringify(updatedPayment), order.id]);
        console.log('Order updated from webhook:', order.id);
      } else {
        console.warn('No order found for Razorpay order_id:', razorpayOrderId);
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});
