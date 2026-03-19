// ══════════════════════════════════════════════════════════════════
//  dictionary.js — Dizionario locale PAROLA → ID pittogramma ARASAAC
//  Persistente in localStorage tra sessioni diverse.
// ══════════════════════════════════════════════════════════════════

const STORAGE_KEY = 'caa_dictionary_v1';

/**
 * Dizionario seed — pre-popola con parole frequenti della scuola primaria.
 * ⚙️  Come aggiungere voci:
 *   1. Cerca la parola su https://arasaac.org/pictograms/search
 *   2. Apri il pittogramma → annota l'ID numerico nell'URL
 *   3. Aggiungi: 'PAROLA': 12345
 *
 * Le voci seed vengono sovrascritte dalle scelte dell'utente (localStorage).
 */
const SEED_DICTIONARY = {
  // ── Aggiungi qui le parole frequenti della tua classe ──────────
  // Esempio verificato: cerca su https://arasaac.org/pictograms/search
  // 'MELA':     6740,
  // 'BAMBINO':  3214,
  // 'SCUOLA':   7779,
};

// ── API pubblica ─────────────────────────────────────────────────

/** Carica il dizionario (seed + localStorage). */
export function loadDictionary() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const local  = stored ? JSON.parse(stored) : {};
    return { ...SEED_DICTIONARY, ...local };   // locale sovrascrive seed
  } catch {
    return { ...SEED_DICTIONARY };
  }
}

/** Salva l'intero dizionario in localStorage. */
export function saveDictionary(dict) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dict));
}

/**
 * Cerca l'ID salvato per una parola.
 * @param {Object} dict
 * @param {string} word
 * @returns {number|null}
 */
export function lookupWord(dict, word) {
  return dict[word.toUpperCase()] ?? null;
}

/**
 * Aggiorna il dizionario con un nuovo abbinamento e lo salva.
 * @param {Object} dict
 * @param {string} word
 * @param {number} id
 * @returns {Object} nuovo dizionario aggiornato
 */
export function rememberWord(dict, word, id) {
  const updated = { ...dict, [word.toUpperCase()]: id };
  saveDictionary(updated);
  return updated;
}

/** Esporta il dizionario come file JSON scaricabile. */
export function exportDictionary(dict) {
  const json = JSON.stringify(dict, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: 'dizionario-caa.json',
  });
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Legge e analizza un file JSON importato.
 * @param {File} file
 * @returns {Promise<Object>}
 */
export async function importDictionaryFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try   { resolve(JSON.parse(e.target.result)); }
      catch { reject(new Error('File JSON non valido')); }
    };
    reader.onerror = () => reject(new Error('Errore di lettura file'));
    reader.readAsText(file);
  });
}
