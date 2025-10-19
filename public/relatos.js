
document.addEventListener('DOMContentLoaded', () => {
  const form   = document.getElementById('formRelato');
  const table  = document.getElementById('tabelaRelatos');
  const tbody  = table ? table.getElementsByTagName('tbody')[0] : null;
  const API_URL = '/api/relatos';

  // ---- helpers ----
  const hasSwal = () => typeof Swal !== 'undefined';
  const toast  = (t, m, i = 'info') => hasSwal() ? Swal.fire(t, m, i) : alert(`${t}\n${m || ''}`);
  const api = (url, opts = {}) =>
    fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });

  // ---- limitar data máxima (não permite futuro) ----
  const inputData = document.getElementById('data');
  if (inputData) {
    inputData.setAttribute('max', new Date().toISOString().slice(0, 10));
  }

  // ---- mapa Leaflet ----
  let map = null;
  let markers = [];

  function ensureMap() {
    const el = document.getElementById('map');
    if (!el || typeof L === 'undefined') return null;

    if (map) return map;

    map = L.map('map').setView([-23.315376418263703, -46.21903297473394], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    return map;
  }

  const customIcon = (typeof L !== 'undefined') ? L.icon({
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34]
  }) : null;

  function clearMarkers() {
    if (!map) return;
    for (const m of markers) m.remove();
    markers = [];
  }

  function addMarker(lat, lng, html) {
    if (!map || typeof L === 'undefined') return;
    const mk = L.marker([lat, lng], customIcon ? { icon: customIcon } : undefined).addTo(map);
    if (html) mk.bindPopup(html);
    markers.push(mk);
  }

  // ---- renderização de relatos na tabela ----
  function renderizarRelatos(relatos) {
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!Array.isArray(relatos) || relatos.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Nenhum relato encontrado</td></tr>';
      return;
    }

    // ordenar por data (desc)
    relatos.sort((a, b) => {
      const aD = new Date(a.data_original || a.data || 0);
      const bD = new Date(b.data_original || b.data || 0);
      return bD - aD;
    });

    for (const r of relatos) {
      const tr = tbody.insertRow();
      tr.className = 'relato-row';
      tr.insertCell(0).textContent = r.bairro || 'Não informado';
      tr.insertCell(1).textContent = r.texto || '-';

      const dataCell = tr.insertCell(2);
      dataCell.textContent = formatarData(r.data_original || r.data, r.data_formatada);
      dataCell.className = 'data-cell';
    }
  }

  function formatarData(dataIso, dataFormatadaApi) {
    // se a API já mandou formatada, use
    if (dataFormatadaApi) return dataFormatadaApi;

    if (!dataIso) return '-';
    try {
      // yyyy-mm-dd...
      if (/^\d{4}-\d{2}-\d{2}/.test(dataIso)) {
        const [ano, mes, dia] = dataIso.split('T')[0].split('-');
        return `${dia}/${mes}/${ano}`;
      }
      // dd/mm/yyyy
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(dataIso)) return dataIso;

      return dataIso;
    } catch {
      return dataIso;
    }
  }

  // ---- carregar relatos do servidor ----
  async function carregarRelatos() {
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="3" class="loading-state">Carregando relatos...</td></tr>';
    }

    try {
      const resp = await api(API_URL, { method: 'GET' });
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await resp.text();
        throw new Error(`Resposta inesperada: ${text.slice(0, 120)}...`);
      }

      const data = await resp.json();

      if (!resp.ok) {
        const msg = (data && (data.message || data.mensagem)) || `Erro ${resp.status}`;
        throw new Error(msg);
      }

      renderizarRelatos(data);

      // mapa
      const m = ensureMap();
      if (m) {
        clearMarkers();
        for (const r of data) {
          const lat = Number(r.latitude);
          const lng = Number(r.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            addMarker(lat, lng, `<strong>${r.bairro || ''}</strong><br>${(r.texto || '').replace(/</g,'&lt;')}`);
          }
        }
      }
    } catch (err) {
      console.error('Erro ao carregar relatos:', err);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="3" class="error-state">Erro ao carregar: ${err.message || err}</td></tr>`;
      }
      toast('❌ Erro', 'Falha ao carregar relatos. Recarregue a página.', 'error');
    }
  }

  // ---- envio do formulário ----
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const bairro = (document.getElementById('bairro')?.value || '').trim();
      const texto  = (document.getElementById('relato')?.value || '').trim();
      const data   = (document.getElementById('data')?.value || '').trim() || new Date().toISOString().split('T')[0];

      if (!bairro || !texto || !data) {
        return toast('⚠️ Atenção', 'Bairro, texto e data são obrigatórios.', 'warning');
      }
      if (texto.length < 10) {
        return toast('⚠️ Atenção', 'O relato deve ter pelo menos 10 caracteres!', 'warning');
      }

      try {
        if (hasSwal()) {
          Swal.fire({ title: 'Enviando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        }

        const resp = await api(API_URL, {
          method: 'POST',
          body: JSON.stringify({ bairro, texto, data })
        });

        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          const text = await resp.text();
          throw new Error(`Resposta inesperada: ${text.slice(0, 120)}...`);
        }

        const result = await resp.json();

        if (!resp.ok || !result.success) {
          const msg = result?.message || 'Erro ao salvar o relato.';
          throw new Error(msg);
        }

        if (hasSwal()) {
          await Swal.fire({ title: '✅ Sucesso!', text: 'Relato registrado com sucesso.', icon: 'success', timer: 2000, showConfirmButton: false });
        } else {
          alert('Relato registrado com sucesso.');
        }

        form.reset();
        await carregarRelatos();
      } catch (error) {
        console.error('Erro no envio:', error);
        toast('❌ Erro', error.message || 'Falha na comunicação com o servidor.', 'error');
      }
    });
  }

  // ---- boot ----
  carregarRelatos();
});
