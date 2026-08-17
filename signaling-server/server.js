/**
 * server.js — Servidor de SEÑALIZACIÓN (signaling) para Chat Privado WebRTC
 * ---------------------------------------------------------------------------
 * QUÉ HACE:
 *   - Permite que dos navegadores se encuentren y se intercambien la
 *     información necesaria (SDP offer/answer + candidatos ICE) para abrir
 *     una conexión WebRTC DIRECTA entre ellos (RTCDataChannel).
 *   - Limita cada "sala" a exactamente 2 personas. Un tercer intento de
 *     entrar recibe el mensaje "room-full" y la conexión se cierra.
 *   - Avisa al otro participante cuando alguien se desconecta.
 *
 * QUÉ NO HACE (a propósito):
 *   - NO guarda mensajes de chat. El contenido de los mensajes JAMÁS pasa
 *     por este servidor: viaja directamente entre los dos navegadores a
 *     través del RTCDataChannel una vez que la conexión está establecida.
 *   - NO usa base de datos. Todo el estado (qué salas existen, quién está
 *     en cada una) vive únicamente en un objeto de JavaScript en memoria
 *     (el Map `rooms`). Si el proceso se reinicia, todo ese estado
 *     desaparece — y no pasa nada, porque no es información que deba
 *     persistir.
 *   - NO tiene cuentas, contraseñas ni base de datos de usuarios.
 *
 * POR QUÉ ES NECESARIO A PESAR DE "SOLO HTML/CSS/JS":
 *   Dos pestañas de navegador en dos dispositivos distintos no tienen
 *   ninguna forma de encontrarse entre sí sin un tercer punto de encuentro
 *   en Internet (esto se llama el "problema del signaling" en WebRTC).
 *   Este servidor es exactamente ese punto de encuentro: un simple cartero
 *   que reenvía sobres cerrados (SDP/ICE) de un navegador a otro. Nunca
 *   abre esos sobres, y en cuanto entrega el último, su trabajo termina.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// Límites básicos anti-abuso (no hay base de datos, pero sí validación).
const MAX_NAME_LENGTH = 24;
const MAX_ROOM_ID_LENGTH = 64;
const MAX_SIGNAL_PAYLOAD_BYTES = 8000; // SDP/ICE candidates son pequeños; esto es margen de sobra.

/**
 * Estado en memoria. Estructura:
 * rooms: Map<roomId, { clients: Map<clientId, ws> }>
 * Cada room admite como máximo 2 clientes. No se guarda ningún mensaje aquí,
 * solo qué sockets pertenecen a qué sala para poder reenviarles el signaling.
 */
const rooms = new Map();

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { clients: new Map() };
    rooms.set(roomId, room);
  }
  return room;
}

function otherClient(room, selfId) {
  for (const [id, ws] of room.clients) {
    if (id !== selfId) return { id, ws };
  }
  return null;
}

function cleanupClient(ws) {
  const { roomId, clientId, name } = ws.meta || {};
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.clients.delete(clientId);

  // Avisa al compañero restante (si lo hay) de que esta persona se fue.
  const remaining = otherClient(room, clientId);
  if (remaining) {
    safeSend(remaining.ws, { type: 'peer-left', name: name || 'El otro usuario' });
  }

  // Si la sala quedó vacía, se elimina del mapa (nada que conservar).
  if (room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

function isValidRoomId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ROOM_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(id);
}

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

const server = http.createServer((req, res) => {
  // Endpoint mínimo de salud, útil para comprobar que el servidor de
  // signaling está vivo cuando lo publiques en un hosting.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Servidor de signaling de Chat Privado. Este servidor no sirve el frontend, solo coordina conexiones WebRTC.');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.meta = null; // { roomId, clientId, name } una vez que hace "join"
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // Mensaje inválido, se ignora silenciosamente.
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        if (ws.meta) return; // Ya se unió antes, ignorar doble join.

        const roomId = isValidRoomId(msg.roomId) ? msg.roomId : 'default';
        const name = sanitizeName(msg.name);
        if (!name) {
          safeSend(ws, { type: 'error', message: 'Nombre inválido.' });
          return;
        }

        const room = getOrCreateRoom(roomId);

        if (room.clients.size >= 2) {
          safeSend(ws, { type: 'room-full' });
          ws.close(1000, 'room-full');
          return;
        }

        const clientId = crypto.randomUUID();
        ws.meta = { roomId, clientId, name };
        room.clients.set(clientId, ws);

        const existing = otherClient(room, clientId);

        // Al segundo en llegar se le indica que él es quien debe iniciar
        // la oferta WebRTC, porque ya sabe con certeza que hay un peer.
        safeSend(ws, {
          type: 'joined',
          clientId,
          isInitiator: !!existing,
          peerName: existing ? existing.ws.meta.name : null,
        });

        if (existing) {
          safeSend(existing.ws, { type: 'peer-joined', peerName: name });
        }
        break;
      }

      case 'signal': {
        // Reenvía SDP offer/answer o candidatos ICE al otro participante,
        // sin inspeccionar ni almacenar el contenido más allá de este reenvío.
        if (!ws.meta) return;
        const room = rooms.get(ws.meta.roomId);
        if (!room) return;

        const payloadSize = JSON.stringify(msg.payload || {}).length;
        if (payloadSize > MAX_SIGNAL_PAYLOAD_BYTES) return;

        const target = otherClient(room, ws.meta.clientId);
        if (target) {
          safeSend(target.ws, { type: 'signal', payload: msg.payload });
        }
        break;
      }

      default:
        break; // Tipos desconocidos se ignoran.
    }
  });

  ws.on('close', () => cleanupClient(ws));
  ws.on('error', () => cleanupClient(ws));
});

// Ping periódico para detectar conexiones muertas (p. ej. el portátil se
// suspendió) y limpiar la sala aunque el evento 'close' no llegue a tiempo.
const HEARTBEAT_MS = 30000;
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      cleanupClient(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`Servidor de signaling escuchando en el puerto ${PORT}`);
});
