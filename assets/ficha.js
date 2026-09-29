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

  // notas livres dos mapas (ver prepararNotas); declaradas antes da construção, que já as usa
  const notas = new Map();        // nome -> elemento .nota
  const paginasNotas = new Map(); // nº da página -> <section>
  const LARGURA_NOTA = 16;        // % da largura da página

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
    if (p.notas) prepararNotas(sec, i + 1);
    folhas.appendChild(sec);
  });

  // ---------- notas livres (mapas da Ficha do Mestre)
  // Cada nota é um campo "p<pág>.nota_<id>" cujo valor é "x;y;texto" (x/y em % da página),
  // então ela grava e sincroniza pelo mesmo caminho dos outros campos.
  function lerNota(v) {
    const m = /^(-?[\d.]+);(-?[\d.]+);([\s\S]*)$/.exec(v || '');
    return m ? { x: +m[1], y: +m[2], t: m[3] } : null;
  }
  const valorNota = (x, y, t) => `${x.toFixed(2)};${y.toFixed(2)};${t}`;

  function prepararNotas(sec, pag) {
    sec.classList.add('com-notas');
    paginasNotas.set(pag, sec);
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'nova-nota';
    botao.textContent = '+ Nota';
    botao.title = 'Adicionar uma nota neste mapa (ou dê um clique duplo no lugar certo)';
    let desloca = 0;
    botao.addEventListener('click', () => { criarNota(pag, 8 + (desloca % 5) * 4, 10 + (desloca % 5) * 6); desloca++; });
    sec.appendChild(botao);
    sec.addEventListener('dblclick', (e) => {
      if (e.target !== sec && e.target.tagName !== 'IMG') return;
      const r = sec.getBoundingClientRect();
      criarNota(pag, (e.clientX - r.left) / r.width * 100 - 2, (e.clientY - r.top) / r.height * 100 - 2);
    });
  }

  function criarNota(pag, x, y) {
    const id = `p${pag}.nota_${Math.random().toString(36).slice(2, 10)}`;
    x = Math.min(Math.max(x, 0), 100 - LARGURA_NOTA);
    y = Math.min(Math.max(y, 0), 94);
    alterar(id, valorNota(x, y, ''), false);
    sincronizarNotas();
    notas.get(id)?.querySelector('textarea').focus();
  }

  function elementoNota(n) {
    const pag = +/^p(\d+)\./.exec(n)[1];
    const sec = paginasNotas.get(pag);
    if (!sec) return null;
    const el = document.createElement('div');
    el.className = 'nota';
    el.style.width = `${LARGURA_NOTA}%`;
    const barra = document.createElement('div');
    barra.className = 'nota-barra';
    barra.title = 'Arraste para mover';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'nota-apagar';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Apagar nota');
    x.addEventListener('click', () => {
      if (lerNota(estado[n])?.t && !confirm('Apagar esta nota?')) return;
      alterar(n, null, false);
      sincronizarNotas();
    });
    barra.appendChild(x);
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Nota no mapa');
    ta.addEventListener('input', () => {
      const v = lerNota(estado[n]) || { x: 0, y: 0 };
      alterar(n, valorNota(v.x, v.y, ta.value), false);
    });
    ta.addEventListener('blur', () => {
      // nota criada e deixada em branco some sozinha
      if (!ta.value.trim() && estado[n] !== undefined) { alterar(n, null, false); sincronizarNotas(); }
    });
    el.append(barra, ta);

    // arrastar pela barra (mouse ou dedo)
    barra.addEventListener('pointerdown', (e) => {
      if (e.target === x) return;
      e.preventDefault();
      barra.setPointerCapture(e.pointerId);
      const r = sec.getBoundingClientRect();
      const inicio = lerNota(estado[n]);
      const ox = e.clientX, oy = e.clientY;
      let nx = inicio.x, ny = inicio.y;
      const mover = (ev) => {
        nx = Math.min(Math.max(inicio.x + (ev.clientX - ox) / r.width * 100, 0), 100 - LARGURA_NOTA);
        ny = Math.min(Math.max(inicio.y + (ev.clientY - oy) / r.height * 100, 0), 97);
        el.style.left = `${nx}%`; el.style.top = `${ny}%`;
      };
      const soltar = () => {
        barra.removeEventListener('pointermove', mover);
        barra.removeEventListener('pointerup', soltar);
        barra.removeEventListener('pointercancel', soltar);
        if (nx !== inicio.x || ny !== inicio.y) alterar(n, valorNota(nx, ny, lerNota(estado[n]).t), false);
      };
      barra.addEventListener('pointermove', mover);
      barra.addEventListener('pointerup', soltar);
      barra.addEventListener('pointercancel', soltar);
    });

    sec.appendChild(el);
    return el;
  }

  // cria/atualiza/remove as notas a partir do estado (depois de carregar ou receber mudanças)
  function sincronizarNotas(foco = document.activeElement) {
    if (!paginasNotas.size) return;
    for (const [n, v] of Object.entries(estado)) {
      if (!/^p\d+\.nota_/.test(n)) continue;
      const d = lerNota(v);
      if (!d) continue;
      let el = notas.get(n);
      if (!el) { el = elementoNota(n); if (!el) continue; notas.set(n, el); }
      el.style.left = `${d.x}%`; el.style.top = `${d.y}%`;
      const ta = el.querySelector('textarea');
      if (ta !== foco && ta.value !== d.t) ta.value = d.t;
    }
    for (const [n, el] of notas) if (estado[n] === undefined) { el.remove(); notas.delete(n); }
  }

  function rotulo(n) {
    return n.replace(/^p\d+\./, '').replace(/_/g, ' ').replace(/(\D)(\d+)/g, '$1 $2');
  }

  function pintar(n) {
    const el = campos.get(n);
    if (!el) return;
    if (el.tagName === 'BUTTON') el.setAttribute('aria-checked', estado[n] ? 'true' : 'false');
    else if (el.value !== (estado[n] || '')) el.value = estado[n] || '';
  }
  const pintarTudo = () => { campos.forEach((_, n) => pintar(n)); sincronizarNotas(); };

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
      sincronizarNotas(foco);
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
