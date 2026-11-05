const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
}));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'yourcompanyemail@gmail.com',
        pass: process.env.EMAIL_PASS || 'your-app-password'
    }
});

// Check if running on cloud (Render with DATABASE_URL) or local
const isProduction = !!process.env.DATABASE_URL;
let db;
let pool;

if (isProduction) {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    pool.query(`
        CREATE TABLE IF NOT EXISTS products (
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
            paymentDetails TEXT,
            components TEXT
        );
    `).catch(err => console.error('PG Table creation error:', err));
    console.log('Connected to PostgreSQL Cloud database.');
} else {
    const sqlite3 = require('sqlite3').verbose();
    const dbFile = path.join(__dirname, 'database.sqlite');
    db = new sqlite3.Database(dbFile, (err) => {
        if (err) console.error('Error opening database', err.message);
        else console.log('Connected to local SQLite database.');
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
            paymentDetails TEXT,
            components TEXT
        )`);
    });
}

function broadcastProducts() {
    if (isProduction) {
        pool.query(`SELECT * FROM products`, [], (err, result) => {
            if (!err && result) {
                const parsedRows = result.rows.map(r => ({
                    ...r,
                    timeline: typeof r.timeline === 'string' ? JSON.parse(r.timeline || '[]') : (r.timeline || []),
                    components: typeof r.components === 'string' ? JSON.parse(r.components || '[]') : (r.components || [])
                }));
                io.emit('product_updated', parsedRows);
            }
        });
    } else {
        db.all(`SELECT * FROM products`, [], (err, rows) => {
            if (!err && rows) {
                const parsedRows = rows.map(r => ({
                    ...r,
                    timeline: JSON.parse(r.timeline || '[]'),
                    components: JSON.parse(r.components || '[]')
                }));
                io.emit('product_updated', parsedRows);
            }
        });
    }
}

io.on('connection', (socket) => {
    console.log('A client connected live:', socket.id);
});

app.get('/api/products', (req, res) => {
    if (isProduction) {
        pool.query(`SELECT * FROM products`, [], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            const parsedRows = result.rows.map(r => ({
                ...r,
                timeline: typeof r.timeline === 'string' ? JSON.parse(r.timeline || '[]') : (r.timeline || []),
                components: typeof r.components === 'string' ? JSON.parse(r.components || '[]') : (r.components || [])
            }));
            res.json(parsedRows);
        });
    } else {
        db.all(`SELECT * FROM products`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const parsedRows = rows.map(r => ({
                ...r,
                timeline: JSON.parse(r.timeline || '[]'),
                components: JSON.parse(r.components || '[]')
            }));
            res.json(parsedRows);
        });
    }
});

// API: Inward new product with components
app.post('/api/products', (req, res) => {
    const { serialNumber, productName, technicianName, phone, clientEmail, technicianPhoto, aadharNo, components } = req.body;
    const now = new Date().toLocaleTimeString();
    const id = Date.now().toString();

    if (!serialNumber || !productName) {
        return res.status(400).json({ error: 'Serial number and Product name are required.' });
    }

    const cleanSerial = serialNumber.trim().toUpperCase();
    const initialTimeline = JSON.stringify([
        { status: 'Inwarded', time: now, remarks: 'Material Inward registered at gate.' }
    ]);
    
    const jsonComponents = JSON.stringify(Array.isArray(components) ? components : []);

    if (isProduction) {
        const query = `INSERT INTO products (id, serialNumber, productName, currentStatus, updatedAt, timeline, technicianName, phone, clientEmail, technicianPhoto, aadharNo, problemDescription, paymentDetails, components) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`;
        pool.query(query, [id, cleanSerial, productName, 'Inwarded', now, initialTimeline, technicianName || '', phone || '', clientEmail || '', technicianPhoto || '', aadharNo || '', '', 'Pending Payment', jsonComponents], (err) => {
            if (err) {
                console.error('Database Insert Error:', err.message);
                return res.status(400).json({ error: 'Serial Number already exists or DB Error!' });
            }
            broadcastProducts();
            res.status(201).json({ success: true });
        });
    } else {
        const query = `INSERT INTO products (id, serialNumber, productName, currentStatus, updatedAt, timeline, technicianName, phone, clientEmail, technicianPhoto, aadharNo, problemDescription, paymentDetails, components) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.run(query, [id, cleanSerial, productName, 'Inwarded', now, initialTimeline, technicianName || '', phone || '', clientEmail || '', technicianPhoto || '', aadharNo || '', '', 'Pending Payment', jsonComponents], function(err) {
            if (err) {
                console.error('Database Insert Error:', err.message);
                return res.status(400).json({ error: 'Serial Number already exists or DB Error!' });
            }
            broadcastProducts();
            res.status(201).json({ success: true });
        });
    }
});

app.put('/api/products/:id/status', (req, res) => {
    const { id } = req.params;
    const { currentStatus, newStatus, remarks, problemDescription, paymentDetails, clientEmail } = req.body;
    
    const finalStatus = currentStatus || newStatus; 
    const finalRemarks = remarks || problemDescription;
    const now = new Date().toLocaleTimeString();

    if (!finalStatus) {
        return res.status(400).json({ error: 'Status is required' });
    }

    if (isProduction) {
        pool.query(`SELECT * FROM products WHERE id = $1`, [id], (err, result) => {
            if (err || result.rows.length === 0) {
                return res.status(404).json({ error: 'Product not found' });
            }

            const product = result.rows[0];
            let timeline = [];
            try {
                timeline = typeof product.timeline === 'string' ? JSON.parse(product.timeline || '[]') : (product.timeline || []);
            } catch (e) {
                timeline = [];
            }

            if (!timeline.some(t => t.status === finalStatus)) {
                timeline.push({ status: finalStatus, time: now, remarks: finalRemarks || 'Status updated.' });
            }

            const updateQuery = `UPDATE products SET currentStatus = $1, updatedAt = $2, timeline = $3, problemDescription = COALESCE($4, problemDescription), paymentDetails = COALESCE($5, paymentDetails) WHERE id = $6`;
            
            pool.query(updateQuery, [finalStatus, now, JSON.stringify(timeline), finalRemarks, paymentDetails, id], (err) => {
                if (err) return res.status(500).json({ error: err.message });

                broadcastProducts();

                const targetEmail = clientEmail || product.clientEmail;
                if (targetEmail) {
                    const mailOptions = {
                        from: 'ABC Company Tracking <yourcompanyemail@gmail.com>',
                        to: targetEmail,
                        subject: `[Material Tracking Update] ${product.serialNumber} is now ${finalStatus}`,
                        html: `
                            <h3>ABC Company - Material Status Update</h3>
                            <p>Your product <b>${product.productName}</b> (Serial: <b>${product.serialNumber}</b>) status has been updated.</p>
                            <p><b>Current Status:</b> <span style="color: #06b6d4;">${finalStatus}</span></p>
                            <p><b>Problem / Remarks:</b> ${finalRemarks || 'N/A'}</p>
                            <p><b>Updated Time:</b> ${now}</p>
                        `
                    };
                    transporter.sendMail(mailOptions, (mailErr) => {
                        if (mailErr) console.error('Email error:', mailErr);
                    });
                }

                res.json({ success: true, message: 'Status updated successfully!' });
            });
        });
    } else {
        db.get(`SELECT * FROM products WHERE id = ?`, [id], (err, product) => {
            if (err || !product) {
                return res.status(404).json({ error: 'Product not found' });
            }

            let timeline = [];
            try {
                timeline = JSON.parse(product.timeline || '[]');
            } catch (e) {
                timeline = [];
            }

            if (!timeline.some(t => t.status === finalStatus)) {
                timeline.push({ status: finalStatus, time: now, remarks: finalRemarks || 'Status updated.' });
            }

            const updateQuery = `UPDATE products SET currentStatus = ?, updatedAt = ?, timeline = ?, problemDescription = COALESCE(?, problemDescription), paymentDetails = COALESCE(?, paymentDetails) WHERE id = ?`;
            
            db.run(updateQuery, [finalStatus, now, JSON.stringify(timeline), finalRemarks, paymentDetails, id], function(err) {
                if (err) return res.status(500).json({ error: err.message });

                broadcastProducts();

                const targetEmail = clientEmail || product.clientEmail;
                if (targetEmail) {
                    const mailOptions = {
                        from: 'ABC Company Tracking <yourcompanyemail@gmail.com>',
                        to: targetEmail,
                        subject: `[Material Tracking Update] ${product.serialNumber} is now ${finalStatus}`,
                        html: `
                            <h3>ABC Company - Material Status Update</h3>
                            <p>Your product <b>${product.productName}</b> (Serial: <b>${product.serialNumber}</b>) status has been updated.</p>
                            <p><b>Current Status:</b> <span style="color: #06b6d4;">${finalStatus}</span></p>
                            <p><b>Problem / Remarks:</b> ${finalRemarks || 'N/A'}</p>
                            <p><b>Updated Time:</b> ${now}</p>
                        `
                    };
                    transporter.sendMail(mailOptions, (mailErr) => {
                        if (mailErr) console.error('Email error:', mailErr);
                    });
                }

                res.json({ success: true, message: 'Status updated successfully!' });
            });
        });
    }
});

app.delete('/api/products/:id', (req, res) => {
    const { id } = req.params;
    if (isProduction) {
        pool.query(`DELETE FROM products WHERE id = $1`, [id], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            if (result.rowCount === 0) return res.status(404).json({ error: 'Product not found' });
            broadcastProducts();
            res.json({ success: true, message: 'Product deleted successfully' });
        });
    } else {
        db.run(`DELETE FROM products WHERE id = ?`, [id], function(err) {
            if (err) return res.status(500).json({ error: arg2 || err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Product not found' });
            broadcastProducts();
            res.json({ success: true, message: 'Product deleted successfully' });
        });
    }
});

server.listen(PORT, () => {
    console.log(`Server running live at http://localhost:${PORT}`);
});
