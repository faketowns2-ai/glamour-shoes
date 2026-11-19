// Glamour Shoes: servidor MCP (Model Context Protocol) para o Claude.
// Endereço do conector: https://glamour-shoes.vercel.app/api/mcp?k=SUA_CHAVE
//
// Variáveis de ambiente (Vercel > Settings > Environment Variables):
//   GS_MCP_KEY     chave secreta do conector (a mesma que vai no ?k= do endereço)
//   GS_ADMIN_PASS  senha do Admin do painel (usada para entrar na planilha)
//   GS_SCRIPT_URL  opcional: URL do Apps Script (padrão abaixo)
//
// Toda ferramenta que altera dados mostra uma PRÉVIA primeiro. Só grava com confirmar=true.

const crypto = require("crypto");

const SITE = "https://glamour-shoes.vercel.app";
const SCRIPT_URL_PADRAO = "https://script.google.com/macros/s/AKfycbw1Pdwu6HC8RzYZplOuhZtYw4kbVcLJPWG35DMElEKiLg4ckebqvRcUHfZMUh_zZu3k/exec";
const VERSAO = "1.1.0";
const GEN = ["Feminino", "Masculino", "Infantil"];

// ─── acesso à planilha (Apps Script) ─────────────────────────────────────────
let TOKEN = null;
const scriptUrl = () => process.env.GS_SCRIPT_URL || SCRIPT_URL_PADRAO;

async function gas(body) {
  const r = await fetch(scriptUrl(), { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), redirect: "follow" });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { throw new Error("Resposta inválida da planilha (HTTP " + r.status + ")."); }
}
async function login() {
  if (!process.env.GS_ADMIN_PASS) throw new Error("Falta configurar GS_ADMIN_PASS no Vercel.");
  const d = await gas({ action: "login", pass: process.env.GS_ADMIN_PASS });
  if (!d.ok || !d.token) throw new Error("Não consegui entrar na planilha: " + (d.error || "erro"));
  TOKEN = d.token;
}
async function admin(body) {
  if (!TOKEN) await login();
  let d = await gas({ ...body, token: TOKEN });
  if (d && d.auth === false) { await login(); d = await gas({ ...body, token: TOKEN }); }
  if (!d || d.ok === false) throw new Error((d && d.error) || "Erro na planilha.");
  return d;
}
const carrega = () => admin({ action: "load" });

// ─── produtos ────────────────────────────────────────────────────────────────
const tams = p => Object.keys(p.stock || {}).filter(k => k[0] !== "_" && (+p.stock[k] || 0) > 0).sort((a, b) => +a - +b);
const grade = p => Object.keys(p.stock || {}).filter(k => k[0] !== "_").sort((a, b) => +a - +b);
const pares = p => grade(p).reduce((s, k) => s + (+p.stock[k] || 0), 0);
const oculto = p => !!(p.stock && p.stock._oculto);
const promo = p => { const v = +((p.stock || {})._promo) || 0, b = +p.price || 0; return v > 0 && v < b ? v : 0; };
const varejo = p => +p.varejo || +((p.stock || {})._varejo) || 0;
const atacado = p => promo(p) || (+p.price || 0);
const descPct = p => promo(p) ? Math.round((1 - promo(p) / (+p.price)) * 100) : 0;
const novoTs = p => +p.id > 1e12 ? +p.id : 0;
const brl = v => "R$ " + (Number(v) || 0).toFixed(2).replace(".", ",");
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const link = (p, modo, afi) => modo === "varejo"
  ? `${SITE}/varejo?${afi ? "ref=" + encodeURIComponent(afi) + "&" : ""}p=${encodeURIComponent(p.id)}`
  : `${SITE}/?p=${encodeURIComponent(p.id)}`;

function resumoProd(p, i) {
  return {
    pos: i + 1, id: String(p.id), codigo: p.code, nome: String(p.name || "").trim(), genero: p.gender,
    atacado: +p.price || 0, promo: promo(p) || null, desconto: descPct(p) ? descPct(p) + "%" : null,
    varejo: varejo(p) || null, custo: +p.cost || 0, destaque: !!p.featured, oculto: oculto(p),
    numeracoes: tams(p), pares: pares(p), novo: novoTs(p) ? new Date(novoTs(p)).toISOString().slice(0, 10) : undefined
  };
}
function acha(prods, ref) {
  const r = norm(ref);
  if (!r) return [];
  let m = prods.filter(p => norm(p.code) === r || norm(p.id) === r);
  if (!m.length) m = prods.filter(p => norm(p.name) === r);
  if (!m.length) m = prods.filter(p => norm(p.name).includes(r));
  return m;
}
function resolve(prods, refs) {
  const ok = [], erros = [];
  for (const ref of [].concat(refs || [])) {
    const m = acha(prods, ref);
    if (m.length === 1) { if (!ok.includes(m[0])) ok.push(m[0]); }
    else if (!m.length) erros.push(`"${ref}": nenhum produto encontrado`);
    else erros.push(`"${ref}": ${m.length} produtos parecidos (${m.slice(0, 5).map(p => p.code + " " + p.name.trim()).join("; ")}). Use o código.`);
  }
  return { ok, erros };
}
async function salvaProdutos(prods, qtdOriginal) {
  if (!Array.isArray(prods) || prods.length !== qtdOriginal) throw new Error("Proteção: a lista de produtos mudou de tamanho. Nada foi salvo.");
  await admin({ action: "saveProducts", products: prods });
}

const ORDENS = {
  destaque: (a, b) => !!b.featured - !!a.featured,
  promo: (a, b) => (promo(b) ? 1 - promo(b) / b.price : 0) - (promo(a) ? 1 - promo(a) / a.price : 0),
  novos: (a, b) => novoTs(b) - novoTs(a) || String(b.code).localeCompare(String(a.code), "pt-BR", { numeric: true }),
  fem: (a, b) => (b.gender === "Feminino") - (a.gender === "Feminino"),
  masc: (a, b) => (b.gender === "Masculino") - (a.gender === "Masculino"),
  inf: (a, b) => (b.gender === "Infantil") - (a.gender === "Infantil"),
  grade: (a, b) => tams(b).length - tams(a).length,
  pares: (a, b) => pares(b) - pares(a),
  menor: (a, b) => atacado(a) - atacado(b),
  maior: (a, b) => atacado(b) - atacado(a),
  az: (a, b) => String(a.name).localeCompare(String(b.name), "pt-BR", { sensitivity: "base", numeric: true }),
  za: (a, b) => String(b.name).localeCompare(String(a.name), "pt-BR", { sensitivity: "base", numeric: true }),
  codigo: (a, b) => String(a.code).localeCompare(String(b.code), "pt-BR", { numeric: true }),
  esgfim: (a, b) => ((oculto(a) || pares(a) <= 0) - (oculto(b) || pares(b) <= 0))
};

// ─── ferramentas ─────────────────────────────────────────────────────────────
const S_PRODS = { type: "array", items: { type: "string" }, description: "Produtos por código (ex.: \"135\"), id ou nome." };
const S_CONF = { type: "boolean", description: "false ou ausente = só mostra a prévia. true = grava na planilha (só depois que o usuário aprovar a prévia)." };
const LEITURA = { readOnlyHint: true, openWorldHint: false };
const ESCRITA = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "resumo_loja", title: "Resumo da loja", annotations: LEITURA,
    description: "Visão geral da Glamour Shoes: produtos (visíveis, ocultos, esgotados, promoções, destaques), pedidos pendentes e faturamento recente, afiliadas pendentes e saques pendentes.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const d = await carrega();
      const P = d.products || [], O = d.orders || [];
      const dias = n => { const t = Date.now() - n * 864e5; return O.filter(o => new Date(o.date).getTime() >= t && o.status !== "cancelled"); };
      const soma = a => a.reduce((s, o) => s + (+o.total || 0), 0);
      const pend = O.filter(o => o.status === "pending");
      return {
        produtos: { total: P.length, visiveis: P.filter(p => !oculto(p)).length, ocultos: P.filter(oculto).length,
          esgotados_visiveis: P.filter(p => !oculto(p) && pares(p) <= 0).map(p => p.code + " " + p.name.trim()),
          em_promocao: P.filter(p => !oculto(p) && promo(p)).length, destaques: P.filter(p => p.featured).map(p => p.code + " " + p.name.trim()),
          pares_em_estoque: P.filter(p => !oculto(p)).reduce((s, p) => s + pares(p), 0) },
        pedidos: { pendentes: pend.length, valor_pendente: brl(soma(pend)),
          ultimos_7_dias: { qtd: dias(7).length, valor: brl(soma(dias(7))) }, ultimos_30_dias: { qtd: dias(30).length, valor: brl(soma(dias(30))) } },
        clientes: (d.crm || []).length,
        afiliadas: { aprovadas: (d.afiliados || []).filter(a => a.status === "aprovado").length, pendentes: (d.afiliados || []).filter(a => a.status === "pendente").map(a => a.nome),
          comissao_padrao: d.comissaoPadrao },
        saques_pendentes: (d.saques || []).filter(s => s.status === "pendente").map(s => `${s.nome}: ${brl(s.valor)}`)
      };
    }
  },
  {
    name: "listar_produtos", title: "Listar produtos", annotations: LEITURA,
    description: "Lista produtos na ordem em que aparecem no catálogo (pos = posição), com preços, promoção, varejo, custo, destaque, oculto e numerações disponíveis. Filtros opcionais.",
    inputSchema: { type: "object", properties: {
      busca: { type: "string", description: "Parte do nome ou código." },
      genero: { type: "string", enum: GEN },
      numeracao: { type: "string", description: "Só produtos com essa numeração em estoque, ex.: \"37\"." },
      so_com_estoque: { type: "boolean" }, so_promocao: { type: "boolean" }, so_destaques: { type: "boolean" },
      incluir_ocultos: { type: "boolean", description: "Padrão: true." },
      limite: { type: "number", description: "Padrão 100." } } },
    async run(a) {
      const d = await carrega();
      let L = (d.products || []).map((p, i) => [p, i]);
      if (a.busca) L = L.filter(([p]) => norm(p.name + " " + p.code).includes(norm(a.busca)));
      if (a.genero) L = L.filter(([p]) => p.gender === a.genero);
      if (a.numeracao) L = L.filter(([p]) => (+((p.stock || {})[a.numeracao]) || 0) > 0);
      if (a.so_com_estoque) L = L.filter(([p]) => pares(p) > 0);
      if (a.so_promocao) L = L.filter(([p]) => promo(p));
      if (a.so_destaques) L = L.filter(([p]) => p.featured);
      if (a.incluir_ocultos === false) L = L.filter(([p]) => !oculto(p));
      return { total: L.length, produtos: L.slice(0, a.limite || 100).map(([p, i]) => resumoProd(p, i)) };
    }
  },
  {
    name: "ver_produto", title: "Ver produto", annotations: LEITURA,
    description: "Todos os detalhes de um produto: estoque por numeração, preços, margem, descrição, fotos e links do catálogo.",
    inputSchema: { type: "object", properties: { produto: { type: "string", description: "Código, id ou nome." } }, required: ["produto"] },
    async run(a) {
      const P = (await carrega()).products || [];
      const m = acha(P, a.produto);
      if (m.length !== 1) return { erro: m.length ? "Mais de um produto encontrado." : "Produto não encontrado.", opcoes: m.slice(0, 10).map(p => resumoProd(p, P.indexOf(p))) };
      const p = m[0];
      const est = {}; grade(p).forEach(k => est[k] = +p.stock[k] || 0);
      return { ...resumoProd(p, P.indexOf(p)), descricao: p.desc, estoque: est,
        margem_atacado: atacado(p) > 0 ? Math.round((1 - p.cost / atacado(p)) * 100) + "%" : null,
        foto: p.image, fotos_extras: (p.stock || {})._fotos || [], link_atacado: link(p, "atacado"), link_varejo: link(p, "varejo") };
    }
  },
  {
    name: "atualizar_produtos", title: "Atualizar produtos", annotations: ESCRITA,
    description: "Aplica as mesmas alterações a um ou mais produtos: preços, promoção (por valor ou % de desconto sobre o atacado), destaque, ocultar/mostrar, nome, descrição, gênero, custo. Primeiro mostra a prévia; grava só com confirmar=true.",
    inputSchema: { type: "object", properties: {
      produtos: S_PRODS,
      alteracoes: { type: "object", properties: {
        preco_atacado: { type: "number" }, preco_varejo: { type: "number" }, custo: { type: "number" },
        preco_promocional: { type: "number", description: "Preço promocional de atacado. 0 remove a promoção." },
        desconto_percentual: { type: "number", description: "Alternativa ao preco_promocional: % sobre o preço de atacado." },
        destaque: { type: "boolean" }, oculto: { type: "boolean" },
        nome: { type: "string" }, descricao: { type: "string" }, genero: { type: "string", enum: GEN } } },
      confirmar: S_CONF }, required: ["produtos", "alteracoes"] },
    async run(a) {
      const P = (await carrega()).products || [], n0 = P.length;
      const { ok, erros } = resolve(P, a.produtos);
      if (erros.length) return { erro: "Ajuste os produtos antes de continuar.", detalhes: erros };
      const c = a.alteracoes || {}, mud = [];
      for (const p of ok) {
        const antes = resumoProd(p, P.indexOf(p));
        p.stock = { ...(p.stock || {}) };
        if (c.preco_atacado != null) p.price = +c.preco_atacado;
        if (c.preco_varejo != null) { p.varejo = +c.preco_varejo; if (+c.preco_varejo > 0) p.stock._varejo = +c.preco_varejo; else delete p.stock._varejo; }
        if (c.custo != null) p.cost = +c.custo;
        if (c.desconto_percentual != null) {
          const v = Math.round((+p.price) * (1 - c.desconto_percentual / 100) * 100) / 100;
          if (c.desconto_percentual > 0 && v > 0) p.stock._promo = v; else delete p.stock._promo;
        }
        if (c.preco_promocional != null) { if (+c.preco_promocional > 0) p.stock._promo = +c.preco_promocional; else delete p.stock._promo; }
        if (p.stock._promo && !(+p.stock._promo < +p.price)) erros.push(`${p.code}: promoção (${brl(p.stock._promo)}) precisa ser menor que o atacado (${brl(p.price)}).`);
        if (c.destaque != null) p.featured = !!c.destaque;
        if (c.oculto != null) { if (c.oculto) p.stock._oculto = 1; else delete p.stock._oculto; }
        if (c.nome) p.name = c.nome;
        if (c.descricao != null) p.desc = c.descricao;
        if (c.genero) p.gender = c.genero;
        mud.push({ antes, depois: resumoProd(p, P.indexOf(p)) });
      }
      if (erros.length) return { erro: "Nada foi salvo.", detalhes: erros };
      if (!a.confirmar) return { previa: true, mensagem: "Prévia. Nada foi salvo. Confirme com o usuário e chame de novo com confirmar=true.", alteracoes: mud };
      await salvaProdutos(P, n0);
      return { salvo: true, alteracoes: mud.map(m => m.depois) };
    }
  },
  {
    name: "ajustar_estoque", title: "Ajustar estoque", annotations: ESCRITA,
    description: "Define ou soma quantidades por numeração de um produto. Ex.: {\"37\":2,\"38\":-1} com modo somar. Prévia primeiro; grava com confirmar=true.",
    inputSchema: { type: "object", properties: {
      produto: { type: "string" }, estoque: { type: "object", additionalProperties: { type: "number" }, description: "numeração: quantidade" },
      modo: { type: "string", enum: ["definir", "somar"], description: "Padrão: definir." }, confirmar: S_CONF }, required: ["produto", "estoque"] },
    async run(a) {
      const P = (await carrega()).products || [], n0 = P.length;
      const { ok, erros } = resolve(P, [a.produto]);
      if (erros.length) return { erro: erros.join(" ") };
      const p = ok[0]; p.stock = { ...(p.stock || {}) };
      const antes = {}; grade(p).forEach(k => antes[k] = +p.stock[k] || 0);
      for (const [k, v] of Object.entries(a.estoque || {})) {
        if (!/^\d{1,2}$/.test(k)) return { erro: `Numeração inválida: ${k}` };
        const nv = a.modo === "somar" ? (+p.stock[k] || 0) + (+v) : +v;
        if (nv < 0) return { erro: `Estoque do nº ${k} ficaria negativo.` };
        p.stock[k] = Math.floor(nv);
      }
      const depois = {}; grade(p).forEach(k => depois[k] = +p.stock[k] || 0);
      if (!a.confirmar) return { previa: true, produto: p.code + " " + p.name.trim(), antes, depois };
      await salvaProdutos(P, n0);
      return { salvo: true, produto: p.code + " " + p.name.trim(), estoque: depois };
    }
  },
  {
    name: "ordenar_catalogo", title: "Ordenar catálogo", annotations: ESCRITA,
    description: "Define a ordem em que os produtos aparecem no catálogo. Aplica os critérios em sequência (cada um preserva a ordem anterior entre empatados), depois coloca produtos escolhidos no topo e/ou no final. Critérios: destaque, promo, novos, fem, masc, inf, grade (mais numerações), pares (mais estoque), menor, maior (preço), az, za, codigo, esgfim (esgotados e ocultos no final). Prévia primeiro; grava com confirmar=true.",
    inputSchema: { type: "object", properties: {
      criterios: { type: "array", items: { type: "string", enum: Object.keys(ORDENS) }, description: "Aplicados na ordem dada; o último manda mais." },
      topo: { ...S_PRODS, description: "Produtos que ficam nas primeiras posições, nesta ordem." },
      final: { ...S_PRODS, description: "Produtos que ficam no final, nesta ordem." },
      confirmar: S_CONF } },
    async run(a) {
      const P = (await carrega()).products || [], n0 = P.length;
      let L = P.slice();
      for (const c of a.criterios || []) L = L.slice().sort(ORDENS[c]);
      const t = resolve(P, a.topo || []), f = resolve(P, a.final || []);
      const erros = t.erros.concat(f.erros);
      if (erros.length) return { erro: "Ajuste os produtos.", detalhes: erros };
      L = t.ok.concat(L.filter(p => !t.ok.includes(p) && !f.ok.includes(p)), f.ok.filter(p => !t.ok.includes(p)));
      const vis = L.filter(p => !oculto(p) && pares(p) > 0);
      const res = { primeiros_no_catalogo: vis.slice(0, 15).map((p, i) => `${i + 1}. ${p.code} ${p.name.trim()}${p.featured ? " ⭐" : ""}${promo(p) ? " 🔥-" + descPct(p) + "%" : ""} (${p.gender})`) };
      if (!a.confirmar) return { previa: true, mensagem: "Prévia. Nada foi salvo.", ...res };
      await salvaProdutos(L, n0);
      return { salvo: true, ...res };
    }
  },
  {
    name: "listar_pedidos", title: "Listar pedidos", annotations: LEITURA,
    description: "Pedidos (mais recentes primeiro) com cliente, telefone, itens, total, status (pending = aguardando, confirmed, cancelled), origem e afiliada.",
    inputSchema: { type: "object", properties: {
      status: { type: "string", enum: ["pending", "confirmed", "cancelled"] }, dias: { type: "number", description: "Só dos últimos N dias." },
      busca: { type: "string", description: "Nome ou telefone do cliente." }, limite: { type: "number", description: "Padrão 30." } } },
    async run(a) {
      let O = ((await carrega()).orders || []).slice().sort((x, y) => (+y.id || 0) - (+x.id || 0));
      if (a.status) O = O.filter(o => o.status === a.status);
      if (a.dias) { const t = Date.now() - a.dias * 864e5; O = O.filter(o => new Date(o.date).getTime() >= t); }
      if (a.busca) { const b = norm(a.busca), dg = String(a.busca).replace(/\D/g, ""); O = O.filter(o => norm(o.client).includes(b) || (dg.length >= 4 && String(o.phone).includes(dg))); }
      return { total: O.length, pedidos: O.slice(0, a.limite || 30).map(o => ({
        id: o.id, data: o.dateStr || o.date, cliente: o.client, telefone: o.phone, status: o.status, pago: !!o.pago, total: brl(o.total),
        origem: o.origin, afiliada: o.ref || undefined, itens: (o.items || []).map(i => `${i.qty}x ${i.code || ""} ${String(i.name || "").trim()} nº ${i.size} (${brl(i.price)})`) })) };
    }
  },
  {
    name: "atualizar_pedido", title: "Atualizar pedido", annotations: { ...ESCRITA, idempotentHint: false },
    description: "Confirma, cancela ou marca como pago um pedido. confirmar = igual ao botão Confirmar do Admin (baixa o estoque e atualiza o cliente no CRM). " +
      "marcar_pago = registra pagamento recebido fora da InfinitePay (PIX, dinheiro, cartão na loja); se o pedido ainda estiver aguardando, também confirma e baixa o estoque; com afiliada, calcula a comissão. " +
      "cancelar = só para pedidos aguardando. Pedido por id, ou por nome/telefone do cliente quando só houver um pedido compatível. Prévia primeiro; grava com confirmar=true.",
    inputSchema: { type: "object", properties: {
      pedido: { type: "string", description: "Id do pedido, ou nome/telefone do cliente." },
      acao: { type: "string", enum: ["confirmar", "cancelar", "marcar_pago"] },
      forma_pagamento: { type: "string", description: "Só para marcar_pago, ex.: pix, dinheiro, cartão." },
      confirmar: S_CONF }, required: ["pedido", "acao"] },
    async run(a) {
      const d = await carrega();
      const P = d.products || [], n0 = P.length, O = d.orders || [], C = d.crm || [];
      const ref = String(a.pedido || "").trim(), b = norm(ref), dg = ref.replace(/\D/g, "");
      let m = O.filter(o => String(o.id) === ref);
      if (!m.length) m = O.filter(o => norm(o.client).includes(b) || (dg.length >= 4 && String(o.phone).includes(dg)));
      // por nome, prefere os pedidos em que a ação faz sentido
      if (m.length > 1) {
        const util = m.filter(o => a.acao === "marcar_pago" ? !o.pago && o.status !== "cancelled" : o.status === "pending");
        if (util.length) m = util;
      }
      const curto = o => `${o.id} • ${o.client} • ${o.dateStr || o.date} • ${brl(o.total)} • ${o.status}${o.pago ? " • pago" : ""}`;
      if (!m.length) return { erro: "Pedido não encontrado." };
      if (m.length > 1) return { erro: "Mais de um pedido encontrado. Use o id.", opcoes: m.slice(0, 10).map(curto) };
      const o = m[0];
      const antes = { status: o.status, pago: !!o.pago };
      const avisos = [];
      if (a.acao === "cancelar" && o.status !== "pending") return { erro: `Só dá para cancelar pedido aguardando. Este está ${o.status}.` };
      if (a.acao === "confirmar" && o.status !== "pending") return { erro: `Este pedido já está ${o.status}.` };
      if (a.acao === "marcar_pago" && o.pago) return { erro: "Este pedido já está marcado como pago." };
      if (a.acao === "marcar_pago" && o.status === "cancelled") return { erro: "Pedido cancelado não pode ser marcado como pago." };

      const confirma = o.status === "pending" && (a.acao === "confirmar" || a.acao === "marcar_pago");
      const baixas = [];
      if (confirma) {
        for (const it of o.items || []) {
          const p = P.find(x => String(x.id) === String(it.pid || it.productId));
          if (!p) { avisos.push(`${it.name}: produto não existe mais no catálogo, estoque não baixado.`); continue; }
          p.stock = { ...(p.stock || {}) };
          if (p.stock[it.size] === undefined) { avisos.push(`${p.code} nº ${it.size}: numeração não existe no produto.`); continue; }
          const tem = +p.stock[it.size] || 0, q = +it.qty || 0;
          if (tem < q) avisos.push(`${p.code} ${p.name.trim()} nº ${it.size}: estoque ${tem}, pedido ${q}. Fica 0.`);
          p.stock[it.size] = Math.max(0, tem - q);
          baixas.push(`${p.code} ${p.name.trim()} nº ${it.size}: ${tem} → ${p.stock[it.size]}`);
        }
        o.status = "confirmed";
        const c = C.find(x => String(x.phone).replace(/\D/g, "") === String(o.phone).replace(/\D/g, ""));
        if (c) { c.orders = (+c.orders || 0) + 1; c.pending = Math.max(0, (+c.pending || 1) - 1); c.lastOrder = o.date; }
      }
      if (a.acao === "cancelar") o.status = "cancelled";
      let comissao;
      if (a.acao === "marcar_pago") {
        const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Belem" });
        o.pago = true;
        o.pagamento = { ...(o.pagamento || {}), manual: true, metodo: a.forma_pagamento || "", valorPago: +o.total || 0, pagoEm: agora, aguardando: false };
        const afi = o.ref ? (d.afiliados || []).find(x => String(x.codigo).toLowerCase() === String(o.ref).toLowerCase()) : null;
        if (afi && !(+o.comissao > 0)) { o.comissao = Math.round((+o.total || 0) * (+afi.comissao || 0)) / 100; comissao = `${afi.nome}: ${brl(o.comissao)} (${afi.comissao}%)`; }
      }
      const res = { pedido: curto({ ...o, status: antes.status, pago: antes.pago }), antes, depois: { status: o.status, pago: !!o.pago },
        baixa_estoque: baixas.length ? baixas : undefined, comissao_afiliada: comissao, avisos: avisos.length ? avisos : undefined };
      if (!a.confirmar) return { previa: true, mensagem: "Prévia. Nada foi salvo. Confirme com o usuário e chame de novo com confirmar=true.", ...res };
      if (confirma) {
        if (P.length !== n0) throw new Error("Proteção: a lista de produtos mudou de tamanho. Nada foi salvo.");
        await admin({ action: "saveAll", products: P, orders: O, crm: C });
      } else {
        await admin({ action: "saveOrders", orders: O });
      }
      return { salvo: true, ...res };
    }
  },
  {
    name: "listar_clientes", title: "Listar clientes", annotations: LEITURA,
    description: "Clientes do CRM com nº de pedidos e data do último pedido. Útil para campanhas: quem não compra há X dias, quem mais compra.",
    inputSchema: { type: "object", properties: {
      busca: { type: "string" }, sem_comprar_ha_dias: { type: "number" }, min_pedidos: { type: "number" },
      ordenar: { type: "string", enum: ["recentes", "mais_pedidos", "inativos"] }, limite: { type: "number", description: "Padrão 50." } } },
    async run(a) {
      let C = (await carrega()).crm || [];
      const ult = c => new Date(c.lastOrder || c.since || 0).getTime() || 0;
      if (a.busca) { const b = norm(a.busca), dg = String(a.busca).replace(/\D/g, ""); C = C.filter(c => norm(c.name).includes(b) || (dg.length >= 4 && String(c.phone).includes(dg))); }
      if (a.sem_comprar_ha_dias) { const t = Date.now() - a.sem_comprar_ha_dias * 864e5; C = C.filter(c => ult(c) < t); }
      if (a.min_pedidos) C = C.filter(c => (+c.orders || 0) + (+c.pending || 0) >= a.min_pedidos);
      const o = a.ordenar || "recentes";
      C = C.slice().sort(o === "mais_pedidos" ? (x, y) => ((+y.orders || 0) + (+y.pending || 0)) - ((+x.orders || 0) + (+x.pending || 0)) : o === "inativos" ? (x, y) => ult(x) - ult(y) : (x, y) => ult(y) - ult(x));
      return { total: C.length, clientes: C.slice(0, a.limite || 50).map(c => ({ nome: c.name, telefone: c.phone, pedidos: (+c.orders || 0) + (+c.pending || 0), ultimo_pedido: c.lastOrder, cliente_desde: c.since })) };
    }
  },
  {
    name: "listar_afiliados", title: "Listar afiliadas", annotations: LEITURA,
    description: "Afiliadas com status, comissão, cidade, cliques e vendas.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["aprovado", "pendente", "recusado"] } } },
    async run(a) {
      const d = await carrega();
      let A = d.afiliados || [];
      if (a.status) A = A.filter(x => x.status === a.status);
      const O = d.orders || [];
      return { comissao_padrao: d.comissaoPadrao, total: A.length, afiliadas: A.map(x => {
        const v = O.filter(o => String(o.ref).toLowerCase() === x.codigo && o.status !== "cancelled");
        return { codigo: x.codigo, nome: x.nome, whatsapp: x.whatsapp, cidade: x.cidade, status: x.status, ativo: x.ativo, comissao: x.comissao + "%",
          cliques: (d.cliques || {})[x.codigo], vendas: v.length, valor_vendido: brl(v.reduce((s, o) => s + (+o.total || 0), 0)), link: `${SITE}/varejo?ref=${x.codigo}` };
      }) };
    }
  },
  {
    name: "definir_comissao", title: "Definir comissão", annotations: ESCRITA,
    description: "Muda a comissão (%) de afiliadas específicas ou de todas as aprovadas; opcionalmente também a comissão padrão de novos cadastros. Prévia primeiro; grava com confirmar=true.",
    inputSchema: { type: "object", properties: {
      afiliadas: { type: "array", items: { type: "string" }, description: "Códigos das afiliadas, ou [\"todas\"]." },
      percentual: { type: "number", description: "Entre 1 e 50." }, tambem_padrao: { type: "boolean" }, confirmar: S_CONF }, required: ["afiliadas", "percentual"] },
    async run(a) {
      const n = +a.percentual;
      if (!(n >= 1 && n <= 50)) return { erro: "Comissão entre 1% e 50%." };
      const d = await carrega(), A = d.afiliados || [];
      const todas = (a.afiliadas || []).map(norm).includes("todas");
      const alvo = todas ? A.filter(x => x.status === "aprovado") : A.filter(x => (a.afiliadas || []).map(norm).includes(norm(x.codigo)));
      const faltam = todas ? [] : (a.afiliadas || []).filter(c => !A.some(x => norm(x.codigo) === norm(c)));
      if (faltam.length) return { erro: "Afiliadas não encontradas: " + faltam.join(", ") };
      const prev = alvo.map(x => `${x.nome} (${x.codigo}): ${x.comissao}% → ${n}%`);
      if (!a.confirmar) return { previa: true, alteracoes: prev, padrao: a.tambem_padrao ? `${d.comissaoPadrao}% → ${n}%` : "sem mudança" };
      const lista = A.map(x => alvo.includes(x) ? { ...x, comissao: n } : x).map(({ chave, ...r }) => r);
      await admin({ action: "saveAfiliados", afiliados: lista });
      if (a.tambem_padrao) await admin({ action: "setComissaoPadrao", comissao: n });
      return { salvo: true, alteracoes: prev };
    }
  },
  {
    name: "montar_mensagem", title: "Montar mensagem de WhatsApp", annotations: LEITURA,
    description: "Monta o texto de divulgação (formatação do WhatsApp) para um ou mais produtos, com preço de atacado ou varejo, numeração, link e descrição. Com afiliada, os links levam o código dela. Útil para disparos (Leona) e grupos de revendedoras.",
    inputSchema: { type: "object", properties: {
      produtos: S_PRODS, modo: { type: "string", enum: ["atacado", "varejo"], description: "Padrão: atacado." },
      afiliada: { type: "string", description: "Código da afiliada (só varejo)." }, abertura: { type: "string", description: "Texto inicial da mensagem." },
      incluir: { type: "object", properties: { preco: { type: "boolean" }, numeracao: { type: "boolean" }, link: { type: "boolean" }, descricao: { type: "boolean" } },
        description: "Padrão: tudo true, exceto descrição." } }, required: ["produtos"] },
    async run(a) {
      const P = (await carrega()).products || [];
      const { ok, erros } = resolve(P, a.produtos);
      if (erros.length) return { erro: "Ajuste os produtos.", detalhes: erros };
      const inc = { preco: true, numeracao: true, link: true, descricao: false, ...(a.incluir || {}) };
      const modo = a.modo === "varejo" ? "varejo" : "atacado";
      const bloco = p => {
        const t = tams(p), pr = promo(p);
        return [
          inc.preco && modo === "atacado" && pr ? `🔥🔥 *PROMOÇÃO -${descPct(p)}%* 🔥🔥` : null,
          `*${String(p.name || "").trim().toUpperCase()}*`,
          inc.preco ? (modo === "varejo" ? (varejo(p) ? `💰 ${brl(varejo(p))}` : null) : (pr ? `💰 Atacado: de ~${brl(p.price)}~ por *${brl(pr)}*` : `💰 Atacado: ${brl(p.price)}`)) : null,
          inc.numeracao ? `📏 Numeração: ${t.length ? t.join(", ") : "consulte"}` : null,
          inc.link ? `🛒 ${link(p, modo, a.afiliada)}` : null,
          inc.descricao && String(p.desc || "").trim() ? `📝 ${String(p.desc).trim()}` : null
        ].filter(Boolean).join("\n");
      };
      const texto = [a.abertura ? a.abertura.trim() : null, ...ok.map(bloco)].filter(Boolean).join("\n\n━━━━━━━━━━\n\n");
      return { texto, fotos: ok.map(p => ({ codigo: p.code, foto: p.image })) };
    }
  }
];

// ─── protocolo MCP (HTTP sem sessão, respostas JSON) ─────────────────────────
const INSTRUCOES = "Ferramentas da loja Glamour Shoes (calçados, Macapá/AP). Preços em reais. 'atacado' é o preço para revendedoras; 'varejo' é o preço para cliente final. " +
  "Ferramentas que alteram dados devolvem uma prévia: mostre a prévia ao usuário e só chame de novo com confirmar=true depois que ele aprovar. " +
  "Depois de mudanças feitas aqui, o painel Admin aberto em outro aparelho deve ser recarregado antes de salvar algo nele, para não sobrescrever.";

function chaveOk(req) {
  const esperada = process.env.GS_MCP_KEY || "";
  if (esperada.length < 16) return false;
  const u = new URL(req.url, "http://x");
  const auth = String(req.headers["authorization"] || "");
  const dada = u.searchParams.get("k") || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
  const a = Buffer.from(String(dada)), b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function lerCorpo(req) {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
  const parts = []; for await (const c of req) parts.push(c);
  const s = Buffer.concat(parts).toString("utf8");
  return s ? JSON.parse(s) : null;
}
async function trata(msg) {
  const { id, method, params } = msg || {};
  const resp = result => ({ jsonrpc: "2.0", id, result });
  const erro = (code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return erro(-32600, "Requisição inválida");
  if (id === undefined) return null; // notificação
  switch (method) {
    case "initialize":
      return resp({ protocolVersion: (params && params.protocolVersion) || "2025-06-18", capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "glamour-shoes", title: "Glamour Shoes", version: VERSAO }, instructions: INSTRUCOES });
    case "ping": return resp({});
    case "tools/list": return resp({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const t = TOOLS.find(x => x.name === (params && params.name));
      if (!t) return erro(-32602, "Ferramenta desconhecida: " + (params && params.name));
      try {
        const out = await t.run((params && params.arguments) || {});
        return resp({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: !!(out && out.erro) });
      } catch (e) {
        return resp({ content: [{ type: "text", text: "Erro: " + e.message }], isError: true });
      }
    }
    case "resources/list": return resp({ resources: [] });
    case "prompts/list": return resp({ prompts: [] });
    default: return erro(-32601, "Método não suportado: " + method);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (!process.env.GS_MCP_KEY) { res.statusCode = 503; return res.end("Configure GS_MCP_KEY no Vercel."); }
  if (!chaveOk(req)) { res.statusCode = 401; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: "Chave inválida" })); }
  if (req.method === "GET") { res.statusCode = 405; res.setHeader("Allow", "POST"); return res.end(); }
  if (req.method === "DELETE") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  let body;
  try { body = await lerCorpo(req); } catch (e) {
    res.statusCode = 400; res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }));
  }
  const lote = Array.isArray(body);
  const saidas = (await Promise.all((lote ? body : [body]).map(trata))).filter(Boolean);
  if (!saidas.length) { res.statusCode = 202; return res.end(); }
  res.statusCode = 200; res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(lote ? saidas : saidas[0]));
};
