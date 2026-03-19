// ══════════════════════════════════════════════════════════════════
//  lemmatizer.js — Riconduce le forme flesse italiane all'infinito
//  (o alla forma base) prima di cercare su ARASAAC.
//
//  Perché serve: ARASAAC indicizza i verbi all'infinito.
//  "mangia" non si trova → "mangiare" sì.
//
//  Strategia: prova trasformazioni in ordine di affidabilità,
//  dalla più specifica (meno rischio di falsi positivi) alla più
//  generica. Ogni candidato viene verificato con l'API ARASAAC.
// ══════════════════════════════════════════════════════════════════

/**
 * Regole di lemmatizzazione: ogni regola è [suffisso_da_rimuovere, suffisso_da_aggiungere].
 * Ordinate per specificità (quelle più lunghe e sicure prima).
 *
 * ⚙️  Aggiungi qui nuovi pattern se noti che certe forme non vengono trovate.
 */
const RULES = [
  // ── Gerundi ───────────────────────────────────────────────────────────
  ['ando', 'are'],        // mangiando  → mangiare
  ['endo', 'ere'],        // correndo   → correre
  ['endo', 'ire'],        // dormendo   → dormire

  // ── Participi passati ─────────────────────────────────────────────────
  ['ato', 'are'],         // mangiato   → mangiare
  ['ata', 'are'],         // mangiata   → mangiare
  ['ati', 'are'],         // mangiati   → mangiare
  ['ate', 'are'],         // mangiate   → mangiare (anche 2ª plurale!)
  ['uto', 'ere'],         // caduto     → cadere
  ['uta', 'ere'],         // caduta     → cadere
  ['ito', 'ire'],         // dormito    → dormire
  ['ita', 'ire'],         // dormita    → dormire

  // ── Imperfetto ────────────────────────────────────────────────────────
  ['ava', 'are'],         // mangiava   → mangiare
  ['avi', 'are'],         // mangiavi   → mangiare
  ['avamo', 'are'],       // mangiavamo → mangiare
  ['avano', 'are'],       // mangiavano → mangiare
  ['eva', 'ere'],         // correva    → correre
  ['evi', 'ere'],
  ['evamo', 'ere'],
  ['evano', 'ere'],
  ['iva', 'ire'],         // dormiva    → dormire
  ['ivi', 'ire'],
  ['ivamo', 'ire'],
  ['ivano', 'ire'],

  // ── Presente — forme plurali (meno ambigue di singolare) ─────────────
  ['iamo', 'are'],        // mangiamo   → mangiare
  ['iamo', 'ire'],        // dormiamo   → dormire
  ['ano', 'are'],         // mangiano   → mangiare
  ['ono', 'ere'],         // corrono    → correre
  ['ono', 'ire'],         // dormono    → dormire
  ['ete', 'ere'],         // correte    → correre
  ['ite', 'ire'],         // dormite    → dormire

  // ── Presente — 3ª persona singolare (più rischiosa: "la" "casa"…) ────
  // Queste vengono tentate SOLO se le regole sopra non hanno prodotto nulla.
  ['isca', 'ire'],        // finisca    → finire  (congiuntivo)
  ['isce', 'ire'],        // finisce    → finire
  ['isco', 'ire'],        // finisco    → finire

  // -a e -e (3ª sing.) — molto ambigue, tentate per ultime
  ['a', 'are'],           // mangia     → mangiare  ⚠️ ambiguo
  ['e', 'ere'],           // corre      → correre   ⚠️ ambiguo
  ['e', 'ire'],           // dorme      → dormire   ⚠️ ambiguo
  ['i', 'are'],           // mangi      → mangiare  ⚠️ ambiguo (tu)
  ['o', 'are'],           // mangio     → mangiare  ⚠️ ambiguo (io)
  ['o', 'ere'],           // corro      → correre
  ['o', 'ire'],           // dormo      → dormire
];

/**
 * Dato un verbo flesso, genera i candidati all'infinito in ordine di priorità.
 * NON verifica se il candidato esiste su ARASAAC: lo fa la funzione chiamante.
 *
 * @param {string} word  - parola in UPPERCASE
 * @returns {string[]}   - array di forme candidate in lowercase
 */
export function getCandidates(word) {
  const lower = word.toLowerCase();
  const seen  = new Set();
  const out   = [];

  for (const [suffix, add] of RULES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 2) {
      const stem      = lower.slice(0, lower.length - suffix.length);
      const candidate = stem + add;
      if (!seen.has(candidate) && candidate !== lower) {
        seen.add(candidate);
        out.push(candidate);
      }
    }
  }

  return out;
}
