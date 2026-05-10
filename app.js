// ============================================================
// APP.JS – Sage Energy and Natural Resources Ltd
// Main application logic: auth guard, invoices, products, reports
// ============================================================

// ── Global state ─────────────────────────────────────────────
let allInvoices    = [];   // cached list of all invoices from Firestore
let allProducts    = [];   // cached list of all products from Firestore
let allOrders      = [];   // cached list of all customer orders from Firestore
let itemCount      = 1;    // auto-incrementing id for invoice item rows
let currentInvoice = null; // invoice currently open in the view modal
let editProductId  = null; // product id being edited in the modal
let cleanupDone    = false; // ensures one-time Firestore cleanup of broken records

// ============================================================
// AUTH GUARD – redirect to login if not signed in
// ============================================================
firebase.auth().onAuthStateChanged(function (user) {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  // Show logged-in email in sidebar
  document.getElementById('userEmail').textContent = user.email;
  initApp();
});

// Logout button
document.getElementById('logoutBtn').addEventListener('click', function () {
  if (confirm('Are you sure you want to log out?')) {
    firebase.auth().signOut().then(function () {
      window.location.href = 'login.html';
    });
  }
});

// ============================================================
// INIT – Run once on load
// ============================================================
function initApp() {
  const today = new Date();

  // Set readable date on dashboard
  document.getElementById('currentDate').textContent =
    today.toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Set default values for date inputs
  const todayStr  = today.toISOString().split('T')[0];
  const monthStr  = today.toISOString().slice(0, 7);

  document.getElementById('invoiceDate').value         = todayStr;
  document.getElementById('reportDate').value          = todayStr;
  document.getElementById('reportMonth').value         = monthStr;
  document.getElementById('invoiceMonthFilter').value  = monthStr;

  // Generate first invoice number
  generateInvoiceNumber();

  // Start real-time Firestore listeners
  loadProducts();          // products must load first so dropdowns populate
  loadInvoices();
  loadOrders();            // customer orders for the admin orders section
  loadCustomerInvoices();  // customer payment invoices for the payments section

  // Wire up live preview listeners on the invoice form
  setupPreviewListeners();
}

// ============================================================
// NAVIGATION
// ============================================================
// Attach click handlers to all sidebar nav links
document.querySelectorAll('.nav-item').forEach(function (link) {
  link.addEventListener('click', function (e) {
    e.preventDefault();
    showSection(this.dataset.section);
  });
});

function showSection(name) {
  // Hide every section and deactivate every nav link
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Show the requested section and mark its nav link active
  const section = document.getElementById('section-' + name);
  const navLink = document.querySelector('[data-section="' + name + '"]');
  if (section) section.classList.add('active');
  if (navLink) navLink.classList.add('active');

  // Reload report data whenever the reports tab is opened
  if (name === 'reports') loadReports();

  closeMobileSidebar();
}

// Mobile sidebar toggle
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
// INVOICE NUMBER – auto-generate a unique number
// Format: INV-YYMM-XXXX  e.g. INV-2405-7823
// ============================================================
function generateInvoiceNumber() {
  const now     = new Date();
  const yy      = now.getFullYear().toString().slice(-2);
  const mm      = String(now.getMonth() + 1).padStart(2, '0');
  const rand    = Math.floor(Math.random() * 9000) + 1000;
  const invNum  = 'INV-' + yy + mm + '-' + rand;
  document.getElementById('invoiceNumber').value = invNum;
  return invNum;
}

// ============================================================
// INVOICE ITEMS – add rows, auto-fill price, calculate totals
// ============================================================
function addInvoiceItem() {
  const container = document.getElementById('invoiceItems');
  const id        = itemCount++;

  // Build product <option> list from cached allProducts
  const opts = buildProductOptions();

  const div = document.createElement('div');
  div.className = 'invoice-item';
  div.id        = 'item-' + id;
  div.innerHTML = `
    <div class="form-row item-row">
      <div class="form-group fg-product">
        <label>Product *</label>
        <select class="item-product" onchange="updateItemPrice(this,${id})" required>
          <option value="">-- Select Product --</option>
          ${opts}
        </select>
      </div>
      <div class="form-group fg-num">
        <label>Qty *</label>
        <input type="number" class="item-qty" min="1" value="1"
               oninput="calculateItemTotal(${id})" required />
      </div>
      <div class="form-group fg-num">
        <label>Price (&#8358;) *</label>
        <input type="number" class="item-price" min="0" step="0.01"
               oninput="calculateItemTotal(${id})" required />
      </div>
      <div class="form-group fg-num">
        <label>Total (&#8358;)</label>
        <input type="number" class="item-total" readonly class="input-readonly" />
      </div>
      <button type="button" class="btn-remove-item"
              onclick="removeInvoiceItem(${id})">&#10005; Remove</button>
    </div>
  `;
  container.appendChild(div);
}

function removeInvoiceItem(id) {
  const el = document.getElementById('item-' + id);
  if (el) el.remove();
  recalcGrandTotal();
  updatePreview();
}

// When a product is selected, auto-fill its unit price
function updateItemPrice(selectEl, id) {
  const opt   = selectEl.options[selectEl.selectedIndex];
  const price = opt ? (opt.getAttribute('data-price') || '') : '';
  const row   = document.getElementById('item-' + id);
  if (row) {
    row.querySelector('.item-price').value = price;
    calculateItemTotal(id);
  }
}

// Recalculate total for one item row
function calculateItemTotal(id) {
  const row = document.getElementById('item-' + id);
  if (!row) return;
  const qty   = parseFloat(row.querySelector('.item-qty').value)   || 0;
  const price = parseFloat(row.querySelector('.item-price').value) || 0;
  row.querySelector('.item-total').value = (qty * price).toFixed(2);
  recalcGrandTotal();
  updatePreview();
}

// Sum all item totals and display
function recalcGrandTotal() {
  let total = 0;
  document.querySelectorAll('.item-total').forEach(el => {
    total += parseFloat(el.value) || 0;
  });
  document.getElementById('subtotalDisplay').textContent  = fmt(total);
  document.getElementById('grandTotalDisplay').textContent = fmt(total);
  return total;
}

// ============================================================
// LIVE PREVIEW – update the right-hand preview as user types
// ============================================================
function setupPreviewListeners() {
  ['customerName','customerAddress','customerPhone','invoiceNotes','invoiceDate'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updatePreview);
    if (el) el.addEventListener('change', updatePreview);
  });
}

function updatePreview() {
  // Header
  document.getElementById('previewInvNum').textContent  = document.getElementById('invoiceNumber').value  || '–';
  document.getElementById('previewDate').textContent    = document.getElementById('invoiceDate').value    || '–';
  document.getElementById('previewCustomer').textContent = document.getElementById('customerName').value  || '–';
  document.getElementById('previewAddress').textContent = document.getElementById('customerAddress').value || '';
  document.getElementById('previewPhone').textContent   = document.getElementById('customerPhone').value  || '';
  document.getElementById('previewNotes').textContent   = document.getElementById('invoiceNotes').value   || '';

  // Items
  const tbody = document.getElementById('previewItems');
  tbody.innerHTML = '';
  let subtotal = 0;

  document.querySelectorAll('.invoice-item').forEach(function (row) {
    const sel   = row.querySelector('.item-product');
    const name  = sel && sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].text.split('(')[0].trim() : '–';
    const qty   = row.querySelector('.item-qty').value   || 0;
    const price = parseFloat(row.querySelector('.item-price').value) || 0;
    const total = parseFloat(row.querySelector('.item-total').value) || 0;
    subtotal += total;

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${name}</td>
        <td>${qty}</td>
        <td>${fmt(price)}</td>
        <td>${fmt(total)}</td>
      </tr>
    `);
  });

  document.getElementById('previewSubtotal').textContent = fmt(subtotal);
  document.getElementById('previewTotal').textContent    = fmt(subtotal);
}

// ============================================================
// SAVE INVOICE – validate form then write to Firestore
// ============================================================
document.getElementById('invoiceForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  // Collect items from all rows
  const items   = [];
  let   valid   = true;

  document.querySelectorAll('.invoice-item').forEach(function (row) {
    const sel       = row.querySelector('.item-product');
    const productId = sel.value;
    const productName = sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].text : '';
    const qty   = parseFloat(row.querySelector('.item-qty').value)   || 0;
    const price = parseFloat(row.querySelector('.item-price').value) || 0;
    const total = parseFloat(row.querySelector('.item-total').value) || 0;

    if (!productId || qty <= 0 || price < 0) { valid = false; return; }
    items.push({ productId, productName, qty, price, total });
  });

  if (!valid || items.length === 0) {
    showToast('Please select a product and enter a valid quantity and price for every item.', 'error');
    return;
  }

  const grandTotal = items.reduce((s, i) => s + i.total, 0);

  const invoiceNumber = document.getElementById('invoiceNumber').value.trim();
  const customerName  = document.getElementById('customerName').value.trim();
  const invoiceDate   = document.getElementById('invoiceDate').value;

  if (!invoiceNumber || !customerName || !invoiceDate) {
    showToast('Invoice number, customer name, and date are required.', 'error');
    return;
  }

  if (grandTotal <= 0) {
    showToast('Invoice total must be greater than zero.', 'error');
    return;
  }

  const data = {
    invoiceNumber,
    customerName,
    customerAddress: document.getElementById('customerAddress').value.trim(),
    customerPhone:   document.getElementById('customerPhone').value.trim(),
    invoiceDate,
    notes:           document.getElementById('invoiceNotes').value.trim(),
    items,
    totalAmount:     grandTotal,
    createdAt:       firebase.firestore.FieldValue.serverTimestamp(),
  };

  const btn = document.getElementById('saveInvoiceBtn');
  btn.textContent = 'Saving…';
  btn.disabled    = true;

  try {
    await db.collection('invoices').add(data);
    showToast('Invoice ' + data.invoiceNumber + ' saved successfully!', 'success');
    resetInvoiceForm();
  } catch (err) {
    console.error('Save invoice error:', err);
    showToast('Failed to save invoice. Please check your connection and try again.', 'error');
  } finally {
    btn.textContent = '💾 Save Invoice';
    btn.disabled    = false;
  }
});

// Reset the create-invoice form to a clean state
function resetInvoiceForm() {
  document.getElementById('invoiceForm').reset();
  itemCount = 1;

  // Restore single empty item row
  document.getElementById('invoiceItems').innerHTML = `
    <div class="invoice-item" id="item-0">
      <div class="form-row item-row">
        <div class="form-group fg-product">
          <label>Product *</label>
          <select class="item-product" onchange="updateItemPrice(this,0)" required>
            <option value="">-- Select Product --</option>
            ${buildProductOptions()}
          </select>
        </div>
        <div class="form-group fg-num">
          <label>Qty *</label>
          <input type="number" class="item-qty" min="1" value="1"
                 oninput="calculateItemTotal(0)" required />
        </div>
        <div class="form-group fg-num">
          <label>Price (&#8358;) *</label>
          <input type="number" class="item-price" min="0" step="0.01"
                 oninput="calculateItemTotal(0)" required />
        </div>
        <div class="form-group fg-num">
          <label>Total (&#8358;)</label>
          <input type="number" class="item-total" readonly />
        </div>
      </div>
    </div>
  `;

  generateInvoiceNumber();
  document.getElementById('invoiceDate').value = new Date().toISOString().split('T')[0];
  recalcGrandTotal();
  updatePreview();
}

// ============================================================
// INVOICE VALIDATION – only invoices with all required fields are shown
// ============================================================
function isValidInvoice(inv) {
  return Boolean(
    inv.invoiceNumber &&
    inv.customerName &&
    inv.invoiceDate &&
    typeof inv.totalAmount === 'number' && inv.totalAmount > 0 &&
    Array.isArray(inv.items) && inv.items.length > 0 &&
    inv.items.every(i => i.productName)
  );
}

// ============================================================
// LOAD INVOICES – real-time Firestore listener
// ============================================================
function loadInvoices() {
  db.collection('invoices')
    .orderBy('createdAt', 'desc')
    .onSnapshot(function (snap) {
      const valid   = [];
      const invalid = [];

      snap.docs.forEach(function (d) {
        const inv = { id: d.id, ...d.data() };
        if (isValidInvoice(inv)) {
          valid.push(inv);
        } else {
          invalid.push(d.id);
        }
      });

      allInvoices = valid;

      // One-time cleanup: delete broken admin-created records only.
      // Never touch documents that have a userId – those are customer
      // auto-generated invoices and use a different schema.
      if (!cleanupDone && invalid.length > 0) {
        cleanupDone = true;
        invalid.forEach(function (id) {
          var doc = snap.docs.find(function (d) { return d.id === id; });
          if (doc && doc.data().userId) return; // protect customer invoices
          db.collection('invoices').doc(id).delete().catch(function () {});
        });
      }

      renderDashboardInvoices();
      renderAllInvoices();
      updateDashboardStats();
    }, function (err) {
      console.error('Invoices listener error:', err);
    });
}

// Render invoices on the dashboard.
// When no search is active, shows the 5 most recent.
// When called with a filtered list (from search), shows all matches.
function renderDashboardInvoices(list) {
  const tbody      = document.getElementById('recentInvoicesTable');
  const searchVal  = (document.getElementById('dashboardSearch').value || '').trim();
  const data       = list !== undefined ? list : allInvoices.slice(0, 5);

  if (data.length === 0) {
    const msg = searchVal
      ? 'No matching invoice found.'
      : 'No invoices yet — create your first one!';
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(inv => `
    <tr>
      <td><strong>${inv.invoiceNumber}</strong></td>
      <td>${escHtml(inv.customerName)}</td>
      <td>${escHtml(inv.customerPhone || '–')}</td>
      <td>${productNames(inv)}</td>
      <td class="amount">${fmt(inv.totalAmount)}</td>
      <td>${inv.invoiceDate || '–'}</td>
      <td><button class="btn-sm btn-view" onclick="viewInvoice('${inv.id}')">View</button></td>
    </tr>
  `).join('');
}

// Live search on the dashboard card — by name, phone, or invoice number
function filterDashboardInvoices() {
  const search = document.getElementById('dashboardSearch').value.toLowerCase().trim();

  if (!search) {
    renderDashboardInvoices();
    return;
  }

  var filtered = allInvoices.filter(function (inv) {
    return (
      (inv.customerName  || '').toLowerCase().includes(search) ||
      (inv.customerPhone || '').toLowerCase().includes(search) ||
      (inv.invoiceNumber || '').toLowerCase().includes(search)
    );
  });

  renderDashboardInvoices(filtered);
}

// Render all invoices (with optional filtered subset)
function renderAllInvoices(list) {
  const tbody     = document.getElementById('allInvoicesTable');
  const data      = list !== undefined ? list : allInvoices;
  const searchVal = (document.getElementById('invoiceSearch').value || '').trim();

  if (data.length === 0) {
    const msg = searchVal ? 'No matching invoice found.' : 'No invoices yet — create your first one!';
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(inv => `
    <tr>
      <td><strong>${inv.invoiceNumber}</strong></td>
      <td>${escHtml(inv.customerName)}</td>
      <td>${escHtml(inv.customerPhone || '–')}</td>
      <td>${productNames(inv)}</td>
      <td class="amount">${fmt(inv.totalAmount)}</td>
      <td>${inv.invoiceDate || '–'}</td>
      <td>
        <button class="btn-sm btn-view"      onclick="viewInvoice('${inv.id}')">View</button>
        <button class="btn-sm btn-danger-sm" onclick="deleteInvoice('${inv.id}','${escHtml(inv.invoiceNumber)}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

// Search / filter on the All Invoices page
function filterInvoices() {
  const search = document.getElementById('invoiceSearch').value.toLowerCase();
  const month  = document.getElementById('invoiceMonthFilter').value;

  const filtered = allInvoices.filter(inv => {
    const matchText  = !search ||
      (inv.customerName  || '').toLowerCase().includes(search) ||
      (inv.customerPhone || '').toLowerCase().includes(search) ||
      (inv.invoiceNumber || '').toLowerCase().includes(search);
    const matchMonth = !month || (inv.invoiceDate && inv.invoiceDate.startsWith(month));
    return matchText && matchMonth;
  });

  renderAllInvoices(filtered);
}

function clearInvoiceFilter() {
  document.getElementById('invoiceSearch').value      = '';
  document.getElementById('invoiceMonthFilter').value = new Date().toISOString().slice(0, 7);
  renderAllInvoices();
}

// ============================================================
// VIEW INVOICE MODAL
// ============================================================
function viewInvoice(id) {
  const inv = allInvoices.find(i => i.id === id);
  if (!inv) return;
  currentInvoice = inv;

  const itemsHTML = (inv.items || []).map(item => `
    <tr>
      <td>${escHtml((item.productName || '').split('(')[0].trim())}</td>
      <td>${item.qty}</td>
      <td>${fmt(item.price)}</td>
      <td>${fmt(item.total)}</td>
    </tr>
  `).join('');

  document.getElementById('invoiceViewContent').innerHTML = `
    <div class="invoice-print-area" id="printableArea">
      <div class="preview-header">
        <div class="company-block">
          <img src="assets/images/logo.png" alt="Sage Energies" class="invoice-logo-img" style="height:44px;max-width:190px;object-fit:contain;display:block;margin-bottom:4px;" />
          <p>and Natural Resources Ltd</p>
          <p>+234 815 411 4232 &nbsp;|&nbsp; Benin City, Edo State</p>
        </div>
        <div class="invoice-meta-block">
          <h3 class="inv-label">INVOICE</h3>
          <p>No: <strong>${inv.invoiceNumber}</strong></p>
          <p>Date: <strong>${inv.invoiceDate || '–'}</strong></p>
        </div>
      </div>

      <div class="preview-bill-to">
        <p class="bill-label">Bill To:</p>
        <p><strong>${escHtml(inv.customerName)}</strong></p>
        ${inv.customerAddress ? '<p class="preview-small">' + escHtml(inv.customerAddress) + '</p>' : ''}
        ${inv.customerPhone   ? '<p class="preview-small">' + escHtml(inv.customerPhone)   + '</p>' : ''}
      </div>

      <table class="preview-table">
        <thead>
          <tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr>
        </thead>
        <tbody>${itemsHTML}</tbody>
      </table>

      <div class="preview-totals">
        <div class="preview-total-row preview-grand">
          <span>TOTAL AMOUNT:</span>
          <span>${fmt(inv.totalAmount)}</span>
        </div>
      </div>

      ${inv.notes ? '<p class="preview-notes-text"><strong>Notes:</strong> ' + escHtml(inv.notes) + '</p>' : ''}

      <div class="preview-footer-text">
        <p>Thank you for your business!</p>
        <p>Sage Energy and Natural Resources Ltd</p>
      </div>
    </div>
  `;

  document.getElementById('invoiceViewModal').classList.add('active');
}

function closeInvoiceModal() {
  document.getElementById('invoiceViewModal').classList.remove('active');
  currentInvoice = null;
}

// Delete invoice from within the view modal
async function deleteInvoiceFromView() {
  if (!currentInvoice) return;
  await deleteInvoice(currentInvoice.id, currentInvoice.invoiceNumber);
  closeInvoiceModal();
}

// Delete invoice by id
async function deleteInvoice(id, invNum) {
  if (!confirm('Delete invoice ' + invNum + '? This action cannot be undone.')) return;
  try {
    await db.collection('invoices').doc(id).delete();
    showToast('Invoice deleted.', 'success');
  } catch (err) {
    console.error('Delete invoice error:', err);
    showToast('Failed to delete invoice. Please try again.', 'error');
  }
}

// ============================================================
// PRINT – open a print-friendly window
// ============================================================
function printViewedInvoice() {
  if (!currentInvoice) return;
  openPrintWindow(document.getElementById('printableArea').innerHTML, currentInvoice.invoiceNumber);
}

function printCurrentInvoice() {
  // Update preview first, then print it
  updatePreview();
  openPrintWindow(document.getElementById('invoicePreview').innerHTML, document.getElementById('invoiceNumber').value);
}

function openPrintWindow(html, title) {
  const w = window.open('', '_blank');
  const base = window.location.href.replace(/[^/]*$/, '');
  w.document.write(`
    <!DOCTYPE html>
    <html><head>
      <base href="${base}" />
      <title>Invoice – ${title}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 30px; color: #222; }
        .preview-header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #0d2137; padding-bottom:16px; margin-bottom:20px; }
        .company-name { font-size:1.2rem; font-weight:900; color:#0d2137; }
        .company-block p { font-size:0.8rem; color:#555; margin-top:3px; }
        .invoice-meta-block { text-align:right; }
        .inv-label { font-size:1.1rem; font-weight:800; color:#0d2137; }
        .invoice-meta-block p { font-size:0.82rem; margin-top:3px; }
        .preview-bill-to { margin:16px 0; }
        .bill-label { font-weight:700; font-size:0.8rem; text-transform:uppercase; color:#555; margin-bottom:4px; }
        .preview-small { color:#666; font-size:0.82rem; }
        .preview-table { width:100%; border-collapse:collapse; font-size:0.85rem; margin:14px 0; }
        .preview-table th { background:#0d2137; color:#fff; padding:9px 12px; text-align:left; }
        .preview-table td { padding:8px 12px; border-bottom:1px solid #eee; }
        .preview-totals { text-align:right; margin-top:12px; }
        .preview-total-row { display:flex; justify-content:flex-end; gap:40px; padding:4px 0; }
        .preview-grand { font-size:1.1rem; font-weight:800; color:#0d2137; border-top:2px solid #0d2137; padding-top:8px; margin-top:4px; }
        .preview-notes-text { margin-top:14px; font-size:0.82rem; color:#555; font-style:italic; }
        .preview-footer-text { text-align:center; margin-top:30px; padding-top:14px; border-top:1px solid #ddd; font-size:0.8rem; color:#888; }
        /* hide UI elements not needed in print */
        .card-title, #invoicePreviewCard > h3 { display:none; }
      </style>
    </head>
    <body>${html}</body></html>
  `);
  w.document.close();
  w.focus();
  w.print();
}

// ============================================================
// PDF DOWNLOAD – using jsPDF
// ============================================================
function downloadCurrentPDF() {
  updatePreview();
  const invNum   = document.getElementById('invoiceNumber').value;
  const customer = document.getElementById('customerName').value || 'Customer';
  const date     = document.getElementById('invoiceDate').value;
  const address  = document.getElementById('customerAddress').value;
  const phone    = document.getElementById('customerPhone').value;
  const notes    = document.getElementById('invoiceNotes').value;

  // Collect items from form
  const items = [];
  document.querySelectorAll('.invoice-item').forEach(function (row) {
    const sel  = row.querySelector('.item-product');
    const name = sel && sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].text.split('(')[0].trim() : '–';
    items.push({
      productName: name,
      qty:         row.querySelector('.item-qty').value || 0,
      price:       parseFloat(row.querySelector('.item-price').value) || 0,
      total:       parseFloat(row.querySelector('.item-total').value) || 0,
    });
  });

  const grandTotal = items.reduce((s, i) => s + i.total, 0);
  buildPDF({ invoiceNumber: invNum, customerName: customer, invoiceDate: date, customerAddress: address, customerPhone: phone, notes, items, totalAmount: grandTotal });
}

function downloadViewedPDF() {
  if (!currentInvoice) return;
  buildPDF(currentInvoice);
}

// Shared PDF builder
function buildPDF(inv) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  // ── Dark header bar ──
  doc.setFillColor(13, 33, 55);
  doc.rect(0, 0, 210, 38, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.setFont(undefined, 'bold');
  doc.text('Sage Energies', 14, 16);

  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.text('and Natural Resources Ltd', 14, 23);
  doc.text('+234 815 411 4232  |  Benin City, Edo State, Nigeria', 14, 30);

  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text('INVOICE', 196, 16, { align: 'right' });
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.text('No: ' + inv.invoiceNumber, 196, 24, { align: 'right' });
  doc.text('Date: ' + (inv.invoiceDate || ''), 196, 30, { align: 'right' });

  // ── Bill To ──
  doc.setTextColor(80, 80, 80);
  doc.setFontSize(8);
  doc.setFont(undefined, 'bold');
  doc.text('BILL TO:', 14, 50);
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text(inv.customerName || '', 14, 58);
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.setTextColor(80, 80, 80);
  let billY = 64;
  if (inv.customerAddress) { doc.text(inv.customerAddress, 14, billY); billY += 6; }
  if (inv.customerPhone)   { doc.text(inv.customerPhone,   14, billY); }

  // ── Items table header ──
  let y = 82;
  doc.setFillColor(13, 33, 55);
  doc.rect(14, y, 182, 9, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont(undefined, 'bold');
  doc.text('PRODUCT',   16, y + 6);
  doc.text('QTY',      122, y + 6);
  doc.text('UNIT PRICE', 142, y + 6);
  doc.text('TOTAL',    185, y + 6, { align: 'right' });

  y += 13;
  doc.setFont(undefined, 'normal');

  // ── Item rows ──
  (inv.items || []).forEach(function (item) {
    const name = (item.productName || '–').split('(')[0].trim().substring(0, 50);
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(9);
    doc.text(name,                       16,  y);
    doc.text(String(item.qty),           122, y);
    doc.text(fmtPdf(item.price),         142, y);
    doc.text(fmtPdf(item.total),         195, y, { align: 'right' });

    doc.setDrawColor(210, 220, 230);
    doc.line(14, y + 3, 196, y + 3);
    y += 11;

    // New page if content runs off
    if (y > 260) { doc.addPage(); y = 20; }
  });

  // ── Total box ──
  y += 4;
  doc.setFillColor(13, 33, 55);
  doc.rect(130, y, 66, 11, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.text('TOTAL AMOUNT:', 133, y + 7.5);
  doc.text(fmtPdf(inv.totalAmount), 193, y + 7.5, { align: 'right' });

  // ── Notes ──
  if (inv.notes) {
    y += 20;
    doc.setTextColor(80, 80, 80);
    doc.setFontSize(8);
    doc.setFont(undefined, 'bold');
    doc.text('Notes:', 14, y);
    doc.setFont(undefined, 'normal');
    doc.text(inv.notes, 14, y + 5);
  }

  // ── Footer ──
  doc.setTextColor(150, 150, 150);
  doc.setFontSize(8);
  doc.text('Thank you for your business! — Sage Energy and Natural Resources Ltd', 105, 287, { align: 'center' });

  doc.save('Invoice-' + inv.invoiceNumber + '.pdf');
}

// ============================================================
// PRODUCTS – real-time listener + CRUD
// ============================================================
function loadProducts() {
  db.collection('products')
    .orderBy('name')
    .onSnapshot(function (snap) {
      allProducts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderProducts();
      refreshAllProductDropdowns();
      checkLowStock();
      updateDashboardStats();
    }, function (err) {
      console.error('Products listener error:', err);
    });
}

function renderProducts() {
  const tbody = document.getElementById('productsTable');

  if (allProducts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No products yet — click "+ Add Product" to get started.</td></tr>';
    return;
  }

  tbody.innerHTML = allProducts.map(p => {
    const low = p.quantity <= (p.lowStockThreshold || 0);
    return `
      <tr class="${low ? 'low-stock-row' : ''}">
        <td><strong>${escHtml(p.name)}</strong></td>
        <td>${p.category || '–'}</td>
        <td class="amount">${fmt(p.price)} / ${p.unit}</td>
        <td><strong>${p.quantity}</strong></td>
        <td>${p.unit}</td>
        <td>
          <span class="badge ${low ? 'badge-danger' : 'badge-success'}">
            ${low ? '&#9888; Low Stock' : '&#10003; In Stock'}
          </span>
        </td>
        <td>
          <button class="btn-sm btn-edit"      onclick="editProduct('${p.id}')">Edit</button>
          <button class="btn-sm btn-danger-sm" onclick="deleteProduct('${p.id}','${escHtml(p.name)}')">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

// Build <option> HTML for product selects
function buildProductOptions() {
  return allProducts.map(p =>
    `<option value="${p.id}" data-price="${p.price}">${escHtml(p.name)} (${fmt(p.price)}/${p.unit})</option>`
  ).join('');
}

// Refresh every product <select> in the invoice form
function refreshAllProductDropdowns() {
  const opts = buildProductOptions();
  document.querySelectorAll('.item-product').forEach(function (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- Select Product --</option>' + opts;
    if (cur) sel.value = cur;
  });
}

function checkLowStock() {
  const lowItems = allProducts.filter(p => p.quantity <= (p.lowStockThreshold || 0));
  const alertEl  = document.getElementById('lowStockAlert');

  if (lowItems.length > 0) {
    alertEl.style.display = 'block';
    alertEl.innerHTML = '&#9888; <strong>Low Stock Alert!</strong> Low stock: ' +
      lowItems.map(p => escHtml(p.name) + ' (' + p.quantity + ' ' + p.unit + ')').join(', ');
  } else {
    alertEl.style.display = 'none';
  }
}

// ── Product Modal ─────────────────────────────────────────────
function openProductModal() {
  editProductId = null;
  document.getElementById('productForm').reset();
  document.getElementById('editProductId').value = '';
  document.getElementById('modalTitle').textContent    = 'Add Product';
  document.getElementById('saveProductBtn').textContent = 'Save Product';
  document.getElementById('productModal').classList.add('active');
}

function editProduct(id) {
  const p = allProducts.find(x => x.id === id);
  if (!p) return;
  editProductId = id;

  document.getElementById('modalTitle').textContent    = 'Edit Product';
  document.getElementById('saveProductBtn').textContent = 'Update Product';
  document.getElementById('editProductId').value = id;
  document.getElementById('productName').value         = p.name;
  document.getElementById('productCategory').value     = p.category;
  document.getElementById('productPrice').value        = p.price;
  document.getElementById('productQuantity').value     = p.quantity;
  document.getElementById('productUnit').value         = p.unit;
  document.getElementById('productLowStock').value     = p.lowStockThreshold || 100;

  document.getElementById('productModal').classList.add('active');
}

function closeProductModal() {
  document.getElementById('productModal').classList.remove('active');
  editProductId = null;
}

// Save or update product
document.getElementById('productForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  const data = {
    name:              document.getElementById('productName').value.trim(),
    category:          document.getElementById('productCategory').value,
    price:             parseFloat(document.getElementById('productPrice').value),
    quantity:          parseFloat(document.getElementById('productQuantity').value),
    unit:              document.getElementById('productUnit').value,
    lowStockThreshold: parseFloat(document.getElementById('productLowStock').value) || 100,
    updatedAt:         firebase.firestore.FieldValue.serverTimestamp(),
  };

  const btn = document.getElementById('saveProductBtn');
  btn.textContent = 'Saving…';
  btn.disabled    = true;

  try {
    if (editProductId) {
      await db.collection('products').doc(editProductId).update(data);
      showToast('Product updated successfully!', 'success');
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection('products').add(data);
      showToast('Product added successfully!', 'success');
    }
    closeProductModal();
  } catch (err) {
    console.error('Save product error:', err);
    showToast('Failed to save product. Please try again.', 'error');
  } finally {
    btn.textContent = editProductId ? 'Update Product' : 'Save Product';
    btn.disabled    = false;
  }
});

async function deleteProduct(id, name) {
  if (!confirm('Delete product "' + name + '"? This cannot be undone.')) return;
  try {
    await db.collection('products').doc(id).delete();
    showToast('Product deleted.', 'success');
  } catch (err) {
    console.error('Delete product error:', err);
    showToast('Failed to delete product. Please try again.', 'error');
  }
}

// ============================================================
// DASHBOARD STATS
// ============================================================
function updateDashboardStats() {
  const totalRevenue  = allInvoices.reduce((s, inv) => s + (inv.totalAmount || 0), 0);
  const lowStockCount = allProducts.filter(p => p.quantity <= (p.lowStockThreshold || 0)).length;

  document.getElementById('totalRevenue').textContent  = fmt(totalRevenue);
  document.getElementById('totalInvoices').textContent = allInvoices.length;
  document.getElementById('totalProducts').textContent = allProducts.length;
  document.getElementById('lowStockCount').textContent = lowStockCount;
}

// ============================================================
// REPORTS
// ============================================================
function loadReports() {
  const dateFilter  = document.getElementById('reportDate').value;
  const monthFilter = document.getElementById('reportMonth').value;

  // Day-level filter
  const dayInvs = dateFilter
    ? allInvoices.filter(inv => inv.invoiceDate === dateFilter)
    : allInvoices;

  // Month-level filter
  const monthInvs = monthFilter
    ? allInvoices.filter(inv => inv.invoiceDate && inv.invoiceDate.startsWith(monthFilter))
    : allInvoices;

  // Stat cards
  document.getElementById('dailySales').textContent    = fmt(dayInvs.reduce((s, i) => s + (i.totalAmount || 0), 0));
  document.getElementById('monthlySales').textContent  = fmt(monthInvs.reduce((s, i) => s + (i.totalAmount || 0), 0));
  document.getElementById('reportTotalRevenue').textContent = fmt(allInvoices.reduce((s, i) => s + (i.totalAmount || 0), 0));
  document.getElementById('reportInvoiceCount').textContent = monthInvs.length;

  // Revenue by product (from the month-filtered set)
  const byProduct = {};
  monthInvs.forEach(function (inv) {
    (inv.items || []).forEach(function (item) {
      const name = (item.productName || '').split('(')[0].trim();
      if (!byProduct[name]) byProduct[name] = { units: 0, revenue: 0 };
      byProduct[name].units   += Number(item.qty)   || 0;
      byProduct[name].revenue += Number(item.total) || 0;
    });
  });

  const prodTbody = document.getElementById('productRevenueTable');
  const entries   = Object.entries(byProduct).sort((a, b) => b[1].revenue - a[1].revenue);

  prodTbody.innerHTML = entries.length === 0
    ? '<tr><td colspan="3" class="empty-row">No sales data for the selected period.</td></tr>'
    : entries.map(([name, d]) => `
        <tr>
          <td>${escHtml(name)}</td>
          <td>${d.units}</td>
          <td class="amount">${fmt(d.revenue)}</td>
        </tr>
      `).join('');

  // Invoice history list
  const histTbody = document.getElementById('reportInvoiceTable');
  histTbody.innerHTML = monthInvs.length === 0
    ? '<tr><td colspan="4" class="empty-row">No invoices for the selected period.</td></tr>'
    : monthInvs.map(inv => `
        <tr>
          <td><strong>${inv.invoiceNumber}</strong></td>
          <td>${escHtml(inv.customerName)}</td>
          <td class="amount">${fmt(inv.totalAmount)}</td>
          <td>${inv.invoiceDate || '–'}</td>
        </tr>
      `).join('');
}

function clearReportFilters() {
  const today = new Date();
  document.getElementById('reportDate').value  = today.toISOString().split('T')[0];
  document.getElementById('reportMonth').value = today.toISOString().slice(0, 7);
  loadReports();
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

// Format a number as Nigerian Naira
function fmt(amount) {
  return '₦' + parseFloat(amount || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// Format for PDF (jsPDF has issues with the ₦ symbol in some fonts, use N instead)
function fmtPdf(amount) {
  return 'N' + parseFloat(amount || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// Safely escape HTML to prevent XSS when rendering user data into innerHTML
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Return a comma-separated product name string from an invoice
function productNames(inv) {
  if (!inv.items || inv.items.length === 0) return '–';
  return inv.items.map(i => escHtml((i.productName || '').split('(')[0].trim())).join(', ');
}

// ============================================================
// CUSTOMER ORDERS – admin view (load, render, approve, deliver, delete)
// ============================================================

// Real-time listener: fetch every order from every customer
function loadOrders() {
  db.collection('orders')
    .orderBy('createdAt', 'desc')
    .onSnapshot(function (snap) {
      allOrders = snap.docs.map(function (d) {
        return { id: d.id, ...d.data() };
      });
      renderOrders();
      updateOrderStats();
    }, function (err) {
      console.error('Orders listener error:', err);
    });
}

// Render the orders table (optionally pass a filtered subset)
function renderOrders(list) {
  var tbody = document.getElementById('allOrdersTable');
  var data  = list !== undefined ? list : allOrders;

  if (data.length === 0) {
    var searchVal = (document.getElementById('orderSearch').value || '').trim();
    var msg = searchVal ? 'No matching orders found.' : 'No customer orders yet.';
    tbody.innerHTML = '<tr><td colspan="9" class="empty-row">' + msg + '</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(function (order) {
    // Convert Firestore server timestamp to a readable date string
    var date = order.createdAt ? order.createdAt.toDate().toLocaleDateString('en-NG') : '–';

    var isPending   = order.status === 'Pending';
    var isApproved  = order.status === 'Approved';
    var isDelivered = order.status === 'Delivered';

    // Build action buttons based on current status
    var actions = '';
    if (isPending) {
      actions += '<button class="btn-sm btn-view" onclick="approveOrder(\'' + order.id + '\')">Approve</button> ';
    }
    if (isApproved) {
      actions += '<button class="btn-sm btn-edit" onclick="deliverOrder(\'' + order.id + '\')">Mark Delivered</button> ';
    }
    actions += '<button class="btn-sm btn-danger-sm" onclick="deleteOrder(\'' + order.id + '\',\'' + escHtml(order.orderNumber) + '\')">Delete</button>';

    // Support both new field names (phone, address) and old names (customerPhone, deliveryAddress)
    var phone   = order.phone   || order.customerPhone   || '–';
    var address = order.address || order.deliveryAddress || '–';

    return '<tr>' +
      '<td><strong>' + escHtml(order.orderNumber)  + '</strong></td>' +
      '<td>' + escHtml(order.customerName)         + '</td>' +
      '<td>' + escHtml(phone)                      + '</td>' +
      '<td>' + escHtml(order.fuelType)             + '</td>' +
      '<td>' + (order.quantity || '–') + ' ' + escHtml(order.fuelUnit || '') + '</td>' +
      '<td>' + escHtml(address)                    + '</td>' +
      '<td>' + orderStatusBadge(order.status)      + '</td>' +
      '<td>' + date                                + '</td>' +
      '<td>' + actions                             + '</td>' +
    '</tr>';
  }).join('');
}

// Update the four stat cards in the orders section
function updateOrderStats() {
  document.getElementById('orderTotalCount').textContent     = allOrders.length;
  document.getElementById('orderPendingCount').textContent   = allOrders.filter(function (o) { return o.status === 'Pending';   }).length;
  document.getElementById('orderApprovedCount').textContent  = allOrders.filter(function (o) { return o.status === 'Approved';  }).length;
  document.getElementById('orderDeliveredCount').textContent = allOrders.filter(function (o) { return o.status === 'Delivered'; }).length;
}

// Live search and status filter for the orders table
function filterOrders() {
  var search = document.getElementById('orderSearch').value.toLowerCase().trim();
  var status = document.getElementById('orderStatusFilter').value;

  var filtered = allOrders.filter(function (order) {
    // Search both new field names and old ones for backward compatibility
    var phone = order.phone || order.customerPhone || '';
    var matchText = !search ||
      (order.customerName || '').toLowerCase().includes(search) ||
      phone.toLowerCase().includes(search) ||
      (order.orderNumber  || '').toLowerCase().includes(search);
    var matchStatus = !status || order.status === status;
    return matchText && matchStatus;
  });

  renderOrders(filtered);
}

// Clear all order filters and show everything
function clearOrderFilter() {
  document.getElementById('orderSearch').value       = '';
  document.getElementById('orderStatusFilter').value = '';
  renderOrders();
}

// Admin: approve a pending order
async function approveOrder(id) {
  if (!confirm('Approve this order?')) return;
  try {
    await db.collection('orders').doc(id).update({
      status:    'Approved',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast('Order approved successfully.', 'success');
  } catch (err) {
    console.error('Approve order error:', err);
    showToast('Failed to approve order. Please try again.', 'error');
  }
}

// Admin: mark an approved order as delivered
async function deliverOrder(id) {
  if (!confirm('Mark this order as Delivered?')) return;
  try {
    await db.collection('orders').doc(id).update({
      status:    'Delivered',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast('Order marked as delivered.', 'success');
  } catch (err) {
    console.error('Deliver order error:', err);
    showToast('Failed to update order. Please try again.', 'error');
  }
}

// Admin: permanently delete an order
async function deleteOrder(id, orderNum) {
  if (!confirm('Delete order ' + orderNum + '? This cannot be undone.')) return;
  try {
    await db.collection('orders').doc(id).delete();
    showToast('Order deleted.', 'success');
  } catch (err) {
    console.error('Delete order error:', err);
    showToast('Failed to delete order. Please try again.', 'error');
  }
}

// Return a coloured status badge HTML string
function orderStatusBadge(status) {
  var badges = {
    'Pending':   '<span class="order-badge badge-pending">&#8987; Pending</span>',
    'Approved':  '<span class="order-badge badge-approved">&#10003; Approved</span>',
    'Delivered': '<span class="order-badge badge-delivered">&#128666; Delivered</span>',
  };
  return badges[status] || '<span class="order-badge badge-pending">' + escHtml(status) + '</span>';
}

// ============================================================
// CUSTOMER PAYMENTS – admin view
// ============================================================

let allCustomerInvoices = [];

// 1. Load all customer payment submissions in real time (payments collection)
function loadCustomerInvoices() {
  db.collection('payments')
    .orderBy('createdAt', 'desc')
    .onSnapshot(function (snap) {
      allCustomerInvoices = snap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); });

      renderCustomerInvoices();
      updatePaymentStats();
    }, function (err) {
      console.error('[Payments] Listener error:', err.code, err.message);
    });
}

// 2. Update the payment stat cards
function updatePaymentStats() {
  var submitted = allCustomerInvoices.filter(function (i) {
    return i.paymentStatus === 'submitted' || i.paymentStatus === 'pending';
  }).length;
  var confirmed = allCustomerInvoices.filter(function (i) { return i.paymentStatus === 'confirmed'; }).length;
  var rejected  = allCustomerInvoices.filter(function (i) { return i.paymentStatus === 'rejected';  }).length;
  document.getElementById('pmtTotalCount').textContent    = allCustomerInvoices.length;
  document.getElementById('pmtSubmittedCount').textContent = submitted;
  document.getElementById('pmtPaidCount').textContent     = confirmed;
  document.getElementById('pmtRejectedCount').textContent = rejected;
}

// 3. Filter payment submissions by search and status
function filterCustomerInvoices() {
  var search = (document.getElementById('invoicePaySearch').value || '').toLowerCase().trim();
  var status = document.getElementById('invoicePayStatusFilter').value;

  var filtered = allCustomerInvoices.filter(function (pmt) {
    var matchText = !search ||
      (pmt.invoiceNumber        || '').toLowerCase().includes(search) ||
      (pmt.customerName         || '').toLowerCase().includes(search) ||
      (pmt.customerEmail        || '').toLowerCase().includes(search) ||
      (pmt.senderName           || '').toLowerCase().includes(search) ||
      (pmt.transactionReference || '').toLowerCase().includes(search);
    var matchStatus = !status || pmt.paymentStatus === status;
    return matchText && matchStatus;
  });

  renderCustomerInvoices(filtered);
}

// 4. Clear all filters
function clearInvoicePayFilter() {
  document.getElementById('invoicePaySearch').value       = '';
  document.getElementById('invoicePayStatusFilter').value = '';
  renderCustomerInvoices();
}

// 5. Render the customer payment submissions table
function renderCustomerInvoices(list) {
  var tbody = document.getElementById('customerInvoicesTable');
  var data  = list !== undefined ? list : allCustomerInvoices;

  if (data.length === 0) {
    var searchVal = (document.getElementById('invoicePaySearch').value || '').trim();
    var msg = searchVal ? 'No matching payments found.' : 'No payment submissions yet.';
    tbody.innerHTML = '<tr><td colspan="9" class="empty-row">' + msg + '</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(function (pmt) {
    var submittedDate = pmt.createdAt
      ? pmt.createdAt.toDate().toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' })
      : '–';

    var status = pmt.paymentStatus || 'submitted';

    var actions = '';
    if (status === 'submitted' || status === 'pending') {
      actions =
        '<button class="btn-sm btn-edit" onclick="updatePaymentStatus(\'' + pmt.id + '\',\'confirmed\')" style="margin-right:4px;">&#10003; Confirm</button>' +
        '<button class="btn-sm btn-danger-sm" onclick="updatePaymentStatus(\'' + pmt.id + '\',\'rejected\')">&#10005; Reject</button>';
    } else if (status === 'confirmed') {
      actions = '<button class="btn-sm btn-secondary-sm" onclick="updatePaymentStatus(\'' + pmt.id + '\',\'pending\')">&#8635; Revert</button>';
    } else if (status === 'rejected') {
      actions =
        '<button class="btn-sm btn-edit" onclick="updatePaymentStatus(\'' + pmt.id + '\',\'confirmed\')" style="margin-right:4px;">&#10003; Confirm</button>' +
        '<button class="btn-sm btn-secondary-sm" onclick="updatePaymentStatus(\'' + pmt.id + '\',\'pending\')">&#8635; Revert</button>';
    }

    return '<tr>' +
      '<td><strong>' + escHtml(pmt.invoiceNumber || '–') + '</strong></td>' +
      '<td>' + escHtml(pmt.customerName || '–') + '<br><small style="color:var(--text-muted);">' + escHtml(pmt.customerEmail || '') + '</small></td>' +
      '<td>' + escHtml(pmt.senderName || '–') + '<br><small style="color:var(--text-muted);">' + escHtml(pmt.bankName || '') + '</small></td>' +
      '<td class="amount">&#8358;' + fmtAdmin(pmt.amountPaid) + '</td>' +
      '<td>' + escHtml(pmt.transactionReference || '–') + '</td>' +
      '<td>' + escHtml(pmt.paymentDate || '–') + '</td>' +
      '<td>' + submittedDate + '</td>' +
      '<td>' + adminPaymentBadge(status) + '</td>' +
      '<td>' + actions + '</td>' +
    '</tr>';
  }).join('');
}

// 6. Admin: update payment status (pending / confirmed / rejected)
async function updatePaymentStatus(id, newStatus) {
  var pmt   = allCustomerInvoices.find(function (i) { return i.id === id; });
  var invNo = pmt ? (pmt.invoiceNumber || id) : id;

  var labels = { pending: 'Pending', confirmed: 'Confirmed', rejected: 'Rejected' };
  var label  = labels[newStatus] || newStatus;

  // Map payment status → invoice status shown to the customer
  var invoiceStatusMap = {
    pending:   'Receipt Submitted',
    confirmed: 'Payment Confirmed',
    rejected:  'Payment Rejected',
  };

  if (!confirm('Mark payment for invoice ' + invNo + ' as ' + label + '?')) return;

  try {
    var pmtUpdate = {
      paymentStatus: newStatus,
      updatedAt:     firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (newStatus === 'confirmed') pmtUpdate.confirmedAt = firebase.firestore.FieldValue.serverTimestamp();
    if (newStatus === 'rejected')  pmtUpdate.rejectedAt  = firebase.firestore.FieldValue.serverTimestamp();

    await db.collection('payments').doc(id).update(pmtUpdate);

    if (pmt && pmt.invoiceId) {
      await db.collection('invoices').doc(pmt.invoiceId).update({
        paymentStatus: invoiceStatusMap[newStatus] || 'Awaiting Payment',
        updatedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      });
    }

    var toastType = newStatus === 'rejected' ? 'error' : 'success';
    showToast('Payment for invoice ' + invNo + ' marked as ' + label + '.', toastType);
  } catch (err) {
    console.error('[updatePaymentStatus] Error:', err.code, err.message);
    showToast('Failed to update payment status. Please try again.', 'error');
  }
}

// Legacy alias
function confirmPayment(id) { updatePaymentStatus(id, 'confirmed'); }

// 7. Admin: view full details of a payment submission
function viewReceiptSubmission(id) {
  var pmt = allCustomerInvoices.find(function (i) { return i.id === id; });
  if (!pmt) return;

  var submittedAt = '–';
  if (pmt.createdAt && pmt.createdAt.toDate) {
    submittedAt = pmt.createdAt.toDate().toLocaleString('en-NG');
  }

  showToast(
    '<strong>' + escHtml(pmt.invoiceNumber || '–') + '</strong> &nbsp;&mdash;&nbsp; ' + escHtml(pmt.customerName || '–') + '<br>' +
    'Sender: ' + escHtml(pmt.senderName || '–') + ' &nbsp;|&nbsp; Bank: ' + escHtml(pmt.bankName || '–') + '<br>' +
    'Amount: &#8358;' + fmtAdmin(pmt.amountPaid) + ' &nbsp;|&nbsp; Ref: ' + escHtml(pmt.transactionReference || '–') + '<br>' +
    'Submitted: ' + escHtml(submittedAt),
    'info'
  );
}

// Legacy alias – kept for any old data that may reference it
function markInvoicePaid(id) { confirmPayment(id); }
function viewPaymentProof(id) { viewReceiptSubmission(id); }

// 8. Payment badge for admin table
function adminPaymentBadge(status) {
  if (status === 'submitted')         return '<span class="order-badge badge-approved">&#128179; Submitted</span>';
  if (status === 'pending')           return '<span class="order-badge badge-pending">&#8987; Pending</span>';
  if (status === 'confirmed')         return '<span class="order-badge badge-delivered">&#10003; Confirmed</span>';
  if (status === 'rejected')          return '<span class="order-badge badge-rejected">&#10005; Rejected</span>';
  // Legacy statuses (backward compat for old data)
  if (status === 'Awaiting Payment')  return '<span class="order-badge badge-pending">&#8987; Awaiting</span>';
  if (status === 'Receipt Submitted') return '<span class="order-badge badge-approved">&#128179; Submitted</span>';
  if (status === 'Payment Confirmed') return '<span class="order-badge badge-delivered">&#10003; Confirmed</span>';
  if (status === 'Payment Rejected')  return '<span class="order-badge badge-rejected">&#10005; Rejected</span>';
  if (status === 'Payment Submitted') return '<span class="order-badge badge-approved">&#128179; Submitted</span>';
  if (status === 'Paid')              return '<span class="order-badge badge-delivered">&#10003; Confirmed</span>';
  return '<span class="order-badge badge-pending">' + escHtml(status || '–') + '</span>';
}

// 9. Format a number as Naira (admin version, returns string without ₦ prefix duplication)
function fmtAdmin(num) {
  return (parseFloat(num) || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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
