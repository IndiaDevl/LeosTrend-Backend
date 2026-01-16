require('dotenv').config();
const nodemailer = require('nodemailer');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const Razorpay = require('razorpay');
const app = express();

// JSON body
app.use(express.json({ limit: '50mb' }));

// CORS (works perfectly on Render + Node 22)
app.use(cors({
  origin: true,
  credentials: true
}));

// In-memory storage (replace with real database like MongoDB for production)
let orders = [];
const tshirts = [
  { id: 1, name: "Om LeosTrend T-Shirt", price: 24.99, image: "om-tshirt.jpg", sizes: ["S", "M", "L", "XL"] },
  { id: 2, name: "Sri LeosTrend T-Shirt", price: 29.99, image: "sri-yantra.jpg", sizes: ["S", "M", "L", "XL"] },
  { id: 3, name: "Ganesh LeosTrend T-Shirt", price: 27.99, image: "ganesh-yantra.jpg", sizes: ["S", "M", "L"] }
];

// API Routes
app.get('/api/leostrend-tshirts', (req, res) => {
  res.json({ 
    message: 'Welcome to LeosTrend T-Shirt Business API',
    products: tshirts 
  });
});

app.get('/api/products', (req, res) => {
  res.json(tshirts);
});

// Order Placement (WhatsApp notification removed)
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items, total, shippingAddress, phone } = req.body;
    
    if (!customer || !items || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create order
    const order = {
      id: Date.now(),
      date: new Date().toISOString(),
      customer,
      phone,
      items,
      total,
      shippingAddress,
      status: 'pending'
    };

    // Save order (in memory - replace with database in production)
    orders.push(order);

    res.status(201).json({ 
      success: true, 
      orderId: order.id,
      message: 'Order placed successfully'
    });

  } catch (error) {
    console.error('Order processing error:', error);
    res.status(500).json({ error: 'Failed to process order' });
  }
});

app.get('/api/orders', (req, res) => {
  res.json(orders);
});


// ✅ Set SendGrid API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ================= EMAIL API =================
app.post('/api/send-notification', async (req, res) => {
  try {
    const { customer, items, phone, email, shippingAddress } = req.body;

    const itemText = (items || []).length
      ? items.map(i => `${i.name} (${i.size}) x ${i.quantity}`).join('\n')
      : 'No items';

    const itemHtml = (items || []).length
      ? items.map(i =>
          `<li>${i.name} (Size: ${i.size}) x ${i.quantity}</li>`
        ).join('')
      : '<li>No items</li>';


    // Prepare email content
    const mailContent = {
      from: {
        email: 'lt@leostrend.com',
        name: 'LeosTrend'
      },
      subject: `🛒 New T-Shirt Order from ${customer}`,
      text: `
New Order Received

Customer: ${customer}
Phone: ${phone}
Email: ${email || 'N/A'}
Address: ${shippingAddress || 'N/A'}

Items:
${itemText}
      `,
      html: `
        <h2>🛒 New T-Shirt Order</h2>
        <p><b>Customer:</b> ${customer}</p>
        <p><b>Phone:</b> ${phone}</p>
        <p><b>Email:</b> ${email || 'N/A'}</p>
        <p><b>Address:</b> ${shippingAddress || 'N/A'}</p>
        <h3>Ordered Items</h3>
        <ul>${itemHtml}</ul>
        <p style="color: green;"><b>Status:</b> Order received from LeosTrend website</p>
      `
    };

    // Send to admin
    const adminMsg = {
      ...mailContent,
      to: 'n.sukumar056@gmail.com'
    };
    // Send to customer if email provided
    const customerMsg = email ? {
      ...mailContent,
      to: email,
      subject: `🛒 Your LeosTrend Order Confirmation`
    } : null;

    // Send both emails in parallel
    const sendPromises = [sgMail.send(adminMsg)];
    if (customerMsg) sendPromises.push(sgMail.send(customerMsg));
    await Promise.all(sendPromises);

    console.log('✅ Emails sent to admin and customer');
    res.json({ success: true, message: 'Emails sent to admin and customer (if provided)' });

  } catch (error) {
    console.error('❌ Email send error:', error.response?.body || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.body || error.message
    });
  }
});

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.post('/api/create-order', async (req, res) => {
  const { amount, currency = "INR" } = req.body;
  try {
    const options = {
      amount: amount * 100, // amount in paise
      currency,
      receipt: `order_rcptid_${Date.now()}`
    };
    const order = await razorpay.orders.create(options);
    res.json({ orderId: order.id, key: process.env.RAZORPAY_KEY_ID, amount: order.amount, currency: order.currency });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create Razorpay order', details: err.message });
  }
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => {
  console.log(`🚀 LeosTrend T-Shirts backend running on port ${PORT}`);
});