const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const REVIEWS_HASH = "dec1c8061483e78373602047450322fd474e79ba9afa8d3dbbc27f504030f91d";
const API_KEY_PADRAO = "d306zoyjsyarp7ifhu67rjxn52tv0t20";

function extrairIdDoLink(url) {
  const m = String(url).match(/\/rooms\/(?:plus\/)?(\d+)/);
  return m ? m[1] : null;
}

function acharValores(raiz, chaves) {
  const achados = {};
  const pilha = [raiz];
  let passos = 0;
  while (pilha.length && passos < 400000) {
    passos++;
    const atual = pilha.pop();
    if (!atual || typeof atual !== "object") continue;
    if (Array.isArray(atual)) {
      for (const item of atual) pilha.push(item);
      continue;
    }
    for (const [k, v] of Object.entries(atual)) {
      if (chaves.includes(k) && achados[k] === undefined && (v === null || typeof v !== "object")) {
        achados[k] = v;
      }
      if (v && typeof v === "object") pilha.push(v);
    }
  }
  return achados;
}

function coletarFotos(raiz) {
  const vistas = new Set();
  const fotos = [];
  const pilha = [raiz];
  let passos = 0;
  while (pilha.length && passos < 400000) {
    passos++;
    const atual = pilha.pop();
    if (!atual || typeof atual !== "object") continue;
    if (Array.isArray(atual)) {
      for (const item of atual) pilha.push(item);
      continue;
    }
    for (const [k, v] of Object.entries(atual)) {
      if (typeof v === "string" && v.includes("muscache.com/im/pictures")) {
        const limpa = v.split("?")[0];
        if (!vistas.has(limpa) && !/\/User\/|avatar|profile_pic/i.test(limpa)) {
          vistas.add(limpa);
          fotos.push(v);
        }
      } else if (v && typeof v === "object") {
        pilha.push(v);
      }
    }
  }
  return fotos;
}

function coletarDescricao(raiz) {
  const partes = [];
  const vistas = new Set();
  const pilha = [raiz];
  let passos = 0;
  while (pilha.length && passos < 400000) {
    passos++;
    const atual = pilha.pop();
    if (!atual || typeof atual !== "object") continue;
    if (Array.isArray(atual)) {
      for (const item of atual) pilha.push(item);
      continue;
    }
    if (typeof atual.htmlText === "string" && atual.htmlText.trim()) {
      const texto = atual.htmlText
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (texto.length > 30 && !vistas.has(texto)) {
        vistas.add(texto);
        partes.push(texto);
      }
    }
    for (const v of Object.values(atual)) {
      if (v && typeof v === "object") pilha.push(v);
    }
  }
  return partes.join("\n\n");
}

function paraNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = parseFloat(String(valor).trim().replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

async function buscarPagina(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "pt-BR,pt;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`O Airbnb respondeu com erro ${res.status} ao abrir esse link.`);
  return res.text();
}

function extrairEstado(html) {
  const m = html.match(/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/) ||
    html.match(/data-deferred-state[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

function extrairMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, "i");
  const m = html.match(re);
  if (m) return m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return "";
}

async function buscarAvaliacoes(listingId, apiKey, maximo = 200) {
  const idCodificado = Buffer.from(`StayListing:${listingId}`).toString("base64");
  const todas = [];
  let total = null;
  const porPagina = 50;

  for (let offset = 0; offset < maximo; offset += porPagina) {
    const variables = {
      id: idCodificado,
      pdpReviewsRequest: {
        fieldSelector: "for_p3_translation_only",
        forPreview: false,
        limit: porPagina,
        offset: String(offset),
        showingTranslationButton: false,
        first: porPagina,
        sortingPreference: "MOST_RECENT",
        numberOfAdults: "1",
        numberOfChildren: "0",
        numberOfInfants: "0",
        numberOfPets: "0",
      },
    };
    const extensions = { persistedQuery: { version: 1, sha256Hash: REVIEWS_HASH } };
    const qs = new URLSearchParams({
      operationName: "StaysPdpReviewsQuery",
      locale: "pt",
      currency: "BRL",
      variables: JSON.stringify(variables),
      extensions: JSON.stringify(extensions),
    });

    const res = await fetch(
      `https://www.airbnb.com.br/api/v3/StaysPdpReviewsQuery/${REVIEWS_HASH}?${qs}`,
      { headers: { "X-Airbnb-Api-Key": apiKey, "User-Agent": UA, Accept: "application/json" } }
    );
    if (!res.ok) break;
    const dados = await res.json();
    const bloco = dados?.data?.presentation?.stayProductDetailPage?.reviews;
    if (!bloco || !Array.isArray(bloco.reviews)) break;

    if (total === null) total = bloco?.metadata?.reviewsCount ?? null;

    const limpas = bloco.reviews.map((r) => ({
      nota: r.rating ?? null,
      data: r.localizedDate ?? null,
      texto: (r.comments || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim(),
      autor: r.reviewer?.firstName ?? null,
      resposta: (r.response || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() || null,
      dataResposta: r.localizedRespondedDate ?? null,
    }));
    todas.push(...limpas);

    if (bloco.reviews.length < porPagina) break;
    if (total !== null && todas.length >= total) break;
  }

  return { avaliacoes: todas, total: total ?? todas.length };
}

async function buscarAnuncio(url) {
  const listingId = extrairIdDoLink(url);
  if (!listingId) {
    throw new Error("Nao consegui identificar o codigo do anuncio nesse link. Use um link no formato airbnb.com.br/rooms/123456.");
  }

  const html = await buscarPagina(`https://www.airbnb.com.br/rooms/${listingId}?locale=pt&currency=BRL`);
  const estado = extrairEstado(html);
  if (!estado) {
    throw new Error("O Airbnb devolveu a pagina em um formato inesperado. Tente de novo em alguns minutos.");
  }

  const apiKey = (html.match(/"key":"([a-z0-9]{32})"/) || [])[1] || API_KEY_PADRAO;

  const campos = acharValores(estado, [
    "guestSatisfactionOverall",
    "visibleReviewCount",
    "reviewCount",
    "isSuperhost",
    "isGuestFavorite",
    "accuracyRating",
    "checkinRating",
    "cleanlinessRating",
    "communicationRating",
    "locationRating",
    "valueRating",
    "personCapacity",
    "sharingConfigTitle",
  ]);

  const fotos = coletarFotos(estado);

  const titulo = extrairMeta(html, "og:description").trim();
  const resumo = extrairMeta(html, "og:title").trim();
  const descricao = coletarDescricao(estado);

  const categorias = {
    limpeza: paraNumero(campos.cleanlinessRating),
    exatidao: paraNumero(campos.accuracyRating),
    checkin: paraNumero(campos.checkinRating),
    comunicacao: paraNumero(campos.communicationRating),
    localizacao: paraNumero(campos.locationRating),
    custo_beneficio: paraNumero(campos.valueRating),
  };
  const temCategorias = Object.values(categorias).some((v) => v !== null);

  const nota = paraNumero(campos.guestSatisfactionOverall);
  const numAvaliacoes = paraNumero(campos.visibleReviewCount ?? campos.reviewCount);

  return {
    listingId,
    titulo,
    resumo,
    descricao,
    nota,
    num_avaliacoes: numAvaliacoes,
    e_superhost: campos.isSuperhost ?? null,
    e_guest_favorite: campos.isGuestFavorite === true || campos.isGuestFavorite === "true",
    capacidade: campos.personCapacity ?? null,
    fotos,
    categorias: temCategorias ? categorias : null,
    apiKey,
  };
}

module.exports = { buscarAnuncio, buscarAvaliacoes, extrairIdDoLink, paraNumero };
