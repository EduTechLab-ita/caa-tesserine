// ══════════════════════════════════════════════════════════════════
//  dictionary.js — Dizionario locale PAROLA → ID pittogramma ARASAAC
//  v2: supporto multi-alunno (retrocompatibile con v1)
// ══════════════════════════════════════════════════════════════════

const STUDENTS_KEY  = 'caa_students_v1';   // lista alunni + alunno corrente
const LEGACY_KEY    = 'caa_dictionary_v1'; // vecchio formato (migrazione)

const SEED_DICTIONARY = {
  // Aggiungi qui parole frequenti verificate su arasaac.org
  // 'MELA': 6740,
};

// ══════════════════════════════════════════════════════════════════
//  GESTIONE ALUNNI
// ══════════════════════════════════════════════════════════════════

/** Carica la struttura alunni da localStorage. */
function loadStudentsData() {
  try {
    const saved = localStorage.getItem(STUDENTS_KEY);
    if (saved) return JSON.parse(saved);
  } catch(e) {}
  // Struttura iniziale: alunno "anonimo" (stringa vuota)
  return { current: '', list: [''] };
}

function saveStudentsData(data) {
  localStorage.setItem(STUDENTS_KEY, JSON.stringify(data));
}

/** Restituisce la lista degli alunni. '' = anonimo. */
export function getStudentsList() {
  return loadStudentsData().list;
}

/** Restituisce l'alunno correntemente selezionato. */
export function getCurrentStudent() {
  return loadStudentsData().current;
}

/** Imposta l'alunno corrente. */
export function setCurrentStudent(name) {
  const data = loadStudentsData();
  data.current = name;
  saveStudentsData(data);
}

/** Aggiunge un nuovo alunno (se non esiste già). */
export function addStudent(name) {
  const data = loadStudentsData();
  if (!data.list.includes(name)) {
    data.list.push(name);
    saveStudentsData(data);
  }
}

/** Rimuove un alunno (non rimuove i dati del dizionario). */
export function removeStudent(name) {
  if (name === '') return; // non rimuovere l'anonimo
  const data = loadStudentsData();
  data.list = data.list.filter(n => n !== name);
  if (data.current === name) data.current = '';
  saveStudentsData(data);
}

// ══════════════════════════════════════════════════════════════════
//  DIZIONARIO PER ALUNNO
// ══════════════════════════════════════════════════════════════════

function dictKey(studentName) {
  return studentName === '' ? LEGACY_KEY : `caa_dict_v2_${studentName}`;
}

/** Carica il dizionario per un alunno specifico. */
export function loadDictionaryForStudent(studentName) {
  try {
    const stored = localStorage.getItem(dictKey(studentName));
    const local  = stored ? JSON.parse(stored) : {};
    return { ...SEED_DICTIONARY, ...local };
  } catch {
    return { ...SEED_DICTIONARY };
  }
}

/** Carica il dizionario dell'alunno corrente. */
export function loadDictionary() {
  return loadDictionaryForStudent(getCurrentStudent());
}

/** Salva il dizionario per un alunno specifico. */
export function saveDictionaryForStudent(studentName, dict) {
  localStorage.setItem(dictKey(studentName), JSON.stringify(dict));
}

/** Salva il dizionario dell'alunno corrente. */
export function saveDictionary(dict) {
  saveDictionaryForStudent(getCurrentStudent(), dict);
}

/** Cerca l'ID salvato per una parola. */
export function lookupWord(dict, word) {
  return dict[word.toUpperCase()] ?? null;
}

/** Aggiorna il dizionario con un nuovo abbinamento e lo salva. */
export function rememberWord(dict, word, id) {
  const updated = { ...dict, [word.toUpperCase()]: id };
  saveDictionary(updated);
  return updated;
}

// ══════════════════════════════════════════════════════════════════
//  MIGRAZIONE DA v1 (vecchio formato senza alunni)
// ══════════════════════════════════════════════════════════════════

/**
 * Controlla se esiste un vecchio dizionario v1 senza nome alunno.
 * @returns {number} numero di parole nel vecchio dizionario (0 = nessun dato da migrare)
 */
export function getLegacyDictionaryCount() {
  try {
    const saved = localStorage.getItem(LEGACY_KEY);
    if (!saved) return 0;
    const data = JSON.parse(saved);
    // Il dizionario "anonimo" usa LEGACY_KEY — conta solo se non è già stato usato come anonimo
    const studentsData = loadStudentsData();
    // Se l'utente ha già più alunni, il legacy è già il dizionario anonimo
    if (studentsData.list.length > 1) return 0;
    return Object.keys(data).length;
  } catch { return 0; }
}

// ══════════════════════════════════════════════════════════════════
//  EXPORT / IMPORT
// ══════════════════════════════════════════════════════════════════

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

/** Legge e analizza un file JSON importato. */
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
