// Glamour Shoes: leitura de documentos (identidade e comprovante de residência) para
// preencher a qualificação da nota promissória.
//
// Variáveis de ambiente (Vercel > Settings > Environment Variables):
//   OPENAI_API_KEY  chave da OpenAI (obrigatória)
//   OPENAI_MODEL    opcional, padrão "gpt-4.1"
//   GS_SCRIPT_URL   opcional: URL do Apps Script (padrão abaixo, o mesmo do painel)
//
// Só quem está logado no Admin consegue usar (o token do painel é conferido na planilha).
// LGPD: a imagem não é gravada em lugar nenhum; é enviada para leitura e descartada.

const SCRIPT_URL_PADRAO = "https://script.google.com/macros/s/AKfycbw1Pdwu6HC8RzYZplOuhZtYw4kbVcLJPWG35DMElEKiLg4ckebqvRcUHfZMUh_zZu3k/exec";
const UFS = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");

// tokens já conferidos (cache curto para não consultar a planilha a cada documento)
const TOKENS_OK = new Map();
async function tokenValido(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return false;
  const t = TOKENS_OK.get(token);
  if (t && t > Date.now()) return true;
  try {
    const r = await fetch(process.env.GS_SCRIPT_URL || SCRIPT_URL_PADRAO, {
      method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "load", token }), redirect: "follow"
    });
    const d = JSON.parse(await r.text());
    if (d && d.admin === true) { TOKENS_OK.set(token, Date.now() + 10 * 60e3); return true; }
  } catch (e) { /* cai no false */ }
  return false;
}

const s = { type: "string" };
const ESQUEMAS = {
  identidade: {
    instrucao: "Você lê documentos de identificação brasileiros (RG antigo, Carteira de Identidade Nacional/CIN, CNH, CTPS, passaporte). " +
      "Transcreva exatamente o que está impresso, sem inventar. Campo ilegível ou ausente: string vazia. " +
      "nome: nome completo do titular (não o nome dos pais). cpf: só se aparecer no documento. rg: número do registro geral (na CNH, o 'Doc. Identidade'). " +
      "orgao: órgão emissor e UF no formato 'SSP/AP' (na CNH o órgão do RG costuma vir junto do número). " +
      "nacionalidade: 'brasileiro(a)' se for documento brasileiro de cidadão brasileiro, senão a nacionalidade impressa. " +
      "sexo: 'Feminino' ou 'Masculino' só se o documento trouxer o sexo, senão vazio. tipo_documento: ex. 'RG', 'CIN', 'CNH'. " +
      "legivel: false se a foto estiver ruim demais para confiar. observacao: problema que a loja deve conferir (ex. dígito borrado), ou vazio.",
    props: { tipo_documento: s, nome: s, cpf: s, rg: s, orgao: s, nacionalidade: s, sexo: s, legivel: { type: "boolean" }, observacao: s }
  },
  residencia: {
    instrucao: "Você lê comprovantes de residência brasileiros (conta de luz, água, telefone, internet, fatura de cartão, boleto, contrato de aluguel). " +
      "Transcreva o endereço de instalação/entrega do titular, sem inventar e sem completar o que não está escrito. Campo ilegível ou ausente: string vazia. " +
      "endereco: logradouro, número e complemento (ex. 'Rua São José, 1234, casa B'). bairro. cidade. uf: sigla de 2 letras. cep: 8 dígitos. " +
      "titular: nome de quem consta como titular/cliente na conta. data_referencia: mês ou data da conta (ex. '10/2026'). " +
      "legivel: false se a foto estiver ruim demais para confiar. observacao: problema que a loja deve conferir, ou vazio.",
    props: { titular: s, endereco: s, bairro: s, cidade: s, uf: s, cep: s, data_referencia: s, legivel: { type: "boolean" }, observacao: s }
  }
};

function lerCorpo(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") return Promise.resolve(JSON.parse(req.body));
  return new Promise((ok, no) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 6e6) { no(new Error("grande")); req.destroy(); } });
    req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch (e) { no(e); } }); req.on("error", no);
  });
}

const limpa = v => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
function normaliza(tipo, d) {
  const o = {};
  Object.keys(ESQUEMAS[tipo].props).forEach(k => { o[k] = typeof d[k] === "boolean" ? d[k] : limpa(d[k]); });
  if (o.cpf !== undefined) { const c = o.cpf.replace(/\D/g, ""); o.cpf = c.length === 11 ? c : ""; }
  if (o.cep !== undefined) { const c = o.cep.replace(/\D/g, ""); o.cep = c.length === 8 ? c : ""; }
  if (o.uf !== undefined) { o.uf = o.uf.toUpperCase(); if (!UFS.includes(o.uf)) o.uf = ""; }
  if (o.sexo !== undefined && !["Feminino", "Masculino"].includes(o.sexo)) o.sexo = "";
  if (o.orgao) o.orgao = o.orgao.toUpperCase().replace(/\s*[-/]\s*/g, "/");
  return o;
}

const responde = (res, code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return responde(res, 405, { ok: false, error: "Use POST." }); }
  if (!process.env.OPENAI_API_KEY) return responde(res, 503, { ok: false, error: "A leitura de documentos ainda não foi ativada: falta cadastrar OPENAI_API_KEY no Vercel." });
  let b;
  try { b = await lerCorpo(req); } catch (e) { return responde(res, 413, { ok: false, error: "Arquivo grande demais. Tire uma foto mais leve ou envie outra imagem." }); }
  const tipo = b.tipo, arq = String(b.arquivo || "");
  if (!ESQUEMAS[tipo]) return responde(res, 400, { ok: false, error: "Tipo de documento inválido." });
  if (!(await tokenValido(b.token))) return responde(res, 401, { ok: false, auth: false, error: "Sessão expirada. Entre de novo no Admin." });
  const m = arq.match(/^data:(image\/(?:jpeg|png|webp|gif)|application\/pdf);base64,/);
  if (!m) return responde(res, 400, { ok: false, error: "Envie uma foto (JPG/PNG) ou um PDF." });

  const anexo = m[1] === "application/pdf"
    ? { type: "file", file: { filename: "documento.pdf", file_data: arq } }
    : { type: "image_url", image_url: { url: arq, detail: "high" } };
  const E = ESQUEMAS[tipo];
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1",
        temperature: 0,
        messages: [
          { role: "system", content: E.instrucao },
          { role: "user", content: [{ type: "text", text: "Extraia os dados deste documento." }, anexo] }
        ],
        response_format: { type: "json_schema", json_schema: { name: tipo, strict: true,
          schema: { type: "object", additionalProperties: false, properties: E.props, required: Object.keys(E.props) } } }
      })
    });
    const j = await r.json();
    if (!r.ok) {
      const msg = (j.error && j.error.message) || "";
      return responde(res, 502, { ok: false, error: /quota|billing|credit/i.test(msg) ? "Sem créditos na conta da OpenAI." : "Não consegui ler o documento agora. Tente de novo." });
    }
    const dados = normaliza(tipo, JSON.parse(j.choices[0].message.content || "{}"));
    return responde(res, 200, { ok: true, tipo, dados });
  } catch (e) {
    return responde(res, 502, { ok: false, error: "Não consegui ler o documento agora. Tente de novo." });
  }
};
