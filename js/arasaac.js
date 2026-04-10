// ══════════════════════════════════════════════════════════════════
//  arasaac.js — Wrapper API ARASAAC
//  Docs: https://arasaac.org/developers/api
//  API:  https://api.arasaac.org/api/
// ══════════════════════════════════════════════════════════════════

const API_BASE = 'https://api.arasaac.org/api';
const LANG     = 'it';  // ⚙️ Cambia in 'es','en','fr' per altra lingua

/**
 * Costruisce l'URL dell'immagine PNG di un pittogramma.
 * ⚙️  Cambia _500 in _2500 per alta risoluzione da stampa.
 * @param {number|string} id
 * @returns {string}
 */
export function getPictogramUrl(id) {
  return `https://static.arasaac.org/pictograms/${id}/${id}_500.png`;
}

/**
 * Cerca pittogrammi in italiano per una parola.
 * Restituisce fino a 8 alternative ordinate per rilevanza ARASAAC.
 *
 * @param {string} word - parola in italiano (qualsiasi case)
 * @returns {Promise<Array<{id:number, keyword:string, imageUrl:string}>>}
 * @throws {Error} se la rete non risponde o ARASAAC ritorna errore HTTP
 */
export async function searchPictograms(word) {
  const url = `${API_BASE}/pictograms/${LANG}/search/${encodeURIComponent(word.toLowerCase())}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`ARASAAC HTTP ${resp.status} per "${word}"`);

  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return [];

  return data.slice(0, 8).map(item => ({
    id:       item._id,
    keyword:  item.keywords?.[0]?.keyword ?? word,
    imageUrl: getPictogramUrl(item._id),
  }));
}

/**
 * Scarica un'immagine come dataURL base64.
 * Serve a jsPDF per incorporare le immagini nel PDF.
 *
 * ⚠️  Richiede che ARASAAC risponda con header CORS (Access-Control-Allow-Origin).
 *    Se il fetch fallisce (CORS o rete), ritorna null → nel PDF comparirà
 *    un segnaposto testuale invece dell'immagine.
 *
 * @param {string} url
 * @returns {Promise<string|null>}  dataURL 'data:image/png;base64,...' oppure null
 */
export async function fetchImageAsDataURL(url) {
  // ── Tentativo 1: Image + Canvas con crossOrigin ────────────────
  // Usa la pipeline di caricamento immagini del browser (più affidabile
  // del fetch diretto per i CDN ARASAAC che rispondono in modo inconsistente).
  try {
    return await new Promise((resolve, reject) => {
      const img   = new Image();
      img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => reject(new Error('timeout')), 12000);
      img.onload = () => {
        clearTimeout(timer);
        try {
          const c = document.createElement('canvas');
          c.width  = img.naturalWidth  || 500;
          c.height = img.naturalHeight || 500;
          c.getContext('2d').drawImage(img, 0, 0);
          const dataUrl = c.toDataURL('image/png');
          if (dataUrl.length < 200) throw new Error('immagine vuota');
          resolve(dataUrl);
        } catch (e) { reject(e); }
      };
      img.onerror = () => { clearTimeout(timer); reject(new Error('load error')); };
      img.src = url;
    });
  } catch { /* fallback sotto */ }

  // ── Tentativo 2: fetch CORS con retry e delay crescente ───────
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 700 * attempt));
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      if (attempt === 2) {
        console.warn('[ARASAAC] fetchImageAsDataURL fallito per', url, '—', err.message);
        return null;
      }
    }
  }
  return null;
}
