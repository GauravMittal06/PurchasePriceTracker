import React, { useState, useEffect, useRef } from 'react';
import { Search, Plus, RefreshCw, Settings, X, TrendingDown, TrendingUp, ChevronDown, Leaf } from 'lucide-react';

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
  const [sortType, setSortType] = useState('price');
  const [sortOrder, setSortOrder] = useState('asc');
  const [showSortMenu, setShowSortMenu] = useState(false);

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
  // SEARCH & FILTERING WITH IMPROVED SORTING
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

    // Apply sorting based on sortType
    filtered.sort((a, b) => {
      let compareValue = 0;

      if (sortType === 'price') {
        compareValue = a.price_per_unit - b.price_per_unit;
      } else if (sortType === 'date') {
        compareValue = new Date(a.purchase_date) - new Date(b.purchase_date);
      } else if (sortType === 'alphabetic') {
        compareValue = a.chemical_name.localeCompare(b.chemical_name);
      }

      return sortOrder === 'asc' ? compareValue : -compareValue;
    });

    setResults(filtered);
  }, [searchChemical, searchVendor, prices, sortType, sortOrder]);

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
        id: `vendor-${Date.now()}`,
        name: logFormData.vendor,
        created_at: Date.now(),
        synced: false,
      };
      await dbOps.put(db, 'vendors', newVendor);
      await dbOps.add(db, 'sync_queue', {
        id: `sync-vendor-${Date.now()}`,
        action: 'create_vendor',
        payload: newVendor,
        timestamp: Date.now(),
        synced: false,
      });
      setVendors([...vendors, newVendor]);
    }

    // Auto-add chemical if new
    const chemicalExists = chemicals.some(
      (c) => c.name.toLowerCase() === logFormData.chemical.toLowerCase()
    );

    if (!chemicalExists) {
      const newChemical = {
        id: `chem-${Date.now()}`,
        name: logFormData.chemical,
        created_at: Date.now(),
        synced: false,
      };
      await dbOps.put(db, 'chemicals', newChemical);
      await dbOps.add(db, 'sync_queue', {
        id: `sync-chem-${Date.now()}`,
        action: 'create_chemical',
        payload: newChemical,
        timestamp: Date.now(),
        synced: false,
      });
      setChemicals([...chemicals, newChemical]);
    }

    setPrices([...prices, newPrice]);
    setOfflineQueueCount((c) => c + 1);
    setLogFormData({
      chemical: '',
      vendor: '',
      price: '',
      unit: 'unit',
      date: new Date().toISOString().split('T')[0],
    });
    setShowLogPrice(false);
    showToast('Price logged successfully', 'success');
  };

  const handleEditPrice = async () => {
    if (
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
      id: editPriceData.id,
      chemical_name: editPriceData.chemical,
      vendor_name: editPriceData.vendor,
      price_per_unit: parseFloat(editPriceData.price),
      unit: editPriceData.unit || 'unit',
      quantity: 1,
      purchase_date: editPriceData.date,
      created_at: Date.now(),
      last_modified: Date.now(),
      synced: false,
    };

    await dbOps.put(db, 'prices', updatedPrice);
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

      if (data.merged_gardens && data.merged_gardens.length > 0) {
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

    // REVERSED LOGIC: if price < curr, it's a loss for the negotiator
    if (price < curr) {
      return { type: 'higher', diff: (curr - price).toFixed(2) };
    } else if (price > curr) {
      return { type: 'lower', diff: (price - curr).toFixed(2) };
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
    <div
      className="min-h-screen bg-slate-50"
      onClick={() => { setOpenDropdown(null); setShowSortMenu(false); }}
    >
      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 px-5 py-3 rounded-2xl shadow-2xl text-white text-sm font-semibold pointer-events-none ${
            toast.type === 'success' ? 'bg-emerald-600'
            : toast.type === 'error' ? 'bg-red-500'
            : toast.type === 'warning' ? 'bg-amber-500'
            : 'bg-slate-700'
          }`}
        >
          {toast.type === 'success' && <span>✓</span>}
          {toast.type === 'error' && <span>✗</span>}
          {toast.type === 'warning' && <span>!</span>}
          {toast.message}
        </div>
      )}

      {/* Header */}
      <header className="bg-teal-700 sticky top-0 z-40 shadow-lg">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-teal-600 p-2 rounded-xl">
              <Leaf size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white leading-tight">Price Negotiator</h1>
              {garden && (
                <p className="text-teal-200 text-xs leading-tight">{garden.name}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {offlineQueueCount > 0 && (
              <span className="bg-amber-400 text-amber-900 text-xs font-bold px-2 py-0.5 rounded-full">
                {offlineQueueCount} pending
              </span>
            )}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2 rounded-xl transition ${showSettings ? 'bg-teal-600 text-white' : 'text-teal-200 hover:text-white hover:bg-teal-600'}`}
              title="Settings"
            >
              <Settings size={19} />
            </button>
            <button
              onClick={handleSync}
              disabled={syncStatus === 'syncing'}
              className={`p-2 rounded-xl transition ${syncStatus === 'syncing' ? 'bg-teal-600 text-white' : 'text-teal-200 hover:text-white hover:bg-teal-600'}`}
              title="Sync"
            >
              <RefreshCw size={19} className={syncStatus === 'syncing' ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 py-5 pb-24 md:pb-8">

        {/* Settings Panel */}
        {showSettings && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 mb-5">
            <div className="flex justify-between items-center mb-4">
              <h2 className="font-semibold text-slate-800">Sync & Data Status</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition"
              >
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                <p className="text-xs text-slate-400 font-medium mb-1">Last Sync</p>
                <p className="text-sm font-semibold text-slate-800 truncate">{lastSyncTime || 'Never'}</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                <p className="text-xs text-slate-400 font-medium mb-1">Pending</p>
                <p className={`text-sm font-bold ${offlineQueueCount > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {offlineQueueCount} record{offlineQueueCount !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                <p className="text-xs text-slate-400 font-medium mb-1">Total Records</p>
                <p className="text-sm font-bold text-slate-800">{prices.length}</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                <p className="text-xs text-slate-400 font-medium mb-1">Status</p>
                <p className={`text-sm font-bold ${
                  syncStatus === 'idle' ? 'text-emerald-600'
                  : syncStatus === 'syncing' ? 'text-blue-600'
                  : syncStatus === 'success' ? 'text-emerald-600'
                  : 'text-red-500'
                }`}>
                  {syncStatus === 'idle' && '● Ready'}
                  {syncStatus === 'syncing' && '↻ Syncing...'}
                  {syncStatus === 'success' && '✓ Synced'}
                  {syncStatus === 'error' && '✗ Error'}
                </p>
              </div>
            </div>
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
              className="w-full flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-800 text-white font-semibold py-2.5 px-4 rounded-xl transition text-sm"
            >
              <Search size={14} />
              View Entire Dataset
            </button>
          </div>
        )}

        {/* Search Panel */}
        <div
          className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 mb-5"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-4">Search Prices</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            {/* Chemical Search */}
            <div className="relative">
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">
                Chemical
              </label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search chemical..."
                  value={searchChemical}
                  onChange={(e) => { setSearchChemical(e.target.value); setOpenDropdown('chemical'); }}
                  onFocus={() => setOpenDropdown('chemical')}
                  className="w-full pl-4 pr-9 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
                {searchChemical ? (
                  <button
                    onClick={() => { setSearchChemical(''); setOpenDropdown(null); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                )}
              </div>
              {openDropdown === 'chemical' && filteredChemicalOptions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto">
                  {filteredChemicalOptions.map((chem) => (
                    <div
                      key={chem.id}
                      onClick={() => { setSearchChemical(chem.name); setOpenDropdown(null); }}
                      className="px-4 py-2.5 hover:bg-teal-50 hover:text-teal-700 cursor-pointer text-sm text-slate-700 border-b border-slate-100 last:border-b-0 transition"
                    >
                      {chem.name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Vendor Search */}
            <div className="relative">
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">
                Vendor <span className="text-slate-400 normal-case font-normal">(optional)</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search vendor..."
                  value={searchVendor}
                  onChange={(e) => { setSearchVendor(e.target.value); setOpenDropdown('vendor'); }}
                  onFocus={() => setOpenDropdown('vendor')}
                  className="w-full pl-4 pr-9 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
                {searchVendor ? (
                  <button
                    onClick={() => { setSearchVendor(''); setOpenDropdown(null); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                )}
              </div>
              {openDropdown === 'vendor' && filteredVendorOptions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto">
                  {filteredVendorOptions.map((vendor) => (
                    <div
                      key={vendor.id}
                      onClick={() => { setSearchVendor(vendor.name); setOpenDropdown(null); }}
                      className="px-4 py-2.5 hover:bg-teal-50 hover:text-teal-700 cursor-pointer text-sm text-slate-700 border-b border-slate-100 last:border-b-0 transition"
                    >
                      {vendor.name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Garden Name */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">
                Garden
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={garden?.name || 'Loading...'}
                  disabled
                  className="w-full pl-4 pr-20 py-2.5 bg-teal-50 border border-teal-100 rounded-xl text-sm text-teal-700 font-medium cursor-not-allowed"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs bg-teal-200 text-teal-800 px-2 py-0.5 rounded-full font-semibold whitespace-nowrap">
                  {garden ? '✓ Active' : '...'}
                </span>
              </div>
            </div>

            {/* Current Negotiating Price */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">
                Negotiating Price <span className="text-slate-400 normal-case font-normal">(optional)</span>
              </label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 font-semibold text-sm">₹</span>
                <input
                  type="number"
                  placeholder="Enter to compare..."
                  value={currentPrice}
                  onChange={(e) => setCurrentPrice(e.target.value)}
                  className="w-full pl-7 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
              </div>
            </div>
          </div>

          {/* Sort Controls */}
          {results.length > 0 && (
            <div className="flex flex-wrap items-center justify-between pt-4 border-t border-slate-100 gap-3">
              <p className="text-sm text-slate-500">
                <span className="font-bold text-slate-700">{results.length}</span> result{results.length !== 1 ? 's' : ''}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowSortMenu(!showSortMenu); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200 transition"
                  >
                    Sort: {sortType === 'price' ? 'Price' : sortType === 'date' ? 'Date' : 'Alphabetic'}
                    <ChevronDown size={12} />
                  </button>
                  {showSortMenu && (
                    <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-50 min-w-36 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                      {[
                        { key: 'price', label: 'Price' },
                        { key: 'date', label: 'Date of Purchase' },
                        { key: 'alphabetic', label: 'Alphabetic' },
                      ].map(({ key, label }) => (
                        <button
                          key={key}
                          onClick={() => { setSortType(key); setShowSortMenu(false); }}
                          className={`w-full text-left px-4 py-2.5 text-sm transition border-b border-slate-100 last:border-b-0 ${sortType === key ? 'bg-teal-50 text-teal-700 font-semibold' : 'hover:bg-slate-50 text-slate-700'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex rounded-lg overflow-hidden border border-slate-200">
                  <button
                    onClick={() => setSortOrder('asc')}
                    className={`px-3 py-1.5 text-xs font-semibold transition ${sortOrder === 'asc' ? 'bg-teal-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                  >
                    ↑ Asc
                  </button>
                  <button
                    onClick={() => setSortOrder('desc')}
                    className={`px-3 py-1.5 text-xs font-semibold transition border-l border-slate-200 ${sortOrder === 'desc' ? 'bg-teal-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                  >
                    ↓ Desc
                  </button>
                </div>
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
                  className={`bg-white rounded-2xl shadow-sm border transition hover:shadow-md ${
                    isSearchedVendor
                      ? 'border-teal-300 ring-1 ring-teal-200'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="p-5">
                    {/* Top row */}
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1.5">
                          <h3 className="text-base font-bold text-slate-900 leading-tight">
                            {result.vendor_name}
                          </h3>
                          {isSearchedVendor && (
                            <span className="text-xs bg-teal-100 text-teal-700 px-2 py-0.5 rounded-full font-semibold">
                              SEARCHED
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full font-medium">
                            {result.chemical_name}
                          </span>
                          {garden && (
                            <span className="text-xs text-slate-400">{garden.name}</span>
                          )}
                        </div>
                      </div>
                      {comparison && (
                        <div
                          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold shrink-0 ${
                            comparison.type === 'lower'
                              ? 'bg-emerald-100 text-emerald-700'
                              : comparison.type === 'higher'
                              ? 'bg-red-100 text-red-600'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {comparison.type === 'lower' && <><TrendingDown size={15} /> Save ₹{comparison.diff}</>}
                          {comparison.type === 'higher' && <><TrendingUp size={15} /> Lose ₹{comparison.diff}</>}
                          {comparison.type === 'equal' && <>Equal</>}
                        </div>
                      )}
                    </div>

                    {/* Bottom row */}
                    <div className="flex items-end justify-between pt-3 border-t border-slate-100">
                      <div>
                        <p className="text-3xl font-black text-slate-900 leading-none tracking-tight">
                          ₹{Number(result.price_per_unit || 0).toFixed(2)}
                          <span className="text-sm font-normal text-slate-500 ml-1">/{result.unit}</span>
                        </p>
                        <p className="text-xs text-slate-400 mt-1.5">
                          Last purchase: {result.purchase_date?.split('T')[0] || 'N/A'}
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
                        className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2 px-4 rounded-xl transition text-sm"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : searchChemical || searchVendor ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
              <div className="bg-slate-100 rounded-full w-14 h-14 flex items-center justify-center mx-auto mb-4">
                <Search size={22} className="text-slate-400" />
              </div>
              <p className="font-semibold text-slate-700">No results found</p>
              <p className="text-sm text-slate-400 mt-1">Try different chemicals or vendors</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-dashed border-slate-200 p-12 text-center">
              <div className="bg-teal-50 rounded-full w-14 h-14 flex items-center justify-center mx-auto mb-4">
                <Search size={22} className="text-teal-400" />
              </div>
              <p className="font-semibold text-slate-700">Search to see prices</p>
              <p className="text-sm text-slate-400 mt-1">Enter a chemical or vendor name above</p>
            </div>
          )}
        </div>

        {/* Log Price Button — Desktop */}
        <div className="hidden md:flex justify-end mt-6">
          <button
            onClick={() => setShowLogPrice(true)}
            className="flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white font-semibold py-3 px-6 rounded-xl shadow-md hover:shadow-lg transition"
          >
            <Plus size={18} />
            Log Price
          </button>
        </div>
      </main>

      {/* Log Price FAB — Mobile only */}
      <div className="fixed bottom-6 right-5 md:hidden z-30">
        <button
          onClick={() => setShowLogPrice(true)}
          className="w-14 h-14 flex items-center justify-center bg-teal-600 hover:bg-teal-700 text-white rounded-full shadow-xl hover:shadow-2xl transition active:scale-95"
          title="Log a new price"
        >
          <Plus size={22} />
        </button>
      </div>

      {/* Edit Price Modal */}
      {showEditPrice && (
        <div
          className="fixed inset-0 bg-black/60 flex items-end md:items-center justify-center z-50 p-0 md:p-4"
          onClick={() => setShowEditPrice(false)}
        >
          <div
            className="bg-white w-full md:max-w-sm rounded-t-3xl md:rounded-2xl shadow-2xl max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Handle bar for mobile */}
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 bg-slate-200 rounded-full" />
            </div>
            <div className="flex justify-between items-center px-5 pt-4 pb-4 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-900">Edit Price</h2>
              <button
                onClick={() => setShowEditPrice(false)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-xl hover:bg-slate-100 transition"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Chemical *</label>
                <input
                  type="text"
                  value={editPriceData.chemical}
                  onChange={(e) => setEditPriceData({ ...editPriceData, chemical: e.target.value })}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Vendor *</label>
                <input
                  type="text"
                  value={editPriceData.vendor}
                  onChange={(e) => setEditPriceData({ ...editPriceData, vendor: e.target.value })}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Price per Unit *</label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-medium">₹</span>
                    <input
                      type="number"
                      value={editPriceData.price}
                      onChange={(e) => setEditPriceData({ ...editPriceData, price: e.target.value })}
                      className="w-full pl-7 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Unit</label>
                  <input
                    type="text"
                    value={editPriceData.unit}
                    onChange={(e) => setEditPriceData({ ...editPriceData, unit: e.target.value })}
                    placeholder="ltr, kgs, bag"
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Purchase Date *</label>
                <input
                  type="date"
                  value={editPriceData.date?.split('T')[0]}
                  onChange={(e) => setEditPriceData({ ...editPriceData, date: e.target.value })}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
              </div>
            </div>

            <div className="px-5 pb-6 flex gap-3">
              <button
                onClick={() => setShowEditPrice(false)}
                className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 rounded-xl transition text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleEditPrice}
                className="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-semibold py-3 rounded-xl transition text-sm"
              >
                Update Price
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Log Price Modal */}
      {showLogPrice && (
        <div
          className="fixed inset-0 bg-black/60 flex items-end md:items-center justify-center z-50 p-0 md:p-4"
          onClick={() => setShowLogPrice(false)}
        >
          <div
            className="bg-white w-full md:max-w-sm rounded-t-3xl md:rounded-2xl shadow-2xl max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Handle bar for mobile */}
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 bg-slate-200 rounded-full" />
            </div>
            <div className="flex justify-between items-center px-5 pt-4 pb-4 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-900">Log Purchase</h2>
              <button
                onClick={() => setShowLogPrice(false)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-xl hover:bg-slate-100 transition"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* Chemical dropdown */}
              <div className="relative" onClick={(e) => e.stopPropagation()}>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Chemical *</label>
                <input
                  type="text"
                  placeholder="Type or select chemical..."
                  onFocus={() => setOpenDropdown('log-chemical')}
                  value={logFormData.chemical}
                  onChange={(e) => setLogFormData({ ...logFormData, chemical: e.target.value })}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
                {openDropdown === 'log-chemical' && logFormData.chemical && filteredLogChemicals.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-50 max-h-40 overflow-y-auto">
                    {filteredLogChemicals.map((chem) => (
                      <div
                        key={chem.id}
                        onClick={() => { setLogFormData({ ...logFormData, chemical: chem.name }); setOpenDropdown(null); }}
                        className="px-4 py-2.5 hover:bg-teal-50 hover:text-teal-700 cursor-pointer text-sm text-slate-700 border-b border-slate-100 last:border-b-0 transition"
                      >
                        {chem.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Vendor dropdown */}
              <div className="relative" onClick={(e) => e.stopPropagation()}>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Vendor *</label>
                <input
                  type="text"
                  placeholder="Type or select vendor..."
                  onFocus={() => setOpenDropdown('log-vendor')}
                  value={logFormData.vendor}
                  onChange={(e) => setLogFormData({ ...logFormData, vendor: e.target.value })}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
                {openDropdown === 'log-vendor' && logFormData.vendor && filteredLogVendors.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-50 max-h-40 overflow-y-auto">
                    {filteredLogVendors.map((vendor) => (
                      <div
                        key={vendor.id}
                        onClick={() => { setLogFormData({ ...logFormData, vendor: vendor.name }); setOpenDropdown(null); }}
                        className="px-4 py-2.5 hover:bg-teal-50 hover:text-teal-700 cursor-pointer text-sm text-slate-700 border-b border-slate-100 last:border-b-0 transition"
                      >
                        {vendor.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Price per Unit *</label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-medium">₹</span>
                    <input
                      type="number"
                      placeholder="0.00"
                      value={logFormData.price}
                      onChange={(e) => setLogFormData({ ...logFormData, price: e.target.value })}
                      className="w-full pl-7 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Unit</label>
                  <input
                    type="text"
                    placeholder="ltr, kgs, bag..."
                    value={logFormData.unit}
                    onChange={(e) => setLogFormData({ ...logFormData, unit: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Purchase Date *</label>
                <input
                  type="date"
                  value={logFormData.date?.split('T')[0]}
                  onChange={(e) => setLogFormData({ ...logFormData, date: e.target.value })}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent focus:bg-white transition"
                />
              </div>
            </div>

            <div className="px-5 pb-6 flex gap-3">
              <button
                onClick={() => setShowLogPrice(false)}
                className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 rounded-xl transition text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleLogPrice}
                className="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-semibold py-3 rounded-xl transition text-sm"
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