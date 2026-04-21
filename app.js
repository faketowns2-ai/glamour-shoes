// Glamour Shoes - app.js
const WHATSAPP = "5596991219866";
const SHEET_ID = "175ba3frE1EriUa3HR_TtezaOLjg4IM0Ssbr4Q7In9OU";
const ADMIN_PASS = "242526";
const SIZES = ["17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43"];

let products = [];
let cart = [];
let selections = {};
let clientName = "";
let clientPhone = "";
let adminUnlocked = false;

const fmt = v => v.toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
const showToast = msg => {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 3000);
};

function showView(v) {
  ["catalog","cart","adminLogin","admin","checkout"].forEach(x => {
    const el = document.getElementById("view-"+x);
    if(el) el.classList.add("hidden");
  });
  const target = document.getElementById("view-"+v);
  if(target) target.classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  const map = {catalog:0,cart:1,adminLogin:2,admin:2};
  const btns = document.querySelectorAll(".nav-btn");
  if(map[v] !== undefined && btns[map[v]]) btns[map[v]].classList.add("active");
}

function checkPass() {
  const p = document.getElementById("admin-pass").value;
  if(p === ADMIN_PASS) {
    adminUnlocked = true;
    document.getElementById("admin-pass").value = "";
    showView("admin");
    renderAdminProducts();
    const su = localStorage.getItem("appsScriptUrl");
    if(su) document.getElementById("apps-script-url").value = su;
  } else {
    showToast("Senha incorreta!");
  }
}

function saveScriptUrl() {
  const url = document.getElementById("apps-script-url").value.trim();
  if(url) {
    localStorage.setItem("appsScriptUrl", url);
    document.getElementById("script-saved").classList.remove("hidden");
    setTimeout(() => document.getElementById("script-saved").classList.add("hidden"), 2000);
    showToast("URL do Apps Script salva!");
  }
}

async function loadProducts() {
  const grid = document.getElementById("view-catalog");
  grid.innerHTML = '<div class="cart-empty">Carregando produtos...</div>';
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=Produtos`;
    const res = await fetch(url);
    const text = await res.text();
    const json = JSON.parse(text.match(/google\.visualization\.Query\.setResponse\((.+)\)/s)[1]);
    const rows = json.table.rows || [];
    products = rows.map((r,i) => {
      const get = idx => (r.c[idx] && r.c[idx].v != null ? String(r.c[idx].v) : "");
      const sizes = get(5).split(",").map(s=>s.trim()).filter(Boolean);
      return { id: i+1, code: get(0), name: get(1), desc: get(2), price: parseFloat(get(3).replace(",",".")) || 0, image: get(4), sizes };
    }).filter(p => p.name);
    renderProducts();
    renderAdminProducts();
  } catch(e) {
    grid.innerHTML = '<div class="cart-empty">Erro ao carregar. Verifique se a planilha está pública.<br><small>'+e.message+'</small></div>';
  }
}

function renderProducts() {
  const grid = document.getElementById("view-catalog");
  if(!products.length) { grid.innerHTML = '<div class="cart-empty">Nenhum produto encontrado na planilha.</div>'; return; }
  grid.innerHTML = '<h2>Nossos Produtos</h2><div class="product-grid">' +
    products.map(p => {
      const sel = selections[p.id] || {size:"",qty:1};
      const szBtns = p.sizes.map(s => `<button class="size-btn${sel.size===s?" selected":""}" onclick="selectSize(${p.id},'${s}')">${s}</button>`).join("");
      const imgHtml = p.image ? `<img src="${p.image}" alt="${p.name}" onerror="this.parentElement.innerHTML='<div class=no-img>👟</div>'">` : '<div class="no-img">👟</div>';
      return `<div class="product-card">
        <div class="product-img">${imgHtml}</div>
        <div class="product-body">
          ${p.code?'<div class="product-code">'+p.code+'</div>':''}
          <div class="product-name">${p.name}</div>
          <div class="product-desc">${p.desc}</div>
          <div class="product-price">${fmt(p.price)}</div>
          <div class="size-label">Numeração:</div>
          <div class="sizes">${szBtns}</div>
          <div class="qty-row">
            <button class="qty-btn" onclick="changeQty(${p.id},-1)">−</button>
            <span class="qty-val" id="qty-${p.id}">${sel.qty}</span>
            <button class="qty-btn" onclick="changeQty(${p.id},1)">+</button>
          </div>
          <button class="btn-pink" onclick="addToCart(${p.id})">Adicionar ao Carrinho</button>
        </div>
      </div>`;
    }).join("") + '</div>';
}

function selectSize(pid, size) {
  if(!selections[pid]) selections[pid] = {size:"",qty:1};
  selections[pid].size = size;
  renderProducts();
}
function changeQty(pid, delta) {
  if(!selections[pid]) selections[pid] = {size:"",qty:1};
  selections[pid].qty = Math.max(1, (selections[pid].qty || 1) + delta);
  const el = document.getElementById("qty-"+pid);
  if(el) el.textContent = selections[pid].qty;
}
function addToCart(pid) {
  const p = products.find(x => x.id===pid);
  const sel = selections[pid] || {};
  if(!sel.size) { showToast("Selecione um número!"); return; }
  const key = pid+"-"+sel.size;
  const ex = cart.find(i => i.key===key);
  if(ex) { ex.qty += (sel.qty||1); } else { cart.push({key,product:p,size:sel.size,qty:sel.qty||1}); }
  updateCartCount();
  showToast("✓ Adicionado ao carrinho!");
}
function updateCartCount() {
  document.getElementById("cart-count").textContent = cart.reduce((s,i)=>s+i.qty,0);
}
function renderCart() {
  const el = document.getElementById("view-cart");
  if(!cart.length) { el.innerHTML='<div class="cart-empty">Seu carrinho está vazio 🛒</div>'; return; }
  const total = cart.reduce((s,i)=>s+i.product.price*i.qty,0);
  el.innerHTML = '<h2>Carrinho</h2><div class="card">' +
    cart.map(i => `<div class="cart-item">
      <div class="cart-info">
        <div class="cart-name">${i.product.name}</div>
        <div class="cart-size">Nº ${i.size}</div>
        <div class="cart-price">${fmt(i.product.price*i.qty)}</div>
      </div>
      <div class="qty-row-sm">
        <button class="qty-btn-sm" onclick="cartQty('${i.key}',-1)">−</button>
        <span>${i.qty}</span>
        <button class="qty-btn-sm" onclick="cartQty('${i.key}',1)">+</button>
        <button class="remove-btn" onclick="removeItem('${i.key}')">×</button>
      </div>
    </div>`).join("") +
    `<div class="summary-total"><span>Total</span><span>${fmt(total)}</span></div>
    </div>
    <div style="margin-top:20px">
      <h3 style="margin-bottom:12px">Seus dados para o pedido</h3>
      <input class="input-full" placeholder="Seu nome completo" id="client-name" value="${clientName}" oninput="clientName=this.value">
      <input class="input-full" placeholder="Seu WhatsApp (com DDD)" id="client-phone" value="${clientPhone}" oninput="clientPhone=this.value">
      <button class="btn-pink" onclick="sendOrder()">📱 Enviar Pedido via WhatsApp</button>
    </div>`;
}
function cartQty(key, delta) {
  const i = cart.find(x=>x.key===key);
  if(!i) return;
  i.qty = Math.max(1, i.qty+delta);
  renderCart();
}
function removeItem(key) {
  cart = cart.filter(i=>i.key!==key);
  updateCartCount();
  renderCart();
}
function sendOrder() {
  if(!clientName.trim()) { showToast("Digite seu nome!"); return; }
  if(!clientPhone.trim()) { showToast("Digite seu WhatsApp!"); return; }
  if(!cart.length) { showToast("Carrinho vazio!"); return; }
  const total = cart.reduce((s,i)=>s+i.product.price*i.qty,0);
  const lines = cart.map(i=>`• ${i.product.name}${i.product.code?" ("+i.product.code+")":""} | Nº ${i.size} | Qtd: ${i.qty} | ${fmt(i.product.price*i.qty)}`).join("\n");
  const msg = `🛍️ NOVO PEDIDO - Glamour❤️Shoes\n\n👤 Cliente: ${clientName}\n📱 WhatsApp: ${clientPhone}\n\nItens:\n${lines}\n\n💰 TOTAL: ${fmt(total)}\n\nData: ${new Date().toLocaleString("pt-BR")}`;
  
  const scriptUrl = localStorage.getItem("appsScriptUrl");
  if(scriptUrl) {
    fetch(scriptUrl, {
      method:"POST",
      mode:"no-cors",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({action:"savePedido",nome:clientName,whatsapp:clientPhone,itens:lines,total:fmt(total)})
    }).catch(()=>{});
  }
  
  window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(msg)}`,"_blank");
}
function renderAdminProducts() {
  const el = document.getElementById("admin-product-list");
  if(!el) return;
  if(!products.length) { el.innerHTML='<p style="color:#888;font-size:13px">Nenhum produto carregado.</p>'; return; }
  el.innerHTML = products.map(p=>`<div style="padding:8px 0;border-bottom:1px solid #eee;font-size:13px"><strong>${p.name}</strong> ${p.code?"("+p.code+")":""} — ${fmt(p.price)} — Nums: ${p.sizes.join(", ")}</div>`).join("");
}

// Init
loadProducts();
const savedUrl = localStorage.getItem("appsScriptUrl");
if(savedUrl) { const el=document.getElementById("apps-script-url"); if(el) el.value=savedUrl; }
showView("catalog");
