// ══════════════════════════════════════════════════════════════════
//  drive.js — Google Drive OAuth + sync per CAArtella
//  Adattato da Valutazione Primaria (stesso CLIENT_ID, stesso meccanismo)
// ══════════════════════════════════════════════════════════════════

const DRIVE_CLIENT_ID   = '374342529488-c123a5j5v8hnfs241udbl55fos5thfq6.apps.googleusercontent.com';
const DRIVE_SCOPE       = 'https://www.googleapis.com/auth/drive.file email profile';
const DRIVE_FOLDER_NAME = 'CAArtella';

// ── Stato Drive (persiste in localStorage) ────────────────────────
let driveState = {
  enabled:     false,
  accessToken: null,
  tokenExpiry: 0,
  folderId:    null,    // cartella CAArtella/ (propria o condivisa)
  userEmail:   '',
  sharedMode:  false,   // true = usa cartella condivisa da collega
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
        onReady && onReady();
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
  updateDriveButton('connected');
  _refreshConnectedPanel();
  showDrivePanel('connected');
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

// ── Usa cartella condivisa tramite codice ─────────────────────────
export async function connectSharedFolder(folderId) {
  if (!isDriveConnected()) {
    throw new Error('Prima collega il tuo account Google Drive, poi inserisci il codice.');
  }
  try {
    await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name`);
  } catch(e) {
    throw new Error('Codice non valido o non sei stata invitata in questa cartella.');
  }
  driveState.folderId   = folderId;
  driveState.sharedMode = true;
  saveDriveState();
  _refreshConnectedPanel();
  showDrivePanel('connected');
}

// ── Torna alla cartella personale ─────────────────────────────────
export async function switchToPersonalFolder() {
  driveState.sharedMode = false;
  driveState.folderId   = await findOrCreateDriveFolder();
  saveDriveState();
  _refreshConnectedPanel();
}

// ── Salva dizionario alunno su Drive ─────────────────────────────
export async function saveStudentToDrive(studentName, dict, custom) {
  if (!isDriveConnected() || !driveState.folderId) return;

  updateDriveButton('syncing');
  const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;

  try {
    const fileId = await findStudentFile(fileName);
    let mergedDict   = { ...dict };
    let mergedCustom = { ...custom };

    // Merge con versione Drive (evita perdite se due colleghe lavorano in simultanea)
    if (fileId) {
      try {
        const existing  = await loadFileContent(fileId);
        mergedDict   = { ...existing.dict,   ...dict };
        mergedCustom = { ...existing.custom, ...custom };
      } catch(e) { /* se il file è corrotto usa i dati locali */ }
    }

    const payload = JSON.stringify({
      dict:    mergedDict,
      custom:  mergedCustom,
      student: studentName,
      savedAt: new Date().toISOString()
    });

    if (!fileId) await createDriveFile(fileName, payload);
    else         await updateDriveFile(fileId, payload);

    updateDriveButton('connected');
    showDriveToast(`✅ Dizionario di "${studentName || 'Anonimo'}" salvato su Drive`);
    return mergedDict;
  } catch(err) {
    updateDriveButton('error');
    console.error('[Drive] Errore salvataggio:', err);
  }
}

// ── Carica dizionario alunno da Drive ────────────────────────────
export async function loadStudentFromDrive(studentName) {
  if (!isDriveConnected() || !driveState.folderId) return null;

  const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;
  try {
    const fileId = await findStudentFile(fileName);
    if (!fileId) return null;
    return await loadFileContent(fileId);
  } catch(err) {
    console.error('[Drive] Errore caricamento:', err);
    return null;
  }
}

// ── Elenca alunni presenti su Drive ──────────────────────────────
export async function listStudentsOnDrive() {
  if (!isDriveConnected() || !driveState.folderId) return [];
  try {
    const q = encodeURIComponent(
      `'${driveState.folderId}' in parents and name contains 'vocabolario-' and trashed=false`
    );
    const resp = await driveApiFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
    );
    return (resp.files || []).map(f => {
      const name = f.name
        .replace(/^vocabolario-/, '')
        .replace(/\.json$/, '')
        .replace(/^_anonimo$/, '');
      return { name, fileName: f.name };
    });
  } catch(e) { return []; }
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
  driveState = {
    enabled: false, accessToken: null, tokenExpiry: 0,
    folderId: null, userEmail: '', sharedMode: false
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
  const codeEl  = document.getElementById('drive-share-code');
  if (codeEl && !driveState.sharedMode) codeEl.value = driveState.folderId || '';
}

// ── UI: Toast salvataggio ─────────────────────────────────────────
function showDriveToast(msg) {
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
