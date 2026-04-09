// ============================================================
// SUPABASE CONFIG
// ============================================================
const SUPABASE_URL = 'https://uhbjhryumuhtnxelugmy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoYmpocnl1bXVodG54ZWx1Z215Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MDIwODIsImV4cCI6MjA5MTI3ODA4Mn0.pf2614vZJQN5VvjGCT7-WWgTzLDUSX__TdJBt5n3hVg';

async function sbFetch(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': options.prefer || 'return=representation',
        ...options.headers
      },
      signal: controller.signal,
      ...options
    });
    clearTimeout(timeoutId);
    if (!res.ok) { const err = await res.text(); throw new Error(err); }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  } catch(e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  }
}

// ============================================================
// ★ IndexedDB — بديل localStorage لتخزين البيانات الكبيرة
// ============================================================
const DB_NAME = 'ALMAHSMarketDB';
const DB_VERSION = 2;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // مخزن المنتجات الكاملة (بالصور والملفات)
      if (!db.objectStoreNames.contains('products'))
        db.createObjectStore('products', { keyPath: 'id' });
      // طابور العمليات اللي لسه ما اترفعتش على Supabase
      if (!db.objectStoreNames.contains('syncQueue'))
        db.createObjectStore('syncQueue', { keyPath: 'qid', autoIncrement: true });
      // إعدادات
      if (!db.objectStoreNames.contains('meta'))
        db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

async function idbClear(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

// ============================================================
// ★ Sync Queue — يحفظ العمليات الفاشلة ويعيد المحاولة
// ============================================================
async function queueOperation(op) {
  // op = { type: 'upsert'|'delete'|'patch', table, id, data }
  await idbPut('syncQueue', { ...op, timestamp: Date.now() });
}

async function flushSyncQueue() {
  let items = await idbGetAll('syncQueue');
  if (!items.length) return;

  console.log(`🔄 مزامنة ${items.length} عملية معلقة...`);
  let successCount = 0;

  for (const item of items) {
    try {
      if (item.type === 'upsert') {
        await sbFetch(item.table, { method: 'POST', body: JSON.stringify(item.data), prefer: 'return=representation' });
      } else if (item.type === 'patch') {
        await sbFetch(`${item.table}?id=eq.${item.id}`, { method: 'PATCH', body: JSON.stringify(item.data), prefer: 'return=minimal' });
      } else if (item.type === 'delete') {
        await sbFetch(`${item.table}?id=eq.${item.id}`, { method: 'DELETE', prefer: 'return=minimal' });
      }
      await idbDelete('syncQueue', item.qid);
      successCount++;
    } catch(e) {
      console.warn(`❌ فشل sync للعملية ${item.qid}:`, e.message);
    }
  }

  if (successCount > 0) {
    showToast(`✅ تمت مزامنة ${successCount} عملية معلقة`, 'success');
  }
}

// ============================================================
// GLOBAL STATE
// ============================================================
let products = [];
let orders = [];
let reviews = [];
let settings = {};
let coupons = [];
let selectedStars = 0;
let pendingFiles = [];
let pendingGallery = [];
let searchQuery = '';
let categories = [];
let currentCategoryPage = null;

// ============================================================
// ★ PRODUCTS — حفظ محلي أولاً، ثم Supabase في الخلفية
// ============================================================
async function loadProductsLocal() {
  try {
    return await idbGetAll('products');
  } catch(e) {
    console.warn('IndexedDB load failed:', e);
    return [];
  }
}

async function loadProductsRemote() {
  try {
    // ★ نجيب البيانات الخفيفة بس — من غير الـ files عشان نسرّع التحميل
    // نجيب الحقول الأساسية بس — بدون حقول ممكن متكونش موجودة في الجدول
    const LIGHT_FIELDS = 'id,name,description,price,category,image,gallery,created_at,user_id,files_locked';
    const data = await sbFetch('products?select=' + LIGHT_FIELDS + '&order=created_at.desc');
    if (data && data.length > 0) {
      // حفظ في IndexedDB — نحافظ على الـ files اللي عندنا كاش ليها
      for (const p of data) {
        const existing = await idbGet('products', p.id).catch(() => null);
        // لو عندنا نسخة كاملة في الكاش، حافظ عليها ومحدّثش الـ files
        if (existing && existing.files) {
          await idbPut('products', { ...existing, ...p, files: existing.files });
        } else {
          await idbPut('products', p);
        }
      }
      return data;
    }
    return null;
  } catch(e) {
    console.warn('Supabase fetch failed, using local cache:', e.message);
    return null;
  }
}

// ★ جلب المنتج الكامل مع الـ files من Supabase (بس لما الزبون يفتح المنتج)
async function loadProductFull(id) {
  try {
    const fresh = await sbFetch('products?id=eq.' + id);
    if (fresh && fresh[0]) {
      await idbPut('products', fresh[0]);
      // حدّث الـ products array في الذاكرة
      const idx = products.findIndex(x => x.id === id);
      if (idx !== -1) products[idx] = fresh[0];
      else products.push(fresh[0]);
      return fresh[0];
    }
    return null;
  } catch(e) {
    console.warn('loadProductFull failed:', e.message);
    return null;
  }
}

async function saveProductToDB(product) {
  // ① حفظ فوري في IndexedDB
  await idbPut('products', product);

  // ② حفظ في Supabase في الخلفية
  try {
    await sbFetch('products', { method: 'POST', body: JSON.stringify(product) });
  } catch(e) {
    console.warn('Supabase save failed, queued for retry:', e.message);
    // ③ لو فشل، ضيفه في الـ queue عشان يتعمل retry
    await queueOperation({ type: 'upsert', table: 'products', id: product.id, data: product });
    showToast('⚠️ حُفظ محلياً — سيُرفع تلقائياً عند الاتصال', 'warn');
  }
}

async function deleteProductFromDB(id) {
  // ① حذف فوري من IndexedDB
  await idbDelete('products', id);

  // ② حذف من Supabase في الخلفية
  try {
    await sbFetch('products?id=eq.' + id, { method: 'DELETE', prefer: 'return=minimal' });
  } catch(e) {
    console.warn('Supabase delete failed, queued:', e.message);
    await queueOperation({ type: 'delete', table: 'products', id });
  }
}

async function syncProductToSupabase(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;

  // تحديث IndexedDB أولاً
  await idbPut('products', p);

  const patchData = {
    pinned: p.pinned || false,
    hidden: p.hidden || false,
    status: p.status || 'متاح',
    name: p.name,
    price: p.price,
    description: p.description,
    category: p.category,
    admin_note: p.adminNote || '',
    image: p.image || '',
    gallery: p.gallery || []
  };

  try {
    await sbFetch('products?id=eq.' + id, { method: 'PATCH', body: JSON.stringify(patchData), prefer: 'return=minimal' });
  } catch(e) {
    console.warn('Supabase patch failed, queued:', e.message);
    await queueOperation({ type: 'patch', table: 'products', id, data: patchData });
  }
}

// ============================================================
// ORDERS
// ============================================================
async function loadOrders() {
  try {
    const data = await sbFetch('orders?order=created_at.desc');
    return data || [];
  } catch(e) { console.error('loadOrders:', e); return []; }
}
async function saveOrderToDB(order) {
  try {
    return await sbFetch('orders', { method: 'POST', body: JSON.stringify(order) });
  } catch(e) {
    await queueOperation({ type: 'upsert', table: 'orders', id: order.id, data: order });
    throw e;
  }
}
async function updateOrderStatusInDB(id, status) {
  try {
    await sbFetch('orders?id=eq.' + id, { method: 'PATCH', body: JSON.stringify({ status }), prefer: 'return=minimal' });
  } catch(e) {
    await queueOperation({ type: 'patch', table: 'orders', id, data: { status } });
  }
}
async function deleteOrderFromDB(id) {
  try {
    await sbFetch('orders?id=eq.' + id, { method: 'DELETE', prefer: 'return=minimal' });
  } catch(e) {
    await queueOperation({ type: 'delete', table: 'orders', id });
  }
}

// ============================================================
// REVIEWS
// ============================================================
async function loadReviews() {
  try {
    const data = await sbFetch('reviews?order=created_at.desc');
    return data || [];
  } catch(e) { console.error('loadReviews:', e); return []; }
}
async function saveReviewToDB(review) {
  return await sbFetch('reviews', { method: 'POST', body: JSON.stringify(review) });
}
async function updateReviewInDB(id, fields) {
  await sbFetch('reviews?id=eq.' + id, { method: 'PATCH', body: JSON.stringify(fields), prefer: 'return=minimal' });
}
async function deleteReviewFromDB(id) {
  await sbFetch('reviews?id=eq.' + id, { method: 'DELETE', prefer: 'return=minimal' });
}

// ============================================================
// SETTINGS
// ============================================================
async function loadSettings() {
  try {
    const data = await sbFetch('settings?id=eq.1');
    const s = data && data[0] ? data[0] : { id: 1, whatsapp: '', password_hash: '', access_code: '' };
    if (s.about_info && typeof s.about_info === 'string') {
      try { s.aboutInfo = JSON.parse(s.about_info); } catch(e) { s.aboutInfo = {}; }
    }
    if (s.social && typeof s.social === 'string') {
      try { s.social = JSON.parse(s.social); } catch(e) { s.social = {}; }
    }
    return s;
  } catch(e) { return { id: 1, whatsapp: '', password_hash: '', access_code: '' }; }
}
async function saveSettings() {
  const payload = { whatsapp: settings.whatsapp, password_hash: settings.passwordHash, access_code: settings.accessCode, about_info: JSON.stringify(settings.aboutInfo || {}), social: JSON.stringify(settings.social || {}) };
  try {
    await sbFetch('settings?id=eq.1', { method: 'PATCH', body: JSON.stringify(payload), prefer: 'return=minimal' });
  } catch(e) {
    try { await sbFetch('settings', { method: 'POST', body: JSON.stringify({ id: 1, ...payload }) }); } catch(e2) {}
  }
  // حفظ محلي كـ fallback
  try { await idbPut('meta', { key: 'settings', value: payload }); } catch(e) {}
}

// ============================================================
// COUPONS
// ============================================================
async function loadCoupons() {
  try { const data = await sbFetch('coupons?order=created_at.desc'); return data || []; } catch(e) { return []; }
}
async function saveCouponToDB(coupon) { return await sbFetch('coupons', { method: 'POST', body: JSON.stringify(coupon) }); }
async function updateCouponInDB(id, fields) { await sbFetch('coupons?id=eq.' + id, { method: 'PATCH', body: JSON.stringify(fields), prefer: 'return=minimal' }); }
async function deleteCouponFromDB(id) { await sbFetch('coupons?id=eq.' + id, { method: 'DELETE', prefer: 'return=minimal' }); }

// ============================================================
// CATEGORIES
// ============================================================
async function loadCategories() {
  try {
    // جرب Supabase أولاً
    const data = await sbFetch('categories?order=sort_order.asc');
    if (data && data.length >= 0) {
      // حفظ في IDB
      await idbPut('meta', { key: 'categories', value: data });
      return data;
    }
  } catch(e) {
    console.warn('categories supabase failed, using local:', e.message);
  }
  // fallback: IDB
  try {
    const local = await idbGet('meta', 'categories');
    return (local && local.value) || [];
  } catch(e) { return []; }
}

async function saveCategoryToDB(cat) {
  // حفظ محلي فوري
  const all = [...categories];
  const idx = all.findIndex(c => c.id === cat.id);
  if (idx !== -1) all[idx] = cat; else all.push(cat);
  await idbPut('meta', { key: 'categories', value: all });
  // Supabase في الخلفية
  try {
    await sbFetch('categories', { method: 'POST', body: JSON.stringify(cat) });
  } catch(e) {
    await queueOperation({ type: 'upsert', table: 'categories', id: cat.id, data: cat });
  }
}

async function deleteCategoryFromDB(id) {
  const all = categories.filter(c => c.id !== id);
  await idbPut('meta', { key: 'categories', value: all });
  try {
    await sbFetch('categories?id=eq.' + id, { method: 'DELETE', prefer: 'return=minimal' });
  } catch(e) {
    await queueOperation({ type: 'delete', table: 'categories', id });
  }
}

// ── عرض الأقسام على الصفحة الرئيسية ──
function renderCategories() {
  const section = document.getElementById('categoriesSection');
  const grid = document.getElementById('catsGrid');
  if (!section || !grid) return;

  if (!categories.length) { section.style.display = 'none'; return; }
  section.style.display = '';

  grid.innerHTML = categories.map(cat => {
    const count = products.filter(p => !p.hidden && p.category === cat.name).length;
    return `
    <div class="cat-card" onclick="openCategoryPage('${cat.id}')" style="--cat-color:${cat.color || '#22a046'}">
      <div class="cat-card-icon">${cat.icon || '📦'}</div>
      <div class="cat-card-name">${cat.name}</div>
      <div class="cat-card-count">${count} منتج</div>
      <div class="cat-card-arrow">←</div>
    </div>`;
  }).join('');
}

// ── صفحة القسم ──
function openCategoryPage(catId) {
  const cat = categories.find(c => c.id === catId);
  if (!cat) return;
  currentCategoryPage = catId;

  const catProducts = products.filter(p => !p.hidden && p.category === cat.name);
  const page = document.getElementById('categoryPage');

  page.innerHTML = `
    <div class="detail-nav" style="position:sticky;top:0;z-index:10;background:rgba(244,250,245,0.95);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);">
      <button class="detail-back" onclick="closeCategoryPage()">← رجوع</button>
      <div class="detail-breadcrumb">الأقسام / <span>${cat.name}</span></div>
    </div>

    <div style="padding:32px 24px 24px;">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px;">
        <div style="font-size:52px;width:80px;height:80px;background:${cat.color}18;border:2px solid ${cat.color}40;border-radius:20px;display:flex;align-items:center;justify-content:center;">${cat.icon || '📦'}</div>
        <div>
          <h1 style="font-size:28px;font-weight:900;color:var(--text);margin:0 0 6px;">${cat.name}</h1>
          <p style="color:var(--text-sub);margin:0;">${cat.description || ''}</p>
        </div>
      </div>
      <div style="color:var(--text-dim);font-size:13px;margin-top:12px;">${catProducts.length} منتج في هذا القسم</div>
    </div>

    <div style="padding:0 24px 60px;">
      ${catProducts.length === 0 ? `
        <div style="text-align:center;padding:60px 20px;color:var(--text-dim);">
          <div style="font-size:56px;margin-bottom:16px;">📦</div>
          <p>لا توجد منتجات في هذا القسم حتى الآن</p>
        </div>
      ` : `
        <div class="products-grid">
          ${catProducts.map(p => {
            const isUnavailable = p.status === 'نفذ';
            const statusColor = p.status === 'نفذ' ? 'rgba(239,68,68,0.85)' : p.status === 'قريباً' ? 'rgba(245,158,11,0.85)' : 'rgba(255,98,0,0.85)';
            return `
            <div class="product-card">
              <div class="product-img-wrap">
                ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy">` : `<div class="product-img-placeholder">📦</div>`}
                <div class="product-overlay">
                  <button class="btn-preview" onclick="closeCategoryPage();openProductDetail('${p.id}')">👁️ استعراض</button>
                  ${!isUnavailable ? `<button class="btn-add-overlay" onclick="openOrderModal('${p.id}');event.stopPropagation()">🛒 اطلب الآن</button>` : `<button class="btn-add-overlay" style="opacity:0.5;cursor:not-allowed;">❌ نفذ المنتج</button>`}
                </div>
                <div class="product-badge" style="background:${statusColor};">${p.status || p.category || 'متاح'}</div>
              </div>
              <div class="product-body">
                <div class="product-name">${p.name}</div>
                <div class="product-desc">${p.description}</div>
                <div class="product-footer">
                  <div class="product-price">${formatPrice(p.price)}</div>
                  ${!isUnavailable ? `<button class="btn-sm btn-add" onclick="openOrderModal('${p.id}')">اطلب ←</button>` : `<span style="font-size:11px;color:#ef4444;font-weight:700;">نفذ المنتج</span>`}
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>
      `}
    </div>
  `;

  page.style.display = 'block';
  document.body.style.overflow = 'hidden';
  page.scrollTo(0, 0);
}

function closeCategoryPage() {
  document.getElementById('categoryPage').style.display = 'none';
  document.body.style.overflow = '';
  currentCategoryPage = null;
}

// ── صفحة عن المتجر ──
function openAboutPage() {
  const page = document.getElementById('aboutPage');
  const wa = (settings.whatsapp || '').replace(/\D/g, '');
  const aboutInfo = settings.aboutInfo || {};

  page.innerHTML = `
    <div class="detail-nav" style="position:sticky;top:0;z-index:10;background:rgba(244,250,245,0.95);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);">
      <button class="detail-back" onclick="closeAboutPage()">← رجوع</button>
      <div class="detail-breadcrumb"><span>عن المتجر</span></div>
    </div>

    <div style="max-width:700px;margin:0 auto;padding:40px 24px 80px;">

      <!-- Brand Hero -->
      <div style="text-align:center;margin-bottom:48px;">
        <div style="width:90px;height:90px;background:linear-gradient(135deg,var(--fire),var(--gold-2));border-radius:24px;display:flex;align-items:center;justify-content:center;font-size:40px;margin:0 auto 20px;box-shadow:0 8px 40px var(--gold-glow);">
          ${aboutInfo.icon || '🌿'}
        </div>
        <h1 style="font-size:32px;font-weight:900;color:var(--text);margin:0 0 12px;">${aboutInfo.title || 'ALMAHSMarket'}</h1>
        <p style="font-size:16px;color:var(--text-sub);line-height:1.8;max-width:500px;margin:0 auto;">${aboutInfo.subtitle || 'منصة متخصصة في تقديم الخدمات والمنتجات الرقمية للسوق المصري'}</p>
      </div>

      <!-- About Text -->
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:28px;margin-bottom:24px;">
        <h3 style="font-size:18px;font-weight:800;color:var(--text);margin:0 0 14px;">✨ من نحن</h3>
        <p style="color:var(--text-sub);line-height:1.9;white-space:pre-line;">${aboutInfo.about || 'نقدم أفضل التصاميم والخدمات البرمجية لتطوير مشروعك الرقمي بجودة عالية وأسعار منافسة. فريقنا المتخصص يعمل على تحقيق رؤيتك بأحدث التقنيات.'}</p>
      </div>

      <!-- Features -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
        ${(aboutInfo.features || ['جودة مضمونة', 'أسعار منافسة', 'دعم فني 24/7', 'تسليم سريع']).map(f => `
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;display:flex;align-items:center;gap:12px;">
            <div style="width:36px;height:36px;background:rgba(34,160,70,0.12);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">✓</div>
            <span style="font-weight:700;color:var(--text);font-size:14px;">${f}</span>
          </div>
        `).join('')}
      </div>

      <!-- Contact -->
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:28px;">
        <h3 style="font-size:18px;font-weight:800;color:var(--text);margin:0 0 20px;">📞 تواصل معنا</h3>
        <div style="display:flex;flex-direction:column;gap:14px;">
          ${aboutInfo.email ? `<div style="display:flex;align-items:center;gap:12px;color:var(--text-sub);font-size:14px;"><span style="font-size:20px;">✉️</span> ${aboutInfo.email}</div>` : ''}
          ${wa ? `<a href="https://wa.me/${wa}?text=${encodeURIComponent('مرحباً! مهتم بخدماتكم 👋')}" target="_blank" style="display:flex;align-items:center;gap:12px;background:rgba(37,211,102,0.1);color:#22c55e;border:1px solid rgba(37,211,102,0.25);border-radius:12px;padding:14px 20px;font-weight:700;text-decoration:none;transition:all .2s;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.117.554 4.103 1.523 5.824L.057 23.997l6.305-1.654A11.954 11.954 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.007-1.374l-.36-.214-3.733.979 1.001-3.641-.235-.374A9.818 9.818 0 1112 21.818z"/></svg>
            تواصل عبر واتساب
          </a>` : ''}
        </div>
      </div>
    </div>
  `;

  page.style.display = 'block';
  document.body.style.overflow = 'hidden';
  page.scrollTo(0, 0);
}

function closeAboutPage() {
  document.getElementById('aboutPage').style.display = 'none';
  document.body.style.overflow = '';
}

// ── إدارة الأقسام (أدمن) ──
function populateAdminCategorySelect() {
  const sel = document.getElementById('prodCategory');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— اختر القسم —</option>' +
    categories.map(c => `<option value="${c.name}" ${c.name === current ? 'selected' : ''}>${c.icon || ''} ${c.name}</option>`).join('');
}

function renderAdminCategories() {
  const list = document.getElementById('adminCatsList');
  if (!list) return;
  if (!categories.length) {
    list.innerHTML = '<div class="no-pending-msg"><span>📂</span><p>لا توجد أقسام بعد — أضف قسم من الأعلى</p></div>';
    return;
  }
  list.innerHTML = `<div class="admin-products-list" style="grid-template-columns:1fr;">${categories.map(cat => {
    const count = products.filter(p => p.category === cat.name).length;
    return `
    <div style="display:flex;align-items:center;gap:14px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;">
      <div style="width:48px;height:48px;background:${cat.color}22;border:2px solid ${cat.color}44;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;">${cat.icon || '📦'}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:800;color:var(--text);font-size:15px;">${cat.name}</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:2px;">${cat.description || 'بدون وصف'} • ${count} منتج</div>
      </div>
      <button onclick="deleteAdminCategory('${cat.id}')" style="background:rgba(239,68,68,0.08);color:#ef4444;border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:7px 12px;cursor:pointer;font-size:13px;white-space:nowrap;">🗑️ حذف</button>
    </div>`;
  }).join('')}</div>`;
}

async function addAdminCategory() {
  const name = document.getElementById('newCatName').value.trim();
  const icon = document.getElementById('newCatIcon').value.trim() || '📦';
  const desc = document.getElementById('newCatDesc').value.trim();
  const color = document.getElementById('newCatColor').value || '#22a046';
  if (!name) { showToast('⚠️ اكتب اسم القسم', 'warn'); return; }
  if (categories.find(c => c.name === name)) { showToast('⚠️ القسم ده موجود بالفعل', 'warn'); return; }
  const cat = { id: generateId(), name, icon, description: desc, color, sort_order: categories.length, created_at: new Date().toISOString() };
  try {
    await saveCategoryToDB(cat);
    categories.push(cat);
    renderAdminCategories();
    renderCategories();
    populateAdminCategorySelect();
    document.getElementById('newCatName').value = '';
    document.getElementById('newCatIcon').value = '';
    document.getElementById('newCatDesc').value = '';
    showToast('✅ تم إضافة القسم!', 'success');
  } catch(e) { showToast('❌ فشل إضافة القسم', 'error'); }
}

async function deleteAdminCategory(id) {
  if (!confirm('هتحذف القسم ده؟ المنتجات مش هتتحذف.')) return;
  await deleteCategoryFromDB(id);
  categories = categories.filter(c => c.id !== id);
  renderAdminCategories();
  renderCategories();
  populateAdminCategorySelect();
  showToast('🗑️ تم حذف القسم', 'warn');
}

// ============================================================
// PASSWORD
// ============================================================
async function hashPassword(pwd) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pwd);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function initPassword() {
  if (!settings.passwordHash) {
    settings.passwordHash = await hashPassword('2008');
    localStorage.setItem('mahsmarket_pwd_hash', settings.passwordHash);
    await saveSettings();
  }
  if (settings.passwordHash) localStorage.setItem('mahsmarket_pwd_hash', settings.passwordHash);
}

async function verifyPassword(input) {
  const hash = await hashPassword(input);
  const storedHash = settings.passwordHash || localStorage.getItem('mahsmarket_pwd_hash');
  if (storedHash) return hash === storedHash;
  settings.passwordHash = await hashPassword('2008');
  localStorage.setItem('mahsmarket_pwd_hash', settings.passwordHash);
  return hash === settings.passwordHash;
}

// ============================================================
// UTILITIES
// ============================================================
function generateId() { return Math.random().toString(36).substr(2, 9); }

function showToast(msg, type = 'default') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show toast-' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function formatPrice(p) { return Number(p).toLocaleString('ar-EG') + ' ج.م'; }

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = { pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', zip: '🗜️', rar: '🗜️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', mp4: '🎬', mov: '🎬', mp3: '🎵', psd: '🎨', ai: '🎨', fig: '🎨', html: '💻', css: '💻', js: '💻', apk: '📱', aab: '📱', ipa: '🍎' };
  return icons[ext] || '📁';
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ============================================================
// SEARCH
// ============================================================
function handleSearch(query) { searchQuery = query.toLowerCase().trim(); renderProducts(); }

function getFilteredProducts() {
  let base = [...products].filter(p => !p.hidden).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  if (!searchQuery) return base;
  return base.filter(p =>
    p.name.toLowerCase().includes(searchQuery) ||
    p.description.toLowerCase().includes(searchQuery) ||
    (p.category && p.category.toLowerCase().includes(searchQuery))
  );
}

// ============================================================
// PRODUCTS RENDER
// ============================================================
function renderProducts() {
  const grid = document.getElementById('productsGrid');
  const filtered = getFilteredProducts();
  if (!products.length) {
    grid.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-dim);grid-column:1/-1;"><div style="font-size:56px;margin-bottom:16px;">📦</div><p>لا توجد منتجات حتى الآن</p></div>';
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-dim);grid-column:1/-1;"><div style="font-size:56px;margin-bottom:16px;">🔍</div><p>مفيش نتايج لـ "<strong>${searchQuery}</strong>"</p></div>`;
    return;
  }
  grid.innerHTML = filtered.map(p => {
    const isUnavailable = p.status === 'نفذ';
    const statusColor = p.status === 'نفذ' ? 'rgba(239,68,68,0.85)' : p.status === 'قريباً' ? 'rgba(245,158,11,0.85)' : 'rgba(255,98,0,0.85)';
    return `
    <div class="product-card">
      <div class="product-img-wrap">
        ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy">` : `<div class="product-img-placeholder">📦</div>`}
        <div class="product-overlay">
          <button class="btn-preview" onclick="openProductDetail('${p.id}')">👁️ استعراض</button>
          ${!isUnavailable ? `<button class="btn-add-overlay" onclick="openOrderModal('${p.id}');event.stopPropagation()">🛒 اطلب الآن</button>` : `<button class="btn-add-overlay" style="opacity:0.5;cursor:not-allowed;">❌ نفذ المنتج</button>`}
        </div>
        <div class="product-badge" style="background:${statusColor};">${p.status || p.category || 'متاح'}</div>
        ${p.pinned ? '<div style="position:absolute;top:6px;left:8px;font-size:14px;" title="منتج مثبت">📌</div>' : ''}
      </div>
      <div class="product-body">
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.description}</div>
        <div class="product-footer">
          <div class="product-price">${formatPrice(p.price)}</div>
          ${!isUnavailable ? `<button class="btn-sm btn-add" onclick="openOrderModal('${p.id}')">اطلب ←</button>` : `<span style="font-size:11px;color:#ef4444;font-weight:700;">نفذ المنتج</span>`}
        </div>
      </div>
    </div>`;
  }).join('');
  updateStats();
}

function updateStats() {
  const completedOrders = orders.filter(o => o.status === 'مكتمل').length;
  const approvedReviews = reviews.filter(r => r.approved).length;
  const statProd = document.getElementById('stat-products');
  const statOrders = document.getElementById('stat-orders');
  const statReviews = document.getElementById('stat-reviews');
  if (statProd) statProd.innerHTML = `<em>${products.filter(p => !p.hidden).length}</em>+`;
  if (statOrders) statOrders.innerHTML = `<em>${completedOrders}</em>`;
  if (statReviews) statReviews.innerHTML = `<em>${approvedReviews}</em>`;
}

// ============================================================
// PRODUCT DETAIL PAGE
// ============================================================
async function openProductDetail(id) {
  // جرب من الذاكرة أولاً
  let p = products.find(x => x.id === id);

  // لو مش موجود في الذاكرة، جيبه من IndexedDB
  if (!p) {
    p = await idbGet('products', id).catch(() => null);
  }

  // لو IndexedDB فاضي، اجلبه من Supabase
  if (!p) {
    try {
      showToast('⏳ جارٍ تحميل تفاصيل المنتج...', 'info');
      p = await loadProductFull(id);
    } catch(e) {}
  }

  if (!p) { showToast('❌ تعذر تحميل المنتج', 'error'); return; }

  // عرض الصفحة فوراً بالبيانات الموجودة
  const page = document.getElementById('productDetailPage');
  page.innerHTML = buildDetailHTML(p);
  page.style.display = 'block';
  document.body.style.overflow = 'hidden';
  page.scrollTo(0, 0);

  // ★ لو عندنا ملفات — مش محتاجين نجيب حاجة
  // لو الملفات مش موجودة في الكاش (لأننا جبنا بيانات خفيفة فقط)، نجيبها في الخلفية
  if (p.files_locked !== undefined && !p.files) {
    loadProductFull(id).then(full => {
      if (full && full.files && full.files.length) {
        // حدّث الصفحة بالملفات بعد ما اتجابت
        const filesSection = page.querySelector('.detail-files-section');
        const detailInner = page.querySelector('.detail-inner');
        if (detailInner) {
          // إعادة بناء الـ HTML مع الملفات
          page.innerHTML = buildDetailHTML(full);
          page.scrollTo(0, 0);
        }
      }
    }).catch(() => {});
  }
}

function buildDetailHTML(p) {
  const isLocked = p.files_locked === true || p.files_locked === 'true';
  const hasBought = hasUserBought(p.id);
  const canDownload = !isLocked || hasBought;

  const filesHTML = p.files && p.files.length ? `
    <div class="detail-files-section">
      <div class="detail-files-title">📎 ملفات المشروع (${p.files.length})</div>
      ${isLocked && !hasBought ? `<div class="files-locked-badge">🔒 الملفات متاحة بعد الشراء فقط</div>` : ''}
      <div class="detail-files-grid">
        ${p.files.map(f => `
          <div class="detail-file-card"
            data-fileid="${f.id}"
            data-filename="${f.name.replace(/"/g, '&quot;')}"
            data-productid="${p.id}"
            data-locked="${!canDownload}"
            onclick="handleFileClick(this)"
            style="${!canDownload ? 'opacity:0.5;cursor:not-allowed;' : 'cursor:pointer;'}">
            <div class="file-icon">${canDownload ? getFileIcon(f.name) : '🔒'}</div>
            <div class="file-info">
              <div class="file-name">${f.name}</div>
              <div class="file-size">${canDownload ? f.size : '🔒 مدفوع'}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  const allImages = [p.image, ...(p.gallery || [])].filter(Boolean);
  const galleryStrip = allImages.length > 1 ? `
    <div class="detail-gallery-strip">
      ${allImages.map((src, i) => `<img class="detail-gallery-thumb ${i === 0 ? 'active' : ''}" src="${src}" onclick="switchDetailImage('${src}', this)" loading="lazy">`).join('')}
    </div>
  ` : '';

  return `
    <div class="detail-nav">
      <button class="detail-back" onclick="closeProductDetail()">← رجوع</button>
      <div class="detail-breadcrumb">المنتجات / <span>${p.name}</span></div>
    </div>
    <div class="detail-inner">
      <div class="detail-grid">
        <div class="detail-gallery">
          ${p.image ? `<img class="detail-main-img" id="detailMainImg" src="${p.image}" alt="${p.name}">` : `<div class="detail-main-placeholder">📦</div>`}
          <div class="detail-img-badge">${p.category || 'متاح الآن'}</div>
          ${galleryStrip}
        </div>
        <div class="detail-info">
          <div class="detail-tag">✦ منتج رقمي</div>
          <h1 class="detail-title">${p.name}</h1>
          <div class="detail-price-box">
            <div>
              <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px;">السعر</div>
              <div class="detail-price">${formatPrice(p.price)}</div>
            </div>
            <div style="font-size:12px;color:var(--green);font-weight:700;background:rgba(16,185,129,0.1);padding:8px 14px;border-radius:8px;border:1px solid rgba(16,185,129,0.2);">✓ متاح</div>
          </div>
          <div class="detail-actions">
            <button class="btn-primary" onclick="openOrderModal('${p.id}')" ${p.status === 'نفذ' ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>🛒 اطلب الآن</button>
            <button class="btn-outline" onclick="closeProductDetail()">رجوع</button>
          </div>
          <div class="detail-desc-title">وصف المنتج</div>
          <div class="detail-desc">${p.description}</div>
        </div>
      </div>
      ${filesHTML}
    </div>
  `;
}

function switchDetailImage(src, thumb) {
  const main = document.getElementById('detailMainImg');
  if (main) main.src = src;
  document.querySelectorAll('.detail-gallery-thumb').forEach(t => t.classList.remove('active'));
  if (thumb) thumb.classList.add('active');
}

function hasUserBought(productId) {
  const myOrders = JSON.parse(localStorage.getItem('mahsmarket_my_orders') || '[]');
  return myOrders.includes(productId);
}

function handleFileClick(el) {
  const locked = el.dataset.locked === 'true';
  if (locked) { showToast('🔒 لازم تشتري المنتج الأول عشان تحمل الملفات', 'warn'); return; }
  downloadFile(el.dataset.fileid, el.dataset.filename, el.dataset.productid);
}

function closeProductDetail() {
  document.getElementById('productDetailPage').style.display = 'none';
  document.body.style.overflow = '';
}

async function downloadFile(fileId, fileName, productId) {
  showToast('⏳ جارٍ تجهيز الملف...', 'info');

  let p = products.find(x => x.id === productId);
  let f = p && p.files ? p.files.find(x => x.id === fileId) : null;

  // لو data مش موجودة، ابدأ بالبحث في IndexedDB
  if (!f || !f.data) {
    const cached = await idbGet('products', productId);
    if (cached && cached.files) {
      f = cached.files.find(x => x.id === fileId);
    }
  }

  // لو لسه مش موجودة، اجلبها من Supabase
  if (!f || !f.data) {
    try {
      const freshData = await sbFetch('products?id=eq.' + productId);
      if (freshData && freshData[0]) {
        await idbPut('products', freshData[0]);
        const idx = products.findIndex(x => x.id === productId);
        if (idx !== -1) products[idx] = { ...products[idx], ...freshData[0] };
        f = freshData[0].files ? freshData[0].files.find(x => x.id === fileId) : null;
      }
    } catch(e) {
      showToast('❌ فشل تحميل الملف، تحقق من الاتصال', 'error');
      return;
    }
  }

  if (f && f.data) {
    const a = document.createElement('a');
    a.href = f.data;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('⬇️ جارٍ التحميل...', 'success');
  } else {
    showToast('❌ الملف غير متاح، تواصل مع الإدارة', 'error');
  }
}

// ============================================================
// FILES LOCK TOGGLE
// ============================================================
function toggleFilesLockLabel() {
  const locked = document.getElementById('prodFilesLock').checked;
  document.getElementById('filesLockLabel').textContent = locked ? '🔒 مدفوع فقط' : '🔓 تحميل مجاني';
}

// ============================================================
// ADD PRODUCT
// ============================================================
async function addProduct() {
  const name = document.getElementById('prodName').value.trim();
  const price = parseFloat(document.getElementById('prodPrice').value);
  const desc = document.getElementById('prodDesc').value.trim();
  const category = document.getElementById('prodCategory').value.trim();
  const imageFile = document.getElementById('prodImage').files[0];
  const filesLocked = document.getElementById('prodFilesLock').checked;

  if (!name || !price || !desc) { showToast('⚠️ ادخل البيانات كاملة', 'warn'); return; }
  if (!imageFile) { showToast('⚠️ اختر صورة للمنتج', 'warn'); return; }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const product = {
      id: generateId(),
      name, price, description: desc, category,
      image: e.target.result,
      gallery: [...pendingGallery],
      files: [...pendingFiles],
      files_locked: filesLocked,
      created_at: new Date().toISOString()
    };
    try {
      showToast('⏳ جارٍ الحفظ...', 'info');
      await saveProductToDB(product);
      products.unshift(product);
      renderProducts();
      renderAdminProducts();

      document.getElementById('prodName').value = '';
      document.getElementById('prodPrice').value = '';
      document.getElementById('prodDesc').value = '';
      document.getElementById('prodCategory').value = '';
      document.getElementById('prodImage').value = '';
      document.getElementById('prodGallery').value = '';
      document.getElementById('prodFilesLock').checked = false;
      document.getElementById('filesLockLabel').textContent = '🔓 تحميل مجاني';
      document.getElementById('imagePreview').style.display = 'none';
      document.getElementById('galleryPreviewList').innerHTML = '';
      pendingFiles = []; pendingGallery = [];
      renderPendingFiles();
      showToast('✅ تمت إضافة المنتج!', 'success');
    } catch(e) {
      showToast('✅ حُفظ محلياً (سيُرفع تلقائياً)', 'warn');
      products.unshift(product);
      renderProducts();
      renderAdminProducts();
    }
  };
  reader.readAsDataURL(imageFile);
}

// ============================================================
// PENDING FILES
// ============================================================
function renderPendingFiles() {
  const el = document.getElementById('pendingFilesList');
  if (!el) return;
  if (!pendingFiles.length) { el.innerHTML = ''; return; }
  el.innerHTML = pendingFiles.map((f, i) => `
    <div class="file-item">
      <span class="file-item-icon">${getFileIcon(f.name)}</span>
      <div class="file-item-info"><div class="file-item-name">${f.name}</div><div class="file-item-size">${f.size}</div></div>
      <button class="file-item-remove" onclick="removePendingFile(${i})">✕</button>
    </div>
  `).join('');
}

function removePendingFile(i) { pendingFiles.splice(i, 1); renderPendingFiles(); }

function renderGalleryPreviews() {
  const el = document.getElementById('galleryPreviewList');
  if (!el) return;
  el.innerHTML = pendingGallery.map((src, i) => `
    <div class="gallery-thumb-wrap">
      <img class="gallery-thumb" src="${src}">
      <button class="gallery-thumb-remove" onclick="removeGalleryImg(${i})">✕</button>
    </div>
  `).join('');
}

function removeGalleryImg(i) { pendingGallery.splice(i, 1); renderGalleryPreviews(); }

// ============================================================
// DELETE PRODUCT
// ============================================================
async function deleteProduct(id) {
  if (!confirm('هتحذف المنتج ده؟')) return;
  try {
    await deleteProductFromDB(id);
    products = products.filter(p => p.id !== id);
    renderProducts();
    renderAdminProducts();
    showToast('🗑️ تم حذف المنتج', 'warn');
  } catch(e) {
    showToast('❌ فشل الحذف', 'error');
  }
}

// ============================================================
// PRODUCT FEATURES: PIN / HIDE / COPY LINK / STATUS
// ============================================================
function togglePinProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  p.pinned = !p.pinned;
  syncProductToSupabase(id);
  renderProducts(); renderAdminProducts();
  showToast(p.pinned ? '📌 تم تثبيت المنتج!' : '📌 تم إلغاء التثبيت', p.pinned ? 'success' : 'default');
}

function toggleHideProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  p.hidden = !p.hidden;
  syncProductToSupabase(id);
  renderProducts(); renderAdminProducts();
  showToast(p.hidden ? '🚫 تم إخفاء المنتج' : '👁️ تم إظهار المنتج', 'default');
}

function copyProductLink(id) {
  const url = window.location.href.split('?')[0] + '?product=' + id;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('🔗 تم نسخ الرابط!', 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    showToast('🔗 تم نسخ الرابط!', 'success');
  }
}

function changeProductStatus(id, status) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  p.status = status;
  syncProductToSupabase(id);
  renderProducts(); renderAdminProducts();
  showToast('✅ تم تغيير الحالة: ' + status, 'success');
}

// ============================================================
// EDIT PRODUCT MODAL
// ============================================================
let editingProductId = null;

function openEditProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  editingProductId = id;
  document.getElementById('editProdName').value = p.name || '';
  document.getElementById('editProdPrice').value = p.price || '';
  document.getElementById('editProdDesc').value = p.description || '';
  document.getElementById('editProdCategory').value = p.category || '';
  document.getElementById('editProdStatus').value = p.status || 'متاح';
  document.getElementById('editProdNote').value = p.adminNote || '';
  const imgPrev = document.getElementById('editImagePreview');
  if (p.image) { imgPrev.src = p.image; imgPrev.style.display = 'block'; } else imgPrev.style.display = 'none';
  document.getElementById('editProductOverlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeEditProduct() {
  document.getElementById('editProductOverlay').style.display = 'none';
  document.body.style.overflow = '';
  editingProductId = null;
}

async function saveEditProduct() {
  const p = products.find(x => x.id === editingProductId);
  if (!p) return;
  const name = document.getElementById('editProdName').value.trim();
  const price = parseFloat(document.getElementById('editProdPrice').value);
  const desc = document.getElementById('editProdDesc').value.trim();
  const category = document.getElementById('editProdCategory').value.trim();
  const status = document.getElementById('editProdStatus').value;
  const adminNote = document.getElementById('editProdNote').value.trim();
  if (!name || !price || !desc) { showToast('⚠️ ادخل البيانات المطلوبة', 'warn'); return; }

  const applyChanges = (imgData) => {
    p.name = name; p.price = price; p.description = desc;
    p.category = category; p.status = status; p.adminNote = adminNote;
    if (imgData) p.image = imgData;
    syncProductToSupabase(editingProductId);
    renderProducts(); renderAdminProducts();
    closeEditProduct();
    showToast('✅ تم حفظ التعديلات!', 'success');
  };

  const imageFile = document.getElementById('editProdImage').files[0];
  if (imageFile) {
    const reader = new FileReader();
    reader.onload = e => applyChanges(e.target.result);
    reader.readAsDataURL(imageFile);
  } else { applyChanges(null); }
}

// ============================================================
// ORDER MODAL
// ============================================================
let currentOrderProductId = null;
let appliedCoupon = null; // { code, value, type, discount, finalPrice }

function openOrderModal(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  if (p.status === 'نفذ') { showToast('❌ هذا المنتج نفذ حالياً', 'error'); return; }
  currentOrderProductId = productId;
  appliedCoupon = null;
  const imgEl = document.getElementById('orderProductImg');
  imgEl.innerHTML = p.image ? `<img src="${p.image}" style="width:100%;height:100%;object-fit:cover;">` : '📦';
  document.getElementById('orderProductName').textContent = p.name;
  document.getElementById('orderProductPrice').textContent = formatPrice(p.price);
  document.getElementById('orderName').value = '';
  document.getElementById('orderPhone').value = '';
  document.getElementById('orderCouponInput').value = '';
  const fb = document.getElementById('couponFeedback');
  fb.style.display = 'none'; fb.textContent = '';
  document.getElementById('orderOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('orderName').focus(), 200);
}

function closeOrderModal() {
  document.getElementById('orderOverlay').classList.remove('open');
  document.body.style.overflow = '';
  currentOrderProductId = null;
  appliedCoupon = null;
}

function applyCoupon() {
  const code = document.getElementById('orderCouponInput').value.trim().toUpperCase();
  const fb = document.getElementById('couponFeedback');
  const priceEl = document.getElementById('orderProductPrice');
  const p = products.find(x => x.id === currentOrderProductId);
  if (!p) return;

  if (!code) { showToast('⚠️ اكتب كود الكوبون الأول', 'warn'); return; }

  const coupon = coupons.find(c => c.code === code && c.active);
  if (!coupon) {
    appliedCoupon = null;
    fb.style.display = 'block';
    fb.style.background = 'rgba(239,68,68,0.1)';
    fb.style.color = '#ef4444';
    fb.style.border = '1px solid rgba(239,68,68,0.25)';
    fb.textContent = '❌ كود غلط أو منتهي — تحقق من الكود وحاول تاني';
    priceEl.textContent = formatPrice(p.price);
    return;
  }

  let discount = 0;
  if (coupon.type === 'percent') {
    discount = Math.round(p.price * coupon.value / 100);
  } else {
    discount = Math.min(coupon.value, p.price);
  }
  const finalPrice = p.price - discount;

  appliedCoupon = { ...coupon, discount, finalPrice };

  priceEl.innerHTML = `<span style="text-decoration:line-through;opacity:0.5;font-size:13px;">${formatPrice(p.price)}</span> <span style="color:var(--fire,#22a046);">${formatPrice(finalPrice)}</span>`;

  fb.style.display = 'block';
  fb.style.background = 'rgba(34,160,70,0.1)';
  fb.style.color = 'var(--fire,#22a046)';
  fb.style.border = '1px solid rgba(34,160,70,0.25)';
  fb.textContent = `✅ تم تطبيق الكوبون! وفّرت ${formatPrice(discount)}`;
  showToast('🎉 كوبون مطبق — وفّرت ' + formatPrice(discount), 'success');
}

async function confirmOrder() {
  const name = document.getElementById('orderName').value.trim();
  const phone = document.getElementById('orderPhone').value.trim();
  if (!name) { showToast('⚠️ ادخل اسمك', 'warn'); return; }
  if (!phone) { showToast('⚠️ ادخل رقم تليفونك', 'warn'); return; }

  const p = products.find(x => x.id === currentOrderProductId);
  if (!p) return;

  const finalTotal = appliedCoupon ? appliedCoupon.finalPrice : p.price;
  const couponCode = appliedCoupon ? appliedCoupon.code : null;

  const order = {
    id: generateId(),
    customer_name: name,
    customer_phone: phone,
    items: [{ id: p.id, name: p.name, price: p.price, quantity: 1 }],
    total: finalTotal,
    coupon: couponCode || '',
    discount: appliedCoupon ? appliedCoupon.discount : 0,
    date: new Date().toLocaleString('ar-EG'),
    status: 'جديد'
  };

  try {
    await saveOrderToDB(order);
    orders.unshift({ ...order, customerName: name, customerPhone: phone });
  } catch(e) {
    orders.unshift({ ...order, customerName: name, customerPhone: phone });
  }

  const myOrders = JSON.parse(localStorage.getItem('mahsmarket_my_orders') || '[]');
  if (!myOrders.includes(p.id)) myOrders.push(p.id);
  localStorage.setItem('mahsmarket_my_orders', JSON.stringify(myOrders));

  const waNumber = (settings.whatsapp || '').replace(/\D/g, '');
  if (waNumber) {
    const couponLine = couponCode ? `\n🏷️ *كوبون:* ${couponCode} (وفّر ${formatPrice(appliedCoupon.discount)})` : '';
    const msg = `🛒 *طلب جديد — ALMAHSMarket*\n\n👤 الاسم: ${name}\n📞 التليفون: ${phone}\n\n📦 *المنتج:* ${p.name}${couponLine}\n💰 *الإجمالي: ${formatPrice(finalTotal)}*\n\nأرجو التأكيد، شكراً! 🙏`;
    window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(msg)}`, '_blank');
  }
  appliedCoupon = null;

  closeOrderModal();
  renderAdminOrders();
  showToast('✅ تم إرسال طلبك! تواصل معك قريباً 🎉', 'success');
}

// ============================================================
// REVIEWS
// ============================================================
function renderReviews() {
  const container = document.getElementById('reviewsContainer');
  const approved = reviews.filter(r => r.approved);
  if (!approved.length) {
    container.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-dim);grid-column:1/-1;">💬 لا توجد آراء حتى الآن</div>';
    return;
  }
  container.innerHTML = approved.map(r => {
    const stars = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
    const initial = r.name.charAt(0) || '؟';
    return `
      <div class="review-card">
        <div class="review-stars">${stars}</div>
        <div class="review-text">"${r.text}"</div>
        <div class="review-footer">
          <div class="review-avatar">${initial}</div>
          <div>
            <div class="review-name">${r.name}</div>
            ${r.product ? `<div class="review-product">${r.product}</div>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function openRevModal() {
  selectedStars = 0; updateStarUI(0);
  ['revName', 'revProduct', 'revText'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('revFormBody').style.display = 'block';
  document.getElementById('revSuccessMsg').style.display = 'none';
  document.getElementById('revOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeRevModal() { document.getElementById('revOverlay').classList.remove('open'); document.body.style.overflow = ''; }
function setStar(n) { selectedStars = n; updateStarUI(n); }
function updateStarUI(n) { document.querySelectorAll('.star-btn').forEach((b, i) => b.classList.toggle('active', i < n)); }

async function submitReview() {
  const name = document.getElementById('revName').value.trim();
  const product = document.getElementById('revProduct').value.trim();
  const text = document.getElementById('revText').value.trim();
  if (!name || !text) { showToast('⚠️ ادخل اسمك ورأيك', 'warn'); return; }
  if (!selectedStars) { showToast('⚠️ اختار التقييم', 'warn'); return; }
  const review = { id: generateId(), name, product, text, stars: selectedStars, approved: false };
  try {
    await saveReviewToDB(review);
    reviews.unshift(review);
    updateRevTabCount();
    document.getElementById('revFormBody').style.display = 'none';
    document.getElementById('revSuccessMsg').style.display = 'block';
    setTimeout(closeRevModal, 2500);
  } catch(e) { showToast('❌ فشل إرسال الرأي', 'error'); }
}

function updateRevTabCount() {
  const pending = reviews.filter(r => !r.approved).length;
  const tab = document.getElementById('tabRevCount');
  if (tab) { tab.textContent = pending; tab.className = 'tab-count' + (pending === 0 ? ' zero' : ''); }
}

function renderAdminReviews() {
  const pending = reviews.filter(r => !r.approved);
  const approved = reviews.filter(r => r.approved);
  const pel = document.getElementById('pendingRevsList');
  const ael = document.getElementById('approvedRevsList');
  pel.innerHTML = !pending.length ? '<div class="no-pending-msg"><span>✅</span><p>مفيش آراء في الانتظار</p></div>' :
    pending.map(r => {
      const stars = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
      return `<div class="admin-rev-item">
        <div class="admin-rev-top"><div class="admin-rev-name">${r.name} <span style="color:var(--text-dim);font-weight:400;font-size:12px">${r.product ? '— ' + r.product : ''}</span></div><div style="color:var(--orange);font-size:12px">${stars}</div></div>
        <div class="admin-rev-text">${r.text}</div>
        <div class="admin-rev-actions"><button class="rev-approve-btn" onclick="approveReview('${r.id}')">✓ نشر</button><button class="rev-reject-btn" onclick="deleteReview('${r.id}')">✕ حذف</button></div>
      </div>`;
    }).join('');
  ael.innerHTML = !approved.length ? '<div class="no-pending-msg"><span>💬</span><p>لسه مفيش آراء منشورة</p></div>' :
    approved.map(r => {
      const stars = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
      return `<div class="admin-rev-item" style="opacity:0.8">
        <div class="admin-rev-top"><div class="admin-rev-name">${r.name}</div><div style="color:var(--orange);font-size:12px">${stars}</div></div>
        <div class="admin-rev-text">${r.text}</div>
        <div class="admin-rev-actions"><button class="rev-reject-btn" onclick="deleteReview('${r.id}')">✕ حذف</button></div>
      </div>`;
    }).join('');
}

async function approveReview(id) {
  try {
    await updateReviewInDB(id, { approved: true });
    const r = reviews.find(x => x.id === id);
    if (r) r.approved = true;
    renderReviews(); renderAdminReviews(); updateRevTabCount();
    showToast('✅ تم نشر الرأي!', 'success');
  } catch(e) { showToast('❌ فشل النشر', 'error'); }
}

async function deleteReview(id) {
  if (!confirm('هتحذف الرأي ده؟')) return;
  try {
    await deleteReviewFromDB(id);
    reviews = reviews.filter(r => r.id !== id);
    renderReviews(); renderAdminReviews(); updateRevTabCount();
    showToast('🗑️ تم حذف الرأي', 'warn');
  } catch(e) { showToast('❌ فشل الحذف', 'error'); }
}

// ============================================================
// ADMIN AUTH
// ============================================================
const SESSION_KEY = 'mahsmarket_admin_auth';
const USER_SESSION_KEY = 'mahsmarket_user_session';

function isAuthenticated() { return sessionStorage.getItem(SESSION_KEY) === '1'; }
function isUserLoggedIn() { return sessionStorage.getItem(USER_SESSION_KEY); }
function getCurrentUserId() { return sessionStorage.getItem(USER_SESSION_KEY); }

function showAdminBtn() {
  const btn = document.getElementById('adminNavBtn');
  const btnM = document.getElementById('adminNavBtnMobile');
  if (btn) btn.style.display = '';
  if (btnM) btnM.style.display = '';
}

function showUserPanelBtn() {
  const btn = document.getElementById('userPanelNavBtn');
  const btnM = document.getElementById('userPanelNavBtnMobile');
  if (btn) btn.style.display = '';
  if (btnM) btnM.style.display = '';
}

let logoTapCount = 0, logoTapTimer = null;
function handleLogoTap(e) {
  e.preventDefault();
  logoTapCount++;
  clearTimeout(logoTapTimer);
  if (logoTapCount >= 5) {
    logoTapCount = 0;
    const saved = settings.accessCode || localStorage.getItem('mahsmarket_access_code');
    if (!saved) { sessionStorage.setItem('mahsmarket_btn_visible', '1'); showAdminBtn(); openPwdModal(); return; }
    const code = prompt('🔑 أدخل كود الوصول:');
    if (!code) return;
    if (code === saved) { sessionStorage.setItem('mahsmarket_btn_visible', '1'); showAdminBtn(); showToast('✅ تم تفعيل الوصول!', 'success'); }
    else showToast('❌ كود غلط', 'error');
    return;
  }
  logoTapTimer = setTimeout(() => { logoTapCount = 0; }, 1500);
}

function checkAdminAccess() {
  if (sessionStorage.getItem('mahsmarket_btn_visible') === '1' || isAuthenticated()) showAdminBtn();
  const logo = document.querySelector('.nav-logo');
  if (logo) logo.addEventListener('click', handleLogoTap);
}

function openPwdModal() {
  if (isAuthenticated()) { openAdmin(); return; }
  document.getElementById('pwdOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('pwdInput').focus(), 200);
}
function closePwdModal() {
  document.getElementById('pwdOverlay').classList.remove('open');
  document.getElementById('pwdInput').value = '';
  document.getElementById('pwdInput').classList.remove('error');
  document.body.style.overflow = '';
}
async function checkPwd() {
  const val = document.getElementById('pwdInput').value;
  const ok = await verifyPassword(val);
  if (ok) {
    sessionStorage.setItem(SESSION_KEY, '1');
    showAdminBtn(); closePwdModal(); openAdmin();
  } else {
    const inp = document.getElementById('pwdInput');
    inp.classList.add('error'); inp.value = ''; inp.focus();
    setTimeout(() => inp.classList.remove('error'), 500);
    showToast('❌ باسورد غلط!', 'error');
  }
}

function openAdmin() {
  document.getElementById('adminPanel').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  renderAdminProducts(); renderAdminOrders(); renderAdminReviews(); updateRevTabCount();
  loadAdminSettings(); renderCouponsList(); renderAdminCategories();
}
function closeAdmin() { document.getElementById('adminPanel').style.display = 'none'; document.body.style.overflow = ''; }

function switchAdminTab(tabName) {
  document.querySelectorAll('.admin-tab').forEach(t => { t.classList.remove('active'); t.style.display = 'none'; });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const tab = document.getElementById(tabName + 'Tab');
  tab.classList.add('active'); tab.style.display = 'block';
  event.target.classList.add('active');
}

// ============================================================
// ADMIN PRODUCTS RENDER
// ============================================================
function renderAdminProducts() {
  const list = document.getElementById('adminProductsList');
  const sorted = [...products].sort((a, b) => { if (a.pinned && !b.pinned) return -1; if (!a.pinned && b.pinned) return 1; return 0; });
  if (!sorted.length) { list.innerHTML = '<div class="no-pending-msg"><span>📦</span><p>لا توجد منتجات</p></div>'; return; }
  list.innerHTML = `<div class="admin-products-list">${sorted.map(p => {
    const statusColor = p.status === 'نفذ' ? '#ef4444' : p.status === 'قريباً' ? '#f59e0b' : '#10b981';
    const statusLabel = p.status || 'متاح';
    const isHidden = p.hidden === true;
    const isPinned = p.pinned === true;
    return `
    <div class="admin-product-item" style="${isHidden ? 'opacity:0.5;' : ''}${isPinned ? 'border:1.5px solid var(--fire,#ff6200);' : ''}">
      <div class="admin-product-img-wrap">
        ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;opacity:0.3;">📦</div>'}
        ${p.category ? `<div class="admin-product-cat-badge">${p.category}</div>` : ''}
        ${isPinned ? '<div style="position:absolute;top:4px;left:4px;background:var(--fire,#ff6200);color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700;">📌 مثبت</div>' : ''}
        ${isHidden ? '<div style="position:absolute;top:4px;right:4px;background:#666;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;">مخفي</div>' : ''}
      </div>
      <div class="admin-product-details">
        <div class="admin-product-name">${p.name}</div>
        <div class="admin-product-price">${formatPrice(p.price)}</div>
        <div style="margin-bottom:8px;"><span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">● ${statusLabel}</span></div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">${p.files && p.files.length ? `📎 ${p.files.length} ملف` : 'لا توجد ملفات'}</div>
        <div class="admin-product-actions" style="margin-bottom:6px;">
          <button class="btn-sm btn-preview" style="background:rgba(34,211,238,0.1);color:var(--cyan);border:1px solid rgba(34,211,238,0.2);flex:1;" onclick="openProductDetail('${p.id}');closeAdmin()">👁️ عرض</button>
          <button class="btn-sm" style="background:rgba(255,165,0,0.1);color:#f59e0b;border:1px solid rgba(255,165,0,0.2);flex:1;" onclick="openEditProduct('${p.id}')">✏️ تعديل</button>
        </div>
        <div class="admin-product-actions" style="flex-wrap:wrap;gap:5px;">
          <button class="btn-sm" title="${isPinned ? 'إلغاء التثبيت' : 'تثبيت في الأول'}"
            style="background:${isPinned ? 'rgba(255,98,0,0.2)' : 'rgba(255,255,255,0.05)'};color:${isPinned ? 'var(--fire,#ff6200)' : 'var(--text-dim)'};border:1px solid ${isPinned ? 'rgba(255,98,0,0.3)' : 'rgba(255,255,255,0.1)'};"
            onclick="togglePinProduct('${p.id}')">📌</button>
          <button class="btn-sm" title="${isHidden ? 'إظهار المنتج' : 'إخفاء عن العملاء'}"
            style="background:${isHidden ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.05)'};color:${isHidden ? '#10b981' : 'var(--text-dim)'};border:1px solid ${isHidden ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.1)'};"
            onclick="toggleHideProduct('${p.id}')">${isHidden ? '👁️' : '🚫'}</button>
          <button class="btn-sm" title="نسخ رابط المنتج"
            style="background:rgba(255,255,255,0.05);color:var(--text-dim);border:1px solid rgba(255,255,255,0.1);"
            onclick="copyProductLink('${p.id}')">🔗</button>
          <select onchange="changeProductStatus('${p.id}', this.value)"
            style="flex:1;background:rgba(255,255,255,0.05);color:var(--text-dim);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 6px;font-size:11px;cursor:pointer;">
            <option value="متاح" ${statusLabel === 'متاح' ? 'selected' : ''}>● متاح</option>
            <option value="نفذ" ${statusLabel === 'نفذ' ? 'selected' : ''}>● نفذ</option>
            <option value="قريباً" ${statusLabel === 'قريباً' ? 'selected' : ''}>● قريباً</option>
          </select>
          <button class="btn-sm btn-del" onclick="deleteProduct('${p.id}')">🗑️</button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ============================================================
// ADMIN ORDERS
// ============================================================
async function changeOrderStatus(id, status) {
  try {
    await updateOrderStatusInDB(id, status);
    const o = orders.find(o => o.id === id);
    if (o) o.status = status;
    renderAdminOrders();
    showToast('✅ تم تحديث الحالة', 'success');
  } catch(e) { showToast('❌ فشل التحديث', 'error'); }
}

async function deleteOrder(id) {
  if (!confirm('هتحذف الأوردر ده؟')) return;
  try {
    await deleteOrderFromDB(id);
    orders = orders.filter(o => o.id !== id);
    renderAdminOrders();
    showToast('🗑️ تم حذف الأوردر', 'warn');
  } catch(e) { showToast('❌ فشل الحذف', 'error'); }
}

function renderAdminOrders() {
  const list = document.getElementById('adminOrdersList');
  if (!orders.length) { list.innerHTML = '<div class="no-pending-msg"><span>📦</span><p>لا توجد أوردرات بعد</p></div>'; return; }
  const statusColors = {
    'جديد': { bg: 'rgba(255,98,0,0.12)', color: 'var(--fire)', border: 'rgba(255,98,0,0.3)' },
    'قيد التنفيذ': { bg: 'rgba(240,180,41,0.12)', color: 'var(--gold)', border: 'rgba(240,180,41,0.3)' },
    'مكتمل': { bg: 'rgba(34,197,94,0.12)', color: '#22c55e', border: 'rgba(34,197,94,0.3)' },
    'ملغي': { bg: 'rgba(239,68,68,0.1)', color: '#ef4444', border: 'rgba(239,68,68,0.25)' },
  };
  list.innerHTML = [...orders].map(o => {
    const sc = statusColors[o.status] || statusColors['جديد'];
    const customerName = o.customerName || o.customer_name || '';
    const customerPhone = o.customerPhone || o.customer_phone || '';
    const phone = customerPhone.replace(/\D/g, '');
    const waMsg = encodeURIComponent(`👋 أهلاً ${customerName}،\nبخصوص طلبك رقم #${o.id.substr(0, 6)} من ALMAHSMarket\n\nتفضل كلمنا هنساعدك 😊`);
    return `
    <div class="admin-order-item" id="order-${o.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:800;color:var(--text);font-size:15px;">🧾 أوردر #${o.id.substr(0, 6)}</div>
        <span style="background:${sc.bg};color:${sc.color};padding:4px 14px;border-radius:100px;font-size:12px;font-weight:700;border:1px solid ${sc.border};">${o.status}</span>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px;">👤 ${customerName}</div>
        <div style="font-size:13px;color:var(--text-sub);">📞 <span dir="ltr">${customerPhone || 'غير محدد'}</span></div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">📅 ${o.date}</div>
      </div>
      <div style="margin-bottom:12px;">
        ${o.items.map(i => `<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-sub);padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);"><span>• ${i.name} × ${i.quantity}</span><span style="color:var(--gold);font-weight:700;">${formatPrice(i.price * i.quantity)}</span></div>`).join('')}
        <div style="display:flex;justify-content:space-between;font-weight:800;font-size:15px;margin-top:8px;padding-top:8px;">
          <span style="color:var(--text);">الإجمالي</span>
          <span style="background:linear-gradient(90deg,var(--fire),var(--gold));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${formatPrice(o.total)}</span>
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">تغيير الحالة:</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${['جديد', 'قيد التنفيذ', 'مكتمل', 'ملغي'].map(s => `
            <button onclick="changeOrderStatus('${o.id}','${s}')"
              style="padding:5px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid ${o.status === s ? sc.border : 'var(--border)'};background:${o.status === s ? sc.bg : 'transparent'};color:${o.status === s ? sc.color : 'var(--text-sub)'};font-family:inherit;transition:all 0.2s;">
              ${s}
            </button>`).join('')}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${phone ? `
          <a href="https://wa.me/${phone}?text=${waMsg}" target="_blank" style="flex:1;min-width:120px;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;border-radius:10px;background:rgba(37,211,102,0.12);color:#25d366;border:1px solid rgba(37,211,102,0.3);font-weight:700;font-size:13px;text-decoration:none;">واتساب</a>
          <a href="tel:${phone}" style="padding:10px 16px;border-radius:10px;background:rgba(240,180,41,0.1);color:var(--gold);border:1px solid rgba(240,180,41,0.25);font-weight:700;font-size:13px;text-decoration:none;display:flex;align-items:center;gap:6px;">📞 اتصال</a>
        ` : '<span style="font-size:12px;color:var(--text-dim);">⚠️ مفيش رقم تليفون</span>'}
        <button onclick="deleteOrder('${o.id}')" style="padding:10px 14px;border-radius:10px;background:rgba(239,68,68,0.08);color:#ef4444;border:1px solid rgba(239,68,68,0.2);font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

// ============================================================
// ADMIN SETTINGS
// ============================================================
function loadAdminSettings() {
  document.getElementById('settingsWhatsapp').value = settings.whatsapp || '';
  document.getElementById('settingsNewPwd').value = '';
  document.getElementById('settingsConfirmPwd').value = '';
  const code = settings.accessCode || '';
  document.getElementById('settingsAccessCode').value = '';
  document.getElementById('currentAccessCode').textContent = code || '(مش محدد)';
  // social media
  const s = settings.social || {};
  const safeSet = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  safeSet('socialTiktok', s.tiktok);
  safeSet('socialInstagram', s.instagram);
  safeSet('socialFacebook', s.facebook);
  safeSet('socialTwitter', s.twitter);
  safeSet('socialYoutube', s.youtube);
  // populate admin category select
  populateAdminCategorySelect();
}

async function saveAccessCode() {
  const code = document.getElementById('settingsAccessCode').value.trim();
  if (!code) { showToast('⚠️ اكتب كود الأول!', 'warn'); return; }
  settings.accessCode = code;
  localStorage.setItem('mahsmarket_access_code', code);
  await saveSettings();
  document.getElementById('currentAccessCode').textContent = code;
  document.getElementById('settingsAccessCode').value = '';
  showToast('✅ تم حفظ الكود!', 'success');
}

async function saveAdminSettings() {
  const wa = document.getElementById('settingsWhatsapp').value.trim();
  const newPwd = document.getElementById('settingsNewPwd').value.trim();
  const confirmPwd = document.getElementById('settingsConfirmPwd').value.trim();
  settings.whatsapp = wa;

  // social media
  const safeGet = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  settings.social = {
    tiktok: safeGet('socialTiktok'),
    instagram: safeGet('socialInstagram'),
    facebook: safeGet('socialFacebook'),
    twitter: safeGet('socialTwitter'),
    youtube: safeGet('socialYoutube')
  };

  if (newPwd) {
    if (newPwd !== confirmPwd) { showToast('❌ كلمة المرور مش متطابقة!', 'error'); return; }
    if (newPwd.length < 4) { showToast('⚠️ كلمة المرور قصيرة جداً', 'warn'); return; }
    settings.passwordHash = await hashPassword(newPwd);
    await saveSettings();
    sessionStorage.removeItem(SESSION_KEY);
    showToast('✅ تم تغيير كلمة المرور! أعد تسجيل الدخول', 'success');
    setTimeout(closeAdmin, 1500);
    return;
  }
  await saveSettings();
  showToast('✅ تم حفظ الإعدادات!', 'success');
  initWaFloating();
  updateFooterSocial();
}

// ============================================================
// WHATSAPP FLOATING
// ============================================================
let waBubbleOpen = false, waAutoShown = false;

function toggleWaBubble() {
  waBubbleOpen = !waBubbleOpen;
  const bubble = document.getElementById('waBubble');
  const btn = document.getElementById('waBtn');
  const iconChat = btn.querySelector('.wa-icon-chat');
  const iconClose = btn.querySelector('.wa-icon-close');
  if (waBubbleOpen) { bubble.classList.add('open'); iconChat.style.display = 'none'; iconClose.style.display = 'flex'; btn.classList.add('active'); }
  else { bubble.classList.remove('open'); iconChat.style.display = 'flex'; iconClose.style.display = 'none'; btn.classList.remove('active'); }
}

function openWaChat() {
  const waNumber = (settings.whatsapp || '').replace(/\D/g, '');
  if (!waNumber) { showToast('⚠️ رقم الواتساب غير مضبوط', 'warn'); return; }
  window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent('أهلاً! مهتم بخدماتكم في ALMAHSMarket 👋')}`, '_blank');
}

function initWaFloating() {
  const waNumber = (settings.whatsapp || '').replace(/\D/g, '');
  const el = document.getElementById('waFloating');
  if (!el) return;
  if (!waNumber) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  if (!waAutoShown) {
    setTimeout(() => { if (!waBubbleOpen) { toggleWaBubble(); waAutoShown = true; } }, 4000);
  }
}

// ============================================================
// SOCIAL MEDIA FOOTER
// ============================================================
function updateFooterSocial() {
  const s = settings.social || {};
  const wa = (settings.whatsapp || '').replace(/\D/g, '');
  const socials = [
    { id: 'fsocTiktok',    href: s.tiktok,    show: !!s.tiktok },
    { id: 'fsocInstagram', href: s.instagram, show: !!s.instagram },
    { id: 'fsocFacebook',  href: s.facebook,  show: !!s.facebook },
    { id: 'fsocTwitter',   href: s.twitter,   show: !!s.twitter },
    { id: 'fsocYoutube',   href: s.youtube,   show: !!s.youtube },
    { id: 'fsocWhatsapp',  href: wa ? `https://wa.me/${wa}` : '', show: !!wa }
  ];
  socials.forEach(({ id, href, show }) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (show && href) { el.href = href; el.style.display = ''; }
    else if (!show) { el.style.display = 'none'; }
  });
  // update footer wa contact link too
  const footerWa = document.getElementById('footerWaLink');
  if (footerWa) {
    if (wa) { footerWa.href = `https://wa.me/${wa}`; footerWa.style.display = ''; }
    else footerWa.style.display = 'none';
  }
}

// ============================================================
// COUPONS
// ============================================================
function renderCouponsList() {
  const el = document.getElementById('couponsList');
  if (!el) return;
  if (!coupons.length) { el.innerHTML = '<div class="no-pending-msg" style="padding:20px;"><span>🏷️</span><p>لا توجد كوبونات</p></div>'; return; }
  el.innerHTML = coupons.map(c => `
    <div class="coupon-admin-item ${c.active ? '' : 'inactive'}">
      <div class="coupon-admin-code">${c.code}</div>
      <div class="coupon-admin-info">
        <span class="coupon-type-badge">${c.type === 'percent' ? c.value + '% خصم' : 'خصم ' + formatPrice(c.value)}</span>
        <span class="coupon-status-badge ${c.active ? 'active' : 'off'}">${c.active ? '✓ فعّال' : '✕ موقوف'}</span>
      </div>
      <div class="coupon-admin-actions">
        <button class="btn-sm" style="background:rgba(34,211,238,0.1);color:var(--cyan);border:1px solid rgba(34,211,238,0.2);" onclick="toggleCoupon('${c.id}')">${c.active ? 'إيقاف' : 'تفعيل'}</button>
        <button class="btn-sm btn-del" onclick="deleteCoupon('${c.id}')">🗑️</button>
      </div>
    </div>
  `).join('');
}

async function addCoupon() {
  const code = document.getElementById('newCouponCode').value.trim().toUpperCase();
  const value = parseFloat(document.getElementById('newCouponValue').value);
  const type = document.getElementById('newCouponType').value;
  if (!code || !value) { showToast('⚠️ أدخل الكود والقيمة', 'warn'); return; }
  const coupon = { id: generateId(), code, value, type, active: true };
  try {
    await saveCouponToDB(coupon);
    coupons.unshift(coupon);
    renderCouponsList();
    document.getElementById('newCouponCode').value = '';
    document.getElementById('newCouponValue').value = '';
    showToast('✅ تم إضافة الكوبون!', 'success');
  } catch(e) { showToast('❌ فشل إضافة الكوبون', 'error'); }
}

async function toggleCoupon(id) {
  const c = coupons.find(x => x.id === id);
  if (!c) return;
  c.active = !c.active;
  try { await updateCouponInDB(id, { active: c.active }); } catch(e) {}
  renderCouponsList();
}

async function deleteCoupon(id) {
  if (!confirm('هتحذف الكوبون ده؟')) return;
  try { await deleteCouponFromDB(id); } catch(e) {}
  coupons = coupons.filter(c => c.id !== id);
  renderCouponsList();
  showToast('🗑️ تم حذف الكوبون', 'warn');
}

// ============================================================
// MOBILE MENU
// ============================================================
function toggleMobileMenu() {
  document.getElementById('mobileMenu').classList.toggle('open');
  document.getElementById('mobileMenuOverlay').classList.toggle('open');
  document.body.style.overflow = document.getElementById('mobileMenu').classList.contains('open') ? 'hidden' : '';
}
function closeMobileMenu() {
  document.getElementById('mobileMenu').classList.remove('open');
  document.getElementById('mobileMenuOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ============================================================
// FILE UPLOAD HANDLER
// ============================================================
function handleFilesInput(files) {
  if (!files || files.length === 0) return;
  let added = 0;
  Array.from(files).forEach(file => {
    if (pendingFiles.some(f => f.name === file.name)) { showToast('⚠️ الملف "' + file.name + '" موجود بالفعل', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      pendingFiles.push({ id: generateId(), name: file.name, size: formatBytes(file.size), data: ev.target.result });
      renderPendingFiles();
    };
    reader.onerror = () => showToast('❌ فشل قراءة الملف: ' + file.name, 'error');
    reader.readAsDataURL(file);
    added++;
  });
  if (added > 0) showToast('✅ جاري رفع ' + added + ' ملف...', 'success');
}

function removeFile(index) { pendingFiles.splice(index, 1); renderPendingFiles(); showToast('🗑️ تم حذف الملف', 'info'); }

// ============================================================
// USER PROJECT UPLOAD
// ============================================================
let userUploadFiles = [];
let userUploadCodeVerified = false;

function openUserUploadModal() {
  const modal = document.getElementById('userUploadModal');
  const overlay = document.getElementById('userUploadOverlay');
  if (!modal || !overlay) return;
  modal.style.display = 'block'; overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
  userUploadCodeVerified = false; userUploadFiles = [];
  resetUserUploadForm();
}

function closeUserUploadModal() {
  const modal = document.getElementById('userUploadModal');
  const overlay = document.getElementById('userUploadOverlay');
  if (modal) modal.style.display = 'none';
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  resetUserUploadForm();
}

function resetUserUploadForm() {
  const safeSet = (id, value) => { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = value; else el.value = value; } };
  safeSet('userUploadCode', ''); safeSet('userProjName', ''); safeSet('userProjDesc', '');
  safeSet('userProjPrice', ''); safeSet('userProjCategory', ''); safeSet('userFilesLock', true); safeSet('userProjFiles', '');
  const formSection = document.getElementById('userUploadForm');
  const codeSection = document.getElementById('userUploadCodeSection');
  if (formSection) formSection.style.display = 'none';
  if (codeSection) codeSection.style.display = 'block';
  const filesList = document.getElementById('userPendingFilesList');
  if (filesList) filesList.innerHTML = '';
  userUploadFiles = [];
}

async function verifyUserUploadCode() {
  const code = document.getElementById('userUploadCode').value.trim();
  if (!code) { showToast('⚠️ أدخل الكود', 'warn'); return; }
  const savedCode = settings.accessCode || localStorage.getItem('mahsmarket_access_code') || 'USER2024';
  if (savedCode && code === savedCode) {
    userUploadCodeVerified = true;
    document.getElementById('userUploadCodeSection').style.display = 'none';
    document.getElementById('userUploadForm').style.display = 'block';
    // ملء قائمة الأقسام
    const catSelect = document.getElementById('userProjCategory');
    if (catSelect) {
      catSelect.innerHTML = '<option value="">— اختر قسم (اختياري) —</option>' +
        categories.map(c => `<option value="${c.name}">${c.icon || ''} ${c.name}</option>`).join('');
    }
    showToast('✅ كود صحيح!', 'success');
  } else { showToast('❌ كود غلط', 'error'); }
}

function setupUserUploadArea() {
  const uploadArea = document.getElementById('userUploadFilesArea');
  const filesInput = document.getElementById('userProjFiles');
  if (!uploadArea || !filesInput) return;
  uploadArea.addEventListener('click', () => filesInput.click());
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', e => { e.preventDefault(); uploadArea.classList.remove('drag-over'); handleUserFiles(e.dataTransfer.files); });
  filesInput.addEventListener('change', e => handleUserFiles(e.target.files));
}

function handleUserFiles(fileList) {
  Array.from(fileList).forEach(file => {
    const r = new FileReader();
    r.onload = ev => { userUploadFiles.push({ id: generateId(), name: file.name, size: formatBytes(file.size), data: ev.target.result }); renderUserPendingFiles(); };
    r.readAsDataURL(file);
  });
}

function renderUserPendingFiles() {
  const list = document.getElementById('userPendingFilesList');
  if (!list) return;
  list.innerHTML = userUploadFiles.map((f, i) => `
    <div class="file-item">
      <span>${getFileIcon(f.name)} ${f.name} (${f.size})</span>
      <button class="btn-sm btn-del" onclick="removeUserFile(${i})">✕</button>
    </div>
  `).join('');
}

function removeUserFile(index) { userUploadFiles.splice(index, 1); renderUserPendingFiles(); }

async function submitUserProject() {
  if (!userUploadCodeVerified) { showToast('❌ تحقق من الكود أولاً', 'error'); return; }
  const getSafeValue = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const getSafeChecked = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
  const name = getSafeValue('userProjName');
  const desc = getSafeValue('userProjDesc');
  const price = parseFloat(getSafeValue('userProjPrice'));
  const category = getSafeValue('userProjCategory');
  const filesLocked = getSafeChecked('userFilesLock');
  if (!name || !desc || !price || price < 1) { showToast('⚠️ ملء جميع البيانات المطلوبة', 'warn'); return; }
  if (userUploadFiles.length === 0) { showToast('⚠️ أرفع ملف واحد على الأقل', 'warn'); return; }

  try {
    showToast('🔄 جاري رفع المشروع...', 'default');
    let userId = sessionStorage.getItem(USER_SESSION_KEY);
    if (!userId) { userId = 'user_' + generateId(); sessionStorage.setItem(USER_SESSION_KEY, userId); }
    const product = {
      id: generateId(), name, description: desc, price,
      category: category || 'مشروع عام', image: '', gallery: [],
      files: userUploadFiles.map(f => ({ id: f.id, name: f.name, size: f.size, data: f.data })),
      files_locked: filesLocked,
      created_at: new Date().toISOString(),
      user_id: userId
    };
    await saveProductToDB(product);
    products.unshift(product);
    renderProducts();
    closeUserUploadModal();
    showUserPanelBtn();
    showToast('✅ تم رفع المشروع بنجاح! 🎉', 'success');
  } catch(e) {
    showToast('❌ فشل الرفع: ' + e.message, 'error');
  }
}

// ============================================================
// USER PANEL
// ============================================================
function openUserPanel() {
  const userId = getCurrentUserId();
  if (!userId) { showToast('❌ الرجاء رفع مشروع أولاً', 'error'); return; }
  document.getElementById('userPanel').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  renderUserProjects();
}

function closeUserPanel() { document.getElementById('userPanel').style.display = 'none'; document.body.style.overflow = ''; }

function renderUserProjects() {
  const userId = getCurrentUserId();
  if (!userId) return;
  const userProjects = products.filter(p => p.user_id === userId);
  const container = document.getElementById('userProjectsList');
  if (!userProjects.length) { container.innerHTML = '<div class="no-pending-msg"><span>📦</span><p>لم تقم برفع أي مشاريع بعد</p></div>'; return; }
  container.innerHTML = `<div class="admin-products-list">${userProjects.map(p => `
    <div class="admin-product-item">
      <div class="admin-product-img-wrap">
        ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;opacity:0.3;">📦</div>'}
        ${p.category ? `<div class="admin-product-cat-badge">${p.category}</div>` : ''}
      </div>
      <div class="admin-product-details">
        <div class="admin-product-name">${p.name}</div>
        <div class="admin-product-price">${formatPrice(p.price)}</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">${p.files && p.files.length ? `📎 ${p.files.length} ملف` : 'لا توجد ملفات'}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">🔒 ${p.files_locked ? 'مقفول' : 'مفتوح'}</div>
        <div class="admin-product-actions">
          <button class="btn-sm btn-preview" style="background:rgba(34,211,238,0.1);color:var(--cyan);border:1px solid rgba(34,211,238,0.2);flex:1;" onclick="openProductDetail('${p.id}');closeUserPanel()">👁️ عرض</button>
          <button class="btn-sm btn-del" onclick="deleteUserProject('${p.id}')">🗑️</button>
        </div>
      </div>
    </div>
  `).join('')}</div>`;
}

async function deleteUserProject(projectId) {
  const userId = getCurrentUserId();
  const project = products.find(p => p.id === projectId);
  if (!project || project.user_id !== userId) { showToast('❌ لا يمكنك حذف هذا المشروع', 'error'); return; }
  if (!confirm('هتحذف المشروع ده؟')) return;
  try {
    await deleteProductFromDB(projectId);
    products = products.filter(p => p.id !== projectId);
    renderUserProjects(); renderProducts();
    showToast('🗑️ تم حذف المشروع', 'success');
  } catch(e) { showToast('❌ فشل الحذف', 'error'); }
}

function checkUserPanel() { if (getCurrentUserId()) showUserPanelBtn(); }

// ============================================================
// ★ DOM READY — التسلسل المحسّن للتحميل
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {

  // ① عرض المنتجات من IndexedDB فوراً (بدون انتظار)
  const localProds = await loadProductsLocal();
  if (localProds.length > 0) {
    products = localProds;
    renderProducts();
    // أخفي حالة التحميل فوراً لو في كاش
  } else {
    const grid = document.getElementById('productsGrid');
    if (grid) grid.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-dim);grid-column:1/-1;"><div style="font-size:40px;margin-bottom:12px;">⏳</div><p>جارٍ التحميل...</p></div>';
  }

  // ② فلش الـ sync queue (عمليات معلقة من جلسات سابقة)
  flushSyncQueue().catch(e => console.warn('flushSyncQueue:', e));

  // ③ تحميل الإعدادات والبيانات الأخرى بالتوازي
  const [sett, ords, revs, coups] = await Promise.all([
    loadSettings().catch(() => ({ id: 1, whatsapp: '201063786533', password_hash: '', access_code: 'ADMIN2024' })),
    loadOrders().catch(() => []),
    loadReviews().catch(() => []),
    loadCoupons().catch(() => [])
  ]);

  orders = (ords || []).map(o => ({ ...o, customerName: o.customer_name, customerPhone: o.customer_phone }));
  reviews = revs || [];
  settings = {
    whatsapp: (sett && sett.whatsapp) || '201063786533',
    passwordHash: (sett && sett.password_hash) || localStorage.getItem('mahsmarket_pwd_hash') || '',
    accessCode: (sett && sett.access_code) || localStorage.getItem('mahsmarket_access_code') || 'ADMIN2024',
    aboutInfo: (sett && sett.aboutInfo) || {},
    social: (sett && sett.social) || {}
  };
  coupons = coups || [];
  if (settings.accessCode) localStorage.setItem('mahsmarket_access_code', settings.accessCode);

  // تحميل الأقسام
  try {
    categories = await loadCategories();
  } catch(e) { categories = []; }
  renderCategories();

  // ④ جلب المنتجات من Supabase في الخلفية وتحديث الواجهة لو في جديد
  loadProductsRemote().then(remoteProds => {
    if (remoteProds && remoteProds.length > 0) {
      const hadDiff = JSON.stringify(remoteProds.map(p => p.id)) !== JSON.stringify(products.map(p => p.id));
      products = remoteProds;
      renderProducts();
      if (hadDiff) console.log('✅ تم تحديث المنتجات من Supabase');
    }
  }).catch(e => console.warn('Background product sync failed:', e));

  await initPassword();
  checkAdminAccess();
  checkUserPanel();

  renderReviews();
  updateRevTabCount();
  initWaFloating();
  updateFooterSocial();

  // Search
  const searchInput = document.getElementById('productSearch');
  if (searchInput) searchInput.addEventListener('input', e => handleSearch(e.target.value));

  // Image preview
  const imgInput = document.getElementById('prodImage');
  if (imgInput) {
    imgInput.addEventListener('change', e => {
      if (e.target.files[0]) {
        const r = new FileReader();
        r.onload = ev => { const prev = document.getElementById('imagePreview'); prev.src = ev.target.result; prev.style.display = 'block'; };
        r.readAsDataURL(e.target.files[0]);
      }
    });
  }

  // Gallery images
  const galleryInput = document.getElementById('prodGallery');
  if (galleryInput) {
    galleryInput.addEventListener('change', e => {
      Array.from(e.target.files).forEach(file => {
        const r = new FileReader();
        r.onload = ev => { pendingGallery.push(ev.target.result); renderGalleryPreviews(); };
        r.readAsDataURL(file);
      });
    });
  }

  // Project files upload
  const filesInput = document.getElementById('prodFiles');
  const uploadArea = document.getElementById('uploadArea');
  if (filesInput) filesInput.addEventListener('change', e => handleFilesInput(e.target.files));
  if (uploadArea) {
    uploadArea.addEventListener('click', () => filesInput && filesInput.click());
    uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
    uploadArea.addEventListener('drop', e => { e.preventDefault(); uploadArea.classList.remove('drag-over'); handleFilesInput(e.dataTransfer.files); });
  }

  // Password enter key
  const pwdInput = document.getElementById('pwdInput');
  if (pwdInput) pwdInput.addEventListener('keyup', e => { if (e.key === 'Enter') checkPwd(); });

  // Order modal enter key
  ['orderName', 'orderPhone'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keyup', e => { if (e.key === 'Enter') confirmOrder(); });
  });

  // Edit product image preview
  const editImgInput = document.getElementById('editProdImage');
  if (editImgInput) {
    editImgInput.addEventListener('change', e => {
      if (e.target.files[0]) {
        const r = new FileReader();
        r.onload = ev => { const prev = document.getElementById('editImagePreview'); prev.src = ev.target.result; prev.style.display = 'block'; };
        r.readAsDataURL(e.target.files[0]);
      }
    });
  }

  // فتح منتج من URL ?product=ID
  const urlParams = new URLSearchParams(window.location.search);
  const productId = urlParams.get('product');
  if (productId) {
    setTimeout(() => {
      const p = products.find(x => x.id === productId);
      if (p) openProductDetail(productId);
    }, 300);
  }

  setupUserUploadArea();
});

// Initialize user upload area on page load
document.addEventListener('DOMContentLoaded', () => { checkUserPanel(); });
