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
      if (desenho) encerrarDesenho(); // um trajeto não atravessa mapas
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
    desenharRotas();
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

  // ---------- trajetos e tempo de viagem
  // Trajeto = campo  p0.rota_<id> = "<mapa>;<terreno>;<cor>;<x,y x,y ...>;<nome>"  (x/y em %).
  // O desenho não tem escala; o ritmo de cada mapa (pixels da imagem por hora de marcha)
  // foi tirado medindo nos próprios mapas trajetos da tabela "Tempos de Viagem" da
  // Ficha do Mestre (ex.: Stonetop -> Encruzilhada 3-4 h, -> Bosque Vermelho 4-6 h,
  // -> Cavidades de Gordin 4 dias, -> Beirântano 10 dias). O mapa da vila não aparece
  // na tabela: o ritmo dele é um palpite. Qualquer trajeto pode virar referência
  // (botão ⌖), o que regrava  p0.ritmo_<mapa>  para o grupo todo.
  const TERRENOS = [
    { id: 'estrada', nome: 'Estrada ou trilha', f: 1 },
    { id: 'aberto', nome: 'Campo aberto ou colinas', f: 1.5 },
    { id: 'dificil', nome: 'Floresta, pântano ou montanha', f: 2 },
  ];
  const RITMO_PADRAO = { lar: 14000, arredores: 120, regiao: 18.75 };
  const HORAS_POR_DIA = 8; // horas de marcha num dia de viagem
  const CORES_ROTA = ['#8a3b1c', '#1b4f72', '#196f3d', '#6c3483', '#9a7d0a', '#0e6655'];

  function lerRota(v) {
    const m = /^([a-z]+);([a-z]+);(#[0-9a-f]{6});([-\d., ]*);([\s\S]*)$/i.exec(v || '');
    if (!m) return null;
    const pts = m[4].trim() ? m[4].trim().split(/\s+/).map(p => p.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite)) : [];
    return { mapa: m[1], terreno: m[2], cor: m[3], pts, nome: m[5] };
  }
  const valorRota = (r) => `${r.mapa};${r.terreno};${r.cor};${r.pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')};${r.nome}`;
  const rotas = () => Object.entries(estado)
    .filter(([n]) => /^p0\.rota_/.test(n))
    .map(([n, v]) => ({ n, ...lerRota(v) }))
    .filter(r => r.mapa && r.pts.length > 1);

  const ritmo = (idMapa) => {
    const v = parseFloat(estado[`p0.ritmo_${idMapa}`]);
    return v > 0 ? v : RITMO_PADRAO[idMapa];
  };
  function comprimentoPx(m, pts) {
    let t = 0;
    for (let i = 1; i < pts.length; i++) {
      t += Math.hypot((pts[i][0] - pts[i - 1][0]) / 100 * m.w, (pts[i][1] - pts[i - 1][1]) / 100 * m.h);
    }
    return t;
  }
  function horasDe(r) {
    const m = MAPAS.find(x => x.id === r.mapa);
    const f = (TERRENOS.find(t => t.id === r.terreno) || TERRENOS[0]).f;
    return comprimentoPx(m, r.pts) * f / ritmo(r.mapa);
  }
  const meio = (v) => { const r = Math.round(v * 2) / 2; const i = Math.floor(r); return (i ? String(i) : '') + (r % 1 ? '½' : '') || '½'; };
  function formatarTempo(h, idMapa) {
    if (!(h > 0)) return '—';
    if (h < 1) { const min = Math.max(5, Math.round(h * 60 / 5) * 5); return `≈ ${min} min`; }
    if (idMapa === 'regiao' || h >= HORAS_POR_DIA * 1.5) {
      const d = h / HORAS_POR_DIA;
      const txt = meio(d);
      return `≈ ${txt} ${d <= 1.25 ? 'dia' : 'dias'}`;
    }
    return `≈ ${meio(h)} ${h <= 1.25 ? 'hora' : 'horas'}`;
  }

  const camadasRota = new Map(); // campo -> { grupo, assinatura }
  function desenharRotas() {
    const lista = rotas();
    const aqui = new Map(lista.filter(r => r.mapa === atual.id).map(r => [r.n, r]));
    for (const [n, c] of camadasRota) if (!aqui.has(n)) { c.grupo.remove(); camadasRota.delete(n); }
    for (const [n, r] of aqui) {
      const assinatura = `${estado[n]}|${ritmo(r.mapa)}`;
      const antiga = camadasRota.get(n);
      if (antiga && antiga.assinatura === assinatura) continue;
      if (antiga) antiga.grupo.remove();
      const lls = r.pts.map(([x, y]) => paraLatLng(atual, x, y));
      const tempo = formatarTempo(horasDe(r), r.mapa);
      const grupo = L.layerGroup([
        L.polyline(lls, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }),
        L.polyline(lls, { color: r.cor, weight: 4, dashArray: r.terreno === 'estrada' ? null : '10 7' })
          .bindTooltip(`${escapar(r.nome)} · ${tempo}`, { sticky: true }),
        L.circleMarker(lls[0], { radius: 5, color: '#fff', weight: 2, fillColor: r.cor, fillOpacity: 1, interactive: false }),
        L.marker(lls[lls.length - 1], {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'rota-rotulo', html: `<span style="--cor:${r.cor}">${escapar(r.nome)} · ${tempo}</span>`, iconSize: [0, 0] }),
        }),
      ]).addTo(mapa);
      camadasRota.set(n, { grupo, assinatura });
    }
    desenharListaRotas(lista);
  }

  const listaRotasEl = document.getElementById('lista-rotas');
  function desenharListaRotas(lista) {
    listaRotasEl.innerHTML = '';
    if (!lista.length) {
      const li = document.createElement('li');
      li.className = 'vazio';
      li.textContent = 'Nenhum trajeto. Use “✏ Trajeto” no canto do mapa.';
      listaRotasEl.appendChild(li);
      return;
    }
    for (const r of lista) {
      const li = document.createElement('li');
      li.className = 'rota';
      const m = MAPAS.find(x => x.id === r.mapa);
      const topo = document.createElement('div');
      topo.className = 'rota-topo';
      const ir = document.createElement('button');
      ir.type = 'button';
      ir.className = 'jog-nome';
      ir.innerHTML = `<span class="bolinha-cor" style="background:${r.cor}"></span><span class="txt"></span><small></small>`;
      ir.querySelector('.txt').textContent = r.nome;
      ir.querySelector('small').textContent = `${formatarTempo(horasDe(r), r.mapa)} · ${m.nome}`;
      ir.title = 'Mostrar no mapa';
      ir.addEventListener('click', () => {
        mostrarMapa(r.mapa, { enquadrar: false });
        mapa.flyToBounds(L.latLngBounds(r.pts.map(([x, y]) => paraLatLng(atual, x, y))).pad(0.3), { duration: 0.6 });
      });
      const acoes = document.createElement('span');
      acoes.className = 'jog-acoes';
      const botao = (txt, titulo, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.title = titulo; b.setAttribute('aria-label', `${titulo}: ${r.nome}`); b.addEventListener('click', fn); acoes.appendChild(b); };
      botao('✎', 'Renomear', () => {
        const novo = prompt('Nome do trajeto:', r.nome);
        if (novo === null || !novo.trim()) return;
        alterar(r.n, valorRota({ ...r, nome: novo.trim().slice(0, 60) }));
      });
      botao('⌖', 'Usar como referência de tempo', () => calibrar(r));
      botao('×', 'Apagar trajeto', () => { if (confirm(`Apagar o trajeto “${r.nome}”?`)) alterar(r.n, null); });
      topo.append(ir, acoes);

      const sel = document.createElement('select');
      sel.className = 'rota-terreno';
      sel.setAttribute('aria-label', `Terreno de ${r.nome}`);
      for (const t of TERRENOS) sel.add(new Option(`${t.nome}${t.f !== 1 ? ` (×${String(t.f).replace('.', ',')})` : ''}`, t.id, false, t.id === r.terreno));
      sel.addEventListener('change', () => alterar(r.n, valorRota({ ...r, terreno: sel.value })));
      li.append(topo, sel);
      listaRotasEl.appendChild(li);
    }
  }

  function calibrar(r) {
    const resp = prompt(`Quanto tempo o trajeto “${r.nome}” leva de verdade?\nEx.: 4 horas, 2 dias, 30 min\n\nIsso ajusta o cálculo de todos os trajetos do mapa ${MAPAS.find(x => x.id === r.mapa).nome}, para o grupo todo.`);
    if (!resp) return;
    const m = /([\d]+(?:[.,]\d+)?)\s*(min|m|h|hora|horas|d|dia|dias)?/i.exec(resp.trim());
    if (!m) { alert('Não entendi o tempo. Use algo como “4 horas” ou “2 dias”.'); return; }
    const n = parseFloat(m[1].replace(',', '.'));
    const u = (m[2] || (r.mapa === 'regiao' ? 'd' : 'h')).toLowerCase();
    const horas = u.startsWith('m') ? n / 60 : u.startsWith('d') ? n * HORAS_POR_DIA : n;
    if (!(horas > 0)) return;
    const mm = MAPAS.find(x => x.id === r.mapa);
    const f = (TERRENOS.find(t => t.id === r.terreno) || TERRENOS[0]).f;
    alterar(`p0.ritmo_${r.mapa}`, String(+(comprimentoPx(mm, r.pts) * f / horas).toFixed(3)));
  }

  // desenho de um trajeto novo: clique ponto a ponto, depois Concluir
  let desenho = null;
  const controle = L.control({ position: 'topright' });
  controle.onAdd = () => {
    const div = L.DomUtil.create('div', 'controle-rota');
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  };
  controle.addTo(mapa);
  const painelRota = controle.getContainer();

  function atualizarControle() {
    if (!desenho) {
      painelRota.innerHTML = '<button type="button" class="btn-rota" data-acao="iniciar" title="Desenhar um trajeto e ver o tempo de viagem">✏ Trajeto</button>';
      return;
    }
    const r = { mapa: atual.id, terreno: desenho.terreno, pts: desenho.pts };
    const info = desenho.pts.length < 2 ? 'Clique no mapa para marcar o caminho, ponto a ponto.' : `${formatarTempo(horasDe(r), atual.id)}`;
    painelRota.innerHTML = `
      <div class="rota-info"><strong>${desenho.pts.length} ${desenho.pts.length === 1 ? 'ponto' : 'pontos'}</strong> <span>${info}</span></div>
      <select data-acao="terreno" aria-label="Terreno">${TERRENOS.map(t => `<option value="${t.id}"${t.id === desenho.terreno ? ' selected' : ''}>${t.nome}</option>`).join('')}</select>
      <div class="rota-botoes">
        <button type="button" data-acao="desfazer"${desenho.pts.length ? '' : ' disabled'}>Desfazer</button>
        <button type="button" data-acao="cancelar">Cancelar</button>
        <button type="button" class="ok" data-acao="concluir"${desenho.pts.length > 1 ? '' : ' disabled'}>Concluir</button>
      </div>`;
  }
  painelRota.addEventListener('click', (e) => {
    const acao = e.target.closest('[data-acao]')?.dataset.acao;
    if (acao === 'iniciar') iniciarDesenho();
    else if (acao === 'desfazer') { desenho.pts.pop(); redesenharPrevia(); }
    else if (acao === 'cancelar') encerrarDesenho();
    else if (acao === 'concluir') concluirDesenho();
  });
  painelRota.addEventListener('change', (e) => {
    if (e.target.dataset.acao === 'terreno' && desenho) { desenho.terreno = e.target.value; atualizarControle(); }
  });

  function iniciarDesenho() {
    desenho = { inicio: performance.now(), pts: [], terreno: 'estrada', linha: L.polyline([], { color: '#8a3b1c', weight: 4, dashArray: '2 8', interactive: false }).addTo(mapa), guia: L.polyline([], { color: '#8a3b1c', weight: 2, opacity: 0.6, dashArray: '4 6', interactive: false }).addTo(mapa) };
    mapa.doubleClickZoom.disable();
    document.getElementById('mapa').classList.add('desenhando');
    atualizarControle();
  }
  function redesenharPrevia() {
    desenho.linha.setLatLngs(desenho.pts.map(([x, y]) => paraLatLng(atual, x, y)));
    if (!desenho.pts.length) desenho.guia.setLatLngs([]);
    atualizarControle();
  }
  function encerrarDesenho() {
    if (!desenho) return;
    desenho.linha.remove(); desenho.guia.remove();
    desenho = null;
    mapa.doubleClickZoom.enable();
    document.getElementById('mapa').classList.remove('desenhando');
    atualizarControle();
  }
  function concluirDesenho() {
    if (!desenho || desenho.pts.length < 2) return;
    const usadas = new Set(rotas().map(r => r.cor));
    const cor = CORES_ROTA.find(c => !usadas.has(c)) || CORES_ROTA[rotas().length % CORES_ROTA.length];
    const nome = `Trajeto ${rotas().length + 1}`;
    // o clique duplo que conclui também marca dois pontos no mesmo lugar: descarta os repetidos
    const pts = desenho.pts.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 0.3);
    if (pts.length < 2) return;
    const r = { mapa: atual.id, terreno: desenho.terreno, cor, pts: pts.slice(0, 300), nome };
    encerrarDesenho();
    alterar(`p0.rota_${Math.random().toString(36).slice(2, 10)}`, valorRota(r));
  }
  mapa.on('click', (e) => {
    if (!desenho) return;
    // o clique que abriu o desenho (no botão do canto) não é um ponto do trajeto
    if (painelRota.contains(e.originalEvent.target) || performance.now() - desenho.inicio < 250) return;
    const p = paraPct(atual, e.latlng);
    desenho.pts.push([p.x, p.y]);
    redesenharPrevia();
  });
  mapa.on('mousemove', (e) => {
    if (!desenho || !desenho.pts.length) return;
    const [x, y] = desenho.pts[desenho.pts.length - 1];
    desenho.guia.setLatLngs([paraLatLng(atual, x, y), e.latlng]);
  });
  mapa.on('dblclick', () => { if (desenho && desenho.pts.length > 1) concluirDesenho(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && desenho) encerrarDesenho(); });
  atualizarControle();

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
