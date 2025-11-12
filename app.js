// === app.js — mostrar SOLO el resultado numérico, robusto a formatos ===
const WEBHOOK_URL = 'https://davidtuzo4854.app.n8n.cloud/webhook-test/operaciones-ai';
const IP_ENDPOINT = 'https://api.ipify.org?format=json';

// DOM
const btn      = document.getElementById('btnCalcular');
const input    = document.getElementById('textoOperacion');
const resWrap  = document.getElementById('resultadoWrap');
const resText  = document.getElementById('resultadoTexto');
const errWrap  = document.getElementById('errorWrap');
const errText  = document.getElementById('errorTexto');
const originalBtnHTML = btn?.innerHTML || 'Realizar';

// Envío con Enter / Ctrl+Enter
input?.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') btn?.click();
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); btn?.click(); }
});

// Acción principal
btn?.addEventListener('click', async () => {
  const prompt = (input?.value || '').trim();
  if (!prompt) return showError('Escribe una operación primero.');

  setLoading(true); clearUI();
  try {
    const ip = await getPublicIP(); // no bloqueante si falla
    const payload = { prompt, ip_publica: ip };
    const resp = await callN8N(payload);

    const numero = getResultadoNumero(resp);
    if (!Number.isFinite(numero)) throw new Error('No se encontró un resultado numérico.');

    showResult(formatNumber(numero)); // ← SOLO el número
  } catch (e) {
    showError(e.message || 'Error procesando la consulta.');
  } finally {
    setLoading(false);
  }
});

/* -------------------- Red -------------------- */
async function getPublicIP() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(IP_ENDPOINT, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) return null;
    const { ip } = await r.json();
    return ip || null;
  } catch { clearTimeout(t); return null; }
}

async function callN8N(payload) {
  const r = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    mode: 'cors',
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  console.log('[n8n RAW]', r.status, text);
  if (!r.ok) throw new Error(`Servidor ${r.status}`);
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

/* ------------- Extracción robusta del resultado ------------- */
function getResultadoNumero(data) {
  // 1) Si es objeto y trae "resultado" directo (num o string)
  if (data && typeof data === 'object') {
    const direct = coerceNum(data.resultado ?? data.Resultado ?? data.result ?? data.output);
    if (Number.isFinite(direct)) return direct;

    // 2) Busca por clave que contenga "resultado"/"result" en profundidad
    const found = findNumericByKey(data, /resultado|result/i);
    if (Number.isFinite(found)) return found;

    // 3) Busca en strings del objeto algo tipo "resultado: 123" o JSON embebido
    const bestFromStrings = findNumberInsideStrings(data);
    if (Number.isFinite(bestFromStrings)) return bestFromStrings;
  }

  // 4) Si es string plano o viene en _raw
  if (typeof data === 'string') {
    const n = extractNumberFromText(data);
    if (Number.isFinite(n)) return n;
  }
  if (data && typeof data._raw === 'string') {
    const n = extractNumberFromText(data._raw);
    if (Number.isFinite(n)) return n;
  }

  return NaN;
}

function coerceNum(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  // limpia formatos raros de n8n: ="41910" o espacios
  const s = String(v).replace(/^\s*=?\s*"?/, '').replace(/"?\s*$/, '').trim();
  const n = Number(s);
  return Number.isNaN(n) ? NaN : n;
}

function findNumericByKey(obj, keyRegex) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur)) {
        if (keyRegex.test(k)) {
          const n = coerceNum(v);
          if (Number.isFinite(n)) return n;
        }
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return NaN;
}

function findNumberInsideStrings(obj) {
  let candidates = [];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === 'object') {
      for (const v of Object.values(cur)) {
        if (typeof v === 'string') {
          // 1) "resultado": 123  ó  resultado=123  ó  "resultado":"123"
          const m1 = /resultado[^0-9\-]*(-?\d+(?:\.\d+)?)/i.exec(v);
          if (m1) candidates.push(Number(m1[1]));
          // 2) JSON embebido
          try {
            const parsed = JSON.parse(v);
            const n = findNumericByKey(parsed, /resultado|result/i);
            if (Number.isFinite(n)) candidates.push(n);
          } catch {}
        } else if (v && typeof v === 'object') {
          stack.push(v);
        }
      }
    }
  }
  // Elegimos el de mayor magnitud (para evitar ids pequeños tipo 20 vs 41910)
  if (candidates.length) {
    candidates.sort((a,b)=>Math.abs(b)-Math.abs(a));
    return candidates[0];
  }
  return NaN;
}

function extractNumberFromText(text) {
  // Preferimos número después de la palabra "resultado"
  const m1 = /resultado[^0-9\-]*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (m1) return Number(m1[1]);

  // Si no hay etiqueta, tomamos el número con mayor magnitud evitando fechas (XXXX-XX-XX)
  const nums = Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g)).map(m => Number(m[0]));
  const plausible = nums.filter(n => Math.abs(n) > 1 && Math.abs(n) !== 2025); // filtra ids/día comunes
  if (plausible.length) {
    plausible.sort((a,b)=>Math.abs(b)-Math.abs(a));
    return plausible[0];
  }
  return NaN;
}

/* -------------------- UI -------------------- */
function setLoading(state) {
  if (!btn) return;
  btn.disabled = state;
  btn.innerHTML = state ? 'Procesando…' : originalBtnHTML;
}
function clearUI() {
  resWrap?.classList.add('d-none');
  errWrap?.classList.add('d-none');
  if (resText) resText.textContent = '';
  if (errText) errText.textContent = '';
}
function showResult(text) {
  errWrap?.classList.add('d-none');
  if (resText) resText.textContent = text;
  resWrap?.classList.remove('d-none');
}
function showError(text) {
  resWrap?.classList.add('d-none');
  if (errText) errText.textContent = text;
  errWrap?.classList.remove('d-none');
}
function formatNumber(n) {
  let s = n.toFixed(10);
  return s.replace(/\.?0+$/,'');
}

