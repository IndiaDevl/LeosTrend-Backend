const nodemailer = require('nodemailer');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'chinnasukumar056@gmail.com',
    pass: 'fjzb fxne zvoe xnae'
  }
});

// Email notification endpoint
app.post('/api/send-notification', async (req, res) => {
  try {
    const { customer, items, phone, email, shippingAddress } = req.body;
    // Compose T-shirt details for email
    const itemsList = (items || []).map(item =>
      `<li>${item.name} (Size: ${item.size}) x${item.quantity} - $${item.price}</li>`
    ).join('');

    const mailOptions = {
      from: 'chinnasukumar056@gmail.com',
      to: 'n.sukumar056@gmail.com',
      subject: `🛒 New T-Shirt Order from ${customer}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #4CAF50; margin-bottom: 20px;">🛒 New T-Shirt Order</h2>
            <p><strong>Customer Name:</strong> ${customer}</p>
            <p><strong>Phone Number:</strong> ${phone}</p>
            <p><strong>Email Address:</strong> ${email || 'N/A'}</p>
            <p><strong>Shipping Address:</strong> ${shippingAddress || 'N/A'}</p>
            <h3>Ordered T-Shirts:</h3>
            <ul>${itemsList}</ul>
            <div style="margin-top: 30px; padding: 15px; background: #e8f5e9; border-left: 4px solid #4CAF50; border-radius: 5px;">
              <p style="margin: 0; color: #2e7d32;">
                <strong>Status:</strong> Order received from LeosTrend website.
              </p>
            </div>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log('✅ Email notification sent successfully');
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('❌ Email send error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => {
  console.log(`🚀 LeosTrend T-Shirts backend running on port ${PORT}`);
//  console.log(`📱 WhatsApp notifications are ${WHATSAPP_CONFIG.accessToken ? 'configured' : 'NOT configured - set environment variables'}`);
});