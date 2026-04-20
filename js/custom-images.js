// ══════════════════════════════════════════════════════════════════
//  custom-images.js — Gestione immagini personalizzate
//  Le immagini sono salvate come base64 in localStorage.
//  Vengono esportate/importate insieme al dizionario ARASAAC.
// ══════════════════════════════════════════════════════════════════

const CUSTOM_KEY = 'caa_custom_images_v1';

/** Prefisso per distinguere immagini custom dagli ID ARASAAC numerici */
export const CUSTOM_PREFIX = 'CUSTOM_';

/** Carica tutte le immagini custom salvate. @returns {Object} { 'BING': 'data:image/...', ... } */
export function loadCustomImages() {
  try {
    const s = localStorage.getItem(CUSTOM_KEY);
    return s ? JSON.parse(s) : {};
  } catch { return {}; }
}

/** Salva il dizionario di immagini custom. */
export function saveCustomImages(imgs) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(imgs));
}

/**
 * Aggiunge o aggiorna un'immagine personalizzata.
 * @param {Object} imgs - dizionario corrente
 * @param {string} word - parola (uppercase)
 * @param {string} dataURL - base64 dell'immagine
 * @returns {Object} dizionario aggiornato
 */
export function addCustomImage(imgs, word, dataURL) {
  const updated = { ...imgs, [word.toUpperCase()]: dataURL };
  saveCustomImages(updated);
  return updated;
}

/** Rimuove un'immagine personalizzata. */
export function removeCustomImage(imgs, word) {
  const updated = { ...imgs };
  delete updated[word.toUpperCase()];
  saveCustomImages(updated);
  return updated;
}

/**
 * Dato un file (File object), lo ridimensiona a max 300×300px e lo
 * converte in JPEG compresso (qualità 0.75) per contenere l'uso di localStorage.
 * @param {File} file
 * @returns {Promise<string>} dataURL JPEG compresso
 */
export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX = 300;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width);  width = MAX; }
          else                { width  = Math.round(width  * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Esporta il dizionario ARASAAC + immagini custom come JSON unificato.
 * Il file esportato contiene tutto quello che serve per ricondividere con le colleghe.
 * @param {Object} dict   - dizionario ARASAAC { PAROLA: id }
 * @param {Object} imgs   - immagini custom { PAROLA: dataURL }
 */
export function exportAll(dict, imgs) {
  const payload = { arasaac: dict, custom: imgs, version: 1 };
  const blob    = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = Object.assign(document.createElement('a'), {
    href: url, download: 'caartella-dizionario.json'
  });
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Importa da file JSON (supporta sia formato vecchio { PAROLA: id }
 * sia formato nuovo { arasaac: {...}, custom: {...} }).
 * @param {File} file
 * @returns {Promise<{ dict: Object, imgs: Object }>}
 */
export async function importAll(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.version === 1 && data.arasaac) {
          resolve({ dict: data.arasaac || {}, imgs: data.custom || {} });
        } else {
          // Formato vecchio: solo dizionario ARASAAC
          resolve({ dict: data, imgs: {} });
        }
      } catch { reject(new Error('File JSON non valido')); }
    };
    reader.onerror = () => reject(new Error('Errore lettura file'));
    reader.readAsText(file);
  });
}
