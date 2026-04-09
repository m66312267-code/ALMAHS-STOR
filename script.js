// ============================================================
// SUPABASE CONFIG
// ============================================================
const SUPABASE_URL = 'https://uhbjhryumuhtnxelugmy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoYmpocnl1bXVodG54ZWx1Z215Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MDIwODIsImV4cCI6MjA5MTI3ODA4Mn0.pf2614vZJQN5VvjGCT7-WWgTzLDUSX__TdJBt5n3hVg';

async function sbFetch(path, options = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...options.headers
    },
    ...options
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ============================================================
// GLOBAL STATE
// ============================================================
let products = [];
let orders = [];
let reviews = [];
let cart = [];
let settings = {};
let coupons = [];
let selectedStars = 0;
let pendingFiles = [];
let pendingGallery = []; // صور إضافية
let searchQuery = '';
let appliedCoupon = null;

// ============================================================
// SUPABASE DATA FUNCTIONS
// ============================================================

// --- Products ---
async function loadProducts() {
  try {
    const data = await sbFetch('products?order=created_at.desc');
    return data || [];
  } catch(e) { 
    console.warn('loadProducts from DB failed, loading from local:', e);
    // تحميل من localStorage كبديل
    const local = JSON.parse(localStorage.getItem('local_products') || '[]');
    return local;
  }
}
async function saveProductToDB(product) {
  try {
    return await sbFetch('products', {
      method: 'POST',
      body: JSON.stringify(product)
    });
  } catch(e) {
    console.warn('Database save failed, saving locally:', e);
    // حفظ محلي في localStorage كبديل
    let localProducts = JSON.parse(localStorage.getItem('local_products') || '[]');
    localProducts.push(product);
    localStorage.setItem('local_products', JSON.stringify(localProducts));
    return product;
  }
}

async function deleteProductFromDB(id) {
  try {
    await sbFetch('products?id=eq.' + id, {
      method: 'DELETE',
      prefer: 'return=minimal'
    });
  } catch(e) {
    console.warn('Database delete failed, deleting locally:', e);
    // حذف محلي من localStorage كبديل
    let localProducts = JSON.parse(localStorage.getItem('local_products') || '[]');
    localProducts = localProducts.filter(p => p.id !== id);
    localStorage.setItem('local_products', JSON.stringify(localProducts));
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

// Cart stays local (per-user)
function saveCart() { localStorage.setItem('mahsmarket_cart', JSON.stringify(cart)); }
function loadCartLocal() { const s = localStorage.getItem('mahsmarket_cart'); return s ? JSON.parse(s) : []; }

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

async function initPassword() {
  if (!settings.passwordHash) {
    settings.passwordHash = await hashPassword('2008');
    await saveSettings();
  }
}

async function verifyPassword(input) {
  const hash = await hashPassword(input);
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
  if (!searchQuery) return products;
  return products.filter(p =>
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

  grid.innerHTML = filtered.map(p => `
    <div class="product-card">
      <div class="product-img-wrap">
        ${p.image ? `<img src="${p.image}" alt="${p.name}">` : `<div class="product-img-placeholder">📦</div>`}
        <div class="product-overlay">
          <button class="btn-preview" onclick="openProductDetail('${p.id}')">👁️ استعراض</button>
          <button class="btn-add-overlay" onclick="addToCart('${p.id}');event.stopPropagation()">أضف للسلة</button>
        </div>
        <div class="product-badge">${p.category || 'متاح'}</div>
      </div>
      <div class="product-body">
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.description}</div>
        <div class="product-footer">
          <div class="product-price">${formatPrice(p.price)}</div>
          <button class="btn-sm btn-add" onclick="addToCart('${p.id}')">+ سلة</button>
        </div>
      </div>
    </div>
  `).join('');
  
  // تحديث الإحصائيات
  updateStats();
}

function updateStats() {
  const completedOrders = orders.filter(o => o.status === 'مكتمل').length;
  const approvedReviews = reviews.filter(r => r.approved).length;
  
  const statProd = document.getElementById('stat-products');
  const statOrders = document.getElementById('stat-orders');
  const statReviews = document.getElementById('stat-reviews');
  
  if (statProd) statProd.innerHTML = `<em>${products.length}</em>+`;
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
            <button class="btn-primary" onclick="addToCart('${p.id}');showToast('✅ تمت الإضافة!','success')">🛒 أضف للسلة</button>
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
// CART
// ============================================================
function addToCart(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;
  const existing = cart.find(i => i.id === productId);
  if (existing) { existing.quantity += 1; } else { cart.push({ ...product, quantity: 1 }); }
  saveCart();
  updateCartUI();
  showToast('✅ تمت الإضافة للسلة!', 'success');
}

function removeFromCart(productId) {
  cart = cart.filter(i => i.id !== productId);
  saveCart();
  updateCartUI();
}

function changeQty(productId, delta) {
  const item = cart.find(i => i.id === productId);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) cart = cart.filter(i => i.id !== productId);
  saveCart();
  updateCartUI();
}

function updateCartUI() {
  const badge = document.getElementById('cartBadge');
  const badgeMobile = document.getElementById('cartBadgeMobile');
  const total = cart.reduce((s, i) => s + i.quantity, 0);
  badge.textContent = total;
  if (badgeMobile) badgeMobile.textContent = total;

  const list = document.getElementById('cartItemsList');
  if (cart.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim);">🛒 السلة فارغة</div>';
    document.getElementById('checkoutBtn').disabled = true;
  } else {
    list.innerHTML = cart.map(item => `
      <div class="cart-item">
        <div class="cart-item-thumb">
          ${item.image ? `<img src="${item.image}" alt="${item.name}">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:24px;">📦</div>'}
        </div>
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-price">${formatPrice(item.price)}</div>
        </div>
        <div class="cart-qty-controls">
          <button class="qty-btn" onclick="changeQty('${item.id}', -1)">−</button>
          <span class="qty-num">${item.quantity}</span>
          <button class="qty-btn" onclick="changeQty('${item.id}', 1)">+</button>
        </div>
        <button class="cart-item-remove" onclick="removeFromCart('${item.id}')">🗑️</button>
      </div>
    `).join('');
    document.getElementById('checkoutBtn').disabled = false;
  }
  const cartSubtotal = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
  const discount = getDiscountAmount(cartSubtotal);
  const cartFinal = cartSubtotal - discount;

  let totalHTML = `<div class="cart-total-row"><span>الإجمالي:</span><span>${formatPrice(cartSubtotal)}</span></div>`;
  if (discount > 0) {
    totalHTML += `<div class="cart-total-row discount-row"><span>🏷️ خصم (${appliedCoupon.type === 'percent' ? appliedCoupon.value + '%' : formatPrice(appliedCoupon.value)}):</span><span>- ${formatPrice(discount)}</span></div>`;
    totalHTML += `<div class="cart-total-row final-row"><span>الإجمالي بعد الخصم:</span><span id="cartTotal" style="font-weight:700;font-size:18px;">${formatPrice(cartFinal)}</span></div>`;
  } else {
    totalHTML += `<div style="display:none"><span id="cartTotal">${formatPrice(cartFinal)}</span></div>`;
  }

  document.querySelector('.cart-total').innerHTML = totalHTML;
  if (!document.getElementById('cartTotal')) {
    const hidden = document.createElement('span');
    hidden.id = 'cartTotal';
    hidden.style.display = 'none';
    hidden.textContent = formatPrice(cartFinal);
    document.querySelector('.cart-total').appendChild(hidden);
  }
}

function openCart() { updateCartUI(); document.getElementById('cartOverlay').classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeCart() { document.getElementById('cartOverlay').classList.remove('open'); document.body.style.overflow = ''; }

function checkout() {
  if (!cart.length) { showToast('⚠️ السلة فارغة', 'warn'); return; }
  closeCart();
  openCheckoutModal();
}

// ============================================================
// CHECKOUT MODAL
// ============================================================
function openCheckoutModal() {
  document.getElementById('checkoutName').value = '';
  document.getElementById('checkoutPhone').value = '';
  document.getElementById('checkoutOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCheckoutModal() {
  document.getElementById('checkoutOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

async function confirmCheckout() {
  const name = document.getElementById('checkoutName').value.trim();
  const phone = document.getElementById('checkoutPhone').value.trim();
  if (!name) { showToast('⚠️ ادخل اسمك', 'warn'); return; }
  if (!phone) { showToast('⚠️ ادخل رقم تليفونك', 'warn'); return; }

  const subtotal = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
  const discount = getDiscountAmount(subtotal);
  const total = subtotal - discount;
  const order = {
    id: generateId(),
    customer_name: name,
    customer_phone: phone,
    items: [...cart],
    total,
    date: new Date().toLocaleString('ar-EG'),
    status: 'جديد'
  };

  try {
    await saveOrderToDB(order);
    // Map for local use
    orders.unshift({ ...order, customerName: order.customer_name, customerPhone: order.customer_phone });
  } catch(e) {
    console.error('saveOrder:', e);
  }

  const waNumber = (settings.whatsapp || '').replace(/\D/g, '');
  if (waNumber) {
    const itemsText = cart.map(i => `• ${i.name} × ${i.quantity} = ${formatPrice(i.price * i.quantity)}`).join('\n');
    const discountLine = discount > 0 ? `\n🏷️ *كوبون خصم (${appliedCoupon.code}):* - ${formatPrice(discount)}` : '';
    const msg = `🛒 *طلب جديد — ALMAHSMarket*\n\n👤 الاسم: ${name}\n📞 التليفون: ${phone}\n\n📦 *المنتجات:*\n${itemsText}${discountLine}\n\n💰 *الإجمالي: ${formatPrice(total)}*`;
    window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(msg)}`, '_blank');
  }

  cart = [];
  saveCart();
  // حفظ المنتجات اللي اشتراها العميل عشان يقدر يحمل ملفاتها
  const myOrders = JSON.parse(localStorage.getItem('mahsmarket_my_orders') || '[]');
  order.items.forEach(i => { if (!myOrders.includes(i.id)) myOrders.push(i.id); });
  localStorage.setItem('mahsmarket_my_orders', JSON.stringify(myOrders));
  appliedCoupon = null;
  updateCartUI();
  closeCheckoutModal();
  renderAdminOrders();
  showToast('✅ تم تسجيل طلبك بنجاح!', 'success');
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
  if (!products.length) {
    list.innerHTML = '<div class="no-pending-msg"><span>📦</span><p>لا توجد منتجات</p></div>';
    return;
  }
  list.innerHTML = `<div class="admin-products-list">${products.map(p => `
    <div class="admin-product-item">
      <div class="admin-product-img-wrap">
        ${p.image ? `<img src="${p.image}" alt="${p.name}">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;opacity:0.3;">📦</div>'}
        ${p.category ? `<div class="admin-product-cat-badge">${p.category}</div>` : ''}
      </div>
      <div class="admin-product-details">
        <div class="admin-product-name">${p.name}</div>
        <div class="admin-product-price">${formatPrice(p.price)}</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">${p.files && p.files.length ? `📎 ${p.files.length} ملف` : 'لا توجد ملفات'}</div>
        <div class="admin-product-actions">
          <button class="btn-sm btn-preview" style="background:rgba(34,211,238,0.1);color:var(--cyan);border:1px solid rgba(34,211,238,0.2);flex:1;" onclick="openProductDetail('${p.id}');closeAdmin()">👁️ عرض</button>
          <button class="btn-sm btn-del" onclick="deleteProduct('${p.id}')">🗑️</button>
        </div>
      </div>
    </div>
  `).join('')}</div>`;
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
function toggleCouponSection() {
  const sec = document.getElementById('couponSection');
  sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
}

function applyCoupon() {
  const code = (document.getElementById('couponInput').value || '').trim().toUpperCase();
  const msg = document.getElementById('couponMsg');
  if (!code) { msg.textContent = '⚠️ ادخل كود الخصم'; msg.className = 'coupon-msg error'; return; }

  const coupon = coupons.find(c => c.code === code && c.active);
  if (!coupon) {
    msg.textContent = '❌ كود الخصم غلط أو منتهي';
    msg.className = 'coupon-msg error';
    appliedCoupon = null;
    updateCartUI();
    return;
  }

  appliedCoupon = coupon;
  const cartSubtotal = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
  const discount = coupon.type === 'percent'
    ? (cartSubtotal * coupon.value / 100)
    : Math.min(coupon.value, cartSubtotal);
  const discountFormatted = formatPrice(discount);

  msg.textContent = `✅ خصم ${coupon.type === 'percent' ? coupon.value + '%' : formatPrice(coupon.value)} — وفرت ${discountFormatted}!`;
  msg.className = 'coupon-msg success';
  updateCartUI();
}

function removeCoupon() {
  appliedCoupon = null;
  const input = document.getElementById('couponInput');
  const msg = document.getElementById('couponMsg');
  if (input) input.value = '';
  if (msg) { msg.textContent = ''; msg.className = 'coupon-msg'; }
  updateCartUI();
}

function getDiscountAmount(subtotal) {
  if (!appliedCoupon) return 0;
  return appliedCoupon.type === 'percent'
    ? (subtotal * appliedCoupon.value / 100)
    : Math.min(appliedCoupon.value, subtotal);
}

async function addCoupon() {
  const code = (document.getElementById('newCouponCode').value || '').trim().toUpperCase();
  const value = parseFloat(document.getElementById('newCouponValue').value);
  const type = document.getElementById('newCouponType').value;

  if (!code) { showToast('⚠️ ادخل كود الكوبون', 'warn'); return; }
  if (!value || value <= 0) { showToast('⚠️ ادخل قيمة صحيحة', 'warn'); return; }
  if (coupons.find(c => c.code === code)) { showToast('❌ الكود ده موجود بالفعل', 'error'); return; }
  if (type === 'percent' && value > 100) { showToast('⚠️ النسبة لازم تكون أقل من 100%', 'warn'); return; }

  const coupon = { id: generateId(), code, value, type, active: true, used_count: 0 };
  try {
    await saveCouponToDB(coupon);
    coupons.unshift(coupon);
    renderCouponsList();
    document.getElementById('newCouponCode').value = '';
    document.getElementById('newCouponValue').value = '';
    showToast('✅ تم إضافة الكوبون!', 'success');
  } catch(e) { showToast('❌ فشل الحفظ', 'error'); }
}

async function toggleCoupon(id) {
  const c = coupons.find(x => x.id === id);
  if (!c) return;
  try {
    await updateCouponInDB(id, { active: !c.active });
    c.active = !c.active;
    renderCouponsList();
  } catch(e) { showToast('❌ فشل التحديث', 'error'); }
}

async function deleteCoupon(id) {
  if (!confirm('هتحذف الكوبون ده؟')) return;
  try {
    await deleteCouponFromDB(id);
    coupons = coupons.filter(c => c.id !== id);
    if (appliedCoupon && appliedCoupon.id === id) removeCoupon();
    renderCouponsList();
    showToast('🗑️ تم حذف الكوبون', 'warn');
  } catch(e) { showToast('❌ فشل الحذف', 'error'); }
}

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
  // Show loading
  const grid = document.getElementById('productsGrid');
  if (grid) grid.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-dim);grid-column:1/-1;"><div style="font-size:40px;margin-bottom:12px;">⏳</div><p>جارٍ التحميل...</p></div>';

  // Load all data from Supabase
  const [prods, ords, revs, sett, coups] = await Promise.all([
    loadProducts(),
    loadOrders(),
    loadReviews(),
    loadSettings(),
    loadCoupons()
  ]);

  products = prods;
  orders = ords.map(o => ({ ...o, customerName: o.customer_name, customerPhone: o.customer_phone }));
  reviews = revs;
  settings = { 
    whatsapp: sett.whatsapp || '201063786533',
    passwordHash: sett.password_hash || '', 
    accessCode: sett.access_code || 'USER2024'
  };
  coupons = coups;
  cart = loadCartLocal();
  


  await initPassword();
  checkAdminAccess();

  renderProducts();
  renderReviews();
  updateCartUI();
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
});



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

    try {
      // محاولة الحفظ في الـ Database
      await saveProductToDB(product);
    } catch(dbError) {
      // إذا فشل الـ Database، احفظ في localStorage
      console.warn('Database error, saving locally:', dbError);
      let localProducts = JSON.parse(localStorage.getItem('local_products') || '[]');
      localProducts.push(product);
      localStorage.setItem('local_products', JSON.stringify(localProducts));
    }
    
    products.unshift(product);
    renderProducts();
    
    closeUserUploadModal();
    showUserPanelBtn();
    showToast('✅ تم رفع المشروع بنجاح!', 'success');
    
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
