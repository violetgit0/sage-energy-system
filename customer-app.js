// ============================================================
// CUSTOMER-APP.JS – Sage Energy Customer Portal
// ============================================================

var currentCustomer  = null; // profile loaded from Firestore customers collection
var ordersListener   = null; // holds the Firestore orders unsubscribe function
var productsListener = null; // holds the Firestore products unsubscribe function
var allFuelProducts  = [];   // latest snapshot of the products collection
var invoicesListener   = null;
var allMyInvoices      = [];
var currentViewInvoice = null;

// ============================================================
// COMPANY PAYMENT DETAILS
// ============================================================
var COMPANY_PAYMENT = {
  companyName: 'Sage Energy and Natural Resources Ltd',
  bankName:    'opay',
  accountNo:   '8062535189',
  accountName: 'Sage Energy and Natural Resources Ltd',
  phone:       '+234 8154114232',
};

// ============================================================
// AUTH GUARD
// The Firebase user object from onAuthStateChanged is passed
// directly into every function that needs the uid.
// We never call firebase.auth().currentUser later because
// it can return null during page initialisation.
// ============================================================
firebase.auth().onAuthStateChanged(async function (user) {

  if (!user) {
    console.log('[Auth] No user – redirecting to login');
    window.location.href = 'customer-login.html';
    return;
  }

  console.log('[Auth] Signed in uid:', user.uid, 'email:', user.email);

  try {
    var doc = await db.collection('customers').doc(user.uid).get();

    if (!doc.exists) {
      console.warn('[Auth] uid not found in customers collection – signing out');
      await firebase.auth().signOut();
      window.location.href = 'customer-login.html';
      return;
    }

    // Build the in-memory profile from Firestore + the auth object
    currentCustomer = {
      uid:     user.uid,
      email:   user.email,
      name:    doc.data().name    || user.email,
      phone:   doc.data().phone   || '',
      address: doc.data().address || '',
    };

    console.log('[Auth] Customer profile loaded:', currentCustomer);

    document.getElementById('userEmail').textContent = currentCustomer.name;

    // Pass the Firebase user directly – avoids any later auth-state race
    initCustomerApp(user);

  } catch (err) {
    console.error('[Auth] Error loading customer profile:', err);
    showOrdersError('Could not load your account. Please refresh the page.');
  }
});

// ============================================================
// LOGOUT
// ============================================================
document.getElementById('logoutBtn').addEventListener('click', function () {
  if (confirm('Are you sure you want to log out?')) {
    if (ordersListener)   ordersListener();   // detach Firestore orders listener
    if (productsListener) productsListener(); // detach Firestore products listener
    if (invoicesListener) invoicesListener(); // detach Firestore invoices listener
    firebase.auth().signOut().then(function () {
      window.location.href = 'customer-login.html';
    });
  }
});

// ============================================================
// NAVIGATION
// ============================================================
document.querySelectorAll('.nav-item').forEach(function (link) {
  link.addEventListener('click', function (e) {
    e.preventDefault();
    showCustomerSection(this.dataset.section);
  });
});

function showCustomerSection(name) {
  document.querySelectorAll('.section').forEach(function (s) { s.classList.remove('active'); });
  document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
  var section = document.getElementById('section-' + name);
  var navLink  = document.querySelector('[data-section="' + name + '"]');
  if (section) section.classList.add('active');
  if (navLink)  navLink.classList.add('active');
  closeMobileSidebar();
}

document.getElementById('menuToggle').addEventListener('click', function () {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('overlay').classList.add('active');
});
document.getElementById('overlay').addEventListener('click', closeMobileSidebar);
function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
}

// ============================================================
// INIT – called once auth + profile are confirmed
// user = the live Firebase Auth user object
// ============================================================
function initCustomerApp(user) {
  generateOrderNumber();
  fillProfileForm();

  // Pre-fill order form with saved defaults
  if (currentCustomer.phone)   document.getElementById('orderPhone').value      = currentCustomer.phone;
  if (currentCustomer.address) document.getElementById('deliveryAddress').value = currentCustomer.address;

  // Start real-time listeners
  loadFuelProducts();
  loadMyOrders(user.uid);
  loadMyInvoices(user.uid);
}

// ============================================================
// ORDER NUMBER  ORD-YYMM-XXXX
// ============================================================
function generateOrderNumber() {
  var now  = new Date();
  var yy   = now.getFullYear().toString().slice(-2);
  var mm   = String(now.getMonth() + 1).padStart(2, '0');
  var rand = Math.floor(Math.random() * 9000) + 1000;
  document.getElementById('orderNumber').value = 'ORD-' + yy + mm + '-' + rand;
}

// ============================================================
// PLACE ORDER
// Field names saved to Firestore:
//   userId, customerEmail, customerName,
//   fuelType, quantity, fuelUnit,
//   phone, address, notes,
//   status, orderNumber, createdAt
// ============================================================
document.getElementById('orderForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  var orderNumber  = document.getElementById('orderNumber').value;
  var fuelType     = document.getElementById('fuelType').value;
  var fuelUnit     = document.getElementById('fuelUnit').value;
  var qty          = parseFloat(document.getElementById('orderQty').value);
  var phone        = document.getElementById('orderPhone').value.trim();
  var address      = document.getElementById('deliveryAddress').value.trim();
  var notes        = document.getElementById('orderNotes').value.trim();
  var pricePerUnit = parseFloat(document.getElementById('pricePerUnit').dataset.rawPrice) || 0;
  var totalAmount  = pricePerUnit > 0 ? qty * pricePerUnit : null;
  var errorDiv     = document.getElementById('orderError');

  if (!fuelType || !qty || qty <= 0 || !phone || !address) {
    errorDiv.textContent   = 'Please fill in all required fields: fuel type, quantity, phone, and delivery address.';
    errorDiv.style.display = 'block';
    return;
  }

  // Fast pre-check from local cache before touching Firestore
  var orderedProduct = allFuelProducts.find(function (p) { return p.name === fuelType; });
  if (orderedProduct) {
    var cachedStock = Number(orderedProduct.quantity) || 0;
    if (qty > cachedStock) {
      errorDiv.textContent = cachedStock <= 0
        ? fuelType + ' is currently out of stock.'
        : 'Insufficient stock. Only ' + cachedStock + ' ' + (orderedProduct.unit || 'units') + ' of ' + fuelType + ' available.';
      errorDiv.style.display = 'block';
      return;
    }
  }

  errorDiv.style.display = 'none';

  var btn = document.getElementById('submitOrderBtn');
  btn.textContent = 'Submitting…';
  btn.disabled    = true;

  // Guard: currentCustomer must be loaded before submitting
  if (!currentCustomer || !currentCustomer.uid) {
    errorDiv.textContent   = 'Session error – please refresh the page and try again.';
    errorDiv.style.display = 'block';
    btn.textContent = '\u{1F6D2} Submit Order';
    btn.disabled    = false;
    return;
  }

  var orderData = {
    orderNumber:   orderNumber,
    userId:        currentCustomer.uid,
    customerEmail: currentCustomer.email,
    customerName:  currentCustomer.name,
    fuelType:      fuelType,
    quantity:      qty,
    fuelUnit:      fuelUnit,
    phone:         phone,
    address:       address,
    notes:         notes,
    pricePerUnit:  pricePerUnit || null,
    totalAmount:   totalAmount,
    status:        'Pending',
    createdAt:     firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    // ── 1. Save the order ─────────────────────────────────────────
    var docRef = await db.collection('orders').add(orderData);
    console.log('[Order] Saved. ID:', docRef.id, '| fuelType:', fuelType, '| qty:', qty);

    // ── 2. Deduct stock from inventory ────────────────────────────
    // Uses the document ID already held in allFuelProducts (populated
    // by onSnapshot — proven to work because products show in the UI).
    // A direct doc().get() + doc().update() is used instead of a
    // where() query because collection queries can return stale/empty
    // results on first call in the compat SDK.
    try {
      var cachedProd = allFuelProducts.find(function (p) { return p.name === fuelType; });

      console.log('[Inventory] Cache lookup:',
        cachedProd
          ? 'FOUND id=' + cachedProd.id + ' qty=' + cachedProd.quantity
          : 'NOT FOUND',
        '| cache size:', allFuelProducts.length,
        '| searched name:', JSON.stringify(fuelType));

      if (cachedProd && cachedProd.id) {
        // Fresh read from Firestore so we have the authoritative qty
        var liveDoc  = await db.collection('products').doc(cachedProd.id).get();
        var liveQty  = Number(liveDoc.data().quantity);
        var ordered  = Number(qty);
        var newStock = Math.max(0, liveQty - ordered);

        console.log('[Inventory] Live qty from Firestore:', liveQty,
                    '| ordered:', ordered, '| new stock:', newStock);

        await db.collection('products').doc(cachedProd.id).update({
          quantity:  newStock,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });

        console.log('[Inventory] ✓ quantity written to Firestore:', newStock,
                    '| doc id:', cachedProd.id);
        showToast('Stock updated: ' + fuelType + ' ' + liveQty + ' → ' + newStock + ' ' + (cachedProd.unit || 'units'), 'info');
      } else {
        console.warn('[Inventory] Product not in cache. Names available:',
          allFuelProducts.map(function (p) { return JSON.stringify(p.name); }).join(', '));
      }
    } catch (stockErr) {
      console.error('[Inventory] ✗ Stock update failed:', stockErr.code, stockErr.message);
      showToast('Warning: stock count could not be updated (' + (stockErr.code || stockErr.message) + ')', 'error');
    }

    // ── 3. Create invoice ─────────────────────────────────────────
    var invNumber = generateInvoiceNumber();
    await createOrderInvoice(docRef.id, orderData, invNumber);
    showToast('Order submitted! Invoice ' + invNumber + ' generated — check My Invoices.', 'success');
    resetOrderForm();
    showCustomerSection('my-invoices');
  } catch (err) {
    console.error('[Order] FAILED:', err.code, err.message);
    errorDiv.textContent   = 'Failed to submit order: ' + (err.message || 'unknown error') + '. Please try again.';
    errorDiv.style.display = 'block';
  } finally {
    btn.textContent = '&#128722; Submit Order';
    btn.disabled    = false;
  }
});

function resetOrderForm() {
  document.getElementById('orderForm').reset();
  generateOrderNumber();
  document.getElementById('orderError').style.display = 'none';
  // Clear price / total fields
  var priceFld = document.getElementById('pricePerUnit');
  priceFld.value = '';
  priceFld.dataset.rawPrice = '';
  document.getElementById('estimatedTotalBox').style.display = 'none';
  // Re-render cards to clear the selected highlight
  renderFuelProductCards();
  if (currentCustomer) {
    if (currentCustomer.phone)   document.getElementById('orderPhone').value      = currentCustomer.phone;
    if (currentCustomer.address) document.getElementById('deliveryAddress').value = currentCustomer.address;
  }
}

// ============================================================
// LOAD MY ORDERS
// uid is passed directly from the auth callback – never read
// from firebase.auth().currentUser to avoid race conditions.
//
// Query uses ONLY .where() – no .orderBy() on a different field,
// which would require a Firestore composite index.
// Sorting is done in JavaScript after the snapshot arrives.
// ============================================================
function loadMyOrders(uid) {
  console.log('[Orders] Starting real-time listener for uid:', uid);

  // Show loading state
  document.getElementById('myOrdersTable').innerHTML =
    '<tr><td colspan="7" class="empty-row">Loading your orders…</td></tr>';

  // Detach any previous listener to avoid duplicates on re-auth
  if (ordersListener) {
    ordersListener();
    ordersListener = null;
  }

  ordersListener = db.collection('orders')
    .where('userId', '==', uid)
    .onSnapshot(
      function (snap) {
        console.log('[Orders] Snapshot received. Documents count:', snap.size);

        var orders = snap.docs.map(function (d) {
          var data = d.data();
          console.log('[Orders] doc id:', d.id, '| userId:', data.userId, '| status:', data.status);
          return { id: d.id, ...data };
        });

        // Sort newest first in JavaScript (no Firestore composite index needed)
        orders.sort(function (a, b) {
          var aMs = a.createdAt ? a.createdAt.toMillis() : 0;
          var bMs = b.createdAt ? b.createdAt.toMillis() : 0;
          return bMs - aMs;
        });

        renderMyOrders(orders);
        updateMyOrderStats(orders);
      },
      function (err) {
        // This fires if Firestore security rules block the read
        console.error('[Orders] Listener error:', err.code, err.message);
        showOrdersError(
          'Could not load orders (' + err.code + '). ' +
          'Please check your internet connection or contact support.'
        );
      }
    );
}

// ============================================================
// RENDER ORDERS TABLE
// ============================================================
function renderMyOrders(orders) {
  var tbody = document.getElementById('myOrdersTable');

  if (orders.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="empty-row">' +
      'No orders found. Click “Place Order” to get started!' +
      '</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map(function (order) {
    var date = order.createdAt
      ? order.createdAt.toDate().toLocaleDateString('en-NG', { day:'2-digit', month:'short', year:'numeric' })
      : '–';

    return '<tr>' +
      '<td><strong>' + safeText(order.orderNumber) + '</strong></td>' +
      '<td>' + safeText(order.fuelType)            + '</td>' +
      '<td>' + safeText(String(order.quantity || '–')) + ' ' + safeText(order.fuelUnit || '') + '</td>' +
      '<td>' + safeText(order.phone)               + '</td>' +
      '<td>' + safeText(order.address)             + '</td>' +
      '<td>' + orderStatusBadge(order.status)      + '</td>' +
      '<td>' + date                                + '</td>' +
    '</tr>';
  }).join('');
}

// ============================================================
// DASHBOARD COUNTERS
// ============================================================
function updateMyOrderStats(orders) {
  document.getElementById('myTotalOrders').textContent     = orders.length;
  document.getElementById('myPendingOrders').textContent   = orders.filter(function (o) { return o.status === 'Pending';   }).length;
  document.getElementById('myApprovedOrders').textContent  = orders.filter(function (o) { return o.status === 'Approved';  }).length;
  document.getElementById('myDeliveredOrders').textContent = orders.filter(function (o) { return o.status === 'Delivered'; }).length;
}

// ============================================================
// PROFILE
// ============================================================
function fillProfileForm() {
  document.getElementById('profileName').value    = currentCustomer.name    || '';
  document.getElementById('profileEmail').value   = currentCustomer.email   || '';
  document.getElementById('profilePhone').value   = currentCustomer.phone   || '';
  document.getElementById('profileAddress').value = currentCustomer.address || '';
}

document.getElementById('profileForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  var name    = document.getElementById('profileName').value.trim();
  var phone   = document.getElementById('profilePhone').value.trim();
  var address = document.getElementById('profileAddress').value.trim();
  var msgDiv  = document.getElementById('profileMessage');

  var btn = document.getElementById('saveProfileBtn');
  btn.textContent = 'Saving…';
  btn.disabled    = true;

  try {
    await db.collection('customers').doc(currentCustomer.uid).update({ name, phone, address });
    currentCustomer.name    = name;
    currentCustomer.phone   = phone;
    currentCustomer.address = address;
    document.getElementById('userEmail').textContent = name;
    showMessage(msgDiv, 'Profile updated successfully!', 'success');
    setTimeout(function () { msgDiv.style.display = 'none'; }, 3000);
  } catch (err) {
    console.error('[Profile] Update error:', err);
    showMessage(msgDiv, 'Failed to update profile. Please try again.', 'error');
  } finally {
    btn.textContent = 'Save Changes';
    btn.disabled    = false;
  }
});

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function safeText(str) {
  if (str === null || str === undefined || str === '') return '–';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function orderStatusBadge(status) {
  var map = {
    'Pending':   '<span class="order-badge badge-pending">&#8987; Pending</span>',
    'Approved':  '<span class="order-badge badge-approved">&#10003; Approved</span>',
    'Delivered': '<span class="order-badge badge-delivered">&#128666; Delivered</span>',
  };
  return map[status] || '<span class="order-badge badge-pending">' + safeText(status) + '</span>';
}

function showOrdersError(message) {
  document.getElementById('myOrdersTable').innerHTML =
    '<tr><td colspan="7" class="empty-row" style="color:#c62828;">' + safeText(message) + '</td></tr>';
  updateMyOrderStats([]);
}

function showMessage(div, text, type) {
  div.textContent = text;
  if (type === 'success') {
    div.style.cssText = 'display:block;background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;padding:10px 14px;border-radius:8px;font-size:0.875rem;margin-bottom:12px;';
  } else {
    div.style.cssText = 'display:block;background:#ffebee;color:#c62828;border:1px solid #ef9a9a;padding:10px 14px;border-radius:8px;font-size:0.875rem;margin-bottom:12px;';
  }
}

// ============================================================
// FUEL PRODUCTS – live cards from Firestore products collection
// ============================================================
function loadFuelProducts() {
  if (productsListener) { productsListener(); productsListener = null; }

  productsListener = db.collection('products')
    .onSnapshot(function (snap) {
      allFuelProducts = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      renderFuelProductCards();
      updateFuelDropdown();
    }, function (err) {
      console.error('[Products] Listener error:', err.code, err.message);
      document.getElementById('fuelProductsGrid').innerHTML =
        '<p style="color:var(--danger-bg);padding:8px 0;">Could not load fuel products. Please refresh.</p>';
    });
}

function getStockStatus(product) {
  var qty       = Number(product.quantity)          || 0;
  var threshold = Number(product.lowStockThreshold) || 10;
  if (qty <= 0)         return 'outofstock';
  if (qty <= threshold) return 'low';
  return 'instock';
}

function fuelIcon(name) {
  var n = (name || '').toLowerCase();
  if (n.includes('diesel'))                           return '\u{1F6E2}️';
  if (n.includes('petrol') || n.includes('pms'))      return '⛽';
  if (n.includes('gas')    || n.includes('lpg'))      return '🔥';
  if (n.includes('kerosene') || n.includes('dpk'))    return '💧';
  return '⚡';
}

function renderFuelProductCards() {
  var grid = document.getElementById('fuelProductsGrid');
  if (!grid) return;

  if (allFuelProducts.length === 0) {
    grid.innerHTML = '<p style="color:var(--text-muted);padding:8px 0;">No fuel products are listed yet. Please check back soon.</p>';
    document.getElementById('stockWarningBanner').style.display = 'none';
    return;
  }

  var hasLow = allFuelProducts.some(function (p) { return getStockStatus(p) === 'low'; });
  document.getElementById('stockWarningBanner').style.display = hasLow ? 'flex' : 'none';

  var selectedType = document.getElementById('fuelType').value;

  grid.innerHTML = allFuelProducts.map(function (product) {
    var status     = getStockStatus(product);
    var isOut      = status === 'outofstock';
    var badgeClass = { instock: 'stock-badge-instock', low: 'stock-badge-low', outofstock: 'stock-badge-outofstock' }[status];
    var badgeLabel = { instock: '✓ In Stock', low: '⚠ Low Stock', outofstock: '✕ Out of Stock' }[status];
    var isSelected = !isOut && selectedType === product.name;
    var cardClass  = 'fuel-card' + (isSelected ? ' fuel-card-selected' : '') + (isOut ? ' fuel-card-disabled' : '');
    var unit       = safeText(product.unit || 'Litre');
    var clickAttr  = isOut ? '' : 'onclick="selectFuel(\'' + product.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\')"';

    return '<div class="' + cardClass + '" ' + clickAttr + '>' +
      '<div class="fuel-card-icon">'  + fuelIcon(product.name)                + '</div>' +
      '<div class="fuel-card-name">'  + safeText(product.name)                + '</div>' +
      '<div class="fuel-card-price">₦' + fmt(product.price) +
        '<small style="font-weight:400;font-size:0.72rem;color:var(--text-muted);">/' + unit + '</small>' +
      '</div>' +
      '<div class="fuel-card-stock">Stock: ' + safeText(String(Number(product.quantity) || 0)) + ' ' + unit + '</div>' +
      '<span class="stock-badge ' + badgeClass + '">' + badgeLabel + '</span>' +
      '</div>';
  }).join('');
}

function updateFuelDropdown() {
  var select  = document.getElementById('fuelType');
  var current = select.value;

  select.innerHTML = '<option value="">-- Select Fuel Type --</option>';
  allFuelProducts.forEach(function (product) {
    if (getStockStatus(product) === 'outofstock') return;
    var opt = document.createElement('option');
    opt.value       = product.name;
    opt.textContent = product.name + (getStockStatus(product) === 'low' ? ' (Low Stock)' : '');
    if (product.name === current) opt.selected = true;
    select.appendChild(opt);
  });

  // If the previously selected fuel is no longer available, clear price/total
  if (current && select.value !== current) {
    document.getElementById('pricePerUnit').value           = '';
    document.getElementById('pricePerUnit').dataset.rawPrice = '';
    document.getElementById('estimatedTotalBox').style.display = 'none';
  }
}

function selectFuel(name) {
  var select = document.getElementById('fuelType');
  select.value = name;
  onFuelTypeChange();
}

function onFuelTypeChange() {
  var name    = document.getElementById('fuelType').value;
  var product = allFuelProducts.find(function (p) { return p.name === name; });
  var priceFld = document.getElementById('pricePerUnit');

  if (product && product.price != null) {
    var unit = product.unit || 'Litre';
    priceFld.value                = '₦' + fmt(product.price) + ' / ' + unit;
    priceFld.dataset.rawPrice     = product.price;

    // Sync the unit dropdown if possible
    var unitSel = document.getElementById('fuelUnit');
    var unitLow = unit.toLowerCase();
    for (var i = 0; i < unitSel.options.length; i++) {
      if (unitSel.options[i].value.toLowerCase().startsWith(unitLow.split(' ')[0])) {
        unitSel.selectedIndex = i;
        break;
      }
    }
  } else {
    priceFld.value                = '';
    priceFld.dataset.rawPrice     = '';
  }

  calculateTotal();
  renderFuelProductCards(); // update selected card highlight
}

function calculateTotal() {
  var qty      = parseFloat(document.getElementById('orderQty').value) || 0;
  var rawPrice = parseFloat(document.getElementById('pricePerUnit').dataset.rawPrice) || 0;
  var totalBox = document.getElementById('estimatedTotalBox');
  var totalAmt = document.getElementById('estimatedTotalAmount');

  if (qty > 0 && rawPrice > 0) {
    totalAmt.textContent   = '₦' + fmt(qty * rawPrice);
    totalBox.style.display = 'flex';
  } else {
    totalBox.style.display = 'none';
  }

  checkQtyStock();
}

function checkQtyStock() {
  var fuelType = document.getElementById('fuelType').value;
  var qty      = parseFloat(document.getElementById('orderQty').value) || 0;
  var errorDiv = document.getElementById('orderError');

  if (!fuelType || qty <= 0) {
    if (errorDiv.dataset.stockWarn === '1') {
      errorDiv.style.display     = 'none';
      errorDiv.dataset.stockWarn = '0';
    }
    return;
  }

  var product   = allFuelProducts.find(function (p) { return p.name === fuelType; });
  if (!product) return;

  var available = Number(product.quantity) || 0;
  if (qty > available) {
    errorDiv.textContent = available <= 0
      ? fuelType + ' is currently out of stock.'
      : 'Only ' + available + ' ' + (product.unit || 'units') + ' of ' + fuelType + ' available.';
    errorDiv.style.display     = 'block';
    errorDiv.dataset.stockWarn = '1';
  } else if (errorDiv.dataset.stockWarn === '1') {
    errorDiv.style.display     = 'none';
    errorDiv.dataset.stockWarn = '0';
  }
}

function fmt(num) {
  return (parseFloat(num) || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================
// INVOICE WORKFLOW – customer portal
// ============================================================

// 1. Generate a unique invoice number: INV-YYMM-XXXX
function generateInvoiceNumber() {
  var now  = new Date();
  var yy   = now.getFullYear().toString().slice(-2);
  var mm   = String(now.getMonth() + 1).padStart(2, '0');
  var rand = Math.floor(Math.random() * 9000) + 1000;
  return 'INV-' + yy + mm + '-' + rand;
}

// 2. Create an invoice document in Firestore for a placed order
async function createOrderInvoice(orderId, orderData, invoiceNumber) {
  var invoiceData = {
    invoiceNumber:   invoiceNumber,
    orderId:         orderId,
    orderNumber:     orderData.orderNumber,
    userId:          orderData.userId,
    customerEmail:   orderData.customerEmail,
    customerName:    orderData.customerName,
    fuelType:        orderData.fuelType,
    fuelUnit:        orderData.fuelUnit,
    quantity:        orderData.quantity,
    pricePerUnit:    orderData.pricePerUnit || null,
    totalAmount:     orderData.totalAmount  || null,
    deliveryAddress: orderData.address,
    phone:           orderData.phone,
    notes:           orderData.notes || '',
    paymentStatus:   'Awaiting Payment',
    createdAt:       firebase.firestore.FieldValue.serverTimestamp(),
  };
  var docRef = await db.collection('invoices').add(invoiceData);
  return docRef;
}

// 3. Load invoices for the logged-in customer in real time
function loadMyInvoices(uid) {
  console.log('[Invoices] Starting real-time listener for uid:', uid);

  document.getElementById('myInvoicesTable').innerHTML =
    '<tr><td colspan="7" class="empty-row">Loading your invoices&hellip;</td></tr>';

  if (invoicesListener) {
    invoicesListener();
    invoicesListener = null;
  }

  invoicesListener = db.collection('invoices')
    .where('userId', '==', uid)
    .onSnapshot(
      function (snap) {
        allMyInvoices = snap.docs.map(function (d) {
          return Object.assign({ id: d.id }, d.data());
        });

        // Sort newest first in JS (no composite index needed)
        allMyInvoices.sort(function (a, b) {
          var aMs = a.createdAt ? a.createdAt.toMillis() : 0;
          var bMs = b.createdAt ? b.createdAt.toMillis() : 0;
          return bMs - aMs;
        });

        renderMyInvoices();
        updateMyInvoiceStats(allMyInvoices);
      },
      function (err) {
        console.error('[Invoices] Listener error:', err.code, err.message);
        document.getElementById('myInvoicesTable').innerHTML =
          '<tr><td colspan="7" class="empty-row" style="color:#c62828;">' +
          'Could not load invoices (' + safeText(err.code) + '). Please refresh the page.' +
          '</td></tr>';
        updateMyInvoiceStats([]);
      }
    );
}

// 4. Update the four invoice stat cards
function updateMyInvoiceStats(list) {
  document.getElementById('myInvTotal').textContent     = list.length;
  document.getElementById('myInvAwaiting').textContent  = list.filter(function (i) { return i.paymentStatus === 'Awaiting Payment';  }).length;
  document.getElementById('myInvSubmitted').textContent = list.filter(function (i) { return i.paymentStatus === 'Receipt Submitted'; }).length;
  document.getElementById('myInvPaid').textContent      = list.filter(function (i) { return i.paymentStatus === 'Payment Confirmed'; }).length;
}

// 5. Render the My Invoices table
function renderMyInvoices() {
  var tbody = document.getElementById('myInvoicesTable');

  if (allMyInvoices.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="empty-row">No invoices yet. Place an order to get started!</td></tr>';
    return;
  }

  tbody.innerHTML = allMyInvoices.map(function (inv) {
    var date = inv.createdAt
      ? inv.createdAt.toDate().toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' })
      : '–';

    return '<tr>' +
      '<td><strong>' + safeText(inv.invoiceNumber) + '</strong></td>' +
      '<td>' + safeText(inv.fuelType) + '</td>' +
      '<td>' + safeText(String(inv.quantity || '–')) + ' ' + safeText(inv.fuelUnit || '') + '</td>' +
      '<td class="amount">&#8358;' + fmt(inv.totalAmount) + '</td>' +
      '<td>' + date + '</td>' +
      '<td>' + paymentStatusBadge(inv.paymentStatus) + '</td>' +
      '<td><button class="btn-sm btn-view" onclick="openInvoiceModal(\'' + inv.id + '\')">View Invoice</button></td>' +
    '</tr>';
  }).join('');
}

// 6. Open the invoice view modal
function openInvoiceModal(id) {
  var inv = allMyInvoices.find(function (i) { return i.id === id; });
  if (!inv) return;
  currentViewInvoice = inv;
  document.getElementById('invoiceModalContent').innerHTML = buildInvoiceViewHTML(inv);
  document.getElementById('customerInvoiceModal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

// 7. Close the invoice view modal
function closeInvoiceModal() {
  document.getElementById('customerInvoiceModal').classList.remove('active');
  document.body.style.overflow = '';
  currentViewInvoice = null;
}

// 8. Return a coloured payment status badge HTML string
function paymentStatusBadge(status) {
  if (status === 'Awaiting Payment')  return '<span class="payment-badge payment-awaiting">&#8987; Awaiting Payment</span>';
  if (status === 'Receipt Submitted') return '<span class="payment-badge payment-submitted">&#128179; Receipt Submitted</span>';
  if (status === 'Payment Confirmed') return '<span class="payment-badge payment-paid">&#10003; Payment Confirmed</span>';
  if (status === 'Payment Rejected')  return '<span class="payment-badge payment-rejected">&#10005; Payment Rejected</span>';
  return '<span class="payment-badge payment-awaiting">' + safeText(status || 'Awaiting Payment') + '</span>';
}

// 9. Build the full invoice view HTML string
function buildInvoiceViewHTML(inv) {
  var isConfirmed   = inv.paymentStatus === 'Payment Confirmed';
  var isReceiptSent = inv.paymentStatus === 'Receipt Submitted';
  var isRejected    = inv.paymentStatus === 'Payment Rejected';

  var todayStr = new Date().toISOString().split('T')[0];

  var date = inv.createdAt
    ? inv.createdAt.toDate().toLocaleDateString('en-NG', { day: '2-digit', month: 'long', year: 'numeric' })
    : '–';

  var confirmedBanner = isConfirmed
    ? '<div style="background:#e8f5e9;border:1.5px solid #a5d6a7;border-radius:10px;padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:14px;">' +
        '<span style="font-size:2rem;">&#9989;</span>' +
        '<div>' +
          '<div style="font-weight:700;color:#2e7d32;font-size:1rem;">Payment Confirmed</div>' +
          '<div style="color:#388e3c;font-size:0.82rem;margin-top:3px;">Your payment has been verified by Sage Energy. Thank you for your business!</div>' +
        '</div>' +
      '</div>'
    : '';

  var rejectedBanner = isRejected
    ? '<div style="background:#ffebee;border:1.5px solid #ef9a9a;border-radius:8px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px;">' +
        '<span style="font-size:1.4rem;">&#10005;</span>' +
        '<div>' +
          '<div style="font-weight:700;color:#c62828;font-size:0.875rem;">Payment Rejected</div>' +
          '<div style="color:#b71c1c;font-size:0.8rem;margin-top:2px;">Your payment details could not be verified. Please resubmit with correct information.</div>' +
        '</div>' +
      '</div>'
    : '';

  var receiptSentBanner = isReceiptSent
    ? '<div style="background:#e3f2fd;border:1.5px solid #90caf9;border-radius:8px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px;">' +
        '<span style="font-size:1.4rem;">&#128179;</span>' +
        '<div>' +
          '<div style="font-weight:700;color:#1565c0;font-size:0.875rem;">Payment Submitted</div>' +
          '<div style="color:#1976d2;font-size:0.8rem;margin-top:2px;">Your payment details are under review. We will notify you once confirmed.</div>' +
        '</div>' +
      '</div>'
    : '';

  var paymentInfoBox = !isConfirmed
    ? '<div class="payment-info-box">' +
        '<p class="payment-info-title">&#127970; Payment Details &mdash; Bank Transfer</p>' +
        '<div class="payment-info-row">' +
          '<span class="payment-info-label">Account Name</span>' +
          '<span class="payment-info-value">' + safeText(COMPANY_PAYMENT.accountName) + '</span>' +
        '</div>' +
        '<div class="payment-info-row">' +
          '<span class="payment-info-label">Bank Name</span>' +
          '<span class="payment-info-value">' + safeText(COMPANY_PAYMENT.bankName) + '</span>' +
        '</div>' +
        '<div class="payment-info-row">' +
          '<span class="payment-info-label">Account Number</span>' +
          '<span class="payment-info-value">' +
            safeText(COMPANY_PAYMENT.accountNo) +
            '&nbsp;<button class="copy-acct-btn" id="copyAcctBtn" onclick="copyAccountNumber()">Copy</button>' +
          '</span>' +
        '</div>' +
        '<div class="payment-info-row">' +
          '<span class="payment-info-label">Company Phone</span>' +
          '<span class="payment-info-value">' + safeText(COMPANY_PAYMENT.phone) + '</span>' +
        '</div>' +
      '</div>'
    : '';

  var submitBtnLabel = isRejected ? '&#8635; Resubmit Payment Details' : '&#10003; Submit Payment Details';

  var whatsappSection = !isConfirmed
    ? '<div class="payment-confirm-section">' +
        '<h4>&#128179; ' + (isRejected ? 'Resubmit Payment Details' : 'Confirm Your Payment') + '</h4>' +
        rejectedBanner +
        receiptSentBanner +
        '<p style="font-size:0.875rem;color:var(--text-muted);margin-bottom:16px;line-height:1.65;">' +
          'After transferring payment to the account above, fill in your payment details below. ' +
          'Admin will confirm once verified.' +
        '</p>' +
        '<div style="margin-bottom:12px;">' +
          '<label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:5px;">Sender Name *</label>' +
          '<input type="text" id="payFormSenderName" placeholder="Name on your bank account" ' +
                 'style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:0.875rem;box-sizing:border-box;" />' +
        '</div>' +
        '<div style="margin-bottom:12px;">' +
          '<label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:5px;">Your Bank Name *</label>' +
          '<input type="text" id="payFormBankName" placeholder="e.g. First Bank, Opay, GTBank" ' +
                 'style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:0.875rem;box-sizing:border-box;" />' +
        '</div>' +
        '<div style="margin-bottom:12px;">' +
          '<label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:5px;">Amount Paid (&#8358;) *</label>' +
          '<input type="number" id="payFormAmount" placeholder="0.00" min="0" step="0.01" ' +
                 'style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:0.875rem;box-sizing:border-box;" />' +
        '</div>' +
        '<div style="margin-bottom:12px;">' +
          '<label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:5px;">Transaction Reference *</label>' +
          '<input type="text" id="payFormReference" placeholder="From your bank alert or SMS" ' +
                 'style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:0.875rem;box-sizing:border-box;" />' +
        '</div>' +
        '<div style="margin-bottom:16px;">' +
          '<label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:5px;">Payment Date *</label>' +
          '<input type="date" id="payFormDate" value="' + todayStr + '" max="' + todayStr + '" ' +
                 'style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:0.875rem;box-sizing:border-box;" />' +
        '</div>' +
        '<div id="payFormMsg" style="display:none;margin-bottom:12px;padding:10px 14px;border-radius:8px;font-size:0.875rem;"></div>' +
        '<button class="btn-primary" id="payFormSubmitBtn" onclick="submitPaymentForm()" ' +
                'style="width:100%;padding:12px;font-size:0.95rem;">' + submitBtnLabel + '</button>' +
        '<p style="font-size:0.78rem;color:var(--text-muted);margin-top:12px;text-align:center;line-height:1.55;">' +
          '&#128204; <em>You can also send your receipt on ' +
          '<a href="#" onclick="sendReceiptWhatsApp();return false;" ' +
             'style="color:#25d366;font-weight:700;text-decoration:none;">WhatsApp</a>.</em>' +
        '</p>' +
      '</div>'
    : '';

  return '<div class="inv-view">' +
    // Header
    '<div class="inv-view-header">' +
      '<div class="inv-view-brand">' +
        '<img src="assets/images/logo.png" alt="Sage Energies" style="height:48px;max-width:200px;object-fit:contain;display:block;margin-bottom:6px;" />' +
        '<p>and Natural Resources Ltd</p>' +
        '<p>Benin City, Edo State, Nigeria</p>' +
        '<p>' + safeText(COMPANY_PAYMENT.phone) + '</p>' +
      '</div>' +
      '<div class="inv-view-meta">' +
        '<div class="inv-number">' + safeText(inv.invoiceNumber) + '</div>' +
        '<div class="inv-date">Date: ' + date + '</div>' +
        '<div class="inv-date">Order #: ' + safeText(inv.orderNumber || '–') + '</div>' +
        '<div style="margin-top:6px;">' + paymentStatusBadge(inv.paymentStatus) + '</div>' +
      '</div>' +
    '</div>' +
    // Parties
    '<div class="inv-view-parties">' +
      '<div class="inv-party-block">' +
        '<h4>Billed To</h4>' +
        '<p><strong>' + safeText(inv.customerName) + '</strong></p>' +
        '<p>' + safeText(inv.customerEmail || '–') + '</p>' +
        '<p>' + safeText(inv.phone         || '–') + '</p>' +
        '<p>' + safeText(inv.deliveryAddress || '–') + '</p>' +
      '</div>' +
      '<div class="inv-party-block">' +
        '<h4>From</h4>' +
        '<p><strong>' + safeText(COMPANY_PAYMENT.companyName) + '</strong></p>' +
        '<p>' + safeText(COMPANY_PAYMENT.bankName) + '</p>' +
        '<p>' + safeText(COMPANY_PAYMENT.phone) + '</p>' +
      '</div>' +
    '</div>' +
    // Items table
    '<table class="inv-items-table">' +
      '<thead><tr>' +
        '<th>Fuel Type</th>' +
        '<th>Unit</th>' +
        '<th>Quantity</th>' +
        '<th>Price / Unit</th>' +
        '<th>Total</th>' +
      '</tr></thead>' +
      '<tbody><tr>' +
        '<td>' + safeText(inv.fuelType)  + '</td>' +
        '<td>' + safeText(inv.fuelUnit)  + '</td>' +
        '<td>' + safeText(String(inv.quantity || '–')) + '</td>' +
        '<td>&#8358;' + fmt(inv.pricePerUnit) + '</td>' +
        '<td><strong>&#8358;' + fmt(inv.totalAmount) + '</strong></td>' +
      '</tr></tbody>' +
    '</table>' +
    // Total box
    '<div class="inv-total-row">' +
      '<div class="inv-total-box">' +
        '<div class="inv-total-label">TOTAL AMOUNT DUE</div>' +
        '<div class="inv-total-amount">&#8358;' + fmt(inv.totalAmount) + '</div>' +
      '</div>' +
    '</div>' +
    // Payment confirmed banner or bank details
    confirmedBanner +
    paymentInfoBox +
    // WhatsApp receipt section
    whatsappSection +
    (inv.notes ? '<p style="font-size:0.82rem;color:var(--text-muted);margin-top:16px;font-style:italic;">Notes: ' + safeText(inv.notes) + '</p>' : '') +
    '</div>';
}

// 10. Copy account number to clipboard
function copyAccountNumber() {
  var acct = COMPANY_PAYMENT.accountNo;
  var btn  = document.getElementById('copyAcctBtn');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(acct).then(function () {
      if (btn) { btn.textContent = '&#10003; Copied!'; btn.style.background = '#2e7d32'; }
      setTimeout(function () {
        if (btn) { btn.textContent = 'Copy'; btn.style.background = ''; }
      }, 2500);
    }).catch(function () {
      fallbackCopy(acct);
    });
  } else {
    fallbackCopy(acct);
    if (btn) { btn.textContent = '&#10003; Copied!'; btn.style.background = '#2e7d32'; }
    setTimeout(function () {
      if (btn) { btn.textContent = 'Copy'; btn.style.background = ''; }
    }, 2500);
  }
}

// 11. Open WhatsApp with a prefilled payment receipt message
// Also sets invoice status to "Receipt Submitted" on first send
function sendReceiptWhatsApp() {
  if (!currentViewInvoice) return;
  var inv    = currentViewInvoice;
  var amount = (inv.totalAmount && inv.totalAmount > 0)
    ? '₦' + fmt(inv.totalAmount)
    : 'as quoted';

  var message =
    'Hello Sage Energy,\n\n' +
    'I have made payment for my fuel order and I am attaching my receipt.\n\n' +
    'Invoice Number: ' + (inv.invoiceNumber || '–') + '\n' +
    'Customer Name:  ' + (inv.customerName  || '–') + '\n' +
    'Amount:         ' + amount             + '\n\n' +
    'Kindly confirm receipt of payment. Thank you.';

  var url = 'https://wa.me/2348154114232?text=' + encodeURIComponent(message);

  // Mark invoice as "Receipt Submitted" the first time the button is clicked
  if (inv.paymentStatus === 'Awaiting Payment') {
    db.collection('invoices').doc(inv.id).update({
      paymentStatus: 'Receipt Submitted',
      receiptSentAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).then(function () {
      console.log('[WhatsApp] Invoice status → Receipt Submitted');
    }).catch(function (err) {
      console.error('[WhatsApp] Status update failed:', err.code, err.message);
    });
  }

  window.open(url, '_blank');
}

// 12. Submit payment details to Firestore payments collection
async function submitPaymentForm() {
  if (!currentViewInvoice) return;
  var inv = currentViewInvoice;

  var senderNameEl = document.getElementById('payFormSenderName');
  var bankNameEl   = document.getElementById('payFormBankName');
  var amountEl     = document.getElementById('payFormAmount');
  var referenceEl  = document.getElementById('payFormReference');
  var dateEl       = document.getElementById('payFormDate');
  var msgDiv       = document.getElementById('payFormMsg');
  var btn          = document.getElementById('payFormSubmitBtn');

  if (!senderNameEl || !bankNameEl || !amountEl || !referenceEl || !btn) return;

  var senderName  = senderNameEl.value.trim();
  var bankName    = bankNameEl.value.trim();
  var amountPaid  = parseFloat(amountEl.value) || 0;
  var reference   = referenceEl.value.trim();
  var paymentDate = dateEl ? dateEl.value : '';

  if (!senderName || !bankName || !reference || !paymentDate || amountPaid <= 0) {
    msgDiv.textContent = 'Please fill in all required fields including the payment date.';
    msgDiv.style.cssText = 'display:block;background:#ffebee;color:#c62828;border:1px solid #ef9a9a;padding:10px 14px;border-radius:8px;font-size:0.875rem;margin-bottom:12px;';
    return;
  }

  btn.textContent = 'Submitting…';
  btn.disabled    = true;
  msgDiv.style.display = 'none';

  var success = false;

  try {
    await db.collection('payments').add({
      senderName:           senderName,
      bankName:             bankName,
      amountPaid:           amountPaid,
      transactionReference: reference,
      paymentDate:          paymentDate,
      invoiceNumber:        inv.invoiceNumber || '',
      invoiceId:            inv.id,
      customerEmail:        inv.customerEmail || '',
      customerName:         inv.customerName  || '',
      userId:               inv.userId        || '',
      paymentStatus:        'submitted',
      createdAt:            firebase.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('invoices').doc(inv.id).update({
      paymentStatus: 'Receipt Submitted',
      receiptSentAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    success = true;
    msgDiv.textContent = 'Payment submitted successfully. Admin will review and confirm shortly.';
    msgDiv.style.cssText = 'display:block;background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;padding:10px 14px;border-radius:8px;font-size:0.875rem;margin-bottom:12px;';
    btn.textContent      = '✔ Submitted';
    btn.style.background = '#2e7d32';

  } catch (err) {
    console.error('[Payment] Submit error:', err.code, err.message);
    msgDiv.textContent = 'Failed to submit payment. Please try again.';
    msgDiv.style.cssText = 'display:block;background:#ffebee;color:#c62828;border:1px solid #ef9a9a;padding:10px 14px;border-radius:8px;font-size:0.875rem;margin-bottom:12px;';
  } finally {
    if (!success) {
      btn.textContent      = '✓ Submit Payment Details';
      btn.disabled         = false;
      btn.style.background = '';
    }
  }
}

// 13. Textarea clipboard fallback for older browsers
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* silent fail */ }
  document.body.removeChild(ta);
}

// ── Payment form removed – customers now use WhatsApp to send receipt ──

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  if (!container) return;
  var icons = { success: '&#10003;', error: '&#10005;', info: 'i' };
  var t = type || 'info';
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + t;
  toast.innerHTML = '<span class="toast-icon">' + (icons[t] || icons.info) + '</span><span>' + message + '</span>';
  container.appendChild(toast);
  setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 4100);
}

// 13. Download / print invoice as a standalone HTML page
function downloadInvoicePDF() {
  if (!currentViewInvoice) {
    showToast('No invoice loaded. Please open an invoice first.', 'error');
    return;
  }
  var inv  = currentViewInvoice;
  var isPaid = inv.paymentStatus === 'Paid';

  var date = inv.createdAt
    ? inv.createdAt.toDate().toLocaleDateString('en-NG', { day: '2-digit', month: 'long', year: 'numeric' })
    : '–';

  var paymentSection = !isPaid
    ? '<div style="background:#f0f7ff;border:1.5px solid #90caf9;border-radius:8px;padding:16px 18px;margin-bottom:18px;">' +
      '<p style="font-size:0.82rem;font-weight:700;color:#0d2137;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.4px;">Bank Transfer Details</p>' +
      '<table style="width:100%;font-size:0.85rem;border-collapse:collapse;">' +
        '<tr><td style="padding:5px 0;color:#5a6a7a;width:140px;">Company Name</td><td style="font-weight:700;">' + safeText(COMPANY_PAYMENT.companyName) + '</td></tr>' +
        '<tr><td style="padding:5px 0;color:#5a6a7a;">Bank</td><td style="font-weight:700;">' + safeText(COMPANY_PAYMENT.bankName) + '</td></tr>' +
        '<tr><td style="padding:5px 0;color:#5a6a7a;">Account Number</td><td style="font-weight:700;">' + safeText(COMPANY_PAYMENT.accountNo) + '</td></tr>' +
        '<tr><td style="padding:5px 0;color:#5a6a7a;">Account Name</td><td style="font-weight:700;">' + safeText(COMPANY_PAYMENT.accountName) + '</td></tr>' +
        '<tr><td style="padding:5px 0;color:#5a6a7a;">Phone</td><td style="font-weight:700;">' + safeText(COMPANY_PAYMENT.phone) + '</td></tr>' +
      '</table>' +
      '</div>'
    : '<div style="background:#e8f5e9;border:1.5px solid #a5d6a7;border-radius:8px;padding:14px 18px;margin-bottom:18px;color:#2e7d32;font-weight:700;">&#9989; Invoice Paid &ndash; Payment confirmed by admin.</div>';

  var base = window.location.href.replace(/[^/]*$/, '');
  var html = '<!DOCTYPE html>' +
    '<html><head>' +
    '<meta charset="UTF-8"/>' +
    '<base href="' + base + '" />' +
    '<title>Invoice &ndash; ' + safeText(inv.invoiceNumber) + '</title>' +
    '<style>' +
      'body{font-family:Arial,sans-serif;padding:36px;color:#1a1a2e;max-width:740px;margin:0 auto;}' +
      '.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0d2137;padding-bottom:16px;margin-bottom:20px;}' +
      '.brand h2{font-size:1.3rem;font-weight:900;color:#0d2137;}' +
      '.brand p{font-size:0.8rem;color:#5a6a7a;margin-top:3px;}' +
      '.meta{text-align:right;}' +
      '.inv-num{font-size:1rem;font-weight:800;color:#1e88e5;}' +
      '.inv-date{font-size:0.8rem;color:#5a6a7a;margin-top:4px;}' +
      '.parties{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;}' +
      '.party h4{font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#5a6a7a;margin-bottom:6px;}' +
      '.party p{font-size:0.875rem;line-height:1.6;}' +
      'table.items{width:100%;border-collapse:collapse;margin-bottom:18px;}' +
      'table.items th{background:#0d2137;color:#fff;padding:9px 12px;text-align:left;font-size:0.8rem;}' +
      'table.items td{padding:9px 12px;border-bottom:1px solid #e0e8f0;font-size:0.875rem;}' +
      '.total-row{display:flex;justify-content:flex-end;margin-bottom:20px;}' +
      '.total-box{background:#0d2137;color:#fff;border-radius:8px;padding:14px 20px;min-width:200px;text-align:right;}' +
      '.total-label{font-size:0.8rem;opacity:0.8;}' +
      '.total-amount{font-size:1.4rem;font-weight:800;}' +
      '.footer{text-align:center;margin-top:32px;padding-top:14px;border-top:1px solid #d0dae6;font-size:0.78rem;color:#5a6a7a;}' +
      '@media print{body{padding:20px;}}' +
    '</style>' +
    '</head><body>' +
    '<div class="header">' +
      '<div class="brand"><img src="assets/images/logo.png" alt="Sage Energies" style="height:52px;max-width:200px;object-fit:contain;display:block;margin-bottom:4px;" /><p>and Natural Resources Ltd</p><p>Benin City, Edo State, Nigeria</p><p>' + safeText(COMPANY_PAYMENT.phone) + '</p></div>' +
      '<div class="meta"><div class="inv-num">' + safeText(inv.invoiceNumber) + '</div><div class="inv-date">Date: ' + date + '</div><div class="inv-date">Order #: ' + safeText(inv.orderNumber || '–') + '</div><div style="margin-top:6px;font-weight:700;color:' + (isPaid ? '#2e7d32' : '#e65100') + ';">' + safeText(inv.paymentStatus) + '</div></div>' +
    '</div>' +
    '<div class="parties">' +
      '<div class="party"><h4>Billed To</h4><p><strong>' + safeText(inv.customerName) + '</strong></p><p>' + safeText(inv.customerEmail || '') + '</p><p>' + safeText(inv.phone || '') + '</p><p>' + safeText(inv.deliveryAddress || '') + '</p></div>' +
      '<div class="party"><h4>From</h4><p><strong>' + safeText(COMPANY_PAYMENT.companyName) + '</strong></p><p>' + safeText(COMPANY_PAYMENT.bankName) + '</p><p>' + safeText(COMPANY_PAYMENT.phone) + '</p></div>' +
    '</div>' +
    '<table class="items"><thead><tr><th>Fuel Type</th><th>Unit</th><th>Quantity</th><th>Price / Unit</th><th>Total</th></tr></thead>' +
    '<tbody><tr>' +
      '<td>' + safeText(inv.fuelType)  + '</td>' +
      '<td>' + safeText(inv.fuelUnit)  + '</td>' +
      '<td>' + safeText(String(inv.quantity || '–')) + '</td>' +
      '<td>&#8358;' + fmt(inv.pricePerUnit) + '</td>' +
      '<td><strong>&#8358;' + fmt(inv.totalAmount) + '</strong></td>' +
    '</tr></tbody></table>' +
    '<div class="total-row"><div class="total-box"><div class="total-label">TOTAL AMOUNT DUE</div><div class="total-amount">&#8358;' + fmt(inv.totalAmount) + '</div></div></div>' +
    paymentSection +
    (inv.notes ? '<p style="font-size:0.82rem;color:#5a6a7a;font-style:italic;">Notes: ' + safeText(inv.notes) + '</p>' : '') +
    '<div class="footer"><p>Thank you for your business!</p><p>Sage Energy and Natural Resources Ltd &mdash; ' + safeText(COMPANY_PAYMENT.phone) + '</p></div>' +
    '</body></html>';

  var win = window.open('', '_blank');
  if (!win) {
    showToast('Popup blocked. Please allow popups for this site and try again.', 'error');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(function () { win.print(); }, 500);
}
