'use strict';

/**
 * app.js — Lógica del cliente de Chat Privado (WebRTC DataChannel)
 * ---------------------------------------------------------------------------
 * Resumen del flujo:
 *   1. El usuario introduce su nombre → nos conectamos al servidor de
 *      SIGNALING (WebSocket) solo para "encontrarnos" con la otra persona.
 *   2. Mediante el signaling intercambiamos una oferta/respuesta SDP y
 *      candidatos ICE para abrir una conexión WebRTC directa.
 *   3. En cuanto el RTCDataChannel se abre, los mensajes viajan DIRECTAMENTE
 *      entre los dos navegadores. El servidor de signaling ya no interviene
 *      en el contenido de la conversación (solo lo mantenemos abierto para
 *      detectar desconexiones al instante).
 *   4. Nada se guarda en localStorage/IndexedDB/base de datos. Todo vive en
 *      variables de JavaScript en memoria y desaparece al recargar la página.
 */

// ============================================================================
// CONFIGURACIÓN — EDITA ESTO AL DESPLEGAR
// ============================================================================
const CONFIG = {
  // URL del servidor de signaling (ver /signaling-server). En local, con
  // `npm start` dentro de esa carpeta, escucha en ws://localhost:8080.
  // Al publicar el frontend, cambia esto por la URL wss:// de tu servidor
  // de signaling ya desplegado (Render, Railway, Fly.io, un VPS, etc.).
  SIGNALING_URL: (() => {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'ws://localhost:8080';
    }
    // ⚠️ Reemplaza esta línea por la URL real de tu servidor de signaling
    // publicado, por ejemplo: 'wss://mi-chat-signaling.onrender.com'
    return 'wss://chat-signaling.onrender.com';
  })(),

  // Servidores STUN públicos, necesarios para que WebRTC descubra cómo
  // atravesar routers/NAT. No transportan mensajes, solo ayudan a abrir
  // la conexión directa. En redes muy restrictivas (algunas corporativas
  // o de operador con NAT simétrico) puede hacer falta además un servidor
  // TURN — ver README.md.
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],

  MAX_NAME_LENGTH: 24,
  MAX_MESSAGE_LENGTH: 2000,
  TYPING_STOP_DELAY_MS: 1200,
  RATE_LIMIT_MAX_MESSAGES: 5,
  RATE_LIMIT_WINDOW_MS: 3000,
};

// ============================================================================
// ESTADO EN MEMORIA (nada de esto se persiste nunca)
// ============================================================================
const state = {
  ws: null,
  pc: null,
  dc: null,
  localName: '',
  peerName: '',
  roomId: 'default',
  isInitiator: false,
  remoteDescriptionSet: false,
  pendingCandidates: [],
  messageCount: 0,
  everConnected: false,
  roomFullHandled: false,
  intentionalClose: false,
  typingActive: false,
  typingStopTimer: null,
  peerTypingTimer: null,
  sentTimestamps: [],
};

// ============================================================================
// REFERENCIAS AL DOM
// ============================================================================
const el = {
  screenLogin: document.getElementById('screen-login'),
  screenChat: document.getElementById('screen-chat'),
  formLogin: document.getElementById('form-login'),
  inputName: document.getElementById('input-name'),
  inputRoom: document.getElementById('input-room'),
  loginError: document.getElementById('login-error'),

  presenceOrb: document.getElementById('presence-orb'),
  peerStatusText: document.getElementById('peer-status-text'),
  messageCounter: document.getElementById('message-counter'),
  bannerArea: document.getElementById('banner-area'),
  messageList: document.getElementById('message-list'),
  typingIndicator: document.getElementById('typing-indicator'),
  typingText: document.getElementById('typing-text'),

  formMessage: document.getElementById('form-message'),
  inputMessage: document.getElementById('input-message'),
  btnSend: document.getElementById('btn-send'),
};

// ============================================================================
// UTILIDADES
// ============================================================================
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sanitizeName(raw) {
  return raw.trim().replace(/\s+/g, ' ').slice(0, CONFIG.MAX_NAME_LENGTH);
}

function sanitizeRoomId(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return 'default';
  // Solo letras, números, guiones y guion bajo — evita inyectar cualquier
  // cosa rara en el identificador de sala.
  return trimmed.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';
}

function showLoginError(message) {
  el.loginError.textContent = message;
  el.loginError.hidden = false;
}

function clearLoginError() {
  el.loginError.hidden = true;
  el.loginError.textContent = '';
}

function setPresence(stateName, text) {
  el.presenceOrb.dataset.state = stateName;
  el.peerStatusText.textContent = text;
}

function showBanner(text, kind = 'info', timeoutMs = 4000) {
  const banner = document.createElement('div');
  banner.className = `banner banner--${kind}`;
  banner.textContent = text;
  el.bannerArea.innerHTML = '';
  el.bannerArea.appendChild(banner);
  if (timeoutMs) {
    setTimeout(() => {
      if (banner.parentNode) banner.remove();
    }, timeoutMs);
  }
}

function appendSystemMessage(text) {
  const row = document.createElement('div');
  row.className = 'msg-row msg-row--system';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text; // textContent → nunca se interpreta como HTML
  row.appendChild(bubble);
  el.messageList.appendChild(row);
  scrollToBottom();
}

function appendChatMessage({ sender, text, time, isOwn }) {
  const row = document.createElement('div');
  row.className = `msg-row ${isOwn ? 'msg-row--own' : 'msg-row--peer'}`;

  const senderEl = document.createElement('div');
  senderEl.className = 'msg-sender';
  senderEl.textContent = sender; // textContent escapa automáticamente

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text; // idem: nunca se inserta como HTML → sin XSS

  const timeEl = document.createElement('div');
  timeEl.className = 'msg-time';
  timeEl.textContent = formatTime(time);

  row.appendChild(senderEl);
  row.appendChild(bubble);
  row.appendChild(timeEl);
  el.messageList.appendChild(row);

  state.messageCount++;
  el.messageCounter.textContent = String(state.messageCount);

  scrollToBottom();
}

function scrollToBottom() {
  el.messageList.scrollTop = el.messageList.scrollHeight;
}

function setComposerEnabled(enabled) {
  el.inputMessage.disabled = !enabled;
  el.btnSend.disabled = !enabled;
}

// ============================================================================
// PASO 1 — PANTALLA DE ACCESO
// ============================================================================
el.formLogin.addEventListener('submit', (e) => {
  e.preventDefault();
  clearLoginError();

  const name = sanitizeName(el.inputName.value);
  if (!name) {
    showLoginError('Introduce un nombre válido.');
    return;
  }
  if (/^[\s]*$/.test(name)) {
    showLoginError('El nombre no puede estar vacío.');
    return;
  }

  const roomId = sanitizeRoomId(el.inputRoom.value);

  state.localName = name;
  state.roomId = roomId;

  enterChatScreen();
  connectSignaling();
});

function enterChatScreen() {
  el.screenLogin.hidden = true;
  el.screenChat.hidden = false;
  setPresence('connecting', 'Conectando…');
}

// ============================================================================
// PASO 2 — CONEXIÓN AL SERVIDOR DE SIGNALING (solo para "encontrarnos")
// ============================================================================
function connectSignaling() {
  let ws;
  try {
    ws = new WebSocket(CONFIG.SIGNALING_URL);
  } catch (err) {
    handleSignalingUnavailable();
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    sendSignalingMessage({ type: 'join', name: state.localName, roomId: state.roomId });
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSignalingMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (state.intentionalClose || state.roomFullHandled) return;
    // El servidor de signaling se cayó o la red falló antes/durante el
    // intercambio de señalización, o mientras seguía abierto para avisos
    // de desconexión.
    if (!state.everConnected) {
      setPresence('disconnected', 'No se pudo conectar');
      showBanner('No se pudo contactar con el servidor de conexión. Comprueba tu red e inténtalo de nuevo.', 'danger', 0);
    } else if (state.dc && state.dc.readyState !== 'open') {
      setPresence('disconnected', 'Desconectado');
    }
  });

  ws.addEventListener('error', () => {
    // El evento 'close' se dispara justo después; ahí se maneja el aviso.
  });
}

function handleSignalingUnavailable() {
  setPresence('disconnected', 'No se pudo conectar');
  showBanner('No se pudo contactar con el servidor de conexión. Revisa la URL configurada en app.js.', 'danger', 0);
}

function sendSignalingMessage(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      state.isInitiator = !!msg.isInitiator;
      if (msg.peerName) state.peerName = msg.peerName;

      createPeerConnection();

      if (state.isInitiator) {
        // Ya sabemos que el otro usuario está esperando: abrimos el canal.
        setPresence('connecting', 'Conectando…');
        createDataChannelAndOffer();
      } else {
        setPresence('waiting', 'Esperando al otro usuario…');
      }
      break;
    }

    case 'peer-joined': {
      // Solo le llega a quien ya estaba esperando en la sala.
      state.peerName = msg.peerName || state.peerName;
      setPresence('connecting', 'Conectando…');
      break;
    }

    case 'signal': {
      handleRemoteSignal(msg.payload);
      break;
    }

    case 'peer-left': {
      handlePeerLeft(msg.name);
      break;
    }

    case 'room-full': {
      state.roomFullHandled = true;
      el.screenChat.hidden = true;
      el.screenLogin.hidden = false;
      showLoginError('Esta sala ya está llena. Solo caben 2 personas.');
      teardownConnection({ notifyPeer: false });
      break;
    }

    case 'error': {
      showBanner(msg.message || 'Error de conexión.', 'danger');
      break;
    }

    default:
      break;
  }
}

function handlePeerLeft(name) {
  setPresence('disconnected', `${name || 'El otro usuario'} se ha desconectado`);
  showBanner(`${name || 'El otro usuario'} se ha desconectado.`, 'warn', 0);
  setComposerEnabled(false);
  hidePeerTyping();
  if (state.dc) {
    try { state.dc.close(); } catch { /* noop */ }
  }
}

// ============================================================================
// PASO 3 — WEBRTC: CREAR LA CONEXIÓN Y EL CANAL DE DATOS
// ============================================================================
function createPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
  state.pc = pc;
  state.remoteDescriptionSet = false;
  state.pendingCandidates = [];

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      sendSignalingMessage({
        type: 'signal',
        payload: { kind: 'candidate', candidate: event.candidate.toJSON() },
      });
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    switch (pc.connectionState) {
      case 'connected':
        state.everConnected = true;
        break;
      case 'disconnected':
        setPresence('reconnecting', 'Reconectando…');
        break;
      case 'failed':
      case 'closed':
        if (state.everConnected) {
          setPresence('disconnected', `${state.peerName || 'El otro usuario'} se ha desconectado`);
          setComposerEnabled(false);
        }
        break;
      default:
        break;
    }
  });

  // Si NO somos quien inicia, esperamos a que llegue el canal creado
  // por el otro navegador (esto ocurre al procesar la oferta SDP).
  pc.addEventListener('datachannel', (event) => {
    attachDataChannel(event.channel);
  });
}

function createDataChannelAndOffer() {
  const dc = state.pc.createDataChannel('chat', { ordered: true });
  attachDataChannel(dc);

  state.pc.createOffer()
    .then((offer) => state.pc.setLocalDescription(offer))
    .then(() => {
      sendSignalingMessage({
        type: 'signal',
        payload: { kind: 'offer', sdp: state.pc.localDescription.sdp },
      });
    })
    .catch(() => {
      showBanner('No se pudo iniciar la conexión WebRTC.', 'danger', 0);
    });
}

async function handleRemoteSignal(payload) {
  if (!payload || !state.pc) return;
  const pc = state.pc;

  try {
    if (payload.kind === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      state.remoteDescriptionSet = true;
      await flushPendingCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignalingMessage({
        type: 'signal',
        payload: { kind: 'answer', sdp: pc.localDescription.sdp },
      });
    } else if (payload.kind === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      state.remoteDescriptionSet = true;
      await flushPendingCandidates();
    } else if (payload.kind === 'candidate' && payload.candidate) {
      if (state.remoteDescriptionSet) {
        await pc.addIceCandidate(payload.candidate);
      } else {
        // Puede llegar un candidato ICE antes que la oferta/respuesta se
        // haya terminado de procesar: lo guardamos y lo aplicamos después.
        state.pendingCandidates.push(payload.candidate);
      }
    }
  } catch (err) {
    showBanner('Error al negociar la conexión WebRTC.', 'danger', 0);
  }
}

async function flushPendingCandidates() {
  const queued = state.pendingCandidates;
  state.pendingCandidates = [];
  for (const candidate of queued) {
    try {
      await state.pc.addIceCandidate(candidate);
    } catch {
      /* candidato inválido o ya obsoleto: se ignora */
    }
  }
}

// ============================================================================
// PASO 4 — CANAL DE DATOS: AQUÍ VIAJAN LOS MENSAJES, DIRECTO ENTRE NAVEGADORES
// ============================================================================
function attachDataChannel(channel) {
  state.dc = channel;

  channel.addEventListener('open', () => {
    state.everConnected = true;
    setPresence('connected', `${state.peerName || 'Usuario'} está conectado`);
    setComposerEnabled(true);
    appendSystemMessage('Conexión establecida. Los mensajes viajan directamente entre los dos navegadores.');
    el.inputMessage.focus();
  });

  channel.addEventListener('close', () => {
    setComposerEnabled(false);
    if (state.everConnected) {
      setPresence('disconnected', `${state.peerName || 'El otro usuario'} se ha desconectado`);
    }
  });

  channel.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handleDataChannelMessage(data);
  });
}

function handleDataChannelMessage(data) {
  if (!data || typeof data.type !== 'string') return;

  switch (data.type) {
    case 'chat': {
      const text = typeof data.text === 'string' ? data.text.slice(0, CONFIG.MAX_MESSAGE_LENGTH) : '';
      if (!text.trim()) return;
      hidePeerTyping();
      appendChatMessage({
        sender: state.peerName || 'Usuario',
        text,
        time: Date.now(),
        isOwn: false,
      });
      break;
    }
    case 'typing': {
      showPeerTyping();
      break;
    }
    case 'stop-typing': {
      hidePeerTyping();
      break;
    }
    default:
      break;
  }
}

function showPeerTyping() {
  el.typingText.textContent = `${state.peerName || 'El otro usuario'} está escribiendo…`;
  el.typingIndicator.hidden = false;
  clearTimeout(state.peerTypingTimer);
  // Salvaguarda: si nunca llega "stop-typing" (p. ej. se cerró la pestaña
  // de golpe), el indicador desaparece solo tras unos segundos de silencio.
  state.peerTypingTimer = setTimeout(hidePeerTyping, 4000);
}

function hidePeerTyping() {
  el.typingIndicator.hidden = true;
  clearTimeout(state.peerTypingTimer);
}

// ============================================================================
// PASO 5 — ENVIAR MENSAJES
// ============================================================================
el.formMessage.addEventListener('submit', (e) => {
  e.preventDefault();
  trySendMessage();
});

el.inputMessage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    trySendMessage();
  }
});

el.inputMessage.addEventListener('input', () => {
  autoGrowTextarea();
  handleLocalTyping();
});

function autoGrowTextarea() {
  el.inputMessage.style.height = 'auto';
  el.inputMessage.style.height = `${Math.min(el.inputMessage.scrollHeight, 140)}px`;
}

function isRateLimited() {
  const now = Date.now();
  state.sentTimestamps = state.sentTimestamps.filter((t) => now - t < CONFIG.RATE_LIMIT_WINDOW_MS);
  return state.sentTimestamps.length >= CONFIG.RATE_LIMIT_MAX_MESSAGES;
}

function trySendMessage() {
  if (!state.dc || state.dc.readyState !== 'open') return;

  const raw = el.inputMessage.value;
  const text = raw.trim().slice(0, CONFIG.MAX_MESSAGE_LENGTH);
  if (!text) return;

  if (isRateLimited()) {
    showBanner('Estás enviando mensajes muy rápido. Espera un momento.', 'warn', 2500);
    return;
  }

  const time = Date.now();
  const payload = { type: 'chat', text, time };

  try {
    state.dc.send(JSON.stringify(payload));
  } catch {
    showBanner('No se pudo enviar el mensaje. Comprueba la conexión.', 'danger');
    return;
  }

  state.sentTimestamps.push(time);

  appendChatMessage({ sender: state.localName, text, time, isOwn: true });

  el.inputMessage.value = '';
  autoGrowTextarea();
  stopLocalTyping(); // enviar un mensaje cuenta como dejar de escribir
}

// ---- Indicador de "escribiendo…" (con debounce, sin spamear por tecla) ----
function handleLocalTyping() {
  const hasText = el.inputMessage.value.trim().length > 0;

  if (!state.dc || state.dc.readyState !== 'open') return;

  if (hasText) {
    if (!state.typingActive) {
      state.typingActive = true;
      sendTypingSignal('typing');
    }
    clearTimeout(state.typingStopTimer);
    state.typingStopTimer = setTimeout(stopLocalTyping, CONFIG.TYPING_STOP_DELAY_MS);
  } else {
    stopLocalTyping();
  }
}

function stopLocalTyping() {
  clearTimeout(state.typingStopTimer);
  if (state.typingActive) {
    state.typingActive = false;
    sendTypingSignal('stop-typing');
  }
}

function sendTypingSignal(type) {
  if (state.dc && state.dc.readyState === 'open') {
    try {
      state.dc.send(JSON.stringify({ type }));
    } catch {
      /* si falla, no es crítico */
    }
  }
}

// ============================================================================
// LIMPIEZA AL ABANDONAR
// ============================================================================
function teardownConnection({ notifyPeer } = { notifyPeer: true }) {
  state.intentionalClose = true;

  if (state.dc) {
    try { state.dc.close(); } catch { /* noop */ }
  }
  if (state.pc) {
    try { state.pc.close(); } catch { /* noop */ }
  }
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    try { state.ws.close(); } catch { /* noop */ }
  }

  state.dc = null;
  state.pc = null;
  state.ws = null;
}

window.addEventListener('beforeunload', () => {
  // Mejor esfuerzo: cerrar limpiamente para que el servidor de signaling
  // avise al instante a la otra persona ("peer-left"), en vez de esperar
  // al timeout del heartbeat.
  teardownConnection({ notifyPeer: true });
});
