// Junta as notas dos topicos e calcula a nota geral ponderada.
// Cada topico chega em momento diferente (cada analise e um clique), entao a
// nota geral e sempre parcial ate a ultima chegar, e diz isso na cara.
(function () {
  const TOPICOS = [
    { chave: "reputacao", nome: "Reputação", peso: 3 },
    { chave: "descricao", nome: "Descrição", peso: 3 },
    { chave: "fotos", nome: "Fotos", peso: 2 },
    { chave: "escuta", nome: "Avaliações", peso: 2 },
  ];

  const notas = {};

  function registrar(chave, nota) {
    const n = Number(nota);
    if (!Number.isFinite(n)) return;
    notas[chave] = Math.max(0, Math.min(10, n));
    render();
  }

  function limpar() {
    Object.keys(notas).forEach((k) => delete notas[k]);
    render();
  }

  // Nota deterministica da reputacao, a partir da nota do Airbnb e do volume.
  // Nao depende de IA: da para mostrar assim que o anuncio e buscado.
  function calcularReputacao(nota, numAvaliacoes) {
    const n = Number(nota);
    const q = Number(numAvaliacoes);
    if (!Number.isFinite(n)) return null;

    // Escala ancorada nos cortes reais do Airbnb: 4,50 vale 0 e 5,00 vale 10.
    // Assim bater Superhost (4,80) da 6 e bater Preferido (4,90) da 8.
    let base = ((n - 4.5) / 0.5) * 10;
    base = Math.max(0, Math.min(10, base));

    // Poucas avaliacoes tornam a nota fragil: uma ruim derruba tudo.
    if (Number.isFinite(q)) {
      if (q < 5) base *= 0.6;
      else if (q < 15) base *= 0.85;
    }
    return Math.round(base * 10) / 10;
  }

  function situacao(n) {
    if (n >= 8) return { classe: "t-pass", rotulo: "Adequada" };
    if (n >= 5) return { classe: "t-weak", rotulo: "Aceitável" };
    return { classe: "t-fail", rotulo: "Requer conserto" };
  }

  function corDaNota(n) {
    return n >= 8 ? "var(--forest)" : n >= 5 ? "var(--amber)" : "var(--oxblood)";
  }

  function calcularGeral() {
    let soma = 0;
    let pesos = 0;
    const feitos = [];
    const faltando = [];
    TOPICOS.forEach((t) => {
      if (notas[t.chave] === undefined) {
        faltando.push(t.nome);
      } else {
        soma += notas[t.chave] * t.peso;
        pesos += t.peso;
        feitos.push(t);
      }
    });
    return {
      nota: pesos ? Math.round((soma / pesos) * 10) / 10 : null,
      feitos,
      faltando,
      completo: faltando.length === 0,
    };
  }

  function render() {
    const alvo = document.getElementById("faixaVeredito");
    if (!alvo) return;

    const g = calcularGeral();
    if (g.nota === null) {
      alvo.style.display = "none";
      return;
    }
    alvo.style.display = "";

    const s = situacao(g.nota);
    const carimbo =
      g.nota >= 8
        ? { texto: "Aprovado", cor: "var(--forest)" }
        : g.nota >= 5
        ? { texto: "Requer atenção", cor: "var(--amber)" }
        : { texto: "Requer conserto", cor: "var(--oxblood)" };

    const linhas = TOPICOS.map((t) => {
      const n = notas[t.chave];
      if (n === undefined) {
        return `<div class="item"><span>${t.nome} <span class="sub">· peso ${t.peso}</span></span><span class="mark" style="color:var(--ink-soft)">—</span><span class="tag" style="background:transparent;color:var(--ink-soft);border:1px dotted var(--rule)">Não analisado</span></div>`;
      }
      const st = situacao(n);
      return `<div class="item"><span>${t.nome} <span class="sub">· peso ${t.peso}</span></span><span class="mark num" style="color:${corDaNota(n)}">${n.toFixed(1)}</span><span class="tag ${st.classe}">${st.rotulo}</span></div>`;
    }).join("");

    alvo.innerHTML = `
      <div class="hero">
        <div class="bigscore">
          <div class="n num" style="color:${corDaNota(g.nota)}">${g.nota.toFixed(1)}</div>
          <div class="d">de 10</div>
        </div>
        <div>
          <span class="stamp" style="border-color:${carimbo.cor}; color:${carimbo.cor}">${carimbo.texto}</span>
          <h1>${textoVeredito(g)}</h1>
          <p class="note">${
            g.completo
              ? "Nota geral ponderada pelos quatro tópicos."
              : `Parcial: ${g.feitos.length} de ${TOPICOS.length} tópicos analisados. Falta ${g.faltando.join(", ").toLowerCase()}.`
          }</p>
        </div>
        <div class="notasTopico">
          <div class="lbl">Nota por tópico</div>
          <div class="items">${linhas}</div>
        </div>
      </div>`;
  }

  function textoVeredito(g) {
    const piores = g.feitos
      .filter((t) => notas[t.chave] < 5)
      .sort((a, b) => notas[a.chave] - notas[b.chave]);
    if (!piores.length) {
      return g.completo
        ? "Nenhum tópico em estado crítico."
        : "Sem problema crítico no que foi analisado até agora.";
    }
    if (piores.length === 1) {
      return `O ponto que mais derruba este anúncio é <em>${piores[0].nome.toLowerCase()}</em>.`;
    }
    return `<em>${piores[0].nome}</em> e <em>${piores[1].nome.toLowerCase()}</em> são o que mais derrubam este anúncio.`;
  }

  window.Notas = { registrar, limpar, calcularReputacao, situacao, corDaNota, TOPICOS };
})();
