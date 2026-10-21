const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Email Transporter Config
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'yourcompanyemail@gmail.com',
        pass: 'your-app-password'
    }
});

// Initialize SQLite Database with Flow Chart fields
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Error opening database', err.message);
    else console.log('Connected to SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        serialNumber TEXT UNIQUE,
        productName TEXT,
        currentStatus TEXT,
        updatedAt TEXT,
        timeline TEXT,
        technicianName TEXT,
        phone TEXT,
        clientEmail TEXT,
        technicianPhoto TEXT,
        aadharNo TEXT,
        problemDescription TEXT,
        paymentDetails TEXT
    )`);
});

function broadcastProducts() {
    db.all(`SELECT * FROM products`, [], (err, rows) => {
        if (!err) {
            const parsedRows = rows.map(r => ({
                ...r,
                timeline: JSON.parse(r.timeline)
            }));
            io.emit('product_updated', parsedRows);
        }
    });
}

io.on('connection', (socket) => {
    console.log('A client connected live:', socket.id);
});

// API: Get all products
app.get('/api/products', (req, res) => {
    db.all(`SELECT * FROM products`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const parsedRows = rows.map(r => ({
            ...r,
            timeline: JSON.parse(r.timeline)
        }));
        res.json(parsedRows);
    });
});

// API: Inward new product
app.post('/api/products', (req, res) => {
    const { serialNumber, productName, technicianName, phone, clientEmail, technicianPhoto, aadharNo } = req.body;
    const now = new Date().toLocaleTimeString();
    const id = Date.now().toString();

    if (!serialNumber || !productName) {
        return res.status(400).json({ error: 'Serial number and Product name are required.' });
    }

    const cleanSerial = serialNumber.trim().toUpperCase();
    const initialTimeline = JSON.stringify([
        { status: 'Inwarded', time: now, remarks: 'Material Inward registered at gate.' }
    ]);

    const query = `INSERT INTO products (id, serialNumber, productName, currentStatus, updatedAt, timeline, technicianName, phone, clientEmail, technicianPhoto, aadharNo, problemDescription, paymentDetails) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.run(query, [id, cleanSerial, productName, 'Inwarded', now, initialTimeline, technicianName || '', phone || '', clientEmail || '', technicianPhoto || '', aadharNo || '', '', 'Pending Payment'], function(err) {
        if (err) {
            return res.status(400).json({ error: 'Serial Number already exists!' });
        }
        broadcastProducts();
        res.status(201).json({ success: true });
    });
});

// API: Update status, problem description, and trigger Email + WhatsApp Notifications
app.put('/api/products/:id/status', (req, res) => {
    const { id } = req.params;
    const { newStatus, remarks, problemDescription, paymentDetails, clientEmail } = req.body;
    const now = new Date().toLocaleTimeString();

    db.get(`SELECT * FROM products WHERE id = ?`, [id], (err, product) => {
        if (err || !product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        let timeline = JSON.parse(product.timeline);
        if (!timeline.some(t => t.status === newStatus)) {
            timeline.push({ status: newStatus, time: now, remarks: remarks || 'Status updated.' });
        }

        const updateQuery = `UPDATE products SET currentStatus = ?, updatedAt = ?, timeline = ?, problemDescription = COALESCE(?, problemDescription), paymentDetails = COALESCE(?, paymentDetails) WHERE id = ?`;
        
        db.run(updateQuery, [newStatus, now, JSON.stringify(timeline), problemDescription, paymentDetails, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });

            broadcastProducts();

            const targetEmail = clientEmail || product.clientEmail;
            
            // 1. Email Notification Dispatch
            if (targetEmail) {
                const mailOptions = {
                    from: 'ABC Company Tracking <yourcompanyemail@gmail.com>',
                    to: targetEmail,
                    subject: `[Material Tracking Update] ${product.serialNumber} is now ${newStatus}`,
                    html: `
                        <h3>ABC Company - Material Status Update</h3>
                        <p>Your product <b>${product.productName}</b> (Serial: <b>${product.serialNumber}</b>) status has been updated.</p>
                        <p><b>Current Status:</b> <span style="color: #06b6d4;">${newStatus}</span></p>
                        <p><b>Problem / Remarks:</b> ${problemDescription || remarks || 'N/A'}</p>
                        <p><b>Payment Details:</b> ${paymentDetails || 'N/A'}</p>
                        <p><b>Updated Time:</b> ${now}</p>
                    `
                };

                transporter.sendMail(mailOptions, (mailErr, info) => {
                    if (mailErr) console.error('Email error:', mailErr);
                    else console.log('Email sent successfully:', info.response);
                });
            }

            // 2. WhatsApp Bot Notification Dispatch
            if (product.phone) {
                const whatsappMessage = `*ABC Company Update*\n\nProduct: ${product.productName}\nSerial: ${product.serialNumber}\nStatus: *${newStatus}*\nRemarks: ${problemDescription || remarks || 'N/A'}\nTime: ${now}`;
                
                // Note: Integrate your WhatsApp Bot API call here (e.g., Twilio, WATI, or local whatsapp-web.js client)
                console.log(`[WhatsApp Bot Triggered] Sending message to ${product.phone}: \n${whatsappMessage}`);
            }

            res.json({ success: true, message: 'Status updated and notifications sent successfully!' });
        });
    });
});

app.delete('/api/products/:id', (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM products WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Product not found' });
        broadcastProducts();
        res.json({ success: true, message: 'Product deleted successfully' });
    });
});

server.listen(PORT, () => {
    console.log(`Server running live at http://localhost:${PORT}`);
});