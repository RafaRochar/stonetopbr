// Monta uma ficha interativa a partir de window.FICHA (gerado em dados/<id>.js).
// Cada página é a imagem original com os campos posicionados por cima em %.
//
// Dois modos:
//  - local:  sem código no endereço; tudo fica no localStorage deste navegador.
//  - online: endereço com #c=<codigo>; a ficha vive em /api/ficha (Redis na Vercel)
//            e quem abrir o mesmo link vê e edita a mesma ficha, quase ao vivo.
(() => {
  const F = window.FICHA;
  const API = 'api/ficha';
  const INTERVALO = 4000; // ms entre verificações de mudanças feitas por outra pessoa
  const folhas = document.getElementById('folhas');
  const status = document.getElementById('status');
  const campos = new Map(); // nome -> elemento

  const codigoDoEndereco = () => (new URLSearchParams(location.hash.slice(1)).get('c') || '').toLowerCase();
  let codigo = codigoDoEndereco();
  const online = () => !!codigo;
  const chaveLocal = () => online() ? `stonetop:${F.id}:${codigo}` : `stonetop:${F.id}`;

  // ---------- armazenamento local (pode falhar em aba anônima / bloqueio de cookies)
  const ler = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  const gravarLocal = (d) => { try { localStorage.setItem(chaveLocal(), JSON.stringify(d)); return true; } catch { return false; } };

  let estado = ler(chaveLocal());
  const avisar = (t) => { status.textContent = t; };

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

  // ---------- gravação
  const pendentes = new Map(); // campo -> valor (null = apagar), ainda não enviados
  let timer = null, enviando = false, versao = 0, resetPendente = false;

  function alterar(n, valor, repintar) {
    if (valor === null) delete estado[n]; else estado[n] = valor;
    if (repintar) pintar(n);
    gravarLocal(estado); // no modo online serve de cópia de segurança
    if (!online()) { avisar('Salvo neste navegador'); return; }
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
    if (enviando || (!pendentes.size && !resetPendente)) return;
    enviando = true;
    const lote = new Map(pendentes);
    pendentes.clear();
    const reset = resetPendente;
    resetPendente = false;
    const corpo = { tipo: F.id, c: codigo, set: {}, del: [] };
    if (reset) { corpo.reset = true; Object.assign(corpo.set, estado); }
    else for (const [n, v] of lote) v === null ? corpo.del.push(n) : (corpo.set[n] = v);
    let outraPessoa = false;
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro || `HTTP ${r.status}`);
      // se a versão pulou mais de 1, outra pessoa gravou no meio: busca o resto
      outraPessoa = d.v !== versao + 1;
      versao = d.v;
      avisar('Salvo online');
    } catch (e) {
      // devolve o lote para a fila sem passar por cima do que foi digitado depois
      for (const [n, v] of lote) if (!pendentes.has(n)) pendentes.set(n, v);
      if (reset) resetPendente = true;
      avisar('Sem conexão — tentando de novo…');
      console.warn('ficha online:', e);
      clearTimeout(timer);
      timer = setTimeout(enviar, 5000);
    } finally {
      enviando = false;
      if (pendentes.size || resetPendente) agendarEnvio();
      else if (outraPessoa) verificar(true); // só depois de liberar `enviando`, senão verificar() desiste
    }
  }

  // ---------- leitura (primeira carga e mudanças de outras pessoas)
  async function verificar(forcar = false) {
    if (!online() || enviando) return;
    try {
      const q = new URLSearchParams({ tipo: F.id, c: codigo });
      if (!forcar) q.set('v', versao);
      const r = await fetch(`${API}?${q}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erro || `HTTP ${r.status}`);
      if (d.igual) return;
      versao = d.v;
      const foco = document.activeElement;
      const novos = d.campos || {};
      // o que ainda está na fila local vence o que veio do servidor
      for (const [n, v] of pendentes) { if (v === null) delete novos[n]; else novos[n] = v; }
      estado = novos;
      gravarLocal(estado);
      campos.forEach((el, n) => { if (el !== foco) pintar(n); });
      if (!pendentes.size) avisar('Salvo online');
    } catch (e) {
      console.warn('ficha online:', e);
      avisar('Sem conexão com a ficha online');
    }
  }

  let sondagem = null;
  function iniciarSondagem() {
    clearInterval(sondagem);
    sondagem = setInterval(() => { if (!document.hidden) verificar(); }, INTERVALO);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && online()) verificar(); });

  // ---------- modo online: criar link e compartilhar
  const botaoOnline = document.getElementById('online');
  const dialogo = document.getElementById('dialogo-online');
  const campoLink = document.getElementById('link-online');

  function novoCodigo() {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return [...b].map(x => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join('');
  }

  function linkAtual() { return `${location.origin}${location.pathname}#c=${codigo}`; }

  function atualizarBotao() {
    botaoOnline.textContent = online() ? 'Link da ficha' : 'Colocar online';
    document.body.classList.toggle('modo-online', online());
  }

  function lembrar() {
    // lista de fichas online abertas neste navegador, mostrada na página inicial
    try {
      const k = 'stonetop:recentes';
      const lista = JSON.parse(localStorage.getItem(k) || '[]').filter(x => !(x.tipo === F.id && x.c === codigo));
      lista.unshift({ tipo: F.id, titulo: F.titulo, c: codigo, nome: nomePersonagem(), em: Date.now() });
      localStorage.setItem(k, JSON.stringify(lista.slice(0, 30)));
    } catch { /* sem armazenamento, sem lista */ }
  }

  botaoOnline.addEventListener('click', async () => {
    if (!online()) {
      if (!confirm('Criar um link online para esta ficha?\n\nQuem tiver o link poderá ver e editar a ficha de qualquer lugar. O que já está preenchido vai junto.')) return;
      codigo = novoCodigo();
      history.replaceState(null, '', `#c=${codigo}`);
      versao = 0;
      resetPendente = true; // sobe a ficha inteira de uma vez
      gravarLocal(estado);
      atualizarBotao();
      iniciarSondagem();
      await enviar();
      lembrar();
    }
    campoLink.value = linkAtual();
    dialogo.showModal();
    campoLink.select();
  });

  document.getElementById('copiar-link').addEventListener('click', async () => {
    const b = document.getElementById('copiar-link');
    try { await navigator.clipboard.writeText(campoLink.value); b.textContent = 'Copiado!'; }
    catch { campoLink.select(); document.execCommand('copy'); b.textContent = 'Copiado!'; }
    setTimeout(() => { b.textContent = 'Copiar'; }, 1800);
  });
  document.getElementById('fechar-dialogo').addEventListener('click', () => dialogo.close());

  document.getElementById('sair-online').addEventListener('click', () => {
    if (!confirm('Parar de usar o link neste navegador?\n\nA ficha online continua existindo para quem tem o link. Aqui você volta para a ficha local.')) return;
    dialogo.close();
    location.href = location.pathname;
  });

  window.addEventListener('hashchange', () => location.reload());

  // ---------- exportar / importar / imprimir / limpar
  const nomePersonagem = () => {
    const k = [...campos.keys()].find(n => /\.nome$/.test(n));
    return (k && estado[k] || '').trim();
  };

  function substituirTudo(novo) {
    estado = novo;
    pintarTudo();
    gravarLocal(estado);
    if (online()) { pendentes.clear(); resetPendente = true; agendarEnvio(0); }
    else avisar('Salvo neste navegador');
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
  atualizarBotao();
  pintarTudo();
  if (online()) {
    avisar('Carregando ficha online…');
    verificar(true).then(() => { lembrar(); iniciarSondagem(); });
  } else {
    avisar(Object.keys(estado).length ? 'Ficha carregada deste navegador' : 'Tudo o que você preencher fica salvo neste navegador');
  }
})();
