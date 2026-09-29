// Função serverless da Vercel: guarda as fichas online num Redis (Upstash).
//
// Cada ficha é um hash  ficha:<tipo>:<codigo>  (campo -> valor) e um contador
// ficha:<tipo>:<codigo>:v  que sobe a cada gravação. Gravar campo a campo (HSET/HDEL)
// é o que deixa duas pessoas editarem ao mesmo tempo sem uma apagar a outra.
//
//   GET  /api/ficha?tipo=abencoado&c=<codigo>[&v=<versão que já tenho>]
//        -> { v, campos }  ou  { v, igual: true } se nada mudou
//   POST /api/ficha  { tipo, c, set: {campo: valor}, del: [campo], reset?: true }
//        -> { v }
//
// Variáveis de ambiente (criadas pela integração Upstash da Vercel):
//   KV_REST_API_URL + KV_REST_API_TOKEN   ou   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN

const TIPOS = new Set(['abencoado', 'suposto-heroi', 'vilarejo']);
const CODIGO = /^[a-z0-9]{8,32}$/;
const CAMPO = /^p\d{1,2}\.[a-zA-Z0-9_]{1,60}$/;
const MAX_VALOR = 4000;
const MAX_CAMPOS = 800;
const VALIDADE = 60 * 60 * 24 * 400; // ~13 meses sem uso e a ficha expira

const URL_REDIS = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(caminho, comandos) {
  const r = await fetch(`${URL_REDIS}/${caminho}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comandos),
  });
  if (!r.ok) throw new Error(`redis ${r.status}: ${await r.text()}`);
  const out = await r.json();
  const erro = out.find?.(x => x.error);
  if (erro) throw new Error(`redis: ${erro.error}`);
  return out.map(x => x.result);
}

const erro = (res, status, msg) => res.status(status).json({ erro: msg });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_REDIS || !TOKEN) return erro(res, 500, 'Banco não configurado: conecte o Upstash Redis ao projeto na Vercel.');

  const fonte = req.method === 'GET' ? req.query : (req.body || {});
  const { tipo, c } = fonte;
  if (!TIPOS.has(tipo)) return erro(res, 400, 'tipo de ficha inválido');
  if (typeof c !== 'string' || !CODIGO.test(c)) return erro(res, 400, 'código inválido');
  const chave = `ficha:${tipo}:${c}`, chaveV = `${chave}:v`;

  try {
    if (req.method === 'GET') {
      const [v] = await redis('pipeline', [['GET', chaveV]]);
      const versao = Number(v) || 0;
      if (req.query.v !== undefined && Number(req.query.v) === versao) return res.json({ v: versao, igual: true });
      const [lista] = await redis('pipeline', [['HGETALL', chave]]);
      const campos = {};
      for (let i = 0; i < (lista || []).length; i += 2) {
        const val = lista[i + 1];
        campos[lista[i]] = val === '\u0001' ? true : val; // \u0001 = caixa marcada
      }
      return res.json({ v: versao, campos });
    }

    if (req.method === 'POST') {
      const set = fonte.set && typeof fonte.set === 'object' ? fonte.set : {};
      const del = Array.isArray(fonte.del) ? fonte.del : [];
      const nomes = [...Object.keys(set), ...del];
      if (nomes.length > MAX_CAMPOS) return erro(res, 400, 'campos demais');
      if (nomes.some(n => typeof n !== 'string' || !CAMPO.test(n))) return erro(res, 400, 'nome de campo inválido');

      const hset = [];
      for (const [n, val] of Object.entries(set)) {
        if (val === true) hset.push(n, '\u0001');
        else if (typeof val === 'string' && val.length <= MAX_VALOR && val !== '\u0001') hset.push(n, val);
        else return erro(res, 400, `valor inválido em ${n}`);
      }

      const cmds = [];
      if (fonte.reset) cmds.push(['DEL', chave]);
      if (hset.length) cmds.push(['HSET', chave, ...hset]);
      if (del.length && !fonte.reset) cmds.push(['HDEL', chave, ...del]);
      cmds.push(['INCR', chaveV], ['EXPIRE', chave, VALIDADE], ['EXPIRE', chaveV, VALIDADE]);

      const out = await redis('multi-exec', cmds);
      return res.json({ v: out[out.length - 3] });
    }

    res.setHeader('Allow', 'GET, POST');
    return erro(res, 405, 'método não permitido');
  } catch (e) {
    console.error(e);
    return erro(res, 502, 'falha ao falar com o banco');
  }
};
