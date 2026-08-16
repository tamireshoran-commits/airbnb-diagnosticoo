require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { buscarAnuncio, buscarAvaliacoes } = require("./airbnb");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function paraNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const limpo = String(valor).trim().replace(",", ".");
  const n = parseFloat(limpo);
  return Number.isNaN(n) ? null : n;
}

// ROTA 1: Buscar dados automaticamente
app.post("/api/extrair", async (req, res) => {
  const { url } = req.body || {};

  if (!url || !/^https?:\/\/(www\.)?airbnb\.[a-z.]+\//i.test(url)) {
    return res.status(400).json({ error: "Cole um link valido de um anuncio do Airbnb (ex: https://www.airbnb.com.br/rooms/12345)." });
  }

  try {
    const anuncio = await buscarAnuncio(url);
    let avaliacoes = [];
    let totalAvaliacoes = anuncio.num_avaliacoes;
    try {
      const r = await buscarAvaliacoes(anuncio.listingId, anuncio.apiKey);
      avaliacoes = r.avaliacoes;
      totalAvaliacoes = r.total || totalAvaliacoes;
    } catch (err) {
      console.error("Falha ao ler avaliacoes:", err.message);
    }

    const { apiKey, ...publico } = anuncio;
    return res.json({ ...publico, num_avaliacoes: totalAvaliacoes, avaliacoes });
  } catch (err) {
    console.error("Erro em /api/extrair:", err.message);
    return res.status(502).json({ error: "Nao foi possivel buscar o anuncio: " + err.message });
  }
});

// ROTA: Analise critica das avaliacoes
app.post("/api/analisar-avaliacoes", async (req, res) => {
  const { avaliacoes } = req.body || {};

  if (!Array.isArray(avaliacoes) || !avaliacoes.length) {
    return res.status(400).json({ error: "Nenhuma avaliacao disponivel. Busque o anuncio automaticamente primeiro." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Chave da API do Gemini nao encontrada." });
  }

  const negativas = avaliacoes.filter((a) => a.nota !== null && a.nota <= 4);
  const semResposta = negativas.filter((a) => !a.resposta);

  const linhas = avaliacoes
    .slice(0, 120)
    .map((a, i) => `[${i + 1}] Nota ${a.nota ?? "?"} (${a.data ?? "sem data"}): ${(a.texto || "").slice(0, 600)}${a.resposta ? `\n    RESPOSTA DO ANFITRIAO: ${a.resposta.slice(0, 300)}` : "\n    (o anfitriao NAO respondeu)"}`)
    .join("\n");

  const prompt =
    "Voce e um consultor severo e direto de anuncios de aluguel por temporada no Airbnb Brasil. " +
    "Abaixo estao as avaliacoes reais de um anuncio, com as respostas do anfitriao quando existirem.\n\n" +
    linhas +
    "\n\nResponda em portugues, sem rodeios e sem elogios vazios, em JSON valido com exatamente estas chaves:\n" +
    '{"problemas_recorrentes": [{"problema": "...", "quantas_vezes": 0, "gravidade": "alta|media|baixa", "evidencia": "trecho curto de uma avaliacao real"}], ' +
    '"erros_nas_respostas": ["..."], "o_que_esta_custando_dinheiro": ["..."], "acoes_prioritarias": ["..."]}\n' +
    "Em problemas_recorrentes, liste no maximo 6, do mais grave ao menos grave, considerando so o que aparece de fato nas avaliacoes. " +
    "Em erros_nas_respostas, aponte respostas defensivas, genericas, ou reclamacoes serias que ficaram sem resposta. " +
    "Responda APENAS com o JSON, sem texto antes ou depois, sem blocos de codigo.";

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(502).json({ error: data?.error?.message || "Erro na API do Gemini." });
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const limpo = texto.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let analise;
    try {
      analise = JSON.parse(limpo);
    } catch (_) {
      return res.status(502).json({ error: "A IA respondeu num formato inesperado. Tente novamente." });
    }

    return res.json({
      analise,
      estatisticas: {
        total: avaliacoes.length,
        negativas: negativas.length,
        negativas_sem_resposta: semResposta.length,
        taxa_resposta: avaliacoes.length
          ? Math.round((avaliacoes.filter((a) => a.resposta).length / avaliacoes.length) * 100)
          : 0,
      },
    });
  } catch (err) {
    console.error("Erro em /api/analisar-avaliacoes:", err.message);
    return res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

// ROTA: Quanto o anuncio perde por nao ter os selos
app.post("/api/perda-selos", (req, res) => {
  const { diaria, ocupacao, e_superhost, e_guest_favorite, nota } = req.body || {};

  const valorDiaria = paraNumero(diaria);
  if (valorDiaria === null || valorDiaria <= 0) {
    return res.status(400).json({ error: "Informe o valor da diaria para calcular." });
  }

  const taxaOcupacao = Math.min(Math.max(paraNumero(ocupacao) ?? 60, 0), 100) / 100;
  const GANHO_SUPERHOST = 0.09;
  const GANHO_GUEST_FAVORITE = 0.06;

  const noitesMes = 30 * taxaOcupacao;
  const receitaMensal = valorDiaria * noitesMes;

  const perdaSuperhost = e_superhost ? 0 : receitaMensal * GANHO_SUPERHOST;
  const perdaGuestFavorite = e_guest_favorite ? 0 : receitaMensal * GANHO_GUEST_FAVORITE;
  const perdaMensal = perdaSuperhost + perdaGuestFavorite;

  const notaAtual = paraNumero(nota);

  return res.json({
    e_superhost: !!e_superhost,
    e_guest_favorite: !!e_guest_favorite,
    receita_mensal_estimada: Math.round(receitaMensal),
    perda_superhost_mensal: Math.round(perdaSuperhost),
    perda_guest_favorite_mensal: Math.round(perdaGuestFavorite),
    perda_mensal_estimada: Math.round(perdaMensal),
    perda_anual_estimada: Math.round(perdaMensal * 12),
    falta_de_nota: {
      para_superhost: notaAtual === null ? null : Math.max(0, +(4.8 - notaAtual).toFixed(2)),
      para_guest_favorite: notaAtual === null ? null : Math.max(0, +(4.9 - notaAtual).toFixed(2)),
    },
    premissas: [
      `Diaria de R$ ${valorDiaria.toFixed(2)} e ocupacao de ${Math.round(taxaOcupacao * 100)}% (${noitesMes.toFixed(0)} noites/mes).`,
      "Referencia de mercado: o selo Superhost costuma valer por volta de 9% a mais de faturamento, e o Preferido dos Hospedes (Guest Favorite) por volta de 6%, por melhorarem posicao na busca e taxa de conversao.",
      "Os dois se somam quando faltam os dois selos, mas nao sao garantia: servem para dimensionar a ordem de grandeza do que esta ficando na mesa.",
    ],
  });
});

// ROTA 2: Diagnostico
app.post("/api/diagnosticar", (req, res) => {
  const { nota, num_avaliacoes, num_fotos, descricao, categorias, meta } = req.body || {};
  const notaMeta = paraNumero(meta) ?? 4.85;

  // Avaliacoes necessarias
  const notaAtual = paraNumero(nota);
  const numAv = parseInt(num_avaliacoes, 10);

  let avaliacoes_necessarias = null;
  if (notaAtual !== null && !Number.isNaN(numAv)) {
    const somaAtual = notaAtual * numAv;
    const xBruto = (notaMeta * (numAv + 1) - somaAtual) / (5 - notaMeta);
    const necessarias = Math.max(0, Math.ceil(xBruto - 1e-9));
    const notaFinalEstimada = ((somaAtual + 5 * necessarias) / (numAv + necessarias)).toFixed(2);
    avaliacoes_necessarias = {
      jaAtingiu: notaAtual >= notaMeta,
      notaAtual: notaAtual.toFixed(2),
      meta: notaMeta,
      necessarias,
      notaFinalEstimada,
    };
  }

  // Descricao
  const NOMES_SECOES = { descricao_anuncio: "Descrição do anúncio", sua_propriedade: "Sua propriedade", acesso_hospede: "Acesso do hóspede", interacao_hospedes: "Interação com os hóspedes", outras_informacoes: "Outras informações importantes" };
  const descricaoPorSecao = {};
  ["descricao_anuncio", "sua_propriedade", "acesso_hospede", "interacao_hospedes", "outras_informacoes"].forEach((chave) => {
    descricaoPorSecao[chave] = { texto: "", pontosFortes: [], pontosAMelhorar: [] };
  });

  // Fotos
  const fotosPontosFortes = [];
  const fotosPontosAMelhorar = [];
  const numF = parseInt(num_fotos, 10);
  if (numF >= 20) fotosPontosFortes.push(`${numF} fotos, dentro da faixa recomendada pelo Airbnb (20 ou mais).`);
  else if (numF >= 10) fotosPontosAMelhorar.push(`${numF} fotos, abaixo do ideal. Airbnb recomenda 20 ou mais.`);
  else fotosPontosAMelhorar.push(`${numF} fotos, bem abaixo do recomendado. Airbnb ideal: 20+.`);

  // Selo
  const selo = {
    provavel_elegivel_pelos_criterios_publicos: notaAtual >= 4.9,
    minimo_5_avaliacoes: { valor_atual: numAv, atende: numAv >= 5 },
    categorias_detalhe: {},
    observacao: "Essa e uma estimativa baseada nos criterios publicos do Airbnb. O selo pode estar sujeito a outros fatores internos.",
    criterios_oficiais: [
      "Pelo menos 5 avaliacoes de hospedes",
      "Avaliacoes excelentes (nota geral na faixa de 4.9 ou mais, observado na pratica)",
      "Notas altas nas 6 categorias: check-in, limpeza, exatidao, comunicacao, localizacao e custo-beneficio",
      "Baixa taxa de cancelamento do anfitriao e poucos casos de suporte por qualidade",
      "Comunicacao entre hospede e anfitriao feita dentro da plataforma Airbnb",
    ],
  };

  if (categorias) {
    Object.entries(categorias).forEach(([chave, valor]) => {
      const nome = { limpeza: "Limpeza", exatidao: "Exatidão do anúncio", checkin: "Check-in", comunicacao: "Comunicação", localizacao: "Localização", custo_beneficio: "Custo-benefício" }[chave];
      if (nome) selo.categorias_detalhe[nome] = { valor: paraNumero(valor), referencia: 4.9, atende: paraNumero(valor) >= 4.85 };
    });
  }

  return res.json({
    avaliacoes_necessarias,
    descricao: { secoes: descricaoPorSecao, nomesSecoes: NOMES_SECOES },
    fotos: { pontosFortes: fotosPontosFortes, pontosAMelhorar: fotosPontosAMelhorar },
    selo_preferido_hospedes: selo,
  });
});

// ROTA 3: Proxy de foto
app.post("/api/proxy-foto", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//.test(url)) {
      return res.status(400).json({ error: "URL de foto invalida." });
    }

    const imgRes = await fetch(url, {
      headers: {
        Referer: "https://www.airbnb.com.br/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
    const base64 = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return res.json({ dataUrl });
  } catch (err) {
    console.error("Erro em /api/proxy-foto:", err);
    return res.status(502).json({ error: "Nao foi possivel baixar a foto: " + err.message });
  }
});

// ROTA 4: Sugerir titulos
app.post("/api/sugerir-titulos", async (req, res) => {
  try {
    const { tituloAtual, descricao } = req.body || {};

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Chave da API do Gemini nao encontrada." });
    }

    const prompt =
      "Voce e um especialista em copywriting para anuncios de aluguel por temporada no Airbnb Brasil. " +
      `O titulo atual do anuncio e: "${tituloAtual || "(nao informado)"}". ` +
      `A descricao do anuncio e:\n"""${(descricao || "").slice(0, 2000)}"""\n\n` +
      "De 5 sugestoes de titulo MELHORES que esse. Cada titulo deve ter NO MAXIMO 50 caracteres. " +
      "Responda APENAS com os 5 titulos, um por linha, sem numeracao, sem aspas, sem texto explicativo.";

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      const msgErro = data?.error?.message || "Erro desconhecido na API do Gemini.";
      return res.status(502).json({ error: msgErro });
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const titulos = texto
      .split("\n")
      .map((l) => l.replace(/^[-*\d.\s"]+/, "").replace(/"$/, "").trim())
      .filter(Boolean)
      .slice(0, 5);

    return res.json({ titulos });
  } catch (err) {
    console.error("Erro em /api/sugerir-titulos:", err);
    return res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

// ROTA 5: Analisar fotos
app.post("/api/analisar-fotos", async (req, res) => {
  try {
    const { fotos } = req.body || {};

    if (!fotos || !Array.isArray(fotos) || !fotos.length) {
      return res.status(400).json({ error: "Nenhuma foto disponivel para analisar." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Chave da API do Gemini nao encontrada." });
    }

    const LIMITE_FOTOS = 40;
    const fotosParaAnalisar = fotos.slice(0, LIMITE_FOTOS);
    const resultados = [];
    let cotaEstourada = false;

    for (const url of fotosParaAnalisar) {
      if (cotaEstourada) {
        resultados.push({ url, analise: null, erro: "Nao analisada: cota gratuita do Gemini foi atingida nesta rodada." });
        continue;
      }

      try {
        const imgRes = await fetch(url, {
          headers: {
            Referer: "https://www.airbnb.com.br/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          },
        });
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        const base64 = buffer.toString("base64");

        const prompt =
          "Voce e um fotografo profissional especializado em imoveis para Airbnb, e e severo na avaliacao. " +
          "Analise esta foto e responda APENAS com JSON valido, sem blocos de codigo, no formato: " +
          '{"nota": 0, "luz": "...", "enquadramento": "...", "problema_principal": "...", "como_corrigir": "..."}. ' +
          "nota e de 0 a 10 para a qualidade da foto como anuncio. " +
          "luz avalia iluminacao (escura, estourada, luz amarelada artificial, sombras duras, boa luz natural). " +
          "enquadramento avalia composicao (cortes ruins, angulo baixo demais, torto, ambiente pequeno mal aproveitado, bagunca no quadro). " +
          "problema_principal e o defeito mais grave em uma frase curta. " +
          "como_corrigir e uma acao pratica e concreta que o anfitriao consegue executar. " +
          "Seja direto, sem elogio vazio.";

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }],
                },
              ],
            }),
          }
        );

        const data = await geminiRes.json();
        if (!geminiRes.ok) {
          const status = data?.error?.status || "";
          const msgErro = data?.error?.message || "Erro desconhecido.";
          if (geminiRes.status === 429 || status === "RESOURCE_EXHAUSTED") {
            cotaEstourada = true;
            resultados.push({ url, analise: null, erro: "Cota gratuita do Gemini atingida." });
          } else {
            resultados.push({ url, analise: null, erro: msgErro });
          }
        } else {
          const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          let detalhe = null;
          if (texto) {
            const limpo = texto.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
            try {
              detalhe = JSON.parse(limpo);
            } catch (_) {}
          }
          resultados.push({ url, analise: texto ? texto.trim() : null, detalhe, erro: null });
        }
      } catch (err) {
        resultados.push({ url, analise: null, erro: err.message });
      }

      await new Promise((r) => setTimeout(r, 4500));
    }

    return res.json({ resultados, total_analisadas: resultados.length, total_disponivel: fotos.length, cota_estourada: cotaEstourada });
  } catch (err) {
    console.error("Erro em /api/analisar-fotos:", err);
    return res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando! Abra o navegador em: http://localhost:${PORT}`);
});
