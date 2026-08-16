const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

function loginConfigurado() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_KEY);
}

function cabecalhosServico() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function usuarioDoToken(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? u : null;
}

async function buscarPerfil(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/perfis?user_id=eq.${userId}&select=*`,
    { headers: cabecalhosServico() }
  );
  if (!res.ok) return null;
  const linhas = await res.json();
  return linhas[0] || null;
}

async function criarPerfil(usuario) {
  const corpo = {
    user_id: usuario.id,
    email: usuario.email || null,
    nome: usuario.user_metadata?.full_name || null,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/perfis`, {
    method: "POST",
    headers: { ...cabecalhosServico(), Prefer: "return=representation" },
    body: JSON.stringify(corpo),
  });
  if (!res.ok) throw new Error(`Nao foi possivel criar o perfil (${res.status}).`);
  const linhas = await res.json();
  return linhas[0];
}

async function perfilDoUsuario(usuario) {
  const existente = await buscarPerfil(usuario.id);
  if (existente) return existente;
  return criarPerfil(usuario);
}

async function registrarAnalise(userId, usadasAtuais) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/perfis?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: { ...cabecalhosServico(), Prefer: "return=representation" },
    body: JSON.stringify({ analises_usadas: usadasAtuais + 1, ultima_analise: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Nao foi possivel registrar a analise (${res.status}).`);
  const linhas = await res.json();
  return linhas[0];
}

function temCredito(perfil) {
  if (!perfil) return false;
  if (perfil.plano && perfil.plano !== "gratis") return true;
  return (perfil.analises_usadas || 0) < (perfil.limite_gratis ?? 1);
}

// Middleware: exige login e credito disponivel.
// Enquanto o Supabase nao estiver configurado, deixa passar para nao derrubar o site.
async function exigirCredito(req, res, next) {
  if (!loginConfigurado()) {
    req.perfil = null;
    return next();
  }

  const cabecalho = req.headers.authorization || "";
  const token = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7) : null;

  try {
    const usuario = await usuarioDoToken(token);
    if (!usuario) {
      return res.status(401).json({ error: "Faca login para analisar um anuncio.", precisa_login: true });
    }

    const perfil = await perfilDoUsuario(usuario);
    if (!temCredito(perfil)) {
      return res.status(402).json({
        error: "Voce ja usou sua analise gratuita. Assine para continuar analisando.",
        precisa_pagar: true,
        analises_usadas: perfil.analises_usadas,
        limite_gratis: perfil.limite_gratis,
      });
    }

    req.usuario = usuario;
    req.perfil = perfil;
    return next();
  } catch (err) {
    console.error("Erro na verificacao de login:", err.message);
    return res.status(500).json({ error: "Erro ao verificar seu acesso: " + err.message });
  }
}

module.exports = {
  loginConfigurado,
  exigirCredito,
  perfilDoUsuario,
  usuarioDoToken,
  registrarAnalise,
  temCredito,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
};
