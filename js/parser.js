// ══════════════════════════════════════════════════════════════════
//  parser.js — Suddivide il testo in parole (con filtro stop-words)
// ══════════════════════════════════════════════════════════════════

// ⚙️  Aggiungi o rimuovi parole da questi set per personalizzare il filtro

const ARTICOLI = new Set([
  'IL', 'LO', 'LA', 'I', 'GLI', 'LE',
  'UN', 'UNO', 'UNA',
  "L", "GL",                     // forme troncate (l'albero → L, gl'occhi → GL)
]);

const PREPOSIZIONI = new Set([
  'DI', 'A', 'DA', 'IN', 'CON', 'SU', 'PER', 'TRA', 'FRA',
  // preposizioni articolate
  'DEL', 'DELLO', 'DELLA', 'DELL', 'DEI', 'DEGLI', 'DELLE',
  'AL',  'ALLO',  'ALLA',  'AI',   'AGLI', 'ALLE',
  'DAL', 'DALLO', 'DALLA', 'DAI',  'DAGLI', 'DALLE',
  'NEL', 'NELLO', 'NELLA', 'NEI',  'NEGLI', 'NELLE',
  'SUL', 'SULLO', 'SULLA', 'SUI',  'SUGLI', 'SULLE',
  'COL', 'COLLA', 'COI',
]);

const PRONOMI = new Set([
  'IO', 'TU', 'LUI', 'LEI', 'NOI', 'VOI', 'LORO', 'ESSI', 'ESSE',
  'MI', 'TI', 'SI', 'CI', 'VI', 'NE',
  'ME', 'TE', 'SE', 'CE', 'VE',
  'LO', 'LA', 'LI', 'LE',
  'QUESTO', 'QUESTA', 'QUESTI', 'QUESTE',
  'QUELLO', 'QUELLA', 'QUELLI', 'QUELLE',
  'CHE', 'CHI', 'CUI', 'QUALE', 'QUALI',
]);

const CONGIUNZIONI_E_AVVERBI = new Set([
  'E', 'ED', 'O', 'OD', 'MA', 'NE',
  'PERÒ', 'ANZI', 'DUNQUE', 'QUINDI', 'ALLORA',
  'PERCHÉ', 'PERCHE', 'QUANDO', 'COME', 'DOVE', 'OVE',
  'MENTRE', 'DOPO', 'PRIMA', 'ANCHE', 'PURE',
  'ANCORA', 'GIÀ', 'GIA', 'NON', 'NO', 'SÌ',
]);

const ALL_STOPWORDS = new Set([
  ...ARTICOLI,
  ...PREPOSIZIONI,
  ...PRONOMI,
  ...CONGIUNZIONI_E_AVVERBI,
]);

/**
 * Estrae le parole dal testo.
 * @param {string}  text             - testo in qualsiasi maiuscolo/minuscolo
 * @param {boolean} removeStopWords  - se true filtra le stop-words italiane
 * @returns {string[]} - parole in UPPERCASE, deduplicazione NON applicata
 *                       (stessa parola ripetuta = più tessere)
 */
export function parseText(text, removeStopWords = true) {
  const upper = text
    .toUpperCase()
    // Sostituisce punteggiatura con spazio
    .replace(/[.,;:!?()\[\]{}"'«»—–\-/\\]/g, ' ')
    // Collassa spazi multipli
    .replace(/\s+/g, ' ')
    .trim();

  if (!upper) return [];

  const words = upper.split(' ').filter(w => w.length > 0);

  if (!removeStopWords) return words;

  return words.filter(word => {
    // Rimuove accenti residui per il confronto con il set
    const clean = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return clean.length > 0 && !ALL_STOPWORDS.has(clean) && !ALL_STOPWORDS.has(word);
  });
}
