// ══════════════════════════════════════════════════════════════════
//  drive.js — Google Drive OAuth + sync per CAArtella
//  Adattato da Valutazione Primaria (stesso CLIENT_ID, stesso meccanismo)
// ══════════════════════════════════════════════════════════════════

const DRIVE_CLIENT_ID   = '374342529488-c123a5j5v8hnfs241udbl55fos5thfq6.apps.googleusercontent.com';
const DRIVE_SCOPE       = 'https://www.googleapis.com/auth/drive.file email profile';
const DRIVE_FOLDER_NAME  = 'CAArtella';
const SHARED_INDEX_FILE  = 'indice-condivisi.json';

// ── Stato Drive (persiste in localStorage) ────────────────────────
let driveState = {
  enabled:        false,
  accessToken:    null,
  tokenExpiry:    0,
  folderId:       null,   // cartella CAArtella/ personale
  userEmail:      '',
  ownFileIds:     {},     // { 'EMMA': 'fileId...' }  — file propri (cache)
  sharedFileIds:  {},     // { 'LUCA': 'fileId...' }  — file condivisi da colleghe
};

export function isDriveConnected() {
  return driveState.enabled && !!driveState.accessToken && Date.now() < driveState.tokenExpiry - 30000;
}

function saveDriveState() {
  localStorage.setItem('caa_driveState_v1', JSON.stringify(driveState));
}

// ── Carica stato all'avvio ────────────────────────────────────────
export function loadDriveConfig(onConnected) {
  try {
    const saved = localStorage.getItem('caa_driveState_v1');
    if (saved) driveState = Object.assign(driveState, JSON.parse(saved));
  } catch(e) {}

  updateDriveButton();

  if (driveState.enabled && driveState.accessToken && Date.now() < driveState.tokenExpiry - 30000) {
    onConnected && onConnected();
  } else if (driveState.enabled) {
    trySilentAuth(onConnected);
  }
}

// ── Aggiorna aspetto pulsante Drive ──────────────────────────────
export function updateDriveButton(state) {
  const btn   = document.getElementById('drive-btn');
  const label = document.getElementById('drive-btn-label');
  if (!btn) return;
  btn.className = 'drive-button no-print';
  if (state === 'syncing') {
    btn.classList.add('syncing');
    label.textContent = 'Sincronizzo…';
  } else if (state === 'error') {
    btn.classList.add('error');
    label.textContent = 'Drive ⚠️';
  } else if (driveState.enabled && driveState.accessToken) {
    btn.classList.add('connected');
    label.textContent = 'Drive ✓';
  } else {
    label.textContent = 'Drive';
  }
}

// ── Click su "Collega a Google Drive" ────────────────────────────
export function connectToDrive() {
  if (typeof google === 'undefined' || !google.accounts) {
    alert('Le librerie Google non sono ancora caricate. Riprova tra qualche secondo.');
    return;
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope:     DRIVE_SCOPE,
    callback:  async (tokenResponse) => {
      if (tokenResponse.error) {
        showDrivePanel('error', 'Autorizzazione negata: ' + tokenResponse.error);
        return;
      }
      driveState.accessToken = tokenResponse.access_token;
      driveState.tokenExpiry = Date.now() + (tokenResponse.expires_in * 1000);
      driveState.enabled     = true;
      saveDriveState();
      updateDriveButton('syncing');
      try {
        await initDriveConnection();
      } catch(err) {
        updateDriveButton('error');
        showDrivePanel('error', 'Errore: ' + err.message);
      }
    }
  });
  client.requestAccessToken({ prompt: 'consent' });
}

// ── Rinnovo silenzioso del token ──────────────────────────────────
function trySilentAuth(onReady, retries = 6) {
  if (typeof google === 'undefined' || !google.accounts) {
    if (retries > 0) setTimeout(() => trySilentAuth(onReady, retries - 1), 1500);
    else updateDriveButton('error');
    return;
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope:     DRIVE_SCOPE,
    prompt:    '',
    callback:  (tokenResponse) => {
      if (tokenResponse.access_token) {
        driveState.accessToken = tokenResponse.access_token;
        driveState.tokenExpiry = Date.now() + (tokenResponse.expires_in * 1000);
        saveDriveState();
        updateDriveButton('connected');
        // Ripristina indice condivisi (se abbiamo già il folderId), poi chiama onReady
        const proceed = () => { onReady && onReady(); };
        if (driveState.folderId) {
          restoreSharedIndex().then(proceed).catch(proceed);
        } else {
          proceed();
        }
      } else {
        updateDriveButton('error');
      }
    }
  });
  client.requestAccessToken({ prompt: '' });
}

// ── Prima connessione: recupera info utente + trova/crea cartella ─
async function initDriveConnection() {
  const info = await driveApiFetch('https://www.googleapis.com/oauth2/v2/userinfo');
  driveState.userEmail = info.email || '';

  if (!driveState.sharedMode) {
    driveState.folderId = await findOrCreateDriveFolder();
  }
  saveDriveState();

  // Ripristina vocabolari condivisi dall'indice su Drive
  await restoreSharedIndex();

  updateDriveButton('connected');
  _refreshConnectedPanel();
  showDrivePanel('connected');

  // Notifica app.js che la connessione è completa (incluso il ripristino dell'indice)
  document.dispatchEvent(new CustomEvent('caa-drive-connected'));
}

// ── Indice vocabolari condivisi (indice-condivisi.json) ───────────
// Struttura: [ { name: 'EMMA', fileId: 'xxx' }, ... ]

async function loadSharedIndex() {
  if (!driveState.folderId) return [];
  try {
    const q = encodeURIComponent(
      `name='${SHARED_INDEX_FILE}' and '${driveState.folderId}' in parents and trashed=false`
    );
    const resp = await driveApiFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
    );
    if (!resp.files || resp.files.length === 0) return [];
    const data = await loadFileContent(resp.files[0].id);
    return Array.isArray(data) ? data : [];
  } catch(e) {
    console.warn('[Drive] Errore lettura indice condivisi:', e.message);
    return [];
  }
}

async function saveSharedIndex(entries) {
  if (!driveState.folderId) return;
  // Nessun try/catch qui: gli errori emergono al chiamante (connectSharedFile)
  const payload = JSON.stringify(entries);
  const q = encodeURIComponent(
    `name='${SHARED_INDEX_FILE}' and '${driveState.folderId}' in parents and trashed=false`
  );
  const resp = await driveApiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
  );
  if (resp.files && resp.files.length > 0) {
    await updateDriveFile(resp.files[0].id, payload);
  } else {
    await createDriveFile(SHARED_INDEX_FILE, payload);
  }
}

async function restoreSharedIndex() {
  const entries = await loadSharedIndex();
  if (entries.length === 0) return;
  driveState.sharedFileIds = driveState.sharedFileIds || {};
  entries.forEach(({ name, fileId }) => {
    if (name && fileId) driveState.sharedFileIds[name] = fileId;
  });
  saveDriveState();
}

// ── Trova o crea la cartella CAArtella/ ──────────────────────────
async function findOrCreateDriveFolder() {
  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const resp = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  if (resp.files && resp.files.length > 0) return resp.files[0].id;
  const created = await driveApiFetch(
    'https://www.googleapis.com/drive/v3/files',
    'POST',
    { name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }
  );
  return created.id;
}

// ── Rendi un file pubblicamente leggibile (accesso chiunque con link) ──
async function makeFilePublic(fileId) {
  try {
    await driveApiFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
      'POST',
      { role: 'reader', type: 'anyone' }
    );
  } catch(e) {
    console.warn('[Drive] makeFilePublic fallito:', e.message);
  }
}

// ── Prepara il file per la condivisione (chiamare prima di copiare il messaggio) ─
export async function makeShareReady(fileId) {
  if (!isDriveConnected() || !fileId) return;
  await makeFilePublic(fileId);
}

// ── Usa vocabolario condiviso tramite codice (file ID) ───────────
export async function connectSharedFile(fileId) {
  if (!isDriveConnected()) {
    throw new Error('Prima collega il tuo account Google Drive, poi inserisci il codice.');
  }
  // Prova a leggere il file direttamente per ID
  // (funziona se il file è stato reso pubblico con makeShareReady)
  let data;
  try {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: 'Bearer ' + driveState.accessToken } }
    );
    if (!resp.ok) throw new Error('HTTP_' + resp.status);
    data = await resp.json();
  } catch(e) {
    const code = e.message.startsWith('HTTP_') ? e.message.replace('HTTP_', '') : null;
    if (code === '403') {
      throw new Error(
        'Accesso negato (errore 403). La collega deve aggiornare il messaggio di condivisione: ' +
        'chiedi alla collega di aprire il pannello Drive, selezionare l\'alunno e cliccare di nuovo "Copia messaggio", ' +
        'poi reinviarti il link aggiornato.'
      );
    } else if (code === '404') {
      throw new Error('Codice non valido (errore 404): file non trovato. Verifica che il codice sia corretto.');
    } else {
      throw new Error(
        'Codice non valido, oppure non sei stato/a ancora invitato/a dal/dalla collega a condividere il file. ' +
        'Assicurati che il/la collega ti abbia aggiunto/a come editor nel file Drive prima di inserire il codice.'
      );
    }
  }

  const studentName = data.student || 'Alunno condiviso';
  driveState.sharedFileIds = driveState.sharedFileIds || {};
  driveState.sharedFileIds[studentName] = fileId;
  saveDriveState();

  // Aggiorna l'indice su Drive (sopravvive alla pulizia cache)
  try {
    const entries = await loadSharedIndex();
    if (!entries.find(e => e.fileId === fileId)) {
      entries.push({ name: studentName, fileId });
      await saveSharedIndex(entries);
      console.log('[Drive] ✅ Indice condivisi salvato su Drive:', entries);
    } else {
      console.log('[Drive] Indice già aggiornato per:', studentName);
    }
  } catch(e) {
    console.error('[Drive] ❌ ERRORE indice condivisi:', e.message);
    showDriveToast('⚠️ Errore salvataggio indice Drive: ' + e.message);
  }

  return { studentName, dict: data.dict || {}, custom: data.custom || {} };
}

// ── Ottieni codice da condividere per un alunno (= file ID) ──────
export async function getStudentShareCode(studentName) {
  if (!isDriveConnected() || !driveState.folderId) return null;
  const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;
  // Prima controlla la cache
  if (driveState.ownFileIds?.[studentName]) return driveState.ownFileIds[studentName];
  // Altrimenti cerca su Drive
  const fileId = await findStudentFile(fileName);
  if (fileId) {
    driveState.ownFileIds = driveState.ownFileIds || {};
    driveState.ownFileIds[studentName] = fileId;
    saveDriveState();
  }
  return fileId;
}

// ── Controlla se un alunno è condiviso da una collega ────────────
export function isSharedStudent(studentName) {
  return !!(driveState.sharedFileIds?.[studentName]);
}

// ── URL cartella CAArtella su Drive (null se non connesso) ────────
export function getDriveFolderUrl() {
  if (!driveState.folderId) return null;
  return `https://drive.google.com/drive/folders/${driveState.folderId}`;
}

// ── Salva dizionario alunno su Drive ─────────────────────────────
export async function saveStudentToDrive(studentName, dict, custom) {
  if (!isDriveConnected()) return;

  updateDriveButton('syncing');

  try {
    // Determina il file ID: file condiviso o file proprio
    let fileId = driveState.sharedFileIds?.[studentName] || null;
    let isShared = !!fileId;

    if (!isShared) {
      if (!driveState.folderId) return;
      const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;
      fileId = driveState.ownFileIds?.[studentName] || await findStudentFile(fileName);
    }

    let mergedDict   = { ...dict };
    let mergedCustom = { ...custom };

    // Merge con versione Drive (evita perdite in uso simultaneo)
    if (fileId) {
      try {
        const existing  = await loadFileContent(fileId);
        mergedDict   = { ...existing.dict,   ...dict };
        mergedCustom = { ...existing.custom, ...custom };
      } catch(e) { /* usa dati locali */ }
    }

    const payload = JSON.stringify({
      dict:    mergedDict,
      custom:  mergedCustom,
      student: studentName,
      savedAt: new Date().toISOString()
    });

    if (!fileId) {
      const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;
      const result = await createDriveFile(fileName, payload);
      fileId = result.id;
      driveState.ownFileIds = driveState.ownFileIds || {};
      driveState.ownFileIds[studentName] = fileId;
      saveDriveState();
    } else {
      await updateDriveFile(fileId, payload);
      // Aggiorna cache file ID propri
      if (!isShared) {
        driveState.ownFileIds = driveState.ownFileIds || {};
        driveState.ownFileIds[studentName] = fileId;
        saveDriveState();
      }
    }

    updateDriveButton('connected');
    showDriveToast(`✅ Vocabolario di "${studentName || 'Anonimo'}" salvato su Drive`);
    return mergedDict;
  } catch(err) {
    updateDriveButton('error');
    console.error('[Drive] Errore salvataggio:', err);
  }
}

// ── Carica dizionario alunno da Drive ────────────────────────────
export async function loadStudentFromDrive(studentName) {
  if (!isDriveConnected()) return null;

  try {
    // Prima controlla se è un file condiviso
    const sharedId = driveState.sharedFileIds?.[studentName];
    if (sharedId) return await loadFileContent(sharedId);

    // Altrimenti cerca nel folder personale
    if (!driveState.folderId) return null;
    const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;
    const fileId   = driveState.ownFileIds?.[studentName] || await findStudentFile(fileName);
    if (!fileId) return null;

    // Aggiorna cache
    driveState.ownFileIds = driveState.ownFileIds || {};
    driveState.ownFileIds[studentName] = fileId;
    saveDriveState();
    return await loadFileContent(fileId);
  } catch(err) {
    console.error('[Drive] Errore caricamento:', err);
    return null;
  }
}

// ── Elenca alunni presenti su Drive ──────────────────────────────
export async function listStudentsOnDrive() {
  if (!isDriveConnected() || !driveState.folderId) return [];

  let ownStudents = [];
  try {
    const q = encodeURIComponent(
      `'${driveState.folderId}' in parents and name contains 'vocabolario-' and trashed=false`
    );
    const resp = await driveApiFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
    );
    ownStudents = (resp.files || []).map(f => {
      const name = f.name
        .replace(/^vocabolario-/, '')
        .replace(/\.json$/, '')
        .replace(/^_anonimo$/, '');
      return { name, fileName: f.name };
    });
  } catch(e) {}

  // Aggiunge anche gli studenti condivisi (ripristinati dall'indice)
  const sharedStudents = Object.keys(driveState.sharedFileIds || {})
    .filter(name => name && name !== '')
    .map(name => ({ name, fileName: `vocabolario-${name}.json`, shared: true }));

  // Unifica evitando duplicati
  const seen = new Set(ownStudents.map(s => s.name));
  sharedStudents.forEach(s => { if (!seen.has(s.name)) ownStudents.push(s); });

  return ownStudents;
}

// ── Restituisce il codice da condividere (= folder ID) ────────────
export function getShareCode() {
  return driveState.folderId || '';
}

// ── Disconnetti Drive ─────────────────────────────────────────────
export function disconnectDrive(onDisconnect) {
  if (!confirm(
    'Disconnetto Drive e rimuovo i dati di accesso da questo browser.\n' +
    'Il dizionario sul Drive rimane al sicuro. Confermi?'
  )) return;
  if (driveState.accessToken && typeof google !== 'undefined' && google.accounts) {
    google.accounts.oauth2.revoke(driveState.accessToken);
  }
  // Preserva sharedFileIds: anche dopo disconnect, i vocabolari condivisi ricevuti
  // devono tornare automaticamente alla prossima connessione (es. se si cancella un alunno per errore)
  const savedSharedIds = driveState.sharedFileIds || {};
  driveState = {
    enabled: false, accessToken: null, tokenExpiry: 0,
    folderId: null, userEmail: '', sharedMode: false,
    sharedFileIds: savedSharedIds,
  };
  saveDriveState();
  updateDriveButton();
  showDrivePanel('connect');
  onDisconnect && onDisconnect();
}

// ── Helper: chiamate Drive API ────────────────────────────────────
async function driveApiFetch(url, method, body) {
  const opts = {
    method: method || 'GET',
    headers: { Authorization: 'Bearer ' + driveState.accessToken }
  };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) throw new Error('Drive API error ' + resp.status);
  return resp.json();
}

async function findStudentFile(fileName) {
  const q = encodeURIComponent(
    `name='${fileName}' and '${driveState.folderId}' in parents and trashed=false`
  );
  const resp = await driveApiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
  );
  return (resp.files && resp.files.length > 0) ? resp.files[0].id : null;
}

async function loadFileContent(fileId) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: 'Bearer ' + driveState.accessToken } }
  );
  if (!resp.ok) throw new Error('Lettura Drive fallita (' + resp.status + ')');
  return resp.json();
}

async function createDriveFile(fileName, content) {
  const boundary = 'caa_' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify({ name: fileName, parents: [driveState.folderId] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + driveState.accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body
    }
  );
  if (!resp.ok) throw new Error('Creazione file Drive fallita (' + resp.status + ')');
  return resp.json();
}

async function updateDriveFile(fileId, content) {
  const boundary = 'caa_' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + driveState.accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body
    }
  );
  if (!resp.ok) throw new Error('Aggiornamento Drive fallito (' + resp.status + ')');
  return resp.json();
}

// ── UI: Modal Drive ───────────────────────────────────────────────
export function openDriveModal() {
  const panel = isDriveConnected() ? 'connected' : 'connect';
  if (panel === 'connected') _refreshConnectedPanel();
  showDrivePanel(panel);
  document.getElementById('drive-modal').style.display = 'flex';
}

export function closeDriveModal() {
  document.getElementById('drive-modal').style.display = 'none';
}

export function showDrivePanel(panel, errorMsg) {
  ['drive-panel-connect', 'drive-panel-connected', 'drive-panel-error', 'drive-panel-code']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  const target = {
    connect:   'drive-panel-connect',
    connected: 'drive-panel-connected',
    error:     'drive-panel-error',
    code:      'drive-panel-code',
  }[panel];
  if (target) document.getElementById(target).style.display = 'block';
  if (errorMsg) {
    const el = document.getElementById('drive-error-text');
    if (el) el.textContent = errorMsg;
  }
}

function _refreshConnectedPanel() {
  const emailEl = document.getElementById('drive-user-email');
  if (emailEl) emailEl.textContent = driveState.userEmail;
  const modeEl  = document.getElementById('drive-mode-label');
  if (modeEl)  modeEl.textContent = driveState.sharedMode ? '📂 Cartella condivisa' : '📁 Cartella personale';
  // NOTA: drive-share-code NON viene impostato qui — solo _refreshDriveSharePanel (app.js)
  // lo imposta con il fileId corretto. Impostarlo qui con folderId causava il bug "404".
  // Bottone "Apri CAArtella su Drive" — visibile sempre quando c'è il folderId
  const folderBtn = document.getElementById('drive-open-folder-btn');
  if (folderBtn) folderBtn.style.display = driveState.folderId ? 'inline-flex' : 'none';
}

// ── UI: Toast salvataggio ─────────────────────────────────────────
export function showDriveToast(msg) {
  const toast = document.getElementById('drive-toast');
  if (!toast) return;
  const msgEl = toast.querySelector('.drive-toast-msg');
  if (msgEl) msgEl.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 4000);
}

// ── Utility ───────────────────────────────────────────────────────
function sanitizeName(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').trim() || '_anonimo';
}
