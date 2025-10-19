(function () {
  // helpers 
  const hasSwal = () => typeof Swal !== 'undefined';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // fetch com cookies e timeout
  async function api(url, opts = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        signal: controller.signal,
        ...opts
      });
      return res;
    } finally {
      clearTimeout(id);
    }
  }

  // CLIMA
  let climaIntervalId = null;
  let climaRunning = false;

  async function carregarClima() {
    // evita concorrência 
    if (climaRunning) return;
    climaRunning = true;

    try {
      const tempEl = document.getElementById('temperatura');
      const descEl = document.getElementById('descricao');
      const umiEl  = document.getElementById('umidade');
      const venEl  = document.getElementById('vento');
      const senEl  = document.getElementById('sensacao');
      const icoEl  = document.getElementById('icone-clima');

      // se a página não tiver bloco de clima, não faz nada
      if (!tempEl || !descEl) return;

      const res = await api('/api/clima');
      if (!res.ok) throw new Error(`Erro HTTP: ${res.status}`);
      const dados = await res.json();

      const traducoes = {
        'clear': 'Céu limpo',
        'sunny': 'Ensolarado',
        'partly cloudy': 'Parcialmente nublado',
        'overcast': 'Nublado',
        'rain': 'Chuva',
        'mist': 'Neblina',
        'light rain': 'Chuva leve',
        'moderate rain': 'Chuva moderada',
        'moderate or heavy rain with thunder': 'Chuva moderada e trovões',
        'heavy rain': 'Chuva forte',
        'storm': 'Tempestade',
        'patchy rain nearby': 'Chuva irregular'
      };

      const descOrig = String(dados.descricao || '').toLowerCase();
      const descricaoPt = traducoes[descOrig] || dados.descricao || '--';

      tempEl.textContent = `${dados.temperatura ?? '--'}°C`;
      descEl.textContent = descricaoPt;
      if (umiEl) umiEl.textContent = `${dados.umidade ?? '--'}%`;
      if (venEl) venEl.textContent = `${dados.vento_kph ?? '--'} km/h`;
      if (senEl) senEl.textContent = `${dados.sensacao ?? '--'}°C`;
      if (icoEl && dados.icone) {
        icoEl.src = dados.icone;
        icoEl.alt = dados.descricao || 'Condição atual';
      }
    } catch (erro) {
      console.error('Erro ao buscar clima:', erro);
      const descEl = document.getElementById('descricao');
      if (descEl) descEl.textContent = 'Dados meteorológicos indisponíveis';
    } finally {
      climaRunning = false;
    }
  }

  function iniciarClimaAuto() {
    // limpa antigo se existir
    if (climaIntervalId) {
      clearInterval(climaIntervalId);
      climaIntervalId = null;
    }
    // executa agora
    carregarClima();
    // e repete a cada 10 min (somente se o bloco existir)
    if (document.getElementById('temperatura') && document.getElementById('descricao')) {
      climaIntervalId = setInterval(() => {
        // pausa em abas ocultas para poupar rede
        if (document.hidden) return;
        carregarClima();
      }, 10 * 60 * 1000);
    }
  }

  // pausa/retoma quando a aba muda de visibilidade
  document.addEventListener('visibilitychange', () => {
    if (!climaIntervalId) return;
    if (document.hidden) {
      clearInterval(climaIntervalId);
      climaIntervalId = null;
    } else {
      iniciarClimaAuto();
    }
  });

  //  LOGOUT 
  async function doLogout() {
    try {
      const r = await api('/auth/logout', { method: 'POST' });
      if (r.ok) {
        // dá um respiro para evitar race com redirects em alguns navegadores
        await sleep(120);
        window.location.href = '/login.html';
      } else {
        const msg = 'Não foi possível sair. Tente novamente.';
        hasSwal() ? Swal.fire('Ops!', msg, 'error') : alert(msg);
      }
    } catch {
      const msg = 'Falha de rede. Tente novamente.';
      hasSwal() ? Swal.fire('Ops!', msg, 'error') : alert(msg);
    }
  }

  //  DESCADASTRAR 
  async function descadastrarFlow() {
    let prosseguir = false;

    if (hasSwal()) {
      const { isConfirmed } = await Swal.fire({
        title: 'Excluir sua conta?',
        text: 'Esta ação é irreversível. Seus dados serão removidos e você deixará de receber alertas.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Sim, excluir',
        cancelButtonText: 'Cancelar'
      });
      prosseguir = isConfirmed;
    } else {
      prosseguir = confirm('Tem certeza que deseja excluir sua conta? Esta ação é irreversível.');
    }

    if (!prosseguir) return;

    try {
      const resp = await api('/descadastrar', { method: 'POST' });
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok || !data.sucesso) {
        const msg = data?.mensagem || 'Não foi possível excluir a conta.';
        hasSwal() ? Swal.fire('Ops!', msg, 'error') : alert(msg);
        return;
      }

      if (hasSwal()) await Swal.fire('Pronto!', data.mensagem || 'Conta excluída com sucesso.', 'success');
      else alert(data.mensagem || 'Conta excluída com sucesso.');

      await sleep(120);
      window.location.href = '/login.html';
    } catch (e) {
      const msg = 'Falha de rede. Tente novamente.';
      hasSwal() ? Swal.fire('Ops!', msg, 'error') : alert(msg);
    }
  }

  //  binds 
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'btn-logout') {
      ev.preventDefault();
      doLogout();
    }
    if (t.id === 'btn-descadastro') {
      ev.preventDefault();
      descadastrarFlow();
    }
  });

  // ---------- boot ----------
  document.addEventListener('DOMContentLoaded', () => {
    iniciarClimaAuto();
  });
})();
