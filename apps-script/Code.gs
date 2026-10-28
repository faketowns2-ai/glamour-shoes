const SHEET_ID = "175ba3frE1EriUa3HR_TtezaOLjg4IM0Ssbr4Q7In9OU";

// ── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const IP_HANDLE   = "yalleybr";                                   // InfiniteTag sem o $
const SITE_URL    = "https://glamour-shoes.vercel.app";
const SCRIPT_URL  = "https://script.google.com/macros/s/AKfycbw1Pdwu6HC8RzYZplOuhZtYw4kbVcLJPWG35DMElEKiLg4ckebqvRcUHfZMUh_zZu3k/exec";
// A senha do Admin fica em Configurações do projeto > Propriedades do script (ADMIN_PASS), nunca no código.
const TOKEN_DIAS  = 30;
const TZ          = "America/Belem";

const H_PROD = ["id","code","gender","name","desc","price","cost","image","featured","stock","varejo"];
const H_ORD  = ["id","date","dateStr","client","phone","items","total","status","origin","ref","comissao","comissaoPaga","pago","pagamento"];
const H_CRM  = ["id","name","phone","orders","pending","lastOrder","since"];
const H_AFI  = ["codigo","nome","whatsapp","pix","comissao","ativo","criado"];

function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handleRequest(e) {
  try {
    let p = {};
    if (e && e.postData && e.postData.contents) { try { p = JSON.parse(e.postData.contents); } catch (x) { p = {}; } }
    if (e && e.parameter) Object.keys(e.parameter).forEach(k => { if (p[k] === undefined) p[k] = e.parameter[k]; });

    // Aviso automático da InfinitePay: chega sem "action"
    let action = p.action;
    if (!action && p.order_nsu && (p.invoice_slug || p.transaction_nsu)) action = "webhook";
    action = action || "load";

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const admin = isAdmin_(p.token);

    switch (action) {
      case "load": {
        // Visitante não vê preço de custo, pedidos, clientes nem afiliados
        const prods = loadProducts(ss);
        const out = { ok: true, admin: admin, products: admin ? prods : prods.map(x => { const c = Object.assign({}, x); delete c.cost; return c; }) };
        if (admin) { out.orders = loadOrders(ss); out.crm = loadCRM(ss); out.afiliados = loadAfiliados(ss); }
        return json_(out);
      }
      case "login":      return json_(login_(p.pass));
      case "logout":     revokeToken_(p.token); return json_({ ok: true });
      case "changePass": {
        if (!admin) return json_({ ok: false, auth: false, error: "Faça login novamente." });
        if (!p.newPass || String(p.newPass).length < 6) return json_({ ok: false, error: "A senha precisa ter pelo menos 6 caracteres." });
        PropertiesService.getScriptProperties().setProperty("ADMIN_PASS", String(p.newPass));
        return json_({ ok: true });
      }
      case "createOrder": return json_(withLock_(() => createOrder_(ss, p, false)));
      case "checkout":    return json_(withLock_(() => createOrder_(ss, p, true)));
      case "confirm":
      case "webhook":     return json_(withLock_(() => confirmPayment_(ss, p)));
      case "saveProducts": case "saveOrders": case "saveCRM": case "saveAll": case "saveAfiliados": {
        if (!admin) return json_({ ok: false, auth: false, error: "Faça login novamente." });
        withLock_(() => {
          const arr = v => typeof v === "string" ? JSON.parse(v) : v;
          if ((action === "saveProducts" || action === "saveAll") && p.products) saveProducts(ss, arr(p.products));
          if ((action === "saveOrders"   || action === "saveAll") && p.orders)   saveOrders(ss, arr(p.orders));
          if ((action === "saveCRM"      || action === "saveAll") && p.crm)      saveCRM(ss, arr(p.crm));
          if ((action === "saveAfiliados"|| action === "saveAll") && p.afiliados) saveAfiliados(ss, arr(p.afiliados));
        });
        return json_({ ok: true });
      }
      default: return json_({ ok: false, error: "Ação desconhecida" });
    }
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ── ACESSO DO ADMIN ──────────────────────────────────────────────────────────
function login_(pass) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("login_fails") || 0);
  if (fails >= 5) return { ok: false, error: "Muitas tentativas. Aguarde 15 minutos." };
  const props = PropertiesService.getScriptProperties();
  const real = props.getProperty("ADMIN_PASS");
  if (!real) return { ok: false, error: "Senha do Admin não configurada no Apps Script." };
  if (String(pass || "") !== real) {
    cache.put("login_fails", String(fails + 1), 900);
    return { ok: false, error: "Senha incorreta!" };
  }
  cache.remove("login_fails");
  const now = Date.now();
  const all = props.getProperties();
  Object.keys(all).forEach(k => { if (k.indexOf("tok_") === 0 && Number(all[k]) < now) props.deleteProperty(k); });
  const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  props.setProperty("tok_" + token, String(now + TOKEN_DIAS * 864e5));
  return { ok: true, token: token };
}
function isAdmin_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return false;
  const exp = PropertiesService.getScriptProperties().getProperty("tok_" + token);
  return !!exp && Number(exp) > Date.now();
}
function revokeToken_(token) {
  if (token && /^[a-f0-9]{64}$/.test(String(token))) PropertiesService.getScriptProperties().deleteProperty("tok_" + token);
}

// ── PEDIDO DO CATÁLOGO (preços e estoque conferidos aqui, nunca no site) ─────
function createOrder_(ss, p, pay) {
  const mode   = p.mode === "varejo" ? "varejo" : "atacado";
  const client = String(p.client || "").trim().slice(0, 80);
  const phone  = String(p.phone  || "").trim().slice(0, 30);
  if (!client) return { ok: false, error: "Informe o nome!" };
  if (phone.replace(/\D/g, "").length < 10) return { ok: false, error: "Informe o WhatsApp com DDD!" };
  const reqItems = Array.isArray(p.items) ? p.items : [];
  if (!reqItems.length || reqItems.length > 40) return { ok: false, error: "Carrinho vazio." };

  const prods = loadProducts(ss);
  const items = [];
  for (const it of reqItems) {
    const prod = prods.find(x => String(x.id) === String(it.pid));
    const qty  = Math.floor(Number(it.qty));
    const size = String(it.size || "");
    if (!prod || isHidden_(prod)) return { ok: false, error: "Um produto do carrinho não está mais disponível." };
    if (!(qty >= 1 && qty <= 50) || size.charAt(0) === "_" || !(size in prod.stock)) return { ok: false, error: "Item inválido no carrinho." };
    const price = unitPrice_(prod, mode);
    if (!(price > 0)) return { ok: false, error: `${prod.name} está sem preço.` };
    const used = items.filter(x => String(x.pid) === String(prod.id) && x.size === size).reduce((s, x) => s + x.qty, 0);
    if ((Number(prod.stock[size]) || 0) < qty + used) return { ok: false, error: `Estoque insuficiente: ${prod.name} nº ${size}.` };
    items.push({ key: prod.id + "-" + size, pid: prod.id, name: prod.name, code: prod.code, image: prod.image,
                 size: size, qty: qty, price: price, cost: Number(prod.cost) || 0 });
  }
  const total = round2_(items.reduce((s, i) => s + i.price * i.qty, 0));

  const afis = loadAfiliados(ss);
  const refCode = String(p.ref || "").toLowerCase();
  const afi = afis.find(a => a.codigo === refCode && a.ativo);

  const now = new Date();
  const order = {
    id: now.getTime(), date: Utilities.formatDate(now, TZ, "yyyy-MM-dd"),
    dateStr: Utilities.formatDate(now, TZ, "dd/MM/yyyy, HH:mm:ss"),
    client: client, phone: phone, items: items, total: total, status: "pending",
    origin: mode === "varejo" ? "varejo" : "catalog", ref: afi ? afi.codigo : "",
    comissao: 0, comissaoPaga: false, pago: false, pagamento: {}
  };

  let url = "";
  if (pay) {
    const digits = phone.replace(/\D/g, "");
    const body = {
      handle: IP_HANDLE,
      order_nsu: String(order.id),
      redirect_url: SITE_URL + (mode === "varejo" ? "/varejo" : "/") + "?pedido=" + order.id,
      webhook_url: SCRIPT_URL,
      items: items.map(i => ({ quantity: i.qty, price: Math.round(i.price * 100), description: `${i.name} nº ${i.size}`.slice(0, 120) })),
      customer: { name: client, phone_number: "+55" + (digits.length > 11 ? digits.slice(-11) : digits) }
    };
    const res = UrlFetchApp.fetch("https://api.checkout.infinitepay.io/links", {
      method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true });
    let r = {};
    try { r = JSON.parse(res.getContentText()); } catch (x) {}
    if (res.getResponseCode() >= 300 || !r.url) return { ok: false, error: "Não foi possível gerar o pagamento agora. Tente de novo ou finalize pelo WhatsApp." };
    url = r.url;
    order.pagamento = { link: url, aguardando: true };
  }

  appendOrder_(ss, order);
  upsertCRM_(ss, order);
  return { ok: true, id: order.id, total: total, url: url, ref: order.ref };
}

function isHidden_(prod) { return !!(prod.stock && prod.stock._oculto); }
function unitPrice_(prod, mode) {
  if (mode === "varejo") return Number(prod.varejo) > 0 ? Number(prod.varejo) : (Number(prod.stock && prod.stock._varejo) || 0);
  return Number(prod.price) || 0;
}
function round2_(v) { return Math.round(v * 100) / 100; }

// ── CONFIRMAÇÃO DE PAGAMENTO (sempre conferida direto com a InfinitePay) ─────
function confirmPayment_(ss, p) {
  const nsu  = String(p.order_nsu || p.pedido || "");
  const tnsu = String(p.transaction_nsu || "");
  const slug = String(p.slug || p.invoice_slug || "");
  if (!nsu || !tnsu || !slug) return { ok: false, error: "Dados do pagamento incompletos." };

  const sh = ss.getSheetByName("Pedidos");
  const rows = sh.getDataRange().getValues();
  const hdr = rows[0].map(h => String(h).trim());
  const iId = hdr.indexOf("id");
  let rowIdx = -1;
  for (let i = 1; i < rows.length; i++) if (String(rows[i][iId]) === nsu) { rowIdx = i; break; }
  if (rowIdx < 0) return { ok: false, error: "Pedido não encontrado." };
  const order = rowToOrder_(hdr, rows[rowIdx]);
  if (order.pago) return { ok: true, paid: true, order: publicOrder_(order) };
  if (order.status === "cancelled") return { ok: false, error: "Pedido cancelado." };

  const res = UrlFetchApp.fetch("https://api.checkout.infinitepay.io/payment_check", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({ handle: IP_HANDLE, order_nsu: nsu, transaction_nsu: tnsu, slug: slug }) });
  let r = {};
  try { r = JSON.parse(res.getContentText()); } catch (x) {}
  const paidCents = Number(r.paid_amount || r.amount || 0);
  const totalCents = Math.round(order.total * 100);
  if (!(r.success && r.paid) || paidCents < totalCents) return { ok: true, paid: false };

  // Pago: confirma, baixa estoque, calcula comissão, atualiza cliente
  const afi = order.ref ? loadAfiliados(ss).find(a => a.codigo === order.ref) : null;
  order.status = "confirmed";
  order.pago = true;
  order.comissao = afi ? round2_(order.total * (Number(afi.comissao) || 0) / 100) : 0;
  order.pagamento = {
    transaction_nsu: tnsu, slug: slug, receipt_url: String(p.receipt_url || ""),
    metodo: String(r.capture_method || p.capture_method || ""), parcelas: Number(r.installments || 1),
    valorPago: paidCents / 100, pagoEm: Utilities.formatDate(new Date(), TZ, "dd/MM/yyyy, HH:mm:ss")
  };
  sh.getRange(rowIdx + 1, 1, 1, H_ORD.length).setValues([orderRow_(order)]);
  decrementStock_(ss, order.items);
  const crm = ss.getSheetByName("CRM");
  if (crm) {
    const cr = crm.getDataRange().getValues();
    for (let i = 1; i < cr.length; i++) if (String(cr[i][2]) === order.phone) {
      crm.getRange(i + 1, 4, 1, 2).setValues([[Number(cr[i][3] || 0) + 1, Math.max(0, Number(cr[i][4] || 1) - 1)]]);
      break;
    }
  }
  return { ok: true, paid: true, order: publicOrder_(order) };
}
function publicOrder_(o) {
  return { id: o.id, client: o.client, total: o.total, items: o.items.map(i => ({ name: i.name, size: i.size, qty: i.qty, price: i.price })) };
}
function decrementStock_(ss, items) {
  const sh = ss.getSheetByName("Produtos");
  const rows = sh.getDataRange().getValues();
  const hdr = rows[0].map(h => String(h).trim().toLowerCase());
  const iId = hdr.indexOf("id"), iSt = hdr.indexOf("stock");
  items.forEach(it => {
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][iId]) !== String(it.pid)) continue;
      let st = {};
      try { st = typeof rows[i][iSt] === "string" ? JSON.parse(rows[i][iSt]) : (rows[i][iSt] || {}); } catch (x) {}
      if (st[it.size] !== undefined) st[it.size] = Math.max(0, (Number(st[it.size]) || 0) - it.qty);
      rows[i][iSt] = JSON.stringify(st);
      sh.getRange(i + 1, iSt + 1).setValue(rows[i][iSt]);
      break;
    }
  });
}

// ── LOAD ────────────────────────────────────────────────────────────────────
function readSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return null;
  const rows = sh.getDataRange().getValues();
  if (rows.length < 2) return { hdr: rows[0] ? rows[0].map(h => String(h).trim()) : [], rows: [] };
  return { hdr: rows[0].map(h => String(h).trim()), rows: rows.slice(1).filter(r => r[0] !== "" && r[0] !== null && r[0] !== undefined) };
}
function rowObj_(hdr, r) { const o = {}; hdr.forEach((h, i) => { o[h.toLowerCase()] = r[i]; }); return o; }
function parseJ_(v, d) { if (typeof v !== "string") return v || d; try { return JSON.parse(v); } catch (e) { return d; } }
function bool_(v) { return v === true || v === "true" || v === "TRUE"; }

function loadProducts(ss) {
  const t = readSheet_(ss, "Produtos");
  if (!t) return [];
  return t.rows.map(r => {
    const o = rowObj_(t.hdr, r);
    return {
      id:       String(o.id   || ""),
      code:     String(o.code || ""),
      gender:   String(o.gender || "Feminino"),
      name:     String(o.name  || ""),
      desc:     String(o.desc  || ""),
      price:    Number(o.price || 0),
      cost:     Number(o.cost  || 0),
      image:    String(o.image || ""),
      featured: bool_(o.featured),
      varejo:   Number(o.varejo || 0),
      stock:    parseJ_(o.stock, {})
    };
  });
}

function rowToOrder_(hdr, r) {
  const o = rowObj_(hdr, r);
  return {
    id:      o.id,
    date:    String(o.date    || ""),
    dateStr: String(o.datestr || ""),
    client:  String(o.client  || ""),
    phone:   String(o.phone   || ""),
    items:   parseJ_(o.items, []),
    total:   Number(o.total   || 0),
    status:  String(o.status  || "pending"),
    origin:  String(o.origin  || "catalog"),
    ref:     String(o.ref     || ""),
    comissao: Number(o.comissao || 0),
    comissaoPaga: bool_(o.comissaopaga),
    pago:    bool_(o.pago),
    pagamento: parseJ_(o.pagamento, {})
  };
}
function loadOrders(ss) {
  const t = readSheet_(ss, "Pedidos");
  return t ? t.rows.map(r => rowToOrder_(t.hdr, r)) : [];
}

function loadCRM(ss) {
  const t = readSheet_(ss, "CRM");
  if (!t) return [];
  return t.rows.map(r => {
    const o = rowObj_(t.hdr, r);
    return {
      id:        o.id,
      name:      String(o.name      || ""),
      phone:     String(o.phone     || ""),
      orders:    Number(o.orders    || 0),
      pending:   Number(o.pending   || 0),
      lastOrder: String(o.lastorder || ""),
      since:     String(o.since     || "")
    };
  });
}

function loadAfiliados(ss) {
  const t = readSheet_(ss, "Afiliados");
  if (!t) return [];
  return t.rows.map(r => {
    const o = rowObj_(t.hdr, r);
    return {
      codigo:   String(o.codigo || "").toLowerCase(),
      nome:     String(o.nome || ""),
      whatsapp: String(o.whatsapp || ""),
      pix:      String(o.pix || ""),
      comissao: Number(o.comissao || 0),
      ativo:    o.ativo === "" || o.ativo === undefined ? true : bool_(o.ativo),
      criado:   String(o.criado || "")
    };
  });
}

// ── SAVE ────────────────────────────────────────────────────────────────────
function writeAll_(ss, name, headers, rows) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const data = [headers].concat(rows);
  sh.clearContents();
  sh.getRange(1, 1, data.length, headers.length).setValues(data);
}
function ensureHeader_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const cur = sh.getLastRow() > 0 ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String) : [];
  if (cur.join("|") !== headers.join("|")) {
    // Reescreve no formato novo, preservando os dados existentes
    if (name === "Pedidos") writeAll_(ss, name, headers, loadOrders(ss).map(orderRow_));
    else sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return ss.getSheetByName(name);
}

function saveProducts(ss, products) {
  const costs = {};
  loadProducts(ss).forEach(x => { costs[String(x.id)] = x.cost; });
  products.forEach(p => { if (p.cost === undefined || p.cost === null || p.cost === "") p.cost = costs[String(p.id)] || 0; });
  writeAll_(ss, "Produtos", H_PROD, products.map(p => [
    p.id || "", p.code || "", p.gender || "Feminino", p.name || "", p.desc || "",
    Number(p.price || 0), Number(p.cost || 0), p.image || "", p.featured ? true : false,
    JSON.stringify(p.stock || {}), Number(p.varejo || 0)
  ]));
}

function orderRow_(o) {
  return [
    o.id || "", o.date || "", o.dateStr || "", o.client || "", o.phone || "",
    JSON.stringify(o.items || []), Number(o.total || 0), o.status || "pending", o.origin || "catalog",
    o.ref || "", Number(o.comissao || 0), o.comissaoPaga ? true : false, o.pago ? true : false,
    JSON.stringify(o.pagamento || {})
  ];
}
function appendOrder_(ss, order) {
  const sh = ensureHeader_(ss, "Pedidos", H_ORD);
  // pedidos novos ficam no topo, como no painel
  if (sh.getLastRow() >= 2) { sh.insertRowBefore(2); sh.getRange(2, 1, 1, H_ORD.length).setValues([orderRow_(order)]); }
  else sh.getRange(2, 1, 1, H_ORD.length).setValues([orderRow_(order)]);
}

// O Admin manda a lista inteira. Mesclamos com a planilha para não perder
// pedidos criados ou pagos enquanto o painel estava aberto.
function saveOrders(ss, orders) {
  const server = loadOrders(ss);
  const byId = {};
  server.forEach(o => { byId[String(o.id)] = o; });
  const seen = {};
  const merged = orders.map(o => {
    const k = String(o.id); seen[k] = true;
    const s = byId[k];
    if (s && s.pago && !o.pago) return Object.assign({}, s, { comissaoPaga: !!o.comissaoPaga });
    if (s && s.pagamento && s.pagamento.link && !(o.pagamento && o.pagamento.link)) o.pagamento = s.pagamento;
    return o;
  });
  const missing = server.filter(o => !seen[String(o.id)]);
  writeAll_(ss, "Pedidos", H_ORD, missing.concat(merged).map(orderRow_));
}

function upsertCRM_(ss, order) {
  let sh = ss.getSheetByName("CRM");
  if (!sh) { writeAll_(ss, "CRM", H_CRM, []); sh = ss.getSheetByName("CRM"); }
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2]) === order.phone) {
      sh.getRange(i + 1, 2).setValue(order.client);
      sh.getRange(i + 1, 5, 1, 2).setValues([[Number(rows[i][4] || 0) + 1, order.date]]);
      return;
    }
  }
  sh.appendRow([order.id + Math.random(), order.client, order.phone, 0, 1, order.date, order.date]);
}
function saveCRM(ss, crm) {
  const server = loadCRM(ss);
  const phones = {};
  crm.forEach(c => { phones[String(c.phone)] = true; });
  const all = crm.concat(server.filter(c => !phones[String(c.phone)]));
  writeAll_(ss, "CRM", H_CRM, all.map(c => [
    c.id || "", c.name || "", c.phone || "", Number(c.orders || 0), Number(c.pending || 0), c.lastOrder || "", c.since || ""
  ]));
}

function saveAfiliados(ss, afis) {
  writeAll_(ss, "Afiliados", H_AFI, afis.map(a => [
    String(a.codigo || "").toLowerCase(), a.nome || "", a.whatsapp || "", a.pix || "",
    Number(a.comissao || 0), a.ativo === false ? false : true, a.criado || ""
  ]));
}

