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
const uuid = require('uuid');
require('dotenv').config();

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
  console.log('   Data will not persist between server restarts');
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
        quantity NUMERIC(10, 2),
        purchase_date DATE NOT NULL,
        created_at BIGINT NOT NULL,
        last_modified BIGINT NOT NULL,
        device_id VARCHAR(255),
        synced BOOLEAN DEFAULT true,
        created_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        garden_id UUID
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

    // Gardens table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gardens (
        id UUID PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        created_at BIGINT NOT NULL,
        created_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add foreign key constraint for garden_id
    try {
      await pool.query(`
        ALTER TABLE prices ADD CONSTRAINT fk_garden_id 
        FOREIGN KEY (garden_id) REFERENCES gardens(id);
      `);
    } catch (error) {
      // Constraint might already exist, that's ok
      if (!error.message.includes('already exists')) {
        console.error('Error adding foreign key:', error.message);
      }
    }

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
      const { id, chemical_name, vendor_name, price_per_unit, unit, quantity, purchase_date, created_at, last_modified, device_id, garden_id } = priceData;
      await pool.query(
        `INSERT INTO prices (id, chemical_name, vendor_name, price_per_unit, unit, quantity, purchase_date, created_at, last_modified, device_id, garden_id, synced)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
        [id, chemical_name, vendor_name, price_per_unit, unit, quantity, purchase_date, created_at, last_modified, device_id, garden_id]
      );
    } else {
      inMemoryData.prices.push({
        id: priceData.id || uuid.v4(),
        ...priceData
      });
    }
  },

  insertChemical: async (chemicalData) => {
    if (useDatabase && pool) {
      const { id, name, created_at } = chemicalData;
      try {
        await pool.query(
          `INSERT INTO chemicals (id, name, created_at) VALUES ($1, $2, $3)`,
          [id, name, created_at]
        );
      } catch (error) {
        // Ignore duplicate key errors
        if (!error.message.includes('duplicate')) {
          throw error;
        }
      }
    } else {
      const existing = inMemoryData.chemicals.find(c => c.name.toLowerCase() === chemicalData.name.toLowerCase());
      if (!existing) {
        inMemoryData.chemicals.push({
          id: chemicalData.id || uuid.v4(),
          ...chemicalData
        });
      }
    }
  },

  insertVendor: async (vendorData) => {
    if (useDatabase && pool) {
      const { id, name, created_at, device_id } = vendorData;
      try {
        await pool.query(
          `INSERT INTO vendors (id, name, created_at, device_id) VALUES ($1, $2, $3, $4)`,
          [id, name, created_at, device_id]
        );
      } catch (error) {
        // Ignore duplicate key errors
        if (!error.message.includes('duplicate')) {
          throw error;
        }
      }
    } else {
      const existing = inMemoryData.vendors.find(v => v.name.toLowerCase() === vendorData.name.toLowerCase());
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
      const result = await pool.query('SELECT id FROM vendors WHERE LOWER(name) = LOWER($1)', [vendorName]);
      return result.rows.length > 0;
    } else {
      return inMemoryData.vendors.some(v => v.name.toLowerCase() === vendorName.toLowerCase());
    }
  },

  priceExists: async (chemical_name, vendor_name, purchase_date) => {
    if (useDatabase && pool) {
      const result = await pool.query(
        `SELECT id FROM prices WHERE LOWER(chemical_name) = LOWER($1) AND LOWER(vendor_name) = LOWER($2) AND purchase_date = $3`,
        [chemical_name, vendor_name, purchase_date]
      );
      return result.rows.length > 0;
    } else {
      return inMemoryData.prices.some(
        p => p.chemical_name.toLowerCase() === chemical_name.toLowerCase() && 
             p.vendor_name.toLowerCase() === vendor_name.toLowerCase() && 
             p.purchase_date === purchase_date
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
// GET PRICES BY CHEMICAL
// ============================================================================

app.get('/api/prices/chemical/:name', async (req, res) => {
  try {
    const chemicalName = req.params.name;
    const prices = useDatabase && pool 
      ? (await pool.query('SELECT * FROM prices WHERE LOWER(chemical_name) = LOWER($1)', [chemicalName])).rows
      : inMemoryData.prices.filter(p => p.chemical_name.toLowerCase() === chemicalName.toLowerCase());

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
      ? (await pool.query('SELECT * FROM prices WHERE LOWER(vendor_name) = LOWER($1)', [vendorName])).rows
      : inMemoryData.prices.filter(p => p.vendor_name.toLowerCase() === vendorName.toLowerCase());

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

    // Auto-add vendor if not exists
    const vendorExists = await queryHelper.vendorExists(vendor_name);
    if (!vendorExists) {
      await queryHelper.insertVendor({
        id: uuid.v4(),
        name: vendor_name,
        created_at: now
      });
    }

    // Auto-add chemical if not exists
    await queryHelper.insertChemical({
      id: uuid.v4(),
      name: chemical_name,
      created_at: now
    });

    await queryHelper.insertPrice({
      id,
      chemical_name,
      vendor_name,
      price_per_unit: parseFloat(price_per_unit),
      unit: unit || 'unit',
      quantity: quantity ? parseFloat(quantity) : 1,
      purchase_date,
      created_at: now,
      last_modified: now,
      synced: !useDatabase
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
// SYNC ENDPOINT - Core offline-first sync logic
// ============================================================================

app.post('/api/sync', async (req, res) => {
  try {
    const { device_id, last_sync_timestamp, offline_queue } = req.body;
    const now = Date.now();

    console.log(`\n📡 SYNC Request from device: ${device_id}`);
    console.log(`   Queue items: ${(offline_queue || []).length}`);

    // Process the offline queue - apply all pending changes
    let processedCount = 0;
    let skippedCount = 0;

    for (const item of (offline_queue || [])) {
      try {
        if (item.action === 'create_price') {
          const p = item.payload;
          const exists = await queryHelper.priceExists(p.chemical_name, p.vendor_name, p.purchase_date);
          
          if (!exists) {
            // Auto-add vendor if not exists
            const vendorExists = await queryHelper.vendorExists(p.vendor_name);
            if (!vendorExists) {
              await queryHelper.insertVendor({
                id: uuid.v4(),
                name: p.vendor_name,
                created_at: p.created_at,
                device_id
              });
            }

            // Auto-add chemical if not exists
            await queryHelper.insertChemical({
              id: uuid.v4(),
              name: p.chemical_name,
              created_at: p.created_at
            });

            // Insert price
            await queryHelper.insertPrice({
              id: uuid.v4(),
              chemical_name: p.chemical_name,
              vendor_name: p.vendor_name,
              price_per_unit: p.price_per_unit,
              unit: p.unit,
              quantity: p.quantity,
              purchase_date: p.purchase_date,
              created_at: p.created_at,
              last_modified: p.last_modified,
              device_id,
            });
            processedCount++;
          } else {
            skippedCount++;
          }
        } else if (item.action === 'update_price') {
          // Handle update_price action
          const p = item.payload;
          if (useDatabase && pool) {
            await pool.query(
              `UPDATE prices SET chemical_name = $1, vendor_name = $2, price_per_unit = $3, unit = $4, purchase_date = $5, last_modified = $6 
               WHERE id = $7`,
              [p.chemical_name, p.vendor_name, p.price_per_unit, p.unit, p.purchase_date, p.last_modified, p.id]
            );
          } else {
            const priceIdx = inMemoryData.prices.findIndex(pr => pr.id === p.id);
            if (priceIdx !== -1) {
              inMemoryData.prices[priceIdx] = { ...inMemoryData.prices[priceIdx], ...p };
            }
          }
          processedCount++;
        }
      } catch (itemError) {
        console.error(`   ⚠️  Error processing queue item:`, itemError.message);
        skippedCount++;
      }
    }

    console.log(`   ✓ Processed: ${processedCount}, Skipped: ${skippedCount}`);

    // Fetch merged state from DB (or memory)
    let prices, vendors, chemicals, gardens;
    if (useDatabase && pool) {
      prices = (await pool.query('SELECT * FROM prices')).rows;
      vendors = (await pool.query('SELECT * FROM vendors')).rows;
      chemicals = (await pool.query('SELECT * FROM chemicals')).rows;
      gardens = (await pool.query('SELECT * FROM gardens')).rows;
      console.log('🌱 Gardens fetched:', gardens);
    } else {
      prices = inMemoryData.prices;
      vendors = inMemoryData.vendors;
      chemicals = inMemoryData.chemicals;
      gardens = inMemoryData.gardens || [];
    }

    console.log(`   📊 Current state: ${prices.length} prices, ${vendors.length} vendors, ${chemicals.length} chemicals\n`);
    
    res.json({
      success: true,
      merged_prices: prices,
      merged_vendors: vendors,
      merged_chemicals: chemicals,
      merged_gardens: gardens,
      sync_timestamp: now,
      processed_count: processedCount,
      skipped_count: skippedCount,
    });
  } catch (error) {
    console.error('❌ Sync error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Sync failed',
      details: error.message 
    });
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
// GET GARDENS
// ============================================================================

app.get('/api/gardens', async (req, res) => {
  try {
    if (useDatabase && pool) {
      const result = await pool.query('SELECT * FROM gardens');
      res.json(result.rows);
    } else {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch gardens' });
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
║   Running on http://localhost:${PORT}                  ║
║   ${useDatabase ? 'Database: PostgreSQL' : 'Database: In-Memory (Dev Mode)'}                              ║
║                                                        ║
║   Endpoints:                                           ║
║   GET    /api/health                - Health check     ║
║   GET    /api/data                  - Get all data     ║
║   GET    /api/prices/chemical/:name - Query by chem    ║
║   GET    /api/prices/vendor/:name   - Query by vendor  ║
║   POST   /api/prices                - Add price        ║
║   POST   /api/vendors               - Add vendor       ║
║   POST   /api/sync                  - Sync offline data║
║   GET    /api/gardens               - Get gardens      ║
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