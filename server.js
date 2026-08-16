require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { buscarAnuncio, buscarAvaliacoes } = require("./airbnb");
const auth = require("./auth");
const ia = require("./ia");

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

// Configuracao que o navegador precisa para montar a tela de login
app.get("/api/config", (req, res) => {
  res.json({
    login_ativo: auth.loginConfigurado(),
    supabase_url: auth.SUPABASE_URL,
    supabase_anon_key: auth.SUPABASE_ANON_KEY,
  });
});

// Situacao da conta de quem esta logado
app.get("/api/minha-conta", async (req, res) => {
  if (!auth.loginConfigurado()) {
    return res.json({ login_ativo: false });
  }
  const cabecalho = req.headers.authorization || "";
  const token = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7) : null;
  try {
    const usuario = await auth.usuarioDoToken(token);
    if (!usuario) return res.status(401).json({ error: "Nao autenticado." });
    const perfil = await auth.perfilDoUsuario(usuario);
    return res.json({
      login_ativo: true,
      email: usuario.email,
      nome: usuario.user_metadata?.full_name || null,
      analises_usadas: perfil.analises_usadas || 0,
      limite_gratis: perfil.limite_gratis ?? 1,
      plano: perfil.plano || "gratis",
      tem_credito: auth.temCredito(perfil),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ROTA 1: Buscar dados automaticamente
app.post("/api/extrair", auth.exigirCredito, async (req, res) => {
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

    let conta = null;
    if (req.perfil) {
      try {
        const atualizado = await auth.registrarAnalise(req.perfil.user_id, req.perfil.analises_usadas || 0);
        conta = {
          analises_usadas: atualizado.analises_usadas,
          limite_gratis: atualizado.limite_gratis ?? 1,
          plano: atualizado.plano || "gratis",
        };
      } catch (err) {
        console.error("Falha ao registrar analise:", err.message);
      }
    }

    const { apiKey, ...publico } = anuncio;
    return res.json({ ...publico, num_avaliacoes: totalAvaliacoes, avaliacoes, conta });
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
  if (!ia.provedoresAtivos().length) {
    return res.status(500).json({ error: "Nenhuma chave de IA configurada no servidor." });
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
    const { texto, provedor } = await ia.analisarTexto(prompt, { maxTokens: 4096 });
    const analise = ia.lerJson(texto);
    if (!analise) {
      return res.status(502).json({ error: "A IA respondeu num formato inesperado. Tente novamente." });
    }

    return res.json({
      analise,
      provedor,
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

// ROTA: Projecao de faturamento por cenario de selo
app.post("/api/perda-selos", (req, res) => {
  const { diaria, ocupacao, e_superhost, e_guest_favorite, nota, ganho_superhost, ganho_guest_favorite } = req.body || {};

  const valorDiaria = paraNumero(diaria);
  if (valorDiaria === null || valorDiaria <= 0) {
    return res.status(400).json({ error: "Informe o valor da diaria para calcular." });
  }

  // Ganho de OCUPACAO (nao de diaria): o efeito principal dos selos e aparecer
  // melhor na busca e converter mais, ou seja, encher mais o calendario.
  const upSuper = (paraNumero(ganho_superhost) ?? 8) / 100;
  const upFav = (paraNumero(ganho_guest_favorite) ?? 6) / 100;

  const ocupAtual = Math.min(Math.max(paraNumero(ocupacao) ?? 60, 0), 100) / 100;
  const temSuper = !!e_superhost;
  const temFav = !!e_guest_favorite;

  // Remove o efeito dos selos que o anuncio JA tem, para achar a ocupacao "crua".
  const fatorAtual = 1 + (temSuper ? upSuper : 0) + (temFav ? upFav : 0);
  const ocupBase = ocupAtual / fatorAtual;

  function cenario(comSuper, comFav) {
    const fator = 1 + (comSuper ? upSuper : 0) + (comFav ? upFav : 0);
    const ocup = Math.min(ocupBase * fator, 1);
    const noites = 30 * ocup;
    const mensal = valorDiaria * noites;
    return {
      superhost: comSuper,
      guest_favorite: comFav,
      ocupacao_pct: +(ocup * 100).toFixed(1),
      noites_mes: +noites.toFixed(1),
      receita_mensal: Math.round(mensal),
      receita_anual: Math.round(mensal * 12),
      e_o_atual: comSuper === temSuper && comFav === temFav,
    };
  }

  const cenarios = {
    nenhum: cenario(false, false),
    so_superhost: cenario(true, false),
    so_guest_favorite: cenario(false, true),
    ambos: cenario(true, true),
  };

  const atual = cenario(temSuper, temFav);
  const ideal = cenarios.ambos;
  const perdaMensal = Math.max(0, ideal.receita_mensal - atual.receita_mensal);

  const notaAtual = paraNumero(nota);

  return res.json({
    atual,
    cenarios,
    perda_mensal_estimada: perdaMensal,
    perda_anual_estimada: perdaMensal * 12,
    ganhos_usados: { superhost_pct: upSuper * 100, guest_favorite_pct: upFav * 100 },
    falta_de_nota: {
      para_superhost: notaAtual === null ? null : Math.max(0, +(4.8 - notaAtual).toFixed(2)),
      para_guest_favorite: notaAtual === null ? null : Math.max(0, +(4.9 - notaAtual).toFixed(2)),
    },
    premissas: [
      `Diaria de R$ ${valorDiaria.toFixed(2)} mantida igual em todos os cenarios: o que muda e quantas noites o calendario enche.`,
      `Premissa em uso (ajustavel na tela): Superhost enche o calendario ${(upSuper * 100).toFixed(0)}% a mais, e o Preferido dos Hospedes ${(upFav * 100).toFixed(0)}% a mais.`,
      "O Airbnb nao divulga esses percentuais. Sao premissas suas, nao dados oficiais: mude os valores acima e a projecao inteira se ajusta.",
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

    if (!ia.provedoresAtivos().length) {
      return res.status(500).json({ error: "Nenhuma chave de IA configurada no servidor." });
    }

    const prompt =
      "Voce e um especialista em copywriting para anuncios de aluguel por temporada no Airbnb Brasil. " +
      `O titulo atual do anuncio e: "${tituloAtual || "(nao informado)"}". ` +
      `A descricao do anuncio e:\n"""${(descricao || "").slice(0, 2000)}"""\n\n` +
      "De 5 sugestoes de titulo MELHORES que esse. Cada titulo deve ter NO MAXIMO 50 caracteres. " +
      "Responda APENAS com os 5 titulos, um por linha, sem numeracao, sem aspas, sem texto explicativo.";

    const { texto, provedor } = await ia.analisarTexto(prompt, { maxTokens: 1024 });
    const titulos = texto
      .split("\n")
      .map((l) => l.replace(/^[-*\d.\s"]+/, "").replace(/"$/, "").trim())
      .filter(Boolean)
      .slice(0, 5);

    return res.json({ titulos, provedor });
  } catch (err) {
    console.error("Erro em /api/sugerir-titulos:", err);
    return res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

// ROTA 5: Analisar as fotos como conjunto
app.post("/api/analisar-fotos", async (req, res) => {
  try {
    const { fotos } = req.body || {};

    if (!fotos || !Array.isArray(fotos) || !fotos.length) {
      return res.status(400).json({ error: "Nenhuma foto disponivel para analisar." });
    }
    if (!ia.provedoresAtivos().length) {
      return res.status(500).json({ error: "Nenhuma chave de IA configurada no servidor." });
    }

    const LIMITE_FOTOS = 30;
    const selecionadas = fotos.slice(0, LIMITE_FOTOS);

    // Pede a versao reduzida ao proprio CDN do Airbnb: para julgar luz e
    // enquadramento essa resolucao basta, e corta drasticamente o custo.
    const baixar = async (url) => {
      const menor = url.split("?")[0] + "?im_w=720";
      const r = await fetch(menor, {
        headers: {
          Referer: "https://www.airbnb.com.br/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buffer = Buffer.from(await r.arrayBuffer());
      return {
        url,
        base64: buffer.toString("base64"),
        mimeType: (r.headers.get("content-type") || "image/jpeg").split(";")[0],
      };
    };

    const baixadas = [];
    const falhasDownload = [];
    for (const url of selecionadas) {
      try {
        baixadas.push(await baixar(url));
      } catch (err) {
        falhasDownload.push({ url, erro: err.message });
      }
    }

    if (!baixadas.length) {
      return res.status(502).json({ error: "Nao foi possivel baixar nenhuma das fotos." });
    }

    const prompt =
      `Acima estao as ${baixadas.length} fotos de um anuncio de Airbnb, na ordem em que aparecem (Foto 1 e a capa). ` +
      "Voce e um fotografo profissional de imoveis e um especialista em conversao de anuncios, e e severo. " +
      "Avalie o CONJUNTO, nao cada foto isoladamente.\n\n" +
      "Responda APENAS com JSON valido, sem blocos de codigo, neste formato:\n" +
      '{"nota_conjunto": 0, "veredito": "uma frase direta sobre a impressao geral", ' +
      '"capa": {"e_a_melhor_escolha": true, "comentario": "...", "sugestao_de_capa": 0}, ' +
      '"cobertura": {"comodos_faltando": ["..."], "comentario": "..."}, ' +
      '"consistencia": "as fotos parecem do mesmo imovel, com luz e estilo coerentes?", ' +
      '"ordem": "a sequencia conta uma boa historia para quem esta decidindo?", ' +
      '"piores_fotos": [{"numero": 1, "problema": "...", "como_corrigir": "..."}], ' +
      '"acoes_prioritarias": ["..."]}\n' +
      "nota_conjunto vai de 0 a 10. sugestao_de_capa e o numero da foto que deveria ser a capa (use o numero da capa atual se ja estiver certa). " +
      "comodos_faltando lista ambientes que um hospede espera ver e nao aparecem (banheiro, cozinha, area externa, vista, fachada). " +
      "Em piores_fotos liste no maximo 6, da pior para a menos ruim, citando o numero da foto. " +
      "Em como_corrigir de acoes concretas que o anfitriao consegue executar sozinho.";

    const { texto, provedor } = await ia.analisarImagens(prompt, baixadas, { maxTokens: 4096 });
    const analise = ia.lerJson(texto);
    if (!analise) {
      return res.status(502).json({ error: "A IA respondeu num formato inesperado. Tente novamente." });
    }

    return res.json({
      analise,
      provedor,
      urls: baixadas.map((f) => f.url),
      total_analisadas: baixadas.length,
      total_disponivel: fotos.length,
      falhas: falhasDownload.length,
    });
  } catch (err) {
    console.error("Erro em /api/analisar-fotos:", err.message);
    return res.status(500).json({ error: "Erro ao analisar as fotos: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando! Abra o navegador em: http://localhost:${PORT}`);
});
