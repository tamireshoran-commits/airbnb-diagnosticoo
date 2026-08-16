const Anthropic = require("@anthropic-ai/sdk");

const MODELO_CLAUDE = process.env.CLAUDE_MODELO || "claude-opus-5";
const MODELO_GEMINI = "gemini-flash-latest";

function temClaude() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
function temGemini() {
  return Boolean(process.env.GEMINI_API_KEY);
}

let clienteClaude = null;
function claude() {
  if (!clienteClaude) {
    clienteClaude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return clienteClaude;
}

function textoDaRespostaClaude(resposta) {
  return (resposta.content || [])
    .filter((bloco) => bloco.type === "text")
    .map((bloco) => bloco.text)
    .join("")
    .trim();
}

// --- Claude ---
async function claudeTexto(prompt, maxTokens) {
  const resposta = await claude().messages.create({
    model: MODELO_CLAUDE,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  if (resposta.stop_reason === "refusal") {
    throw new Error("A IA recusou responder a esse conteudo.");
  }
  return textoDaRespostaClaude(resposta);
}

async function claudeImagem(prompt, base64, mimeType, maxTokens) {
  const resposta = await claude().messages.create({
    model: MODELO_CLAUDE,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  if (resposta.stop_reason === "refusal") {
    throw new Error("A IA recusou analisar essa imagem.");
  }
  return textoDaRespostaClaude(resposta);
}

// Varias imagens numa unica chamada, para analisar o conjunto.
async function claudeImagens(prompt, imagens, maxTokens) {
  const conteudo = [];
  imagens.forEach((img, i) => {
    conteudo.push({ type: "text", text: `Foto ${i + 1}:` });
    conteudo.push({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.base64 },
    });
  });
  conteudo.push({ type: "text", text: prompt });

  const resposta = await claude().messages.create({
    model: MODELO_CLAUDE,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: conteudo }],
  });
  if (resposta.stop_reason === "refusal") {
    throw new Error("A IA recusou analisar essas imagens.");
  }
  return textoDaRespostaClaude(resposta);
}

// --- Gemini ---
async function geminiChamar(partes) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: partes }] }),
    }
  );
  const dados = await res.json();
  if (!res.ok) {
    const erro = new Error(dados?.error?.message || "Erro na API do Gemini.");
    erro.status = res.status;
    erro.geminiStatus = dados?.error?.status;
    throw erro;
  }
  return (dados?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

const geminiTexto = (prompt) => geminiChamar([{ text: prompt }]);
const geminiImagem = (prompt, base64, mimeType) =>
  geminiChamar([{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }]);

function geminiImagens(prompt, imagens) {
  const partes = [];
  imagens.forEach((img, i) => {
    partes.push({ text: `Foto ${i + 1}:` });
    partes.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  });
  partes.push({ text: prompt });
  return geminiChamar(partes);
}

// Uma IA de cada vez, na ordem de preferencia, caindo para a outra se falhar.
async function comFallback(tentativas) {
  const disponiveis = tentativas.filter((t) => t.disponivel);
  if (!disponiveis.length) {
    throw new Error(
      "Nenhuma chave de IA configurada. Defina ANTHROPIC_API_KEY (Claude) ou GEMINI_API_KEY (Gemini)."
    );
  }

  let ultimoErro;
  for (const tentativa of disponiveis) {
    try {
      const texto = await tentativa.executar();
      return { texto, provedor: tentativa.nome };
    } catch (err) {
      ultimoErro = err;
      console.error(`IA (${tentativa.nome}) falhou:`, err.message);
    }
  }
  throw ultimoErro;
}

async function analisarTexto(prompt, { maxTokens = 4096 } = {}) {
  return comFallback([
    { nome: "claude", disponivel: temClaude(), executar: () => claudeTexto(prompt, maxTokens) },
    { nome: "gemini", disponivel: temGemini(), executar: () => geminiTexto(prompt) },
  ]);
}

async function analisarImagem(prompt, base64, mimeType, { maxTokens = 1024 } = {}) {
  return comFallback([
    {
      nome: "claude",
      disponivel: temClaude(),
      executar: () => claudeImagem(prompt, base64, mimeType, maxTokens),
    },
    { nome: "gemini", disponivel: temGemini(), executar: () => geminiImagem(prompt, base64, mimeType) },
  ]);
}

async function analisarImagens(prompt, imagens, { maxTokens = 4096 } = {}) {
  return comFallback([
    {
      nome: "claude",
      disponivel: temClaude(),
      executar: () => claudeImagens(prompt, imagens, maxTokens),
    },
    { nome: "gemini", disponivel: temGemini(), executar: () => geminiImagens(prompt, imagens) },
  ]);
}

// Extrai o JSON de uma resposta, tolerando cercas de codigo ao redor.
function lerJson(texto) {
  const limpo = String(texto || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(limpo);
  } catch (_) {
    const inicio = limpo.indexOf("{");
    const fim = limpo.lastIndexOf("}");
    if (inicio !== -1 && fim > inicio) {
      try {
        return JSON.parse(limpo.slice(inicio, fim + 1));
      } catch (_) {}
    }
    return null;
  }
}

function provedoresAtivos() {
  const lista = [];
  if (temClaude()) lista.push("claude");
  if (temGemini()) lista.push("gemini");
  return lista;
}

module.exports = { analisarTexto, analisarImagem, analisarImagens, lerJson, provedoresAtivos, temClaude, temGemini };
