console.log('reader.js carregado');

(function () {
  // -------- estilos --------
  const css = `
  #reader-fab, #reader-panel{ all: initial; font-family: system-ui, Arial, sans-serif;}
  #reader-fab{ position:fixed; right:18px; bottom:18px; width:54px; height:54px; border-radius:50%;
    box-shadow:0 6px 16px rgba(0,0,0,.25); display:flex; align-items:center; justify-content:center;
    cursor:pointer; z-index:99999; background:#111; color:#fff; font-weight:700; }
  #reader-panel{ position:fixed; right:18px; bottom:84px; width:280px; border-radius:14px; padding:14px;
    box-shadow:0 10px 24px rgba(0,0,0,.25); background:#fff; color:#111; z-index:99999; display:none; }
  #reader-panel h3{ margin:0 0 8px 0; font-size:16px; font-weight:700;}
  #reader-panel .row{ display:flex; gap:8px; margin:8px 0;}
  #reader-panel button, #reader-panel select, #reader-panel input[type=range]{
    flex:1; padding:8px; border-radius:10px; border:1px solid #ddd; cursor:pointer; font-size:14px;
  }
  #reader-panel .muted{ font-size:12px; opacity:.7; margin-top:6px;}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.documentElement.appendChild(style);

  const fab = document.createElement('button');
  fab.id = 'reader-fab';
  fab.title = 'Leitor de página (Alt+R)';
  fab.setAttribute('aria-label', 'Leitor de página');
  fab.setAttribute('aria-controls', 'reader-panel');
  fab.setAttribute('aria-expanded', 'false');
  fab.textContent = '🔊';

  const panel = document.createElement('div');
  panel.id = 'reader-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'Controles do leitor de página');
  panel.innerHTML = `
    <h3>Leitura da página</h3>
    <div class="row">
      <button id="reader-play" title="Ler (Alt+R)" aria-label="Ler">▶️ Ler</button>
      <button id="reader-pause" aria-label="Pausar ou retomar">⏸️ Pausar</button>
      <button id="reader-stop" aria-label="Parar leitura">⏹️ Parar</button>
    </div>
    <div class="row">
      <label style="flex:1">
        <div style="font-size:12px;margin-bottom:4px">Velocidade</div>
        <input id="reader-rate" type="range" min="0.6" max="1.6" step="0.1" value="1" aria-label="Velocidade da leitura">
      </label>
      <label style="flex:1">
        <div style="font-size:12px;margin-bottom:4px">Tom</div>
        <input id="reader-pitch" type="range" min="0.8" max="1.4" step="0.1" value="1" aria-label="Tom da leitura">
      </label>
    </div>
    <div class="row">
      <select id="reader-voice" aria-label="Voz"></select>
    </div>
    <div class="muted">Dica: selecione um trecho para ler só a seleção. Atalho: <b>Alt+R</b>. Pressione <b>Esc</b> para fechar.</div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  // -------- obter texto legível --------
  function getReadableText() {
    // seleção do usuário primeiro
    const sel = window.getSelection && String(window.getSelection());
    if (sel && sel.trim().length > 0) return sel.trim();

    const candidates = [
      'main',
      '#content',
      '.content',
      '.container',
      '.wrapper',
      'body',
      
    ];
    let root = null;
    for (const c of candidates) {
      const el = document.querySelector(c);
      if (el) { root = el; break; }
    }
    if (!root) root = document.body;

 
    const clone = root.cloneNode(true);
    const removeSel = 'nav, footer, script, style, noscript, iframe, svg, canvas, video, audio';
    clone.querySelectorAll(removeSel).forEach(e => e.remove());
    clone.querySelectorAll('[aria-hidden="true"], [hidden]').forEach(e => e.remove());

    const txt = clone.textContent || '';
    return txt.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const synth = window.speechSynthesis;
  if (!synth) {
    fab.style.display = 'none';
    console.warn('Leitor: SpeechSynthesis não suportado neste navegador.');
    return;
  }

  let voices = [];
  const voiceSelect = () => document.getElementById('reader-voice');

  function populateVoices() {
    voices = synth.getVoices() || [];
    const select = voiceSelect();
    if (!select) return;
    select.innerHTML = '';
    const sorted = voices.slice().sort((a, b) => {
      const ap = /pt-BR/i.test(a.lang) ? -1 : 0;
      const bp = /pt-BR/i.test(b.lang) ? -1 : 0;
      return ap - bp || a.name.localeCompare(b.name);
    });
    for (const v of sorted) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} — ${v.lang}`;
      select.appendChild(opt);
    }
    // escolhe pt-BR se houver
    const firstPt = Array.from(select.options).find(o => /pt-BR/i.test(o.textContent));
    if (firstPt) select.value = firstPt.value;
  }

  populateVoices();
  // alguns browsers carregam async
  window.speechSynthesis.onvoiceschanged = () => {
    populateVoices();
  };

  // chunking de texto
  function chunkText(text, maxLen = 220) {
    const parts = [];
    const sentences = text
      .replace(/\s+/g, ' ')
      .split(/([.!?…]+)\s+/); 
    let buf = '';
    for (let i = 0; i < sentences.length; i++) {
      const piece = sentences[i];
      if (!piece) continue;
      const next = (buf + ' ' + piece).trim();
      if (next.length <= maxLen) {
        buf = next;
      } else {
        if (buf) parts.push(buf);
        buf = piece;
      }
    }
    if (buf) parts.push(buf);
    
    if (parts.length === 0) {
      for (let i = 0; i < text.length; i += maxLen) {
        parts.push(text.slice(i, i + maxLen));
      }
    }
    return parts;
  }

  let queue = [];
  let isReading = false;

  function stop() {
    synth.cancel();
    queue = [];
    isReading = false;
    currentUtterance = null;
  }

  function pauseOrResume() {
    if (synth.speaking && !synth.paused) synth.pause();
    else if (synth.paused) synth.resume();
  }

  let currentUtterance = null;

  function speak(text) {
    stop();
    if (!text) return;

    const rate  = parseFloat(document.getElementById('reader-rate').value || '1');
    const pitch = parseFloat(document.getElementById('reader-pitch').value || '1');
    const vName = voiceSelect()?.value;
    const chosen = voices.find(v => v.name === vName);

    const lang = chosen?.lang && /pt/i.test(chosen.lang) ? chosen.lang : 'pt-BR';
    queue = chunkText(text);
    isReading = true;

    const playNext = () => {
      if (!queue.length || !isReading) { isReading = false; return; }
      const chunk = queue.shift();
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang  = lang;
      u.rate  = rate;
      u.pitch = pitch;
      if (chosen) u.voice = chosen;

      u.onend = () => playNext();
      u.onerror = (e) => {
        console.warn('Erro na fala:', e.error);
        playNext();
      };

      currentUtterance = u;
      synth.speak(u);
    };

    if (!voices.length) {
      setTimeout(playNext, 50);
    } else {
      playNext();
    }
  }

  function togglePanel() {
    const visible = panel.style.display === 'block';
    panel.style.display = visible ? 'none' : 'block';
    fab.setAttribute('aria-expanded', String(!visible));
    if (!visible) {
      // focar primeiro controle do painel
      const first = panel.querySelector('button, select, input');
      if (first) first.focus();
    } else {
      fab.focus();
    }
  }

  fab.addEventListener('click', () => togglePanel());
  document.getElementById('reader-play').addEventListener('click', () => speak(getReadableText()));
  document.getElementById('reader-pause').addEventListener('click', pauseOrResume);
  document.getElementById('reader-stop').addEventListener('click', stop);

  //alterna ler/parar
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      if (synth.speaking || synth.paused) stop(); else speak(getReadableText());
    }
    // ESC fecha painel
    if (e.key === 'Escape' && panel.style.display === 'block') {
      panel.style.display = 'none';
      fab.setAttribute('aria-expanded', 'false');
      fab.focus();
    }
  });

  window.addEventListener('beforeunload', stop);
})();
