// Mapa de Stonetop com um pino por jogador, sincronizado online.
//
// Usa a mesma API das fichas (/api/ficha, tipo "mapa"). Cada jogador é um campo
//   p0.jog_<id> = "<mapa>;<x>;<y>;<cor>;<nome>"     (x/y em % da imagem)
// então mover um pino grava só aquele campo, e duas pessoas mexendo ao mesmo tempo
// em pinos diferentes não se atrapalham. Como nas fichas, o mapa ganha um código na
// primeira alteração (#c=<codigo>) e o navegador lembra o último mapa aberto.
(() => {
  const TIPO = 'mapa';
  const API = 'api/ficha';
  const INTERVALO = 3000;
  const CODIGO_OK = /^[a-z0-9]{8,32}$/;
  const MAPAS = [
    { id: 'lar', nome: 'Stonetop', img: 'img/mapa-lar.jpg', w: 2454, h: 1260 },
    { id: 'arredores', nome: 'Arredores', img: 'img/mapa-arredores.jpg', w: 2432, h: 1780 },
    { id: 'regiao', nome: 'Região', img: 'img/mapa-regiao.jpg', w: 2490, h: 2100 },
  ];
  const CORES = ['#c0392b', '#2471a3', '#1e8449', '#b9770e', '#7d3c98', '#117a65', '#d35400', '#34495e'];

  const status = document.getElementById('status');
  const avisar = (t, tipo = '') => { status.textContent = t; status.dataset.tipo = tipo; };

  // ---------- armazenamento local
  const lerJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  const lerTexto = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const escrever = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch { return false; } };
  const CHAVE_ATUAL = `stonetop:atual:${TIPO}`;
  const CHAVE_SEM_CODIGO = `stonetop:${TIPO}`;

  let codigo = (new URLSearchParams(location.hash.slice(1)).get('c') || '').toLowerCase();
  if (!CODIGO_OK.test(codigo)) codigo = '';
  if (!codigo) {
    const lembrado = lerTexto(CHAVE_ATUAL);
    if (CODIGO_OK.test(lembrado)) { codigo = lembrado; history.replaceState(null, '', `#c=${codigo}`); }
  }
  if (codigo) escrever(CHAVE_ATUAL, codigo);
  const online = () => !!codigo;
  const chaveLocal = () => online() ? `stonetop:${TIPO}:${codigo}` : CHAVE_SEM_CODIGO;
  let estado = lerJSON(chaveLocal());
  const gravarLocal = () => escrever(chaveLocal(), JSON.stringify(estado));

  // ---------- jogadores <-> campos
  function lerJogador(v) {
    const m = /^([a-z]+);(-?[\d.]+);(-?[\d.]+);(#[0-9a-f]{6});([\s\S]*)$/i.exec(v || '');
    return m ? { mapa: m[1], x: +m[2], y: +m[3], cor: m[4], nome: m[5] } : null;
  }
  const valorJogador = (j) => `${j.mapa};${j.x.toFixed(2)};${j.y.toFixed(2)};${j.cor};${j.nome}`;
  const jogadores = () => Object.entries(estado)
    .filter(([n]) => /^p0\.jog_/.test(n))
    .map(([n, v]) => ({ n, ...lerJogador(v) }))
    .filter(j => j.mapa)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  // ---------- mapa (Leaflet, imagem simples com coordenadas em pixels)
  const mapa = L.map('mapa', { crs: L.CRS.Simple, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false, zoomControl: true });
  let atual = null, camada = null;
  const pinos = new Map(); // nome do campo -> marcador
  let arrastando = null;

  const paraLatLng = (m, x, y) => L.latLng(m.h * (1 - y / 100), m.w * x / 100);
  const paraPct = (m, ll) => ({
    x: Math.min(Math.max(ll.lng / m.w * 100, 0), 100),
    y: Math.min(Math.max((1 - ll.lat / m.h) * 100, 0), 100),
  });

  function mostrarMapa(id, { enquadrar = true } = {}) {
    const m = MAPAS.find(x => x.id === id) || MAPAS[0];
    const trocou = atual !== m;
    atual = m;
    escrever('stonetop:mapa:aba', m.id);
    document.querySelectorAll('.aba-mapa').forEach(b => b.setAttribute('aria-selected', b.dataset.mapa === m.id ? 'true' : 'false'));
    if (trocou) {
      const limites = L.latLngBounds([0, 0], [m.h, m.w]);
      if (camada) camada.remove();
      camada = L.imageOverlay(m.img, limites).addTo(mapa);
      mapa.setMaxBounds(limites.pad(0.15));
      mapa.setMinZoom(-10);
      if (enquadrar) mapa.fitBounds(limites);
      mapa.setMinZoom(mapa.getBoundsZoom(limites) - 0.5);
      mapa.setMaxZoom(mapa.getBoundsZoom(limites) + 3);
    }
    desenharPinos();
  }

  const escapar = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function icone(j) {
    const inicial = escapar((j.nome.trim()[0] || '?').toUpperCase());
    return L.divIcon({
      className: 'pino',
      html: `<div class="pino-corpo" style="--cor:${j.cor}"><span>${inicial}</span></div><div class="pino-nome">${escapar(j.nome || 'Sem nome')}</div>`,
      iconSize: [40, 60], iconAnchor: [20, 44],
    });
  }

  function desenharPinos() {
    const lista = jogadores();
    const aqui = new Set(lista.filter(j => j.mapa === atual.id).map(j => j.n));
    for (const [n, mk] of pinos) if (!aqui.has(n)) { mk.remove(); pinos.delete(n); }
    for (const j of lista) {
      if (j.mapa !== atual.id) continue;
      let mk = pinos.get(j.n);
      if (!mk) {
        mk = L.marker(paraLatLng(atual, j.x, j.y), { draggable: true, icon: icone(j), keyboard: true, title: j.nome, autoPan: true });
        mk.on('dragstart', () => { arrastando = j.n; });
        mk.on('dragend', () => {
          arrastando = null;
          const atualJ = lerJogador(estado[j.n]);
          if (!atualJ) return;
          const p = paraPct(atual, mk.getLatLng());
          alterar(j.n, valorJogador({ ...atualJ, mapa: atual.id, ...p }));
        });
        mk.addTo(mapa);
        mk._assinatura = '';
        pinos.set(j.n, mk);
      }
      const assinatura = `${j.cor}|${j.nome}`;
      if (mk._assinatura !== assinatura) { mk.setIcon(icone(j)); mk._assinatura = assinatura; }
      if (arrastando !== j.n) mk.setLatLng(paraLatLng(atual, j.x, j.y));
    }
    desenharLista(lista);
  }

  // ---------- painel: lista de jogadores
  const listaEl = document.getElementById('lista-jogadores');
  function desenharLista(lista) {
    listaEl.innerHTML = '';
    if (!lista.length) {
      const li = document.createElement('li');
      li.className = 'vazio';
      li.textContent = 'Ninguém no mapa ainda. Adicione um jogador abaixo.';
      listaEl.appendChild(li);
      return;
    }
    for (const j of lista) {
      const li = document.createElement('li');
      const m = MAPAS.find(x => x.id === j.mapa);
      const ir = document.createElement('button');
      ir.type = 'button';
      ir.className = 'jog-nome';
      ir.innerHTML = `<span class="bolinha-cor" style="background:${j.cor}"></span><span class="txt"></span><small></small>`;
      ir.querySelector('.txt').textContent = j.nome || 'Sem nome';
      ir.querySelector('small').textContent = m ? m.nome : '';
      ir.title = 'Mostrar no mapa';
      ir.addEventListener('click', () => {
        mostrarMapa(j.mapa, { enquadrar: false });
        mapa.flyTo(paraLatLng(atual, j.x, j.y), Math.max(mapa.getZoom(), mapa.getMinZoom() + 1.5), { duration: 0.6 });
      });
      const acoes = document.createElement('span');
      acoes.className = 'jog-acoes';
      const botao = (txt, titulo, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.title = titulo; b.setAttribute('aria-label', `${titulo}: ${j.nome}`); b.addEventListener('click', fn); acoes.appendChild(b); };
      if (j.mapa !== atual.id) botao('Trazer', 'Trazer para este mapa', () => {
        const c = paraPct(atual, mapa.getCenter());
        alterar(j.n, valorJogador({ ...j, mapa: atual.id, ...c }));
      });
      botao('✎', 'Renomear', () => {
        const novo = prompt('Nome do jogador:', j.nome);
        if (novo === null || !novo.trim()) return;
        alterar(j.n, valorJogador({ ...j, nome: novo.trim().slice(0, 40) }));
      });
      botao('×', 'Tirar do mapa', () => {
        if (!confirm(`Tirar ${j.nome || 'este jogador'} do mapa?`)) return;
        alterar(j.n, null);
      });
      li.append(ir, acoes);
      listaEl.appendChild(li);
    }
  }

  // formulário de novo jogador
  const form = document.getElementById('novo-jogador');
  const coresEl = document.getElementById('cores');
  let corEscolhida = CORES[0];
  CORES.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cor';
    b.style.background = c;
    b.dataset.cor = c;
    b.setAttribute('aria-label', `Cor ${i + 1}`);
    b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    b.addEventListener('click', () => {
      corEscolhida = c;
      coresEl.querySelectorAll('.cor').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    });
    coresEl.appendChild(b);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = form.nome.value.trim().slice(0, 40);
    if (!nome) { form.nome.focus(); return; }
    const id = `p0.jog_${Math.random().toString(36).slice(2, 10)}`;
    const c = paraPct(atual, mapa.getCenter());
    // cada pino novo entra um pouco ao lado do anterior, para não ficarem empilhados
    const n = jogadores().filter(j => j.mapa === atual.id).length;
    c.x = Math.min(c.x + (n % 6) * 3, 97);
    c.y = Math.min(c.y + Math.floor(n / 6) * 4, 97);
    alterar(id, valorJogador({ mapa: atual.id, ...c, cor: corEscolhida, nome }));
    form.reset();
    // próxima cor livre, para cada jogador sair diferente
    const usadas = new Set(jogadores().map(j => j.cor));
    const livre = CORES.find(c => !usadas.has(c)) || CORES[0];
    coresEl.querySelector(`[data-cor="${livre}"]`)?.click();
  });

  // ---------- sincronização (mesmo protocolo das fichas)
  let semServidor = '';
  function motivo(e, r) {
    if (location.protocol === 'file:') return 'o site foi aberto direto do computador; publique na Vercel para salvar online';
    if (!r) return 'sem conexão com a internet';
    if (r.status === 404) return 'o site publicado não tem a pasta api/ — publique de novo';
    if (e && /Banco não configurado/.test(e.message)) return 'o banco ainda não foi ligado na Vercel (Storage → Upstash Redis)';
    if (e && /tipo de ficha inválido/.test(e.message)) return 'a pasta api/ publicada é antiga — publique de novo';
    return e && e.message ? e.message : `erro ${r.status}`;
  }
  async function chamar(url, opcoes) {
    let r = null;
    try {
      r = await fetch(url, opcoes);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro || `HTTP ${r.status}`);
      return d;
    } catch (e) {
      e.motivo = motivo(e, r);
      e.definitivo = !!r && r.status !== 502;
      throw e;
    }
  }

  const pendentes = new Map();
  let timer = null, enviando = false, versao = 0, resetPendente = false;

  function alterar(n, valor) {
    if (valor === null) delete estado[n]; else estado[n] = valor;
    gravarLocal();
    desenharPinos();
    if (!online()) {
      if (semServidor) { avisar(`Salvo só neste navegador — ${semServidor}`, 'alerta'); return; }
      ficarOnline();
      return;
    }
    pendentes.set(n, valor);
    avisar('Salvando…');
    clearTimeout(timer);
    timer = setTimeout(enviar, 300);
  }

  async function enviar() {
    if (!online() || enviando || (!pendentes.size && !resetPendente)) return;
    enviando = true;
    const lote = new Map(pendentes);
    pendentes.clear();
    const reset = resetPendente;
    resetPendente = false;
    const corpo = { tipo: TIPO, c: codigo, set: {}, del: [] };
    if (reset) { corpo.reset = true; Object.assign(corpo.set, estado); }
    else for (const [n, v] of lote) v === null ? corpo.del.push(n) : (corpo.set[n] = v);
    let outraPessoa = false, falhou = false;
    try {
      const d = await chamar(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      outraPessoa = d.v !== versao + 1;
      versao = d.v;
      avisar('Salvo online', 'ok');
    } catch (e) {
      falhou = true;
      for (const [n, v] of lote) if (!pendentes.has(n)) pendentes.set(n, v);
      if (reset) resetPendente = true;
      avisar(`Não salvou online (${e.motivo}) — tentando de novo…`, 'alerta');
      clearTimeout(timer);
      timer = setTimeout(enviar, 5000);
    } finally {
      enviando = false;
      if (falhou) { /* nova tentativa agendada */ }
      else if (pendentes.size || resetPendente) { clearTimeout(timer); timer = setTimeout(enviar, 300); }
      else if (outraPessoa) verificar(true);
    }
  }

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
      body: JSON.stringify({ tipo: TIPO, c, reset: true, set: estado, del: [] }),
    }).then(d => {
      codigo = c;
      versao = d.v;
      history.replaceState(null, '', `#c=${c}`);
      escrever(CHAVE_ATUAL, c);
      gravarLocal();
      escrever(CHAVE_SEM_CODIGO, null);
      semServidor = '';
      document.body.classList.add('modo-online');
      iniciarSondagem();
      if (mudouDurante) { resetPendente = true; enviar(); }
      else avisar('Salvo online', 'ok');
      return true;
    }).catch(e => {
      semServidor = e.motivo;
      avisar(`Salvo só neste navegador — ${semServidor}`, 'alerta');
      if (!e.definitivo) setTimeout(() => { semServidor = ''; }, 15000);
      return false;
    }).finally(() => { criando = null; });
    return criando;
  }

  async function verificar(forcar = false) {
    if (!online() || enviando) return;
    try {
      const q = new URLSearchParams({ tipo: TIPO, c: codigo });
      if (!forcar) q.set('v', versao);
      const d = await chamar(`${API}?${q}`, { cache: 'no-store' });
      if (d.igual) return;
      versao = d.v;
      const novos = d.campos || {};
      for (const [n, v] of pendentes) { if (v === null) delete novos[n]; else novos[n] = v; }
      estado = novos;
      gravarLocal();
      desenharPinos();
      if (!pendentes.size) avisar('Salvo online', 'ok');
    } catch (e) {
      avisar(`Sem conexão com o mapa online (${e.motivo})`, 'alerta');
    }
  }
  let sondagem = null;
  function iniciarSondagem() {
    clearInterval(sondagem);
    sondagem = setInterval(() => { if (!document.hidden) verificar(); }, INTERVALO);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && online()) verificar(); });
  window.addEventListener('hashchange', () => location.reload());

  // ---------- compartilhar
  const dialogo = document.getElementById('dialogo-online');
  const campoLink = document.getElementById('link-online');
  document.getElementById('online').addEventListener('click', async () => {
    if (!online() && !(await ficarOnline())) {
      alert(`Não consegui colocar o mapa online: ${semServidor}.`);
      return;
    }
    campoLink.value = `${location.origin}${location.pathname}#c=${codigo}`;
    dialogo.showModal();
    campoLink.select();
  });
  document.getElementById('copiar-link').addEventListener('click', async () => {
    const b = document.getElementById('copiar-link');
    try { await navigator.clipboard.writeText(campoLink.value); } catch { campoLink.select(); document.execCommand('copy'); }
    b.textContent = 'Copiado!';
    setTimeout(() => { b.textContent = 'Copiar'; }, 1800);
  });
  document.getElementById('fechar-dialogo').addEventListener('click', () => dialogo.close());

  // ---------- abas dos mapas e início
  document.querySelectorAll('.aba-mapa').forEach(b => b.addEventListener('click', () => mostrarMapa(b.dataset.mapa)));
  window.addEventListener('resize', () => mapa.invalidateSize());

  mostrarMapa(lerTexto('stonetop:mapa:aba') || 'arredores');
  if (online()) {
    document.body.classList.add('modo-online');
    avisar('Carregando mapa online…');
    verificar(true).then(iniciarSondagem);
  } else if (Object.keys(estado).length) {
    ficarOnline();
  } else {
    avisar('Adicione um jogador — o mapa é salvo online automaticamente');
  }
})();
