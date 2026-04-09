// ============================================================
// SUPABASE CONFIG
// ============================================================
const SUPABASE_URL = 'https://uhbjhryumuhtnxelugmy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoYmpocnl1bXVodG54ZWx1Z215Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MDIwODIsImV4cCI6MjA5MTI3ODA4Mn0.pf2614vZJQN5VvjGCT7-WWgTzLDUSX__TdJBt5n3hVg';

async function sbFetch(path, options = {}) {
  // timeout 8 ثواني — لو Supabase مابردش، throw error ويكمل بالبيانات المحلية
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  
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
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  } catch(e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') throw new Error('timeout: Supabase لم يستجب');
    throw e;
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
let pendingGallery = []; // صور إضافية
let searchQuery = '';

// ============================================================
// SUPABASE DATA FUNCTIONS
// ============================================================

// --- Products ---
// حفظ نسخة خفيفة بدون base64 لتجنب QuotaExceededError
function slimProductForCache(p) {
  return {
    ...p,
    image: '',
    gallery: [],
    files: (p.files || []).map(f => ({ id: f.id, name: f.name, size: f.size }))
  };
}

function safeLocalSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch(e) {
    try {
      localStorage.removeItem(key);
      const slim = Array.isArray(value) ? value.slice(0, 20).map(slimProductForCache) : value;
      localStorage.setItem(key, JSON.stringify(slim));
    } catch(e2) {
      console.warn('localStorage full, skipping cache:', e2);
    }
  }
}

async function loadProducts() {
  try {
    const data = await sbFetch('products?order=created_at.desc');
    if (data && data.length > 0) {
      // حفظ نسخة خفيفة في localStorage (بدون base64 الضخمة)
      safeLocalSet('local_products', data.map(slimProductForCache));
      return data;
    }
  } catch(e) {
    console.warn('Supabase load failed, using local cache:', e);
  }
  return JSON.parse(localStorage.getItem('local_products') || '[]');
}
async function saveProductToDB(product) {
  // حفظ نسخة خفيفة في localStorage كـ cache (بدون base64 لتجنب Quota)
  try {
    let local = JSON.parse(localStorage.getItem('local_products') || '[]');
    local = local.filter(p => p.id !== product.id);
    local.unshift(slimProductForCache(product));
    safeLocalSet('local_products', local);
  } catch(le) { console.warn('local cache error:', le); }

  // رفع على Supabase بكل البيانات (صور + ملفات كـ base64)
  try {
    return await sbFetch('products', {
      method: 'POST',
      body: JSON.stringify(product)
    });
  } catch(e) {
    console.warn('Supabase save failed:', e.message);
    // لو فشل بسبب حجم كبير، جرب بدون data الملفات
    try {
      const slim = {
        ...product,
        image: product.image || '',
        gallery: product.gallery || [],
        files: (product.files || []).map(f => ({ id: f.id, name: f.name, size: f.size, data: f.data || '' }))
      };
      return await sbFetch('products', {
        method: 'POST',
        body: JSON.stringify(slim)
      });
    } catch(e2) {
      console.warn('Supabase slim save also failed - stored locally only:', e2.message);
      return product;
    }
  }
}

async function deleteProductFromDB(id) {
  // حذف من local cache فوراً
  try {
    let local = JSON.parse(localStorage.getItem('local_products') || '[]');
    local = local.filter(p => p.id !== id);
    safeLocalSet('local_products', local);
  } catch(le) {}

  // حذف من Supabase
  try {
    await sbFetch('products?id=eq.' + id, {
      method: 'DELETE',
      prefer: 'return=minimal'
    });
  } catch(e) {
    console.warn('Supabase delete failed (deleted locally):', e.message);
  }
}

// --- Orders ---
async function loadOrders() {
  try {
    const data = await sbFetch('orders?order=created_at.desc');
    return data || [];
  } catch(e) { console.error('loadOrders:', e); return []; }
}
async function saveOrderToDB(order) {
  return await sbFetch('orders', {
    method: 'POST',
    body: JSON.stringify(order)
  });
}
async function updateOrderStatusInDB(id, status) {
  await sbFetch('orders?id=eq.' + id, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
    prefer: 'return=minimal'
  });
}
async function deleteOrderFromDB(id) {
  await sbFetch('orders?id=eq.' + id, {
    method: 'DELETE',
    prefer: 'return=minimal'
  });
}

// --- Reviews ---
async function loadReviews() {
  try {
    const data = await sbFetch('reviews?order=created_at.desc');
    return data || [];
  } catch(e) { console.error('loadReviews:', e); return []; }
}
async function saveReviewToDB(review) {
  return await sbFetch('reviews', {
    method: 'POST',
    body: JSON.stringify(review)
  });
}
async function updateReviewInDB(id, fields) {
  await sbFetch('reviews?id=eq.' + id, {
    method: 'PATCH',
    body: JSON.stringify(fields),
    prefer: 'return=minimal'
  });
}
async function deleteReviewFromDB(id) {
  await sbFetch('reviews?id=eq.' + id, {
    method: 'DELETE',
    prefer: 'return=minimal'
  });
}

// --- Settings ---
async function loadSettings() {
  try {
    const data = await sbFetch('settings?id=eq.1');
    return data && data[0] ? data[0] : { id: 1, whatsapp: '', password_hash: '', access_code: '' };
  } catch(e) { console.error('loadSettings:', e); return { id: 1, whatsapp: '', password_hash: '', access_code: '' }; }
}
async function saveSettings() {
  try {
    await sbFetch('settings?id=eq.1', {
      method: 'PATCH',
      body: JSON.stringify({ whatsapp: settings.whatsapp, password_hash: settings.passwordHash, access_code: settings.accessCode }),
      prefer: 'return=minimal'
    });
  } catch(e) {
    // Try insert if patch failed (first time)
    try {
      await sbFetch('settings', {
        method: 'POST',
        body: JSON.stringify({ id: 1, whatsapp: settings.whatsapp || '', password_hash: settings.passwordHash || '', access_code: settings.accessCode || '' })
      });
    } catch(e2) { console.error('saveSettings:', e2); }
  }
}

// --- Coupons ---
async function loadCoupons() {
  try {
    const data = await sbFetch('coupons?order=created_at.desc');
    return data || [];
  } catch(e) { console.error('loadCoupons:', e); return []; }
}
async function saveCouponToDB(coupon) {
  return await sbFetch('coupons', {
    method: 'POST',
    body: JSON.stringify(coupon)
  });
}
async function updateCouponInDB(id, fields) {
  await sbFetch('coupons?id=eq.' + id, {
    method: 'PATCH',
    body: JSON.stringify(fields),
    prefer: 'return=minimal'
  });
}
async function deleteCouponFromDB(id) {
  await sbFetch('coupons?id=eq.' + id, {
    method: 'DELETE',
    prefer: 'return=minimal'
  });
}


// ============================================================
// PASSWORD HASHING (SHA-256 via Web Crypto)
// ============================================================
async function hashPassword(pwd) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pwd);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// الهاش الافتراضي لكلمة المرور '2008' - يُستخدم كـ fallback لو DB فاضل
const DEFAULT_PASSWORD_HASH = 'b1b2a0e2d2e2a0e2d2e2a0e2d2e2a0e2d2e2a0e2d2e2a0e2d2e2a0e2d2e2a0e2'; // placeholder

async function initPassword() {
  if (!settings.passwordHash) {
    settings.passwordHash = await hashPassword('2008');
    // حفظ في localStorage كـ backup
    localStorage.setItem('mahsmarket_pwd_hash', settings.passwordHash);
    await saveSettings();
  }
  // تأكد إن الهاش محفوظ locally دايماً
  if (settings.passwordHash) {
    localStorage.setItem('mahsmarket_pwd_hash', settings.passwordHash);
  }
}

async function verifyPassword(input) {
  const hash = await hashPassword(input);
  // تحقق من settings أو من localStorage كـ fallback
  const storedHash = settings.passwordHash || localStorage.getItem('mahsmarket_pwd_hash');
  if (storedHash) {
    return hash === storedHash;
  }
  // لو مفيش hash خالص، اعمله دلوقتي
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
// SEARCH / FILTER
// ============================================================
function handleSearch(query) {
  searchQuery = query.toLowerCase().trim();
  renderProducts();
}

function getFilteredProducts() {
  // المثبتة أولاً، المخفية مش بتظهر للعملاء
  let base = [...products]
    .filter(p => !p.hidden)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

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
        ${p.image ? `<img src="${p.image}" alt="${p.name}">` : `<div class="product-img-placeholder">📦</div>`}
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
          ${!isUnavailable
            ? `<button class="btn-sm btn-add" onclick="openOrderModal('${p.id}')">اطلب ←</button>`
            : `<span style="font-size:11px;color:#ef4444;font-weight:700;">نفذ المنتج</span>`}
        </div>
      </div>
    </div>`;
  }).join('');
  
  // تحديث الإحصائيات
  updateStats();
}

function updateStats() {
  const completedOrders = orders.filter(o => o.status === 'مكتمل').length;
  const approvedReviews = reviews.filter(r => r.approved).length;
  
  const statProd = document.getElementById('stat-products');
  const statOrders = document.getElementById('stat-orders');
  const statReviews = document.getElementById('stat-reviews');
  
  if (statProd) statProd.innerHTML = `<em>${products.filter(p=>!p.hidden).length}</em>+`;
  if (statOrders) statOrders.innerHTML = `<em>${completedOrders}</em>`;
  if (statReviews) statReviews.innerHTML = `<em>${approvedReviews}</em>`;
}

// ============================================================
// PRODUCT DETAIL PAGE
// ============================================================
function openProductDetail(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const page = document.getElementById('productDetailPage');
  page.innerHTML = buildDetailHTML(p);
  page.style.display = 'block';
  document.body.style.overflow = 'hidden';
  page.scrollTo(0, 0);
}

function buildDetailHTML(p) {
  // Supabase ممكن يرجع files_locked كـ boolean أو string
  const isLocked = p.files_locked === true || p.files_locked === 'true';
  const hasBought = hasUserBought(p.id);
  const canDownload = !isLocked || hasBought;
  console.log('🔒 files_locked:', p.files_locked, '| type:', typeof p.files_locked, '| isLocked:', isLocked, '| canDownload:', canDownload);

  const filesHTML = p.files && p.files.length ? `
    <div class="detail-files-section">
      <div class="detail-files-title">📎 ملفات المشروع (${p.files.length})</div>
      ${isLocked && !hasBought ? `
        <div class="files-locked-badge">🔒 الملفات متاحة بعد الشراء فقط</div>
      ` : ''}
      <div class="detail-files-grid">
        ${p.files.map(f => `
          <div class="detail-file-card"
            data-fileid="${f.id}"
            data-filename="${f.name.replace(/"/g,'&quot;')}"
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

  // Gallery strip
  const allImages = [p.image, ...(p.gallery || [])].filter(Boolean);
  const galleryStrip = allImages.length > 1 ? `
    <div class="detail-gallery-strip">
      ${allImages.map((src, i) => `
        <img class="detail-gallery-thumb ${i === 0 ? 'active' : ''}"
          src="${src}" onclick="switchDetailImage('${src}', this)">
      `).join('')}
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
            <button class="btn-primary" onclick="openOrderModal('${p.id}')" ${p.status==='نفذ'?'disabled style="opacity:0.5;cursor:not-allowed;"':''}>🛒 اطلب الآن</button>
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

// تحقق هل المستخدم اشترى المنتج ده
function hasUserBought(productId) {
  const myOrders = JSON.parse(localStorage.getItem('mahsmarket_my_orders') || '[]');
  return myOrders.includes(productId);
}

// handler موحد لضغط على ملف
function handleFileClick(el) {
  const locked = el.dataset.locked === 'true';
  if (locked) {
    showToast('🔒 لازم تشتري المنتج الأول عشان تحمل الملفات', 'warn');
    return;
  }
  const fileId = el.dataset.fileid;
  const fileName = el.dataset.filename;
  const productId = el.dataset.productid;
  downloadFile(fileId, fileName, productId);
}

function closeProductDetail() {
  document.getElementById('productDetailPage').style.display = 'none';
  document.body.style.overflow = '';
}

function downloadFile(fileId, fileName, productId) {
  const p = products.find(x => x.id === productId);
  if (p && p.files) {
    const f = p.files.find(x => x.id === fileId);
    if (f && f.data) {
      const a = document.createElement('a');
      a.href = f.data;
      a.download = fileName;
      a.click();
      showToast('⬇️ جارٍ التحميل...', 'info');
    }
  }
}

// ============================================================
// FILES LOCK TOGGLE LABEL
// ============================================================
function toggleFilesLockLabel() {
  const locked = document.getElementById('prodFilesLock').checked;
  document.getElementById('filesLockLabel').textContent = locked ? '🔒 مدفوع فقط' : '🔓 تحميل مجاني';
}

// ============================================================
// ADD PRODUCT (with files + gallery + lock)
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
      name,
      price,
      description: desc,
      category,
      image: e.target.result,
      gallery: [...pendingGallery],
      files: [...pendingFiles],
      files_locked: filesLocked
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
      pendingFiles = [];
      pendingGallery = [];
      renderPendingFiles();
      showToast('✅ تمت إضافة المنتج!', 'success');
    } catch(e) {
      console.error(e);
      showToast('❌ فشل الحفظ، تأكد من الاتصال', 'error');
    }
  };
  reader.readAsDataURL(imageFile);
}

// ============================================================
// PENDING FILES (admin add product)
// ============================================================
function renderPendingFiles() {
  const el = document.getElementById('pendingFilesList');
  if (!el) return;
  if (!pendingFiles.length) { el.innerHTML = ''; return; }
  el.innerHTML = pendingFiles.map((f, i) => `
    <div class="file-item">
      <span class="file-item-icon">${getFileIcon(f.name)}</span>
      <div class="file-item-info">
        <div class="file-item-name">${f.name}</div>
        <div class="file-item-size">${f.size}</div>
      </div>
      <button class="file-item-remove" onclick="removePendingFile(${i})">✕</button>
    </div>
  `).join('');
}

function removePendingFile(i) {
  pendingFiles.splice(i, 1);
  renderPendingFiles();
}

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

function removeGalleryImg(i) {
  pendingGallery.splice(i, 1);
  renderGalleryPreviews();
}

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
// PRODUCT FEATURES: PIN / HIDE / COPY LINK / STATUS / EDIT
// ============================================================

function saveProductsLocal() {
  // حفظ في local cache
  localStorage.setItem('local_products', JSON.stringify(products));
}

async function syncProductToSupabase(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  try {
    await sbFetch('products?id=eq.' + id, {
      method: 'PATCH',
      body: JSON.stringify({
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
      }),
      prefer: 'return=minimal'
    });
  } catch(e) {
    console.warn('Supabase sync failed (OK - saved locally):', e.message);
  }
}

// --- تثبيت ---
function togglePinProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  p.pinned = !p.pinned;
  saveProductsLocal();
  syncProductToSupabase(id);
  renderProducts();
  renderAdminProducts();
  showToast(p.pinned ? '📌 تم تثبيت المنتج في الأول!' : '📌 تم إلغاء التثبيت', p.pinned ? 'success' : 'default');
}

// --- إخفاء / إظهار ---
function toggleHideProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  p.hidden = !p.hidden;
  saveProductsLocal();
  syncProductToSupabase(id);
  renderProducts();
  renderAdminProducts();
  showToast(p.hidden ? '🚫 تم إخفاء المنتج عن العملاء' : '👁️ تم إظهار المنتج', 'default');
}

// --- نسخ رابط ---
function copyProductLink(id) {
  const url = window.location.href.split('?')[0] + '?product=' + id;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('🔗 تم نسخ الرابط!', 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('🔗 تم نسخ الرابط!', 'success');
  }
}

// --- تغيير حالة المنتج ---
function changeProductStatus(id, status) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  p.status = status;
  saveProductsLocal();
  syncProductToSupabase(id);
  renderProducts();
  renderAdminProducts();
  showToast('✅ تم تغيير الحالة إلى: ' + status, 'success');
}

// ============================================================
// EDIT PRODUCT MODAL
// ============================================================
let editingProductId = null;

function openEditProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  editingProductId = id;

  // fill fields
  document.getElementById('editProdName').value = p.name || '';
  document.getElementById('editProdPrice').value = p.price || '';
  document.getElementById('editProdDesc').value = p.description || '';
  document.getElementById('editProdCategory').value = p.category || '';
  document.getElementById('editProdStatus').value = p.status || 'متاح';
  document.getElementById('editProdNote').value = p.adminNote || '';

  // show current image
  const imgPrev = document.getElementById('editImagePreview');
  if (p.image) { imgPrev.src = p.image; imgPrev.style.display = 'block'; }
  else imgPrev.style.display = 'none';

  document.getElementById('editProductOverlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeEditProduct() {
  document.getElementById('editProductOverlay').style.display = 'none';
  document.body.style.overflow = '';
  editingProductId = null;
}

// ============================================================
// ORDER MODAL - واتساب مباشر
// ============================================================
let currentOrderProductId = null;

function openOrderModal(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  if (p.status === 'نفذ') { showToast('❌ هذا المنتج نفذ حالياً', 'error'); return; }

  currentOrderProductId = productId;

  // fill product summary
  const imgEl = document.getElementById('orderProductImg');
  imgEl.innerHTML = p.image ? `<img src="${p.image}" style="width:100%;height:100%;object-fit:cover;">` : '📦';

  document.getElementById('orderProductName').textContent = p.name;
  document.getElementById('orderProductPrice').textContent = formatPrice(p.price);

  // reset fields
  document.getElementById('orderName').value = '';
  document.getElementById('orderPhone').value = '';

  document.getElementById('orderOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('orderName').focus(), 200);
}

function closeOrderModal() {
  document.getElementById('orderOverlay').classList.remove('open');
  document.body.style.overflow = '';
  currentOrderProductId = null;
}

async function confirmOrder() {
  const name = document.getElementById('orderName').value.trim();
  const phone = document.getElementById('orderPhone').value.trim();

  if (!name) { showToast('⚠️ ادخل اسمك', 'warn'); return; }
  if (!phone) { showToast('⚠️ ادخل رقم تليفونك', 'warn'); return; }

  const p = products.find(x => x.id === currentOrderProductId);
  if (!p) return;

  // حفظ الطلب في DB
  const order = {
    id: generateId(),
    customer_name: name,
    customer_phone: phone,
    items: [{ id: p.id, name: p.name, price: p.price, quantity: 1 }],
    total: p.price,
    date: new Date().toLocaleString('ar-EG'),
    status: 'جديد'
  };

  try {
    await saveOrderToDB(order);
    orders.unshift({ ...order, customerName: name, customerPhone: phone });
  } catch(e) { console.warn('saveOrder:', e); }

  // حفظ كـ "اشترى" عشان يقدر يحمل الملفات
  const myOrders = JSON.parse(localStorage.getItem('mahsmarket_my_orders') || '[]');
  if (!myOrders.includes(p.id)) myOrders.push(p.id);
  localStorage.setItem('mahsmarket_my_orders', JSON.stringify(myOrders));

  // فتح واتساب
  const waNumber = (settings.whatsapp || '').replace(/\D/g, '');
  if (waNumber) {
    const msg = `🛒 *طلب جديد — ALMAHSMarket*\n\n👤 الاسم: ${name}\n📞 التليفون: ${phone}\n\n📦 *المنتج:* ${p.name}\n💰 *السعر: ${formatPrice(p.price)}*\n\nأرجو التأكيد، شكراً! 🙏`;
    window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(msg)}`, '_blank');
  }

  closeOrderModal();
  renderAdminOrders();
  showToast('✅ تم إرسال طلبك! تواصل معك قريباً 🎉', 'success');
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

  // تحديث الصورة لو اتغيرت
  const imageFile = document.getElementById('editProdImage').files[0];
  const applyChanges = (imgData) => {
    p.name = name;
    p.price = price;
    p.description = desc;
    p.category = category;
    p.status = status;
    p.adminNote = adminNote;
    if (imgData) p.image = imgData;

    saveProductsLocal();
    syncProductToSupabase(editingProductId);
    renderProducts();
    renderAdminProducts();
    closeEditProduct();
    showToast('✅ تم حفظ التعديلات!', 'success');
  };

  if (imageFile) {
    const reader = new FileReader();
    reader.onload = e => applyChanges(e.target.result);
    reader.readAsDataURL(imageFile);
  } else {
    applyChanges(null);
  }
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
  selectedStars = 0;
  updateStarUI(0);
  ['revName','revProduct','revText'].forEach(id => document.getElementById(id).value = '');
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
  } catch(e) {
    showToast('❌ فشل إرسال الرأي', 'error');
  }
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
        <div class="admin-rev-top">
          <div class="admin-rev-name">${r.name} <span style="color:var(--text-dim);font-weight:400;font-size:12px">${r.product ? '— ' + r.product : ''}</span></div>
          <div style="color:var(--orange);font-size:12px">${stars}</div>
        </div>
        <div class="admin-rev-text">${r.text}</div>
        <div class="admin-rev-actions">
          <button class="rev-approve-btn" onclick="approveReview('${r.id}')">✓ نشر</button>
          <button class="rev-reject-btn" onclick="deleteReview('${r.id}')">✕ حذف</button>
        </div>
      </div>`;
    }).join('');

  ael.innerHTML = !approved.length ? '<div class="no-pending-msg"><span>💬</span><p>لسه مفيش آراء منشورة</p></div>' :
    approved.map(r => {
      const stars = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
      return `<div class="admin-rev-item" style="opacity:0.8">
        <div class="admin-rev-top">
          <div class="admin-rev-name">${r.name}</div>
          <div style="color:var(--orange);font-size:12px">${stars}</div>
        </div>
        <div class="admin-rev-text">${r.text}</div>
        <div class="admin-rev-actions">
          <button class="rev-reject-btn" onclick="deleteReview('${r.id}')">✕ حذف</button>
        </div>
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
  const btn  = document.getElementById('adminNavBtn');
  const btnM = document.getElementById('adminNavBtnMobile');
  if (btn)  btn.style.display = '';
  if (btnM) btnM.style.display = '';
}

function showUserPanelBtn() {
  const btn  = document.getElementById('userPanelNavBtn');
  const btnM = document.getElementById('userPanelNavBtnMobile');
  if (btn)  btn.style.display = '';
  if (btnM) btnM.style.display = '';
}

let logoTapCount = 0, logoTapTimer = null;
function handleLogoTap(e) {
  e.preventDefault();
  logoTapCount++;
  clearTimeout(logoTapTimer);
  if (logoTapCount >= 5) {
    logoTapCount = 0;
    const code = prompt('🔑 أدخل كود الوصول:');
    if (!code) return;
    const saved = settings.accessCode || localStorage.getItem('mahsmarket_access_code');
    if (saved && code === saved) {
      sessionStorage.setItem('mahsmarket_btn_visible', '1');
      showAdminBtn();
      showToast('✅ تم تفعيل الوصول!', 'success');
    } else {
      showToast('❌ كود غلط', 'error');
    }
    return;
  }
  logoTapTimer = setTimeout(() => { logoTapCount = 0; }, 1500);
}

function checkAdminAccess() {
  if (sessionStorage.getItem('mahsmarket_btn_visible') === '1' || isAuthenticated()) {
    showAdminBtn();
  }
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
    showAdminBtn();
    closePwdModal();
    openAdmin();
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
  loadAdminSettings(); renderCouponsList();
}
function closeAdmin() { document.getElementById('adminPanel').style.display = 'none'; document.body.style.overflow = ''; }

function switchAdminTab(tabName) {
  document.querySelectorAll('.admin-tab').forEach(t => { t.classList.remove('active'); t.style.display = 'none'; });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const tab = document.getElementById(tabName + 'Tab');
  tab.classList.add('active');
  tab.style.display = 'block';
  event.target.classList.add('active');
}

// ============================================================
// ADMIN PRODUCTS RENDER
// ============================================================
function renderAdminProducts() {
  const list = document.getElementById('adminProductsList');

  // فصل المنتجات: المثبتة أولاً
  const sorted = [...products].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  });

  if (!sorted.length) {
    list.innerHTML = '<div class="no-pending-msg"><span>📦</span><p>لا توجد منتجات</p></div>';
    return;
  }

  list.innerHTML = `<div class="admin-products-list">${sorted.map(p => {
    const statusColor = p.status === 'نفذ' ? '#ef4444' : p.status === 'قريباً' ? '#f59e0b' : '#10b981';
    const statusLabel = p.status || 'متاح';
    const isHidden = p.hidden === true;
    const isPinned = p.pinned === true;

    return `
    <div class="admin-product-item" style="${isHidden ? 'opacity:0.5;' : ''}${isPinned ? 'border:1.5px solid var(--fire,#ff6200);' : ''}">
      <div class="admin-product-img-wrap">
        ${p.image ? `<img src="${p.image}" alt="${p.name}">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;opacity:0.3;">📦</div>'}
        ${p.category ? `<div class="admin-product-cat-badge">${p.category}</div>` : ''}
        ${isPinned ? '<div style="position:absolute;top:4px;left:4px;background:var(--fire,#ff6200);color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700;">📌 مثبت</div>' : ''}
        ${isHidden ? '<div style="position:absolute;top:4px;right:4px;background:#666;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;">مخفي</div>' : ''}
      </div>
      <div class="admin-product-details">
        <div class="admin-product-name">${p.name}</div>
        <div class="admin-product-price">${formatPrice(p.price)}</div>

        <!-- حالة المنتج badge -->
        <div style="margin-bottom:8px;">
          <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">● ${statusLabel}</span>
        </div>

        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">${p.files && p.files.length ? `📎 ${p.files.length} ملف` : 'لا توجد ملفات'}</div>

        <!-- Row 1: عرض + تعديل -->
        <div class="admin-product-actions" style="margin-bottom:6px;">
          <button class="btn-sm btn-preview" style="background:rgba(34,211,238,0.1);color:var(--cyan);border:1px solid rgba(34,211,238,0.2);flex:1;" onclick="openProductDetail('${p.id}');closeAdmin()">👁️ عرض</button>
          <button class="btn-sm" style="background:rgba(255,165,0,0.1);color:#f59e0b;border:1px solid rgba(255,165,0,0.2);flex:1;" onclick="openEditProduct('${p.id}')">✏️ تعديل</button>
        </div>

        <!-- Row 2: تثبيت + إخفاء + رابط + حذف -->
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

          <!-- تغيير الحالة -->
          <select onchange="changeProductStatus('${p.id}', this.value)"
            style="flex:1;background:rgba(255,255,255,0.05);color:var(--text-dim);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 6px;font-size:11px;cursor:pointer;">
            <option value="متاح" ${statusLabel==='متاح'?'selected':''}>● متاح</option>
            <option value="نفذ" ${statusLabel==='نفذ'?'selected':''}>● نفذ</option>
            <option value="قريباً" ${statusLabel==='قريباً'?'selected':''}>● قريباً</option>
          </select>

          <button class="btn-sm btn-del" onclick="deleteProduct('${p.id}')">🗑️</button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ============================================================
// ADMIN ORDERS RENDER
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
    'جديد':        { bg: 'rgba(255,98,0,0.12)',      color: 'var(--fire)',  border: 'rgba(255,98,0,0.3)' },
    'قيد التنفيذ': { bg: 'rgba(240,180,41,0.12)',    color: 'var(--gold)',  border: 'rgba(240,180,41,0.3)' },
    'مكتمل':       { bg: 'rgba(34,197,94,0.12)',      color: '#22c55e',      border: 'rgba(34,197,94,0.3)' },
    'ملغي':        { bg: 'rgba(239,68,68,0.1)',       color: '#ef4444',      border: 'rgba(239,68,68,0.25)' },
  };

  list.innerHTML = [...orders].map(o => {
    const sc = statusColors[o.status] || statusColors['جديد'];
    const customerName = o.customerName || o.customer_name || '';
    const customerPhone = o.customerPhone || o.customer_phone || '';
    const phone = customerPhone.replace(/\D/g, '');
    const waMsg = encodeURIComponent(`👋 أهلاً ${customerName}،\nبخصوص طلبك رقم #${o.id.substr(0,6)} من ALMAHSMarket\n\nتفضل كلمنا هنساعدك 😊`);

    return `
    <div class="admin-order-item" id="order-${o.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:800;color:var(--text);font-size:15px;">🧾 أوردر #${o.id.substr(0,6)}</div>
        <span style="background:${sc.bg};color:${sc.color};padding:4px 14px;border-radius:100px;font-size:12px;font-weight:700;border:1px solid ${sc.border};">${o.status}</span>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px;">👤 ${customerName}</div>
        <div style="font-size:13px;color:var(--text-sub);">📞 <span dir="ltr">${customerPhone || 'غير محدد'}</span></div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">📅 ${o.date}</div>
      </div>
      <div style="margin-bottom:12px;">
        ${o.items.map(i => `
          <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-sub);padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span>• ${i.name} × ${i.quantity}</span>
            <span style="color:var(--gold);font-weight:700;">${formatPrice(i.price * i.quantity)}</span>
          </div>`).join('')}
        <div style="display:flex;justify-content:space-between;font-weight:800;font-size:15px;margin-top:8px;padding-top:8px;">
          <span style="color:var(--text);">الإجمالي</span>
          <span style="background:linear-gradient(90deg,var(--fire),var(--gold));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${formatPrice(o.total)}</span>
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">تغيير الحالة:</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${['جديد','قيد التنفيذ','مكتمل','ملغي'].map(s => `
            <button onclick="changeOrderStatus('${o.id}','${s}')"
              style="padding:5px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid ${o.status===s ? sc.border : 'var(--border)'};background:${o.status===s ? sc.bg : 'transparent'};color:${o.status===s ? sc.color : 'var(--text-sub)'};font-family:inherit;transition:all 0.2s;">
              ${s}
            </button>`).join('')}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${phone ? `
          <a href="https://wa.me/${phone}?text=${waMsg}" target="_blank"
            style="flex:1;min-width:120px;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;border-radius:10px;background:rgba(37,211,102,0.12);color:#25d366;border:1px solid rgba(37,211,102,0.3);font-weight:700;font-size:13px;text-decoration:none;">
            واتساب
          </a>
          <a href="tel:${phone}"
            style="padding:10px 16px;border-radius:10px;background:rgba(240,180,41,0.1);color:var(--gold);border:1px solid rgba(240,180,41,0.25);font-weight:700;font-size:13px;text-decoration:none;display:flex;align-items:center;gap:6px;">
            📞 اتصال
          </a>` : '<span style="font-size:12px;color:var(--text-dim);">⚠️ مفيش رقم تليفون</span>'}
        <button onclick="deleteOrder('${o.id}')"
          style="padding:10px 14px;border-radius:10px;background:rgba(239,68,68,0.08);color:#ef4444;border:1px solid rgba(239,68,68,0.2);font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;">
          🗑️
        </button>
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
}

async function saveAccessCode() {
  const code = document.getElementById('settingsAccessCode').value.trim();
  if (!code) { showToast('⚠️ اكتب كود الأول!', 'warn'); return; }
  settings.accessCode = code;
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
}

// ============================================================
// WHATSAPP FLOATING CHAT
// ============================================================
let waBubbleOpen = false;
let waAutoShown = false;

function toggleWaBubble() {
  waBubbleOpen = !waBubbleOpen;
  const bubble = document.getElementById('waBubble');
  const btn = document.getElementById('waBtn');
  const iconChat = btn.querySelector('.wa-icon-chat');
  const iconClose = btn.querySelector('.wa-icon-close');

  if (waBubbleOpen) {
    bubble.classList.add('open');
    iconChat.style.display = 'none';
    iconClose.style.display = 'flex';
    btn.classList.add('active');
  } else {
    bubble.classList.remove('open');
    iconChat.style.display = 'flex';
    iconClose.style.display = 'none';
    btn.classList.remove('active');
  }
}

function openWaChat() {
  const waNumber = (settings.whatsapp || '').replace(/\D/g, '');
  if (!waNumber) { showToast('⚠️ رقم الواتساب غير مضبوط', 'warn'); return; }
  const msg = 'أهلاً! مهتم بخدماتكم في ALMAHSMarket 👋';
  window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(msg)}`, '_blank');
}

function initWaFloating() {
  const waNumber = (settings.whatsapp || '').replace(/\D/g, '');
  const el = document.getElementById('waFloating');
  if (!el) return;
  if (!waNumber) { el.style.display = 'none'; return; }
  el.style.display = 'flex';

  if (!waAutoShown) {
    setTimeout(() => {
      if (!waBubbleOpen) { toggleWaBubble(); waAutoShown = true; }
    }, 4000);
  }
}

// ============================================================
// COUPON SYSTEM
// ============================================================
function renderCouponsList() {
  const el = document.getElementById('couponsList');
  if (!el) return;
  if (!coupons.length) {
    el.innerHTML = '<div class="no-pending-msg" style="padding:20px;"><span>🏷️</span><p>لا توجد كوبونات</p></div>';
    return;
  }
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
// DOM READY
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  // تنظيف localStorage القديم اللي ممكن يكون فيه base64 ضخمة
  try {
    const old = localStorage.getItem('local_products');
    if (old && old.length > 1_000_000) {
      // أكبر من 1MB = فيه base64 قديمة، امسحه
      localStorage.removeItem('local_products');
      console.log('Cleared oversized local_products cache');
    }
  } catch(e) {}

  // Show loading
  const grid = document.getElementById('productsGrid');
  if (grid) grid.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-dim);grid-column:1/-1;"><div style="font-size:40px;margin-bottom:12px;">⏳</div><p>جارٍ التحميل...</p></div>';

  // Load all data from Supabase - كل واحد بـ fallback مستقل
  const [prods, ords, revs, sett, coups] = await Promise.all([
    loadProducts().catch(e => { console.warn("products:", e); return JSON.parse(localStorage.getItem("local_products") || "[]"); }),
    loadOrders().catch(e => { console.warn("orders:", e); return []; }),
    loadReviews().catch(e => { console.warn("reviews:", e); return []; }),
    loadSettings().catch(e => { console.warn("settings:", e); return { id: 1, whatsapp: "201063786533", password_hash: "", access_code: "USER2024" }; }),
    loadCoupons().catch(e => { console.warn("coupons:", e); return []; })
  ]);

  products = prods || [];
  orders = (ords || []).map(o => ({ ...o, customerName: o.customer_name, customerPhone: o.customer_phone }));
  reviews = revs || [];
  settings = {
    whatsapp: (sett && sett.whatsapp) || "201063786533",
    passwordHash: (sett && sett.password_hash) || localStorage.getItem("mahsmarket_pwd_hash") || "",
    accessCode: (sett && sett.access_code) || "USER2024"
  };
  coupons = coups || [];

  await initPassword();
  checkAdminAccess();

  renderProducts();
  renderReviews();
  updateRevTabCount();
  initWaFloating();

  // Search
  const searchInput = document.getElementById('productSearch');
  if (searchInput) searchInput.addEventListener('input', e => handleSearch(e.target.value));

  // Image preview
  const imgInput = document.getElementById('prodImage');
  if (imgInput) {
    imgInput.addEventListener('change', e => {
      if (e.target.files[0]) {
        const r = new FileReader();
        r.onload = ev => {
          const prev = document.getElementById('imagePreview');
          prev.src = ev.target.result;
          prev.style.display = 'block';
        };
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
        r.onload = ev => {
          pendingGallery.push(ev.target.result);
          renderGalleryPreviews();
        };
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

  // Order modal - Enter key
  ['orderName','orderPhone'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keyup', e => { if (e.key === 'Enter') confirmOrder(); });
  });

  // Edit product image preview
  const editImgInput = document.getElementById('editProdImage');
  if (editImgInput) {
    editImgInput.addEventListener('change', e => {
      if (e.target.files[0]) {
        const r = new FileReader();
        r.onload = ev => {
          const prev = document.getElementById('editImagePreview');
          prev.src = ev.target.result;
          prev.style.display = 'block';
        };
        r.readAsDataURL(e.target.files[0]);
      }
    });
  }

  // فتح منتج من URL مباشرة ?product=ID
  const urlParams = new URLSearchParams(window.location.search);
  const productId = urlParams.get('product');
  if (productId) {
    setTimeout(() => {
      const p = products.find(x => x.id === productId);
      if (p) openProductDetail(productId);
    }, 300);
  }
});



// ============================================================
// FILE UPLOAD HANDLER
// ============================================================
function handleFilesInput(files) {
  if (!files || files.length === 0) return;
  
  let added = 0;
  Array.from(files).forEach(file => {
    if (pendingFiles.some(f => f.name === file.name)) {
      showToast('⚠️ الملف "' + file.name + '" موجود بالفعل', 'warn');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      pendingFiles.push({
        id: generateId(),
        name: file.name,
        size: formatBytes(file.size),
        data: ev.target.result
      });
      renderPendingFiles();
    };
    reader.onerror = () => showToast('❌ فشل قراءة الملف: ' + file.name, 'error');
    reader.readAsDataURL(file);
    added++;
  });
  
  if (added > 0) showToast('✅ جاري رفع ' + added + ' ملف...', 'success');
}

// Render pending files list
function renderPendingFiles() {
  const el = document.getElementById('pendingFilesList');
  if (!el) return;
  
  if (!pendingFiles.length) { 
    el.innerHTML = ''; 
    return; 
  }
  
  el.innerHTML = pendingFiles.map((f, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px;background:rgba(255,98,0,0.08);border-radius:8px;margin-bottom:8px;border-left:3px solid #ff6200;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;color:var(--text-primary);word-break:break-word;font-weight:500;">${f.name}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${f.size}</div>
      </div>
      <button onclick="removeFile(${i})" style="background:#ef4444;color:white;border:none;width:28px;height:28px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">×</button>
    </div>
  `).join('');
}

// Remove file from pending
function removeFile(index) {
  pendingFiles.splice(index, 1);
  renderPendingFiles();
  showToast('🗑️ تم حذف الملف', 'info');
}

// ============================================================
// USER PROJECT UPLOAD SYSTEM
// ============================================================
let userUploadFiles = [];
let userUploadCodeVerified = false;

function openUserUploadModal() {
  const modal = document.getElementById('userUploadModal');
  const overlay = document.getElementById('userUploadOverlay');
  
  if (!modal || !overlay) {
    console.error('User upload modal elements not found');
    return;
  }
  
  modal.style.display = 'block';
  overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
  userUploadCodeVerified = false;
  userUploadFiles = [];
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
  const safeSet = (id, value) => {
    const el = document.getElementById(id);
    if (el) {
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    }
  };
  
  safeSet('userUploadCode', '');
  safeSet('userProjName', '');
  safeSet('userProjDesc', '');
  safeSet('userProjPrice', '');
  safeSet('userProjCategory', '');
  safeSet('userFilesLock', true);
  safeSet('userProjFiles', '');
  
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
  
  try {
    // التحقق من الكود مباشرة من settings أو استخدام كود افتراضي
    const savedCode = settings.accessCode || localStorage.getItem('mahsmarket_access_code') || 'USER2024';
    
    if (savedCode && code === savedCode) {
      userUploadCodeVerified = true;
      document.getElementById('userUploadCodeSection').style.display = 'none';
      document.getElementById('userUploadForm').style.display = 'block';
      showToast('✅ كود صحيح!', 'success');
    } else {
      showToast('❌ كود غلط (جرب: USER2024)', 'error');
    }
  } catch(e) {
    console.error('Code verification error:', e);
    showToast('❌ خطأ في التحقق', 'error');
  }
}

function setupUserUploadArea() {
  const uploadArea = document.getElementById('userUploadFilesArea');
  const filesInput = document.getElementById('userProjFiles');
  
  if (!uploadArea || !filesInput) {
    console.warn('User upload elements not found');
    return;
  }
  
  uploadArea.addEventListener('click', () => filesInput.click());
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', e => { e.preventDefault(); uploadArea.classList.remove('drag-over'); handleUserFiles(e.dataTransfer.files); });
  filesInput.addEventListener('change', e => handleUserFiles(e.target.files));
}

function handleUserFiles(fileList) {
  Array.from(fileList).forEach(file => {
    const r = new FileReader();
    r.onload = ev => {
      userUploadFiles.push({ id: generateId(), name: file.name, size: formatBytes(file.size), data: ev.target.result });
      renderUserPendingFiles();
    };
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

function removeUserFile(index) {
  userUploadFiles.splice(index, 1);
  renderUserPendingFiles();
}

async function submitUserProject() {
  if (!userUploadCodeVerified) {
    showToast('❌ تحقق من الكود أولاً', 'error');
    return;
  }

  const getSafeValue = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  };
  
  const getSafeChecked = (id) => {
    const el = document.getElementById(id);
    return el ? el.checked : false;
  };

  const name = getSafeValue('userProjName');
  const desc = getSafeValue('userProjDesc');
  const price = parseFloat(getSafeValue('userProjPrice'));
  const category = getSafeValue('userProjCategory');
  const filesLocked = getSafeChecked('userFilesLock');

  if (!name || !desc || !price || price < 1) {
    showToast('⚠️ ملء جميع البيانات المطلوبة', 'warn');
    return;
  }

  if (userUploadFiles.length === 0) {
    showToast('⚠️ أرفع ملف واحد على الأقل', 'warn');
    return;
  }

  try {
    showToast('🔄 جاري رفع المشروع...', 'default');
    
    // إنشاء معرّف فريد للـ User
    let userId = sessionStorage.getItem(USER_SESSION_KEY);
    if (!userId) {
      userId = 'user_' + generateId();
      sessionStorage.setItem(USER_SESSION_KEY, userId);
    }
    
    const product = {
      id: generateId(),
      name,
      description: desc,
      price: price,
      category: category || 'مشروع عام',
      image: '',
      gallery: [],
      files: userUploadFiles.map(f => ({ id: f.id, name: f.name, size: f.size, data: f.data })),
      files_locked: filesLocked,
      created_at: new Date().toISOString(),
      // حفظ معرّف المستخدم في localStorage بدل الـ Database
      user_id: userId
    };

    // رفع على Supabase + حفظ محلي
    await saveProductToDB(product);
    
    products.unshift(product);
    renderProducts();
    
    closeUserUploadModal();
    showUserPanelBtn();
    showToast('✅ تم رفع المشروع بنجاح! سيظهر للعملاء فوراً 🎉', 'success');
    
  } catch(e) {
    console.error('Upload error:', e);
    showToast('❌ فشل الرفع: ' + e.message, 'error');
  }
}

// Initialize user upload area on page load
document.addEventListener('DOMContentLoaded', () => {
  setupUserUploadArea();
});


// ============================================================
// USER PANEL / DASHBOARD
// ============================================================
function openUserPanel() {
  const userId = getCurrentUserId();
  if (!userId) {
    showToast('❌ الرجاء رفع مشروع أولاً للوصول للوحة التحكم', 'error');
    return;
  }
  
  document.getElementById('userPanel').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  renderUserProjects();
}

function closeUserPanel() {
  document.getElementById('userPanel').style.display = 'none';
  document.body.style.overflow = '';
}

function renderUserProjects() {
  const userId = getCurrentUserId();
  if (!userId) return;
  
  // تصفية المشاريع الخاصة بهذا المستخدم فقط
  const userProjects = products.filter(p => p.user_id === userId);
  const container = document.getElementById('userProjectsList');
  
  if (!userProjects.length) {
    container.innerHTML = '<div class="no-pending-msg"><span>📦</span><p>لم تقم برفع أي مشاريع بعد</p></div>';
    return;
  }
  
  container.innerHTML = `<div class="admin-products-list">${userProjects.map(p => `
    <div class="admin-product-item">
      <div class="admin-product-img-wrap">
        ${p.image ? `<img src="${p.image}" alt="${p.name}">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;opacity:0.3;">📦</div>'}
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
  
  // التحقق من أن المشروع يخص هذا المستخدم فقط
  if (!project || project.user_id !== userId) {
    showToast('❌ لا يمكنك حذف هذا المشروع', 'error');
    return;
  }
  
  if (!confirm('هتحذف المشروع ده؟ العملية لا يمكن التراجع عنها!')) return;
  
  try {
    showToast('🔄 جاري حذف المشروع...', 'default');
    await deleteProductFromDB(projectId);
    products = products.filter(p => p.id !== projectId);
    renderUserProjects();
    renderProducts();
    showToast('🗑️ تم حذف المشروع', 'success');
  } catch(e) {
    console.error('Delete error:', e);
    showToast('❌ فشل الحذف', 'error');
  }
}

function checkUserPanel() {
  const userId = getCurrentUserId();
  if (userId) {
    showUserPanelBtn();
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  checkUserPanel();
});
