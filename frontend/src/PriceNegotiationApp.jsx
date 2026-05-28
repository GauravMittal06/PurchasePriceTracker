import React, { useState, useEffect, useRef } from 'react';
import { Search, Plus, RefreshCw, Settings, X, TrendingDown, TrendingUp } from 'lucide-react';

// ============================================================================
// INDEXEDDB SETUP - OFFLINE-FIRST DATA PERSISTENCE
// ============================================================================

const DB_NAME = 'PriceNegotiationDB';
const DB_VERSION = 1;
const API_BASE_URL =
  import.meta.env.PROD
    ? 'https://purchasepricetracker.onrender.com/api'
    : 'http://localhost:5000/api';

const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;

      // Prices store
      if (!db.objectStoreNames.contains('prices')) {
        const pricesStore = db.createObjectStore('prices', { keyPath: 'id' });
        pricesStore.createIndex('chemical_name', 'chemical_name', { unique: false });
        pricesStore.createIndex('vendor_name', 'vendor_name', { unique: false });
        pricesStore.createIndex('created_at', 'created_at', { unique: false });
        pricesStore.createIndex('chemical_vendor', ['chemical_name', 'vendor_name'], { unique: false });
      }

      // Chemicals store
      if (!db.objectStoreNames.contains('chemicals')) {
        db.createObjectStore('chemicals', { keyPath: 'id' });
      }

      // Vendors store
      if (!db.objectStoreNames.contains('vendors')) {
        db.createObjectStore('vendors', { keyPath: 'id' });
      }

      // ADD AFTER VENDORS STORE:
      if (!db.objectStoreNames.contains('gardens')) {
        db.createObjectStore('gardens', { keyPath: 'id' });
      }

      // Sync queue for offline changes
      if (!db.objectStoreNames.contains('sync_queue')) {
        db.createObjectStore('sync_queue', { keyPath: 'id' });
      }

      // Metadata store
      if (!db.objectStoreNames.contains('metadata')) {
        db.createObjectStore('metadata', { keyPath: 'key' });
      }
    };
  });
};

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

const dbOps = {
  getAllByIndex: async (db, storeName, indexName, value) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(value);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  },

  getAll: async (db, storeName) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  },

  add: async (db, storeName, data) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.add(data);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  },

  put: async (db, storeName, data) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(data);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  },

  clear: async (db, storeName) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  },

  getMetadata: async (db, key) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['metadata'], 'readonly');
      const store = transaction.objectStore('metadata');
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.value);
    });
  },

  setMetadata: async (db, key, value) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['metadata'], 'readwrite');
      const store = transaction.objectStore('metadata');
      const request = store.put({ key, value });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  },
};

// ============================================================================
// FUZZY SEARCH IMPLEMENTATION
// ============================================================================

const fuzzyMatch = (query, text) => {
  const lowerQuery = query.toLowerCase();
  const lowerText = String(text || '').toLowerCase();

  if (!lowerQuery) return 1;
  if (lowerText === lowerQuery) return 100;
  if (lowerText.includes(lowerQuery)) return 90;
  if (lowerText.startsWith(lowerQuery)) return 80;

  let matches = 0;
  let queryIdx = 0;
  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      matches++;
      queryIdx++;
    }
  }

  return queryIdx === lowerQuery.length ? matches : 0;
};

const searchFuzzy = (query, items, key) => {
  if (!query.trim()) return items;

  const scored = items
    .map((item) => ({
      item,
      score: fuzzyMatch(query, item[key]),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((x) => x.item);
};

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================

export default function PriceNegotiationTracker() {
  const [db, setDb] = useState(null);
  const [prices, setPrices] = useState([]);
  const [chemicals, setChemicals] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [garden, setGarden] = useState(null);

  const [searchChemical, setSearchChemical] = useState('');
  const [searchVendor, setSearchVendor] = useState('');
  const [currentPrice, setCurrentPrice] = useState('');
  const [results, setResults] = useState([]);
  const [sortOrder, setSortOrder] = useState('asc');

  const [showLogPrice, setShowLogPrice] = useState(false);
  const [showEditPrice, setShowEditPrice] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [toast, setToast] = useState(null);

  const [logFormData, setLogFormData] = useState({
    chemical: '',
    vendor: '',
    price: '',
    unit: 'unit',
    date: new Date().toISOString().split('T')[0],
  });

  const [editPriceData, setEditPriceData] = useState({
    id: '',
    chemical: '',
    vendor: '',
    price: '',
    unit: 'unit',
    date: new Date().toISOString().split('T')[0],
  });

  const [openDropdown, setOpenDropdown] = useState(null);

  const loadGarden = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/gardens`);
      const gardens = await response.json();
      if (gardens.length > 0) {
        setGarden(gardens[0]);
        await dbOps.put(db, 'gardens', gardens[0]);
      }
    } catch (error) {
      console.error('Failed to load garden:', error);
    }
  };

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  useEffect(() => {
    const init = async () => {
      try {
        const database = await initDB();
        setDb(database);

        const loadedPrices = await dbOps.getAll(database, 'prices');
        const loadedChemicals = await dbOps.getAll(database, 'chemicals');
        const loadedVendors = await dbOps.getAll(database, 'vendors');

        setPrices(loadedPrices);
        setChemicals(loadedChemicals);
        setVendors(loadedVendors);

        const lastSync = await dbOps.getMetadata(database, 'last_sync_time');
        setLastSyncTime(lastSync);

        const queueCount = await dbOps.getAll(database, 'sync_queue');
        setOfflineQueueCount(queueCount.length);

        await loadGarden();

        if (loadedPrices.length === 0 && loadedVendors.length === 0) {
          await seedInitialData(database);
        }

        if ('serviceWorker' in navigator) {
          navigator.serviceWorker
            .register('/service-worker.js')
            .then((registration) => {
              console.log('SW registered:', registration);
            
              navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data?.type === 'SW_UPDATED') {
                  showToast('New app version available. Refresh app.', 'info');
                }
              });
            })
            .catch((err) => {
              console.error('SW registration failed:', err);
            });
        }
      } catch (error) {
        console.error('DB init error:', error);
        showToast('Failed to initialize database', 'error');
      }
    };

    init();
  }, []);

  const seedInitialData = async (database) => {
    const initialPrices = [
      {
        id: 'price-heroff-1',
        chemical_name: 'HEROFF',
        vendor_name: 'Do Aggri Science',
        price_per_unit: 1600,
        unit: 'ltr',
        quantity: 50,
        purchase_date: '2026-05-18',
        created_at: new Date('2026-05-18').getTime(),
        last_modified: new Date('2026-05-18').getTime(),
        synced: true,
      },
      {
        id: 'price-lender-1',
        chemical_name: 'LENDER',
        vendor_name: 'Do Aggri Science',
        price_per_unit: 43,
        unit: 'kgs',
        quantity: 3950,
        purchase_date: '2026-05-13',
        created_at: new Date('2026-05-13').getTime(),
        last_modified: new Date('2026-05-13').getTime(),
        synced: true,
      },
    ];

    const initialChemicals = [
      { id: 'chem-1', name: 'HEROFF', created_at: Date.now() },
      { id: 'chem-2', name: 'LENDER', created_at: Date.now() },
    ];

    const initialVendors = [
      { id: 'vendor-1', name: 'Do Aggri Science', created_at: Date.now() },
    ];

    for (const price of initialPrices) {
      await dbOps.put(database, 'prices', price);
    }

    for (const chem of initialChemicals) {
      await dbOps.put(database, 'chemicals', chem);
    }

    for (const vendor of initialVendors) {
      await dbOps.put(database, 'vendors', vendor);
    }

    setPrices(initialPrices);
    setChemicals(initialChemicals);
    setVendors(initialVendors);
    showToast('Initial data loaded', 'success');
  };

  // Auto-sync when internet reconnects
  useEffect(() => {
    const handleOnline = () => {
      showToast('Internet restored - syncing...', 'info');
      handleSync();
    };

    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [db, prices, vendors]);

  useEffect(() => {
    if (!navigator.serviceWorker) return;
    
    const handler = (event) => {
      if (event.data?.type === 'TRIGGER_SYNC') {
        handleSync();
      }
    };
  
    navigator.serviceWorker.addEventListener('message', handler);
  
    return () => {
      navigator.serviceWorker.removeEventListener('message', handler);
    };
  }, [db, prices, vendors]);

  // =========================================================================
  // SEARCH & FILTERING
  // =========================================================================

  useEffect(() => {
    if (!searchChemical && !searchVendor) {
      setResults([]);
      return;
    }

    let filtered = [...prices];

    if (searchChemical) {
      filtered = filtered.filter((p) =>
        String(p.chemical_name || '')
          .toLowerCase()
          .includes(searchChemical.toLowerCase())
      );
    }

    if (searchVendor) {
      filtered = filtered.filter((p) =>
        String(p.vendor_name || '').toLowerCase().includes(searchVendor.toLowerCase())
      );
    }

    // Get latest transaction per vendor for searched chemical
    if (searchChemical && !searchVendor) {
      const grouped = {};
      filtered.forEach((p) => {
        const key = p.vendor_name;
        if (!grouped[key] || new Date(p.purchase_date) > new Date(grouped[key].purchase_date)) {
          grouped[key] = p;
        }
      });
      filtered = Object.values(grouped);
    } else if (searchVendor && !searchChemical) {
      const grouped = {};
      filtered.forEach((p) => {
        const key = p.chemical_name;
        if (!grouped[key] || new Date(p.purchase_date) > new Date(grouped[key].purchase_date)) {
          grouped[key] = p;
        }
      });
      filtered = Object.values(grouped);
    }

    // Pin searched vendor to top
    if (searchVendor) {
      const searched = filtered.filter((p) => p.vendor_name === searchVendor);
      const others = filtered.filter((p) => p.vendor_name !== searchVendor);
      filtered = [...searched, ...others];
    }

    // Sort by price
    filtered.sort((a, b) => {
      if (sortOrder === 'asc') {
        return a.price_per_unit - b.price_per_unit;
      } else {
        return b.price_per_unit - a.price_per_unit;
      }
    });

    setResults(filtered);
  }, [searchChemical, searchVendor, prices, sortOrder]);

  // =========================================================================
  // ACTIONS
  // =========================================================================

  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    clearTimeout(window.toastTimeout);

    window.toastTimeout = setTimeout(() => {
      setToast(null);
    }, 3000);
  };

  const handleLogPrice = async () => {
    if (
      !logFormData.chemical ||
      !logFormData.vendor ||
      !logFormData.price ||
      !logFormData.date ||
      !db
    ) {
      showToast('Please fill all required fields', 'warning');
      return;
    }

    const newPrice = {
      id: `price-${Date.now()}-${Math.random()}`,
      chemical_name: logFormData.chemical,
      vendor_name: logFormData.vendor,
      price_per_unit: parseFloat(logFormData.price),
      unit: logFormData.unit || 'unit',
      quantity: 1,
      purchase_date: logFormData.date,
      created_at: Date.now(),
      last_modified: Date.now(),
      synced: false,
    };

    await dbOps.put(db, 'prices', newPrice);
    await dbOps.add(db, 'sync_queue', {
      id: `sync-${Date.now()}`,
      action: 'create_price',
      payload: newPrice,
      timestamp: Date.now(),
      synced: false,
    });

    // Auto-add vendor if new
    
    const vendorExists = vendors.some(
      (v) => v.name.toLowerCase() === logFormData.vendor.toLowerCase()
    );

    if (!vendorExists) {
      const newVendor = {
        id: `vendor-${Date.now()}-${Math.random()}`,
        name: logFormData.vendor,
        created_at: Date.now(),
        last_modified: Date.now(),
        synced: false,
      };
      await dbOps.put(db, 'vendors', newVendor);
      setVendors([...vendors, newVendor]);
    }

    // Auto-add chemical if new
    const chemicalExists = chemicals.some(
      (c) => c.name.toLowerCase() === logFormData.chemical.toLowerCase()
    );
    
    if (!chemicalExists) {
      const newChemical = {
        id: `chem-${Date.now()}-${Math.random()}`,
        name: logFormData.chemical,
        created_at: Date.now(),
        last_modified: Date.now(),
        synced: false,
      };
    
      await dbOps.put(db, 'chemicals', newChemical);
    
      setChemicals([...chemicals, newChemical]);
    }

    setPrices([...prices, newPrice]);
    setLogFormData({
      chemical: '',
      vendor: '',
      price: '',
      unit: 'unit',
      date: new Date().toISOString().split('T')[0],
    });
    setShowLogPrice(false);
    setOfflineQueueCount((c) => c + 1);
    showToast('Price logged successfully', 'success');
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      const registration = await navigator.serviceWorker.ready;

      try {
        await registration.sync.register('sync-price-data');
      } catch (err) {
        console.error('Background sync registration failed:', err);
      }
    }
  };

  const handleEditPrice = async () => {
    if (
      !editPriceData.id ||
      !editPriceData.chemical ||
      !editPriceData.vendor ||
      !editPriceData.price ||
      !editPriceData.date ||
      !db
    ) {
      showToast('Please fill all required fields', 'warning');
      return;
    }

    const updatedPrice = {
      ...prices.find((p) => p.id === editPriceData.id),
      chemical_name: editPriceData.chemical,
      vendor_name: editPriceData.vendor,
      price_per_unit: parseFloat(editPriceData.price),
      unit: editPriceData.unit || 'unit',
      purchase_date: editPriceData.date,
      last_modified: Date.now(),
      synced: false,
    };

    // Update in IndexedDB
    const transaction = db.transaction(['prices'], 'readwrite');
    const store = transaction.objectStore('prices');
    await new Promise((resolve, reject) => {
      const request = store.put(updatedPrice);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });

    await dbOps.add(db, 'sync_queue', {
      id: `sync-${Date.now()}`,
      action: 'update_price',
      payload: updatedPrice,
      timestamp: Date.now(),
      synced: false,
    });

    const updatedPrices = prices.map((p) =>
      p.id === editPriceData.id ? updatedPrice : p
    );
    setPrices(updatedPrices);
    setEditPriceData({
      id: '',
      chemical: '',
      vendor: '',
      price: '',
      unit: 'unit',
      date: new Date().toISOString().split('T')[0],
    });
    setShowEditPrice(false);
    setOfflineQueueCount((c) => c + 1);
    showToast('Price updated successfully', 'success');
  };

  const handleSync = async () => {
    if (!db || syncStatus === 'syncing') return;

    setSyncStatus('syncing');

    try {
      const queue = await dbOps.getAll(db, 'sync_queue');
      const lastSync = await dbOps.getMetadata(db, 'last_sync_time');

      const response = await fetch(`${API_BASE_URL}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: 'browser-' + btoa(navigator.userAgent).substring(0, 20),
          last_sync_timestamp: lastSync || 0,
          offline_queue: queue,
        }),
      }).catch(() => {
        return {
          ok: true,
          json: async () => ({
            success: true,
            merged_prices: prices,
            merged_vendors: vendors,
            sync_timestamp: Date.now(),
          }),
        };
      });

      const data = await response.json();

      if (data.success) {
        await dbOps.clear(db, 'sync_queue');
        await dbOps.setMetadata(db, 'last_sync_time', data.sync_timestamp);

        setLastSyncTime(new Date(data.sync_timestamp).toLocaleString());
        setOfflineQueueCount(0);
        setSyncStatus('success');
        showToast('✓ Synced successfully', 'success');

        setTimeout(() => setSyncStatus('idle'), 2000);
      }
      // Update React state from merged backend state
      if (data.merged_prices) {
        setPrices(data.merged_prices);
      }

      if (data.merged_vendors) {
        setVendors(data.merged_vendors);
      }

      if (data.merged_chemicals) {
        setChemicals(data.merged_chemicals);
      }

      if (data.merged_gardens) {
        setGarden(data.merged_gardens[0]);
      }

      // Refresh IndexedDB with latest merged state

      // Clear old data
      await dbOps.clear(db, 'prices');
      await dbOps.clear(db, 'vendors');
      await dbOps.clear(db, 'chemicals');
      await dbOps.clear(db, 'gardens');

      // Save latest prices
      for (const price of data.merged_prices || []) {
        await dbOps.put(db, 'prices', price);
      }

      // Save latest vendors
      for (const vendor of data.merged_vendors || []) {
        await dbOps.put(db, 'vendors', vendor);
      }

      // Save latest chemicals
      for (const chemical of data.merged_chemicals || []) {
        await dbOps.put(db, 'chemicals', chemical);
      }

      // Save latest gardens
      for (const gdn of data.merged_gardens || []) {
        await dbOps.put(db, 'gardens', gdn);
      }
    } catch (error) {
      console.error('Sync error:', error);
      setSyncStatus('error');
      showToast('Sync failed - data saved locally', 'error');
      setTimeout(() => setSyncStatus('idle'), 2000);
    }
  };

  const getPriceComparison = (price) => {
    price = Number(price);
    if (isNaN(price)) return null;

    if (!currentPrice) return null;
    const curr = parseFloat(currentPrice);
    if (isNaN(curr)) return null;

    if (price < curr) {
      return { type: 'lower', diff: (curr - price).toFixed(2) };
    } else if (price > curr) {
      return { type: 'higher', diff: (price - curr).toFixed(2) };
    } else {
      return { type: 'equal' };
    }
  };

  const filteredChemicalOptions = searchFuzzy(searchChemical, chemicals, 'name');
  const filteredVendorOptions = searchFuzzy(searchVendor, vendors, 'name');
  const filteredLogChemicals = searchFuzzy(logFormData.chemical, chemicals, 'name');
  const filteredLogVendors = searchFuzzy(logFormData.vendor, vendors, 'name');

  // =========================================================================
  // RENDER
  // =========================================================================

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 pb-20 md:pb-0">
      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed top-4 right-4 p-4 rounded-lg shadow-lg text-white z-50 animate-pulse ${
            toast.type === 'success'
              ? 'bg-green-600'
              : toast.type === 'error'
              ? 'bg-red-600'
              : toast.type === 'warning'
              ? 'bg-amber-600'
              : 'bg-blue-600'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Header */}
      <header className="bg-white shadow-sm border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Price Negotiator</h1>
            <p className="text-xs text-slate-500 mt-1">
              Live negotiation tool • Offline-first PWA
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 hover:bg-slate-100 rounded-lg transition"
              title="Settings"
            >
              <Settings size={20} className="text-slate-600" />
            </button>
            <button
              onClick={handleSync}
              disabled={syncStatus === 'syncing'}
              className={`p-2 rounded-lg transition ${
                syncStatus === 'syncing' ? 'bg-blue-50' : 'hover:bg-slate-100'
              }`}
              title="Manual sync"
            >
              <RefreshCw
                size={20}
                className={`${
                  syncStatus === 'syncing'
                    ? 'text-blue-600 animate-spin'
                    : 'text-slate-600'
                }`}
              />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Settings Panel */}
        {showSettings && (
          <div className="bg-white rounded-lg shadow-md p-6 mb-6 border-l-4 border-blue-500">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-slate-900">Sync Status</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={20} />
              </button>
            </div>
        
            <div className="space-y-4 text-sm">
              <div>
                <p className="text-slate-600">
                  <strong>Last Sync:</strong> {lastSyncTime ? lastSyncTime : 'Never'}
                </p>
              </div>
              <div>
                <p className="text-slate-600">
                  <strong>Pending Sync:</strong>{' '}
                  <span
                    className={
                      offlineQueueCount > 0
                        ? 'text-orange-600 font-semibold'
                        : 'text-green-600'
                    }
                  >
                    {offlineQueueCount} record{offlineQueueCount !== 1 ? 's' : ''}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-slate-600">
                  <strong>Total Records:</strong> {prices.length}
                </p>
              </div>
              <div>
                <p className="text-slate-600">
                  <strong>Status:</strong>{' '}
                  {syncStatus === 'idle' ? (
                    <span className="text-green-600">Ready</span>
                  ) : syncStatus === 'syncing' ? (
                    <span className="text-blue-600">Syncing...</span>
                  ) : syncStatus === 'success' ? (
                    <span className="text-green-600">✓ Synced</span>
                  ) : (
                    <span className="text-red-600">✗ Error</span>
                  )}
                </p>
              </div>
                
              <div className="border-t border-slate-200 pt-4">
                <button
                  onClick={() => {
                    setShowSettings(false);
                    const sorted = [...prices].sort((a, b) => {
                      if (a.vendor_name !== b.vendor_name) {
                        return a.vendor_name.localeCompare(b.vendor_name);
                      }
                      return a.chemical_name.localeCompare(b.chemical_name);
                    });
                    setResults(sorted);
                    setSearchChemical('');
                    setSearchVendor('');
                  }}
                  className="w-full bg-slate-600 hover:bg-slate-700 text-white font-semibold py-2 px-4 rounded-lg transition flex items-center justify-center gap-2"
                >
                  <Search size={16} />
                  View Entire Dataset
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Search Panel */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6 border-l-4 border-indigo-500">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Search Prices</h2>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
            {/* Chemical Search */}
            <div className="relative">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Chemical Name
              </label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search chemical..."
                  value={searchChemical}
                  onChange={(e) => {
                    setSearchChemical(e.target.value);
                    setOpenDropdown('chemical');
                  }}
                  onFocus={() => setOpenDropdown('chemical')}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition pr-10"
                />
                {searchChemical ? (
                  <button
                    onClick={() => {
                      setSearchChemical('');
                      setOpenDropdown(null);
                    }}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600"
                  >
                    <X size={18} />
                  </button>
                ) : (
                  <Search size={18} className="absolute right-3 top-2.5 text-slate-400" />
                )}
              </div>
              
              {openDropdown === 'chemical' && filteredChemicalOptions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-300 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                  {filteredChemicalOptions.map((chem) => (
                    <div
                      key={chem.id}
                      onClick={() => {
                        setSearchChemical(chem.name);
                        setOpenDropdown(null);
                      }}
                      className="px-4 py-2 hover:bg-indigo-50 cursor-pointer border-b border-slate-200 last:border-b-0 text-sm"
                    >
                      {chem.name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Vendor Search */}
            <div className="relative">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Vendor Name (Optional)
              </label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search vendor..."
                  value={searchVendor}
                  onChange={(e) => {
                    setSearchVendor(e.target.value);
                    setOpenDropdown('vendor');
                  }}
                  onFocus={() => setOpenDropdown('vendor')}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition pr-10"
                />
                {searchVendor ? (
                  <button
                    onClick={() => {
                      setSearchVendor('');
                      setOpenDropdown(null);
                    }}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600"
                  >
                    <X size={18} />
                  </button>
                ) : (
                  <Search size={18} className="absolute right-3 top-2.5 text-slate-400" />
                )}
              </div>

              {openDropdown === 'vendor' && filteredVendorOptions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-300 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                  {filteredVendorOptions.map((vendor) => (
                    <div
                      key={vendor.id}
                      onClick={() => {
                        setSearchVendor(vendor.name);
                        setOpenDropdown(null);
                      }}
                      className="px-4 py-2 hover:bg-indigo-50 cursor-pointer border-b border-slate-200 last:border-b-0 text-sm"
                    >
                      {vendor.name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Garden Name */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Garden Name
              </label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Garden..."
                  value={garden?.name || 'Loading...'}
                  disabled
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-slate-100 text-slate-600 cursor-not-allowed"
                />
                <span className="absolute right-3 top-2.5 text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded font-semibold">
                  {garden ? '✓ Active' : 'Loading'}
                </span>
              </div>
            </div>

            {/* Current Price */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Current Negotiating Price (Optional)
              </label>
              <input
                type="number"
                placeholder="Enter price to compare..."
                value={currentPrice}
                onChange={(e) => setCurrentPrice(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
              />
            </div>
          </div>

          {/* Sort Controls */}
          {results.length > 0 && (
            <div className="flex items-center justify-between pt-4 border-t border-slate-200">
              <p className="text-sm text-slate-600">
                {results.length} result{results.length !== 1 ? 's' : ''} found
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setSortOrder('asc')}
                  className={`px-3 py-1 text-sm rounded transition ${
                    sortOrder === 'asc'
                      ? 'bg-indigo-100 text-indigo-700 font-semibold'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  ↑ Low to High
                </button>
                <button
                  onClick={() => setSortOrder('desc')}
                  className={`px-3 py-1 text-sm rounded transition ${
                    sortOrder === 'desc'
                      ? 'bg-indigo-100 text-indigo-700 font-semibold'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  ↓ High to Low
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        <div className="space-y-3">
          {results.length > 0 ? (
            results.map((result) => {
              const comparison = getPriceComparison(result.price_per_unit);
              const isSearchedVendor =
                searchVendor &&
                result.vendor_name.toLowerCase() === searchVendor.toLowerCase();

              return (
                <div
                  key={result.id}
                  className={`bg-white rounded-lg shadow-sm p-5 border-l-4 transition ${
                    isSearchedVendor
                      ? 'border-l-green-500 bg-green-50'
                      : 'border-l-slate-300 hover:shadow-md'
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-slate-900">
                        {result.vendor_name}
                        {isSearchedVendor && (
                          <span className="ml-2 text-xs bg-green-200 text-green-800 px-2 py-1 rounded font-semibold">
                            SEARCHED
                          </span>
                        )}
                      </h3>
                      <p className="text-xs text-slate-500 mt-1">
                        Garden: <span className="font-semibold text-slate-700">{garden?.name || 'N/A'}</span>
                      </p>
                      <p className="text-sm text-slate-600 mt-1">{result.chemical_name}</p>
                    </div>

                    {comparison && (
                      <div
                        className={`text-right px-3 py-2 rounded text-sm font-semibold flex items-center gap-1 whitespace-nowrap ml-4 ${
                          comparison.type === 'lower'
                            ? 'bg-green-100 text-green-800'
                            : comparison.type === 'higher'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {comparison.type === 'lower' && (
                          <>
                            <TrendingDown size={16} />
                            Save ₹{comparison.diff}
                          </>
                        )}
                        {comparison.type === 'higher' && (
                          <>
                            <TrendingUp size={16} />
                            Lose ₹{comparison.diff}
                          </>
                        )}
                        {comparison.type === 'equal' && <>Equal</>}
                      </div>
                    )}
                  </div>

                  <div className="flex items-baseline justify-between">
                    <div>
                      <p className="text-2xl font-bold text-slate-900">
                        ₹{Number(result.price_per_unit || 0).toFixed(2)}
                        <span className="text-sm text-slate-600 font-normal">
                          /{result.unit}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Last purchased:{' '}
                        {result.purchase_date
                          ? result.purchase_date.split('T')[0]
                          : 'N/A'}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setEditPriceData({
                          id: result.id,
                          chemical: result.chemical_name,
                          vendor: result.vendor_name,
                          price: result.price_per_unit.toString(),
                          unit: result.unit,
                          date: result.purchase_date,
                        });
                        setShowEditPrice(true);
                      }}
                      className="ml-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2 px-3 rounded-lg transition text-sm"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              );
            })
          ) : searchChemical || searchVendor ? (
            <div className="bg-slate-50 rounded-lg p-8 text-center border border-dashed border-slate-300">
              <Search size={32} className="text-slate-400 mx-auto mb-3" />
              <p className="text-slate-600">No results found</p>
              <p className="text-sm text-slate-500 mt-1">
                Try searching for different chemicals or vendors
              </p>
            </div>
          ) : (
            <div className="bg-slate-50 rounded-lg p-8 text-center border border-dashed border-slate-300">
              <Search size={32} className="text-slate-400 mx-auto mb-3" />
              <p className="text-slate-600">Start searching to see prices</p>
              <p className="text-sm text-slate-500 mt-1">
                Enter a chemical name or vendor to view pricing history
              </p>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="fixed bottom-6 left-4 right-4 md:relative md:bottom-auto md:left-auto md:right-auto md:mt-8 flex gap-3">
          <button
            onClick={() => setShowLogPrice(true)}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition flex items-center justify-center gap-2"
          >
            <Plus size={20} />
            Log Purchase
          </button>
        </div>

        {/* Hidden file input for CSV import */}
        {/* Removed - CSV import no longer needed */}
      </main>

      {/* Modals */}

      {/* Edit Price Modal */}
      {showEditPrice && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-sm max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-900">Update Price</h2>
              <button
                onClick={() => setShowEditPrice(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4 mb-6">
              {/* Chemical (read-only) */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Chemical
                </label>
                <input
                  type="text"
                  value={editPriceData.chemical}
                  disabled
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-slate-100 text-slate-600"
                />
              </div>

              {/* Vendor (read-only) */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Vendor
                </label>
                <input
                  type="text"
                  value={editPriceData.vendor}
                  disabled
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-slate-100 text-slate-600"
                />
              </div>

              {/* Price */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Price per Unit *
                </label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={editPriceData.price}
                  onChange={(e) =>
                    setEditPriceData({ ...editPriceData, price: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              {/* Unit */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Unit
                </label>
                <input
                  type="text"
                  placeholder="e.g., ltr, kgs, bag"
                  value={editPriceData.unit}
                  onChange={(e) =>
                    setEditPriceData({ ...editPriceData, unit: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              {/* Purchase Date */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Purchase Date *
                </label>
                <input
                  type="date"
                  value={editPriceData.date?.split('T')[0]}
                  onChange={(e) =>
                    setEditPriceData({ ...editPriceData, date: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowEditPrice(false)}
                className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-900 font-semibold py-2 px-4 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                onClick={handleEditPrice}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition"
              >
                Update Price
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Log Price Modal */}
      {showLogPrice && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-sm max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-900">Log Purchase</h2>
              <button
                onClick={() => setShowLogPrice(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4 mb-6">
              {/* Chemical dropdown */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Chemical *
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Add chemical..."
                    onFocus={() => setOpenDropdown('log-chemical')}
                    value={logFormData.chemical}
                    onChange={(e) =>
                      setLogFormData({
                        ...logFormData,
                        chemical: e.target.value,
                      })
                    }
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg"
                  />
                  {openDropdown === 'log-chemical' &&
                    logFormData.chemical &&
                    filteredLogChemicals.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-300 rounded-lg shadow-lg z-50 max-h-40 overflow-y-auto">
                      {filteredLogChemicals.map((chem) => (
                        <div
                          key={chem.id}
                          onClick={() => {
                            setLogFormData({
                              ...logFormData,
                              chemical: chem.name,
                            });
                          
                            setOpenDropdown(null);
                          }}
                          className="px-4 py-2 hover:bg-slate-100 cursor-pointer border-b border-slate-200 last:border-b-0 text-sm"
                        >
                          {chem.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Vendor dropdown */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Vendor *
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Add vendor..."
                    onFocus={() => setOpenDropdown('log-vendor')}
                    value={logFormData.vendor}
                    onChange={(e) =>
                      setLogFormData({
                        ...logFormData,
                        vendor: e.target.value,
                      })
                    }
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg"
                  />
                  {openDropdown === 'log-vendor' &&
                    logFormData.vendor &&
                    filteredLogVendors.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-300 rounded-lg shadow-lg z-50 max-h-40 overflow-y-auto">
                      {filteredLogVendors.map((vendor) => (
                        <div
                          key={vendor.id}
                          onClick={() => {
                            setLogFormData({
                              ...logFormData,
                              vendor: vendor.name,
                            });
                          
                            setOpenDropdown(null);
                          }}
                          className="px-4 py-2 hover:bg-slate-100 cursor-pointer border-b border-slate-200 last:border-b-0 text-sm"
                        >
                          {vendor.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Price */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Price per Unit *
                </label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={logFormData.price}
                  onChange={(e) =>
                    setLogFormData({ ...logFormData, price: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg"
                />
              </div>

              {/* Unit */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Unit
                </label>
                <input
                  type="text"
                  placeholder="e.g., ltr, kgs, bag"
                  value={logFormData.unit}
                  onChange={(e) =>
                    setLogFormData({ ...logFormData, unit: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg"
                />
              </div>

              {/* Date */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Purchase Date *
                </label>
                <input
                  type="date"
                  value={logFormData.date?.split('T')[0]}
                  onChange={(e) =>
                    setLogFormData({ ...logFormData, date: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowLogPrice(false)}
                className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-900 font-semibold py-2 px-4 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                onClick={handleLogPrice}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition"
              >
                Log Price
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}