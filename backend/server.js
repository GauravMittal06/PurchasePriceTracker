/**
 * Live Price Negotiation Tracker - Backend Server
 * Node.js + Express + PostgreSQL (with SQLite fallback)
 * 
 * Run: npm install && npm start
 * Or: npm run dev (with nodemon)
 * 
 * Environment variables (optional):
 *   - DATABASE_URL: PostgreSQL connection string (if not set, uses SQLite)
 *   - PORT: Server port (default: 5000)
 *   - NODE_ENV: development/production (default: development)
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const uuid = require('uuid');
require('dotenv').config();

// Configure multer to store uploaded files temporarily in memory
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// ============================================================================
// DATABASE SETUP
// ============================================================================

let pool = null;
let useDatabase = false;

// Try to use PostgreSQL if DATABASE_URL is set
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    pool.on('error', (err) => {
      console.error('❌ Database connection error:', err.message);
    });

    useDatabase = true;
    console.log('✓ Using PostgreSQL');
  } catch (error) {
    console.error('❌ Failed to initialize PostgreSQL:', error.message);
    useDatabase = false;
  }
} else {
  console.log('⚠️  No DATABASE_URL provided - running in memory-only mode');
  console.log('   PDF extraction will work, but data won\'t persist');
}

// ============================================================================
// INITIALIZATION
// ============================================================================

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// In-memory data store (for development/testing without database)
const inMemoryData = {
  prices: [],
  chemicals: [],
  vendors: [],
};

// ============================================================================
// DATABASE SCHEMA INITIALIZATION
// ============================================================================

const initializeDB = async () => {
  if (!useDatabase || !pool) {
    console.log('⏭️  Skipping database initialization (no PostgreSQL)');
    return;
  }

  try {
    // Prices table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prices (
        id UUID PRIMARY KEY,
        chemical_name VARCHAR(255) NOT NULL,
        vendor_name VARCHAR(255) NOT NULL,
        price_per_unit DECIMAL(10, 2) NOT NULL,
        unit VARCHAR(50),
        quantity INTEGER,
        purchase_date DATE NOT NULL,
        created_at BIGINT NOT NULL,
        last_modified BIGINT NOT NULL,
        device_id VARCHAR(255),
        synced BOOLEAN DEFAULT true,
        created_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prices_chemical ON prices(chemical_name);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prices_vendor ON prices(vendor_name);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prices_chemical_vendor ON prices(chemical_name, vendor_name);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prices_purchase_date ON prices(purchase_date);
    `);

    // Chemicals table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chemicals (
        id UUID PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        created_at BIGINT NOT NULL,
        created_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Vendors table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendors (
        id UUID PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        created_at BIGINT NOT NULL,
        device_id VARCHAR(255),
        created_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Sync log table (audit trail)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id UUID PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        action VARCHAR(50),
        record_count INTEGER,
        conflict_count INTEGER,
        sync_timestamp BIGINT NOT NULL,
        created_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✓ Database schema initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Query helper - works with both PostgreSQL and in-memory storage
 */
const queryHelper = {
  // For prices
  selectPrices: async (query, params) => {
    if (useDatabase && pool) {
      const result = await pool.query(query, params);
      return result.rows;
    }
    // In-memory fallback
    return inMemoryData.prices;
  },

  insertPrice: async (priceData) => {
    if (useDatabase && pool) {
      const { id, chemical_name, vendor_name, price_per_unit, unit, quantity, purchase_date, created_at, last_modified, device_id } = priceData;
      await pool.query(
        `INSERT INTO prices (id, chemical_name, vendor_name, price_per_unit, unit, quantity, purchase_date, created_at, last_modified, device_id, synced)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)`,
        [id, chemical_name, vendor_name, price_per_unit, unit, quantity, purchase_date, created_at, last_modified, device_id]
      );
    } else {
      inMemoryData.prices.push({
        id: priceData.id || uuid.v4(),
        ...priceData
      });
    }
  },

  insertVendor: async (vendorData) => {
    if (useDatabase && pool) {
      const { id, name, created_at, device_id } = vendorData;
      await pool.query(
        `INSERT INTO vendors (id, name, created_at, device_id) VALUES ($1, $2, $3, $4)`,
        [id, name, created_at, device_id]
      );
    } else {
      const existing = inMemoryData.vendors.find(v => v.name === vendorData.name);
      if (!existing) {
        inMemoryData.vendors.push({
          id: vendorData.id || uuid.v4(),
          ...vendorData
        });
      }
    }
  },

  vendorExists: async (vendorName) => {
    if (useDatabase && pool) {
      const result = await pool.query('SELECT id FROM vendors WHERE name = $1', [vendorName]);
      return result.rows.length > 0;
    } else {
      return inMemoryData.vendors.some(v => v.name === vendorName);
    }
  },

  priceExists: async (chemical_name, vendor_name, purchase_date) => {
    if (useDatabase && pool) {
      const result = await pool.query(
        `SELECT id FROM prices WHERE chemical_name = $1 AND vendor_name = $2 AND purchase_date = $3`,
        [chemical_name, vendor_name, purchase_date]
      );
      return result.rows.length > 0;
    } else {
      return inMemoryData.prices.some(
        p => p.chemical_name === chemical_name && p.vendor_name === vendor_name && p.purchase_date === purchase_date
      );
    }
  }
};

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: Date.now(),
    database: useDatabase ? 'PostgreSQL' : 'In-Memory',
    priceCount: inMemoryData.prices.length,
    vendorCount: inMemoryData.vendors.length
  });
});

// ============================================================================
// PDF UPLOAD & EXTRACTION ENDPOINT
// ============================================================================

app.post('/api/upload-pdf', upload.single('file'), async (req, res) => {
  console.log('📋 PDF upload request received');

  if (!req.file) {
    console.error('❌ No file uploaded');
    return res.status(400).json({ 
      success: false,
      error: 'No file uploaded' 
    });
  }

  try {
    console.log(`📄 Processing PDF: ${req.file.originalname} (${req.file.size} bytes)`);

    // Parse PDF
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text;

    console.log(`✓ PDF parsed successfully (${text.length} characters)`);

    // Extract vendor name (look for "Ledger Account" section)
    const vendorMatch = text.match(/Ledger Account\s*\n([^\n]+)\n/) || 
                        text.match(/Vendor[:\s]+([^\n]+)\n/) ||
                        text.match(/^([^\n]+)\n/);
    const vendorName = vendorMatch ? vendorMatch[1].trim() : `Vendor_${Date.now()}`;

    console.log(`🏢 Vendor: ${vendorName}`);

    // Extract all transactions (Date, Chemical, Price, Unit, Quantity)
    const transactions = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Look for purchase lines with chemical names and prices
      if (line.includes('Purchase') || line.includes('CHEMICAL') || /\d{1,2}-\w{3}-\d{2}/.test(line)) {
        // Extract date (dd-mmm-yy format)
        const dateMatch = line.match(/(\d{1,2})-(\w{3})-(\d{2})/);
        if (!dateMatch) continue;

        const dayStr = dateMatch[1].padStart(2, '0');
        const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
        const month = monthMap[dateMatch[2]] || '01';
        const year = 2000 + parseInt(dateMatch[3]);
        const dateStr = `${year}-${month}-${dayStr}`;

        // Look ahead for chemical name and price
        let j = i + 1;
        while (j < lines.length && j < i + 10) {
          const nextLine = lines[j];

          // Match pattern: CHEMICAL_NAME QUANTITY UNIT PRICE/UNIT TOTAL_PRICE
          // Or simpler pattern: CHEMICAL QUANTITY UNIT PRICE
          const chemicalMatch = nextLine.match(/([A-Z][A-Za-z0-9\s]*?)\s+([\d.]+)\s+(\w+)\s+([\d.]+)\s*\/?\s*(\w*)\s*([\d.]*)/);
          
          if (chemicalMatch) {
            const chemicalName = chemicalMatch[1].trim();
            const quantity = parseFloat(chemicalMatch[2]) || 1;
            const unit = chemicalMatch[3] || 'unit';
            const pricePerUnit = parseFloat(chemicalMatch[4]) || 0;

            if (pricePerUnit > 0 && chemicalName.length > 0) {
              transactions.push({
                chemical_name: chemicalName,
                vendor_name: vendorName,
                price_per_unit: pricePerUnit,
                unit: unit,
                quantity: quantity,
                purchase_date: dateStr,
              });
              console.log(`  ✓ ${chemicalName}: ${pricePerUnit}/${unit}`);
              break;
            }
          }
          j++;
        }
      }
    }

    console.log(`📊 Found ${transactions.length} transactions`);

    if (transactions.length === 0) {
      // Even if no transactions found, don't fail - return success with 0 records
      console.log('⚠️  No transactions found, but PDF was parsed successfully');
      
      // Still add the vendor
      const vendorAlreadyExists = await queryHelper.vendorExists(vendorName);
      if (!vendorAlreadyExists) {
        await queryHelper.insertVendor({
          id: uuid.v4(),
          name: vendorName,
          created_at: Date.now()
        });
        console.log(`✓ Vendor "${vendorName}" added`);
      }

      return res.json({
        success: true,
        message: 'PDF parsed but no price records found',
        vendor_name: vendorName,
        records_found: 0,
        records_inserted: 0,
        inserted_records: [],
      });
    }

    // Deduplicate: keep only latest price per chemical
    const grouped = {};
    for (const txn of transactions) {
      const key = txn.chemical_name;
      if (!grouped[key] || new Date(txn.purchase_date) > new Date(grouped[key].purchase_date)) {
        grouped[key] = txn;
      }
    }

    const deduplicatedTxns = Object.values(grouped);
    console.log(`✓ Deduplicated to ${deduplicatedTxns.length} unique chemicals`);

    // Insert into database
    let insertedCount = 0;
    const insertedRecords = [];

    try {
      // Insert vendor if not exists
      const vendorExists = await queryHelper.vendorExists(vendorName);
      if (!vendorExists) {
        await queryHelper.insertVendor({
          id: uuid.v4(),
          name: vendorName,
          created_at: Date.now()
        });
        console.log(`✓ Vendor "${vendorName}" added to database`);
      }

      // Insert prices
      for (const txn of deduplicatedTxns) {
        const priceExists = await queryHelper.priceExists(txn.chemical_name, txn.vendor_name, txn.purchase_date);

        if (!priceExists) {
          const now = Date.now();
          await queryHelper.insertPrice({
            id: uuid.v4(),
            chemical_name: txn.chemical_name,
            vendor_name: txn.vendor_name,
            price_per_unit: txn.price_per_unit,
            unit: txn.unit,
            quantity: txn.quantity,
            purchase_date: txn.purchase_date,
            created_at: now,
            last_modified: now,
            synced: true
          });
          insertedCount++;
          insertedRecords.push(txn);
        }
      }

      console.log(`✓ Successfully inserted ${insertedCount} price records`);

      res.json({
        success: true,
        message: `Extracted ${insertedCount} new price records from PDF`,
        vendor_name: vendorName,
        records_found: deduplicatedTxns.length,
        records_inserted: insertedCount,
        inserted_records: insertedRecords,
      });

    } catch (dbError) {
      console.error('❌ Database error:', dbError.message);
      res.status(500).json({ 
        success: false,
        error: 'Failed to insert records into database',
        details: dbError.message 
      });
    }

  } catch (error) {
    console.error('❌ PDF extraction error:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'PDF extraction failed', 
      details: error.message 
    });
  }
});

// ============================================================================
// GET PRICES BY CHEMICAL
// ============================================================================

app.get('/api/prices/chemical/:name', async (req, res) => {
  try {
    const chemicalName = req.params.name;
    const prices = useDatabase && pool 
      ? (await pool.query('SELECT * FROM prices WHERE chemical_name = $1', [chemicalName])).rows
      : inMemoryData.prices.filter(p => p.chemical_name === chemicalName);

    res.json({
      chemical_name: chemicalName,
      prices: prices,
      count: prices.length
    });
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ error: 'Failed to query prices' });
  }
});

// ============================================================================
// GET PRICES BY VENDOR
// ============================================================================

app.get('/api/prices/vendor/:name', async (req, res) => {
  try {
    const vendorName = req.params.name;
    const prices = useDatabase && pool 
      ? (await pool.query('SELECT * FROM prices WHERE vendor_name = $1', [vendorName])).rows
      : inMemoryData.prices.filter(p => p.vendor_name === vendorName);

    res.json({
      vendor_name: vendorName,
      prices: prices,
      count: prices.length
    });
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ error: 'Failed to query prices' });
  }
});

// ============================================================================
// GET ALL DATA
// ============================================================================

app.get('/api/data', async (req, res) => {
  try {
    let prices, chemicals, vendors;

    if (useDatabase && pool) {
      prices = (await pool.query('SELECT * FROM prices')).rows;
      chemicals = (await pool.query('SELECT * FROM chemicals')).rows;
      vendors = (await pool.query('SELECT * FROM vendors')).rows;
    } else {
      prices = inMemoryData.prices;
      chemicals = inMemoryData.chemicals;
      vendors = inMemoryData.vendors;
    }

    res.json({
      prices,
      chemicals,
      vendors,
      total_prices: prices.length,
      total_chemicals: chemicals.length,
      total_vendors: vendors.length
    });
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

// ============================================================================
// ADD PRICE
// ============================================================================

app.post('/api/prices', async (req, res) => {
  try {
    const { chemical_name, vendor_name, price_per_unit, unit, quantity, purchase_date } = req.body;

    if (!chemical_name || !vendor_name || !price_per_unit || !purchase_date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const id = uuid.v4();
    const now = Date.now();

    await queryHelper.insertPrice({
      id,
      chemical_name,
      vendor_name,
      price_per_unit: parseFloat(price_per_unit),
      unit: unit || 'unit',
      quantity: quantity ? parseInt(quantity) : 1,
      purchase_date,
      created_at: now,
      last_modified: now,
      synced: !useDatabase // Only mark as unsynced if using database
    });

    res.json({ 
      success: true, 
      id,
      message: 'Price added successfully' 
    });
  } catch (error) {
    console.error('Insert error:', error);
    res.status(500).json({ error: 'Failed to add price' });
  }
});

// ============================================================================
// ADD VENDOR
// ============================================================================

app.post('/api/vendors', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Vendor name required' });
    }

    const vendorExists = await queryHelper.vendorExists(name);
    if (vendorExists) {
      return res.status(400).json({ error: 'Vendor already exists' });
    }

    const id = uuid.v4();

    await queryHelper.insertVendor({
      id,
      name,
      created_at: Date.now()
    });

    res.json({ 
      success: true, 
      id,
      message: 'Vendor added successfully' 
    });
  } catch (error) {
    console.error('Insert error:', error);
    res.status(500).json({ error: 'Failed to add vendor' });
  }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const startServer = async () => {
  try {
    await initializeDB();

    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════╗
║   Price Negotiation Tracker - Backend Server           ║
║   Running on http://localhost:${PORT}                     ║
║   ${useDatabase ? 'Database: PostgreSQL' : 'Database: In-Memory (Dev Mode)'}                              ║
║                                                        ║
║   Endpoints:                                           ║
║   POST   /api/upload-pdf            - Extract PDF data ║
║   GET    /api/health                - Health check     ║
║   GET    /api/data                  - Get all data     ║
║   GET    /api/prices/chemical/:name - Query by chem    ║
║   GET    /api/prices/vendor/:name   - Query by vendor  ║
║   POST   /api/prices                - Add price        ║
║   POST   /api/vendors               - Add vendor       ║
╚════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down gracefully...');
  if (useDatabase && pool) {
    await pool.end();
  }
  process.exit(0);
});