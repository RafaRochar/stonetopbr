// Monta uma ficha interativa a partir de window.FICHA (gerado em dados/<id>.js).
// Cada página é a imagem original com os campos posicionados por cima em %.
//
// A ficha é salva ONLINE por padrão: na primeira edição ela ganha um código
// (#c=<codigo> no endereço) e passa a viver em /api/ficha (Redis na Vercel). Quem abrir
// o mesmo link vê e edita a mesma ficha, quase ao vivo. O navegador lembra a última
// ficha aberta de cada tipo, então voltar ao site reabre a mesma ficha.
// Se o servidor não responder (sem internet, aberto como arquivo, banco não
// configurado), a ficha continua salva no navegador e a barra diz o motivo.
(() => {
  const F = window.FICHA;
  const API = 'api/ficha';
  const INTERVALO = 4000; // ms entre verificações de mudanças feitas por outra pessoa
  const CODIGO_OK = /^[a-z0-9]{8,32}$/;
  const folhas = document.getElementById('folhas');
  const status = document.getElementById('status');
  const campos = new Map(); // nome -> elemento

  // ---------- armazenamento local (pode falhar em aba anônima / bloqueio de cookies)
  const lerJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  const lerTexto = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const escrever = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch { return false; } };

  const CHAVE_ATUAL = `stonetop:atual:${F.id}`; // código da última ficha aberta deste tipo
  const CHAVE_SEM_CODIGO = `stonetop:${F.id}`;  // ficha ainda não enviada (ou versão antiga do site)

  const codigoDoEndereco = () => (new URLSearchParams(location.hash.slice(1)).get('c') || '').toLowerCase();
  let codigo = codigoDoEndereco();
  if (codigo && !CODIGO_OK.test(codigo)) codigo = '';
  if (!codigo) {
    const lembrado = lerTexto(CHAVE_ATUAL);
    if (CODIGO_OK.test(lembrado)) { codigo = lembrado; history.replaceState(null, '', `#c=${codigo}`); }
  }
  if (codigo) escrever(CHAVE_ATUAL, codigo);

  const online = () => !!codigo;
  const chaveLocal = () => online() ? `stonetop:${F.id}:${codigo}` : CHAVE_SEM_CODIGO;
  const gravarLocal = () => escrever(chaveLocal(), JSON.stringify(estado));

  let estado = lerJSON(chaveLocal());
  const avisar = (t, tipo = '') => { status.textContent = t; status.dataset.tipo = tipo; };

  // ---------- construção
  F.paginas.forEach((p, i) => {
    const sec = document.createElement('section');
    sec.className = 'pagina';
    sec.style.aspectRatio = `1 / ${p.ratio}`;
    sec.setAttribute('aria-label', `Página ${i + 1} de ${F.paginas.length}`);

    const img = document.createElement('img');
    img.src = p.img; img.alt = ''; img.decoding = 'async';
    if (i > 0) img.loading = 'lazy';
    sec.appendChild(img);

    let nMarca = 0;
    for (const c of p.campos) {
      let el;
      if (c.k === 'check' || c.k === 'dot') {
        el = document.createElement('button');
        el.type = 'button';
        el.className = `caixa ${c.k === 'dot' ? 'bolinha' : 'quadrado'}`;
        el.setAttribute('role', 'checkbox');
        el.setAttribute('aria-label', `${c.k === 'dot' ? 'Marcador' : 'Opção'} ${++nMarca}, página ${i + 1}`);
        el.addEventListener('click', () => alterar(c.n, estado[c.n] ? null : true, true));
      } else {
        el = document.createElement(c.k === 'area' ? 'textarea' : 'input');
        if (c.k === 'text') el.type = 'text';
        el.className = `texto ${c.a === 'l' ? 'esq' : 'centro'}`;
        el.style.fontSize = `${(c.fs * 1.15).toFixed(3)}cqw`; // Caveat desenha menor que a Times dos PDFs
        if (c.max) el.maxLength = c.max;
        el.spellcheck = false;
        el.autocomplete = 'off';
        el.setAttribute('aria-label', rotulo(c.n));
        el.addEventListener('input', () => alterar(c.n, el.value || null, false));
      }
      Object.assign(el.style, { left: `${c.x}%`, top: `${c.y}%`, width: `${c.w}%`, height: `${c.h}%` });
      campos.set(c.n, el);
      sec.appendChild(el);
    }
    folhas.appendChild(sec);
  });

  function rotulo(n) {
    return n.replace(/^p\d+\./, '').replace(/_/g, ' ').replace(/(\D)(\d+)/g, '$1 $2');
  }

  function pintar(n) {
    const el = campos.get(n);
    if (!el) return;
    if (el.tagName === 'BUTTON') el.setAttribute('aria-checked', estado[n] ? 'true' : 'false');
    else if (el.value !== (estado[n] || '')) el.value = estado[n] || '';
  }
  const pintarTudo = () => campos.forEach((_, n) => pintar(n));

  // ---------- por que não deu para salvar online (vira texto na barra)
  let semServidor = ''; // motivo; vazio = ainda não falhou
  function motivo(e, r) {
    if (location.protocol === 'file:') return 'o site foi aberto direto do computador; publique na Vercel para salvar online';
    if (!r) return 'sem conexão com a internet';
    if (r.status === 404) return 'o site publicado não tem a pasta api/ — publique de novo';
    if (e && /Banco não configurado/.test(e.message)) return 'o banco ainda não foi ligado na Vercel (Storage → Upstash Redis)';
    return e && e.message ? e.message : `erro ${r.status}`;
  }
  const avisarLocal = () => avisar(`Salvo só neste navegador — ${semServidor}`, 'alerta');

  async function chamar(url, opcoes) {
    let r = null;
    try {
      r = await fetch(url, opcoes);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro || `HTTP ${r.status}`);
      return d;
    } catch (e) {
      e.motivo = motivo(e, r);
      e.definitivo = !!r && r.status !== 502; // 502 = banco oscilou; vale tentar de novo
      throw e;
    }
  }

  // ---------- gravação
  const pendentes = new Map(); // campo -> valor (null = apagar), ainda não enviados
  let timer = null, enviando = false, versao = 0, resetPendente = false;

  function alterar(n, valor, repintar) {
    if (valor === null) delete estado[n]; else estado[n] = valor;
    if (repintar) pintar(n);
    gravarLocal(); // sempre há uma cópia no navegador
    if (!online()) {
      if (semServidor) { avisarLocal(); return; }
      ficarOnline();
      return;
    }
    pendentes.set(n, valor);
    agendarEnvio();
    if (/\.nome$/.test(n)) lembrar(); // mantém o nome certo na lista da página inicial
  }

  function agendarEnvio(ms = 500) {
    avisar('Salvando…');
    clearTimeout(timer);
    timer = setTimeout(enviar, ms);
  }

  async function enviar() {
    if (!online() || enviando || (!pendentes.size && !resetPendente)) return;
    enviando = true;
    const lote = new Map(pendentes);
    pendentes.clear();
    const reset = resetPendente;
    resetPendente = false;
    const corpo = { tipo: F.id, c: codigo, set: {}, del: [] };
    if (reset) { corpo.reset = true; Object.assign(corpo.set, estado); }
    else for (const [n, v] of lote) v === null ? corpo.del.push(n) : (corpo.set[n] = v);
    let outraPessoa = false, falhou = false;
    try {
      const d = await chamar(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      // se a versão pulou mais de 1, outra pessoa gravou no meio: busca o resto
      outraPessoa = d.v !== versao + 1;
      versao = d.v;
      avisar('Salvo online', 'ok');
    } catch (e) {
      falhou = true;
      // devolve o lote para a fila sem passar por cima do que foi digitado depois
      for (const [n, v] of lote) if (!pendentes.has(n)) pendentes.set(n, v);
      if (reset) resetPendente = true;
      avisar(`Não salvou online (${e.motivo}) — tentando de novo…`, 'alerta');
      console.warn('ficha online:', e);
      clearTimeout(timer);
      timer = setTimeout(enviar, 5000);
    } finally {
      enviando = false;
      if (falhou) { /* a nova tentativa já está agendada para daqui a 5s */ }
      else if (pendentes.size || resetPendente) agendarEnvio();
      else if (outraPessoa) verificar(true); // só depois de liberar `enviando`, senão verificar() desiste
    }
  }

  // ---------- primeira gravação: cria o código e sobe a ficha inteira
  let criando = null, mudouDurante = false;
  function novoCodigo() {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return [...b].map(x => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join('');
  }

  function ficarOnline() {
    if (online()) return Promise.resolve(true);
    if (criando) { mudouDurante = true; return criando; }
    mudouDurante = false;
    avisar('Salvando…');
    const c = novoCodigo();
    criando = chamar(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: F.id, c, reset: true, set: estado, del: [] }),
    }).then(d => {
      codigo = c;
      versao = d.v;
      history.replaceState(null, '', `#c=${c}`);
      escrever(CHAVE_ATUAL, c);
      gravarLocal();
      escrever(CHAVE_SEM_CODIGO, null); // já está online; não sobe de novo depois
      semServidor = '';
      atualizarModo();
      iniciarSondagem();
      lembrar();
      if (mudouDurante) { resetPendente = true; agendarEnvio(0); }
      else avisar('Salvo online', 'ok');
      return true;
    }).catch(e => {
      semServidor = e.motivo;
      avisarLocal();
      console.warn('ficha online:', e);
      if (!e.definitivo) setTimeout(() => { semServidor = ''; }, 15000); // tenta de novo na próxima edição
      return false;
    }).finally(() => { criando = null; });
    return criando;
  }

  // ---------- leitura (primeira carga e mudanças de outras pessoas)
  async function verificar(forcar = false) {
    if (!online() || enviando) return;
    try {
      const q = new URLSearchParams({ tipo: F.id, c: codigo });
      if (!forcar) q.set('v', versao);
      const d = await chamar(`${API}?${q}`, { cache: 'no-store' });
      if (d.igual) return;
      versao = d.v;
      const foco = document.activeElement;
      const novos = d.campos || {};
      // o que ainda está na fila local vence o que veio do servidor
      for (const [n, v] of pendentes) { if (v === null) delete novos[n]; else novos[n] = v; }
      estado = novos;
      gravarLocal();
      campos.forEach((el, n) => { if (el !== foco) pintar(n); });
      if (!pendentes.size) avisar('Salvo online', 'ok');
    } catch (e) {
      console.warn('ficha online:', e);
      avisar(`Sem conexão com a ficha online (${e.motivo})`, 'alerta');
    }
  }

  let sondagem = null;
  function iniciarSondagem() {
    clearInterval(sondagem);
    sondagem = setInterval(() => { if (!document.hidden) verificar(); }, INTERVALO);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && online()) verificar(); });
  window.addEventListener('hashchange', () => location.reload());

  // ---------- compartilhar / nova ficha
  const dialogo = document.getElementById('dialogo-online');
  const campoLink = document.getElementById('link-online');
  const linkAtual = () => `${location.origin}${location.pathname}#c=${codigo}`;

  function atualizarModo() { document.body.classList.toggle('modo-online', online()); }

  function lembrar() {
    // lista de fichas online abertas neste navegador, mostrada na página inicial
    try {
      const k = 'stonetop:recentes';
      const lista = JSON.parse(localStorage.getItem(k) || '[]').filter(x => !(x.tipo === F.id && x.c === codigo));
      lista.unshift({ tipo: F.id, titulo: F.titulo, c: codigo, nome: nomePersonagem(), em: Date.now() });
      localStorage.setItem(k, JSON.stringify(lista.slice(0, 30)));
    } catch { /* sem armazenamento, sem lista */ }
  }

  document.getElementById('online').addEventListener('click', async () => {
    if (!online() && !(await ficarOnline())) {
      alert(`Não consegui colocar a ficha online: ${semServidor}.\n\nEla continua salva neste navegador.`);
      return;
    }
    campoLink.value = linkAtual();
    dialogo.showModal();
    campoLink.select();
  });

  document.getElementById('copiar-link').addEventListener('click', async () => {
    const b = document.getElementById('copiar-link');
    try { await navigator.clipboard.writeText(campoLink.value); }
    catch { campoLink.select(); document.execCommand('copy'); }
    b.textContent = 'Copiado!';
    setTimeout(() => { b.textContent = 'Copiar'; }, 1800);
  });
  document.getElementById('fechar-dialogo').addEventListener('click', () => dialogo.close());

  document.getElementById('nova').addEventListener('click', () => {
    const msg = online()
      ? 'Começar uma ficha nova, em branco?\n\nA ficha atual continua salva online: ela fica na lista da página inicial e o link dela continua funcionando.'
      : 'Começar uma ficha nova, em branco? O que está preenchido aqui será apagado — exporte antes se quiser guardar.';
    if (!confirm(msg)) return;
    escrever(CHAVE_ATUAL, null);
    escrever(CHAVE_SEM_CODIGO, null);
    location.href = location.pathname;
  });

  // ---------- exportar / importar / imprimir / limpar
  const nomePersonagem = () => {
    const k = [...campos.keys()].find(n => /\.nome$/.test(n));
    return (k && estado[k] || '').trim();
  };

  function substituirTudo(novo) {
    estado = novo;
    pintarTudo();
    gravarLocal();
    if (online()) { pendentes.clear(); resetPendente = true; agendarEnvio(0); }
    else if (semServidor) avisarLocal();
    else ficarOnline();
  }

  document.getElementById('exportar').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ ficha: F.id, versao: 1, salvo_em: new Date().toISOString(), campos: estado }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    const nome = nomePersonagem();
    a.download = `${F.titulo}${nome ? ' - ' + nome : ''}.json`.replace(/[\\/:*?"<>|]/g, '');
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const arquivo = document.getElementById('arquivo');
  document.getElementById('importar').addEventListener('click', () => arquivo.click());
  arquivo.addEventListener('change', async () => {
    const f = arquivo.files[0];
    arquivo.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.ficha !== F.id) {
        alert(`Este arquivo é de outra ficha (${d.ficha || 'desconhecida'}). Abra a ficha certa para importá-lo.`);
        return;
      }
      if (Object.keys(estado).length && !confirm('Substituir o que está preenchido agora pelo conteúdo do arquivo?')) return;
      substituirTudo(d.campos || {});
    } catch {
      alert('Não consegui ler este arquivo. Ele precisa ser um .json exportado por este site.');
    }
  });

  document.getElementById('imprimir').addEventListener('click', () => window.print());

  document.getElementById('limpar').addEventListener('click', () => {
    const msg = online()
      ? 'Apagar tudo o que foi preenchido nesta ficha? Ela está online: vai ficar em branco para todo mundo que tem o link.'
      : 'Apagar tudo o que foi preenchido nesta ficha? Exporte antes se quiser guardar uma cópia.';
    if (confirm(msg)) substituirTudo({});
  });

  // ---------- início
  atualizarModo();
  pintarTudo();
  if (online()) {
    avisar('Carregando ficha online…');
    verificar(true).then(() => { lembrar(); iniciarSondagem(); });
  } else if (Object.keys(estado).length) {
    ficarOnline(); // ficha preenchida antes (ou em versão antiga do site): sobe agora
  } else {
    avisar('Comece a preencher — a ficha é salva online automaticamente');
  }
})();
