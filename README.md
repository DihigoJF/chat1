# Chat Privado — chat en tiempo real para 2 personas (WebRTC, sin base de datos)

Chat 1‑a‑1 en el que los mensajes viajan **directamente entre los dos
navegadores** mediante un `RTCDataChannel` de WebRTC. No hay base de datos,
no hay historial permanente y no hay cuentas: solo un nombre, una sala y una
conversación que vive en la memoria de las dos pestañas mientras dura la
sesión.

```
/chat-privado
│
├── frontend/                 → esto es lo que se publica como sitio estático
│   ├── index.html
│   ├── style.css
│   └── app.js
│
├── signaling-server/          → pequeño servidor Node.js, SOLO para "presentar"
│   ├── server.js               a los dos usuarios entre sí (ver sección 3)
│   └── package.json
│
└── README.md
```

---

## 1. Por qué hace falta un servidor, aunque sea "solo HTML/CSS/JS"

Esto es importante y quiero ser directo: **es técnicamente imposible** que
dos navegadores en dos dispositivos distintos se encuentren el uno al otro
en Internet usando *únicamente* HTML, CSS y JavaScript sin ningún punto de
encuentro externo. Ningún truco de frontend evita esto — no es una
limitación de este proyecto, es cómo funciona Internet: un navegador no
tiene forma de saber la dirección de red del otro navegador ni de "tocarle
la puerta" sin que alguien se lo diga primero.

Esto se llama el **problema del signaling** en WebRTC, y es distinto del
problema de "dónde vive la conversación":

- **Signaling (obligatorio, mínimo):** un tercer punto donde A y B se
  encuentran para intercambiar tres cosas — quién está en la sala, una
  "oferta"/"respuesta" (SDP) y unos "candidatos" de red (ICE). Una vez
  intercambiado esto, el signaling ya no participa en la conversación.
- **Base de datos de mensajes (evitado, como pediste):** un lugar que
  guarde el contenido del chat. Esto **no existe en este proyecto**.

Así que el servidor de `signaling-server/` existe únicamente para el primer
punto. Nunca ve, procesa ni guarda un solo mensaje de chat — eso viaja
después, directo entre los navegadores, por el `RTCDataChannel`.

```
              Signaling (solo coordina el "apretón de manos")
                          │
                ┌─────────┴─────────┐
                │                   │
          Navegador A  ← WebRTC → Navegador B
                │                   │
                └──── mensajes ─────┘
                 (P2P, cifrado por DTLS,
                  nunca pasa por el servidor)
```

Cualquier sistema que te prometa un chat "real" entre dos dispositivos sin
absolutamente ningún componente de servidor está, en el mejor de los casos,
simulando la conversación dentro de una sola pestaña (justo lo que pediste
evitar en el punto 3 de tu brief). Este proyecto no hace eso.

---

## 2. Tecnologías usadas y por qué

| Pieza | Tecnología | Por qué |
|---|---|---|
| Interfaz | HTML5 + CSS3 + JS vanilla | Pedido explícitamente, sin frameworks pesados |
| Transporte de mensajes | `RTCDataChannel` (WebRTC) | P2P real, cifrado por DTLS, sin pasar por un servidor de mensajes |
| Signaling | WebSocket + Node.js (`ws`) | Es la forma más simple y ligera de coordinar 2 sockets; no usa ninguna base de datos, solo un `Map` en memoria |
| NAT traversal | STUN público de Google | Necesario para que dos navegadores detrás de routers distintos encuentren su ruta directa |

No se usa React/Vue/Angular porque la interfaz (login + lista de mensajes +
composer) no lo necesita — vanilla JS con manipulación directa del DOM es
más ligero y más fácil de mantener aquí.

---

## 3. El servidor de signaling — qué hace exactamente

`signaling-server/server.js` es un servidor WebSocket de ~150 líneas.
Todo su estado vive en un `Map` de JavaScript en memoria (`rooms`), nunca en
disco ni en una base de datos:

1. **`join`** — el cliente manda su nombre y, opcionalmente, un código de
   sala. El servidor comprueba cuántas personas hay ya en esa sala:
   - 0 personas → lo añade y le dice "espera, eres el primero".
   - 1 persona → lo añade y le dice "tú vas a iniciar la conexión", y avisa
     al primero de que ya llegó alguien.
   - 2 personas → responde `room-full` y cierra la conexión. **No se
     admite un tercer usuario, nunca.**
2. **`signal`** — reenvía la oferta/respuesta SDP y los candidatos ICE al
   otro participante de la sala, tal cual, sin abrirlos ni guardarlos.
3. Cuando un socket se cierra, avisa al otro participante (`peer-left`) y
   libera la sala. Si la sala queda vacía, se borra del `Map`.

El servidor de signaling se queda abierto durante toda la sesión (no solo
durante el "apretón de manos" inicial) por un motivo concreto: así puede
avisar **al instante** cuando el otro usuario cierra la pestaña, en vez de
depender solo de los tiempos de espera de WebRTC. Sigue sin tocar el
contenido de los mensajes en ningún momento.

---

## 4. Cómo se conectan A y B, paso a paso

1. **Pedro** abre `index.html`, escribe "Pedro", pulsa "Entrar al chat".
   El navegador abre un WebSocket hacia el servidor de signaling y manda
   `{ type: "join", name: "Pedro" }`.
2. El servidor no tiene a nadie más en la sala → responde a Pedro
   `{ type: "joined", isInitiator: false }`. Pantalla: *"Esperando al otro
   usuario…"*.
3. **Carlos**, desde otro dispositivo, abre el mismo `index.html`, escribe
   "Carlos", entra. Manda `join`. El servidor ve que Pedro ya está →
   responde a Carlos `{ type: "joined", isInitiator: true, peerName:
   "Pedro" }` y avisa a Pedro `{ type: "peer-joined", peerName: "Carlos" }`.
4. Como Carlos es `isInitiator: true`, su navegador crea un
   `RTCPeerConnection`, crea el `RTCDataChannel` ("chat") y genera una
   oferta SDP, que envía al servidor con `{ type: "signal", payload: {
   kind: "offer", sdp: ... } }`.
5. El servidor reenvía esa oferta a Pedro. El navegador de Pedro crea su
   propio `RTCPeerConnection`, aplica la oferta, genera una respuesta SDP y
   la devuelve por el mismo camino.
6. Mientras tanto, ambos navegadores van descubriendo rutas de red
   (candidatos ICE) y se los intercambian por el mismo canal de signaling.
7. En cuanto ambos lados encuentran una ruta viable, WebRTC abre la
   conexión DTLS/SCTP directa y el `RTCDataChannel` pasa a estado `open` en
   los dos navegadores. **A partir de aquí, cada mensaje que escriban viaja
   directo entre los dos navegadores.**

## 5. Identificación de usuarios

Cada cliente genera, del lado del servidor, un `clientId` temporal
(`crypto.randomUUID()`) solo para saber "a cuál de los dos sockets de esta
sala le reenvío este mensaje de signaling". No hay cuentas, ni contraseñas,
ni ningún identificador persistente entre sesiones: al recargar la página,
Pedro vuelve a ser un cliente completamente nuevo.

## 6. Envío y recepción de mensajes

Una vez abierto el `RTCDataChannel`:

- **Enviar:** `dc.send(JSON.stringify({ type: "chat", text, time }))`. El
  remitente añade el mensaje a su propia lista localmente (no espera al
  peer para verlo).
- **Recibir:** el evento `message` del canal recibe ese JSON, se valida y
  se pinta en el DOM usando `textContent` (nunca `innerHTML`), lo que hace
  imposible una inyección de HTML/XSS incluso si alguien intentara mandar
  `<script>` como "mensaje".

El indicador de "escribiendo…" y el fin del envío al pulsar Enter también
viajan por el mismo canal, con un pequeño *debounce*: no se manda un evento
por cada tecla, solo al empezar a escribir y al detenerse (o tras 1.2s de
silencio).

## 7. Detección de desconexión

Se usan dos señales en paralelo, para que la interfaz reaccione lo antes
posible pase lo que pase:

- **`RTCPeerConnection.connectionState`** cambia a `disconnected` /
  `failed` cuando la ruta P2P se rompe (el otro cerró la pestaña, perdió
  la red, etc.).
- **El WebSocket de signaling**, que sigue abierto, recibe `peer-left` en
  cuanto el socket del otro usuario se cierra — esto suele llegar más
  rápido que el timeout de WebRTC.

Cualquiera de las dos señales desactiva el composer y muestra "Carlos se ha
desconectado."

## 8. Por qué la sala se limita a exactamente 2 personas

El servidor comprueba `room.clients.size >= 2` **antes** de aceptar un
`join`. Como Node.js procesa cada mensaje entrante de forma síncrona (no
hay await entre la comprobación y la inserción en el `Map`), no existe
condición de carrera aunque dos personas intenten entrar en el mismo
instante: el tercer intento siempre recibe `room-full` y su conexión se
cierra inmediatamente.

## 9. Por qué no hay base de datos

Porque no hace falta ninguna: los mensajes solo necesitan llegar del
navegador A al navegador B, no persistir en ningún sitio. Guardarlos habría
significado montar un backend adicional (con sus propios riesgos de
privacidad) para un requisito que explícitamente no pediste. Todo el estado
de la conversación vive en un array de JavaScript en la pestaña de cada
usuario y desaparece al recargar o cerrar la página — tal como pediste en
el punto 17.

---

## 10. Ejecutarlo en local

**Requisito:** Node.js 18+ instalado (solo para el servidor de signaling;
el frontend no necesita build ni Node para funcionar).

```bash
# 1. Arranca el servidor de signaling
cd signaling-server
npm install
npm start
# → "Servidor de signaling escuchando en el puerto 8080"

# 2. En otra terminal, sirve el frontend como archivos estáticos
cd frontend
python3 -m http.server 5500
# (cualquier servidor estático vale: npx serve, Live Server de VSCode, etc.
#  Importante: abre esto en http://localhost:5500, no con doble clic sobre
#  el archivo file://, porque WebSocket/WebRTC necesitan un origen http(s).)
```

Abre `http://localhost:5500` en dos pestañas (o dos navegadores)
distintos, escribe un nombre distinto en cada una, y deberían conectarse
entre sí en segundos.

`app.js` ya detecta `localhost` automáticamente y apunta al signaling en
`ws://localhost:8080` sin que tengas que tocar nada.

---

## 11. HTTPS: cuándo hace falta y por qué

Este es el punto donde muchos tutoriales de WebRTC son poco honestos, así
que te doy la respuesta completa:

- **`RTCPeerConnection` solo funciona en un "contexto seguro"** (secure
  context) en todos los navegadores modernos: eso significa `https://` **o
  bien** `http://localhost` / `http://127.0.0.1`. Fuera de esos dos casos,
  el propio objeto `RTCPeerConnection` puede no estar disponible o lanzar
  errores de seguridad.
- **Probar en un único ordenador (dos pestañas o dos navegadores) sobre
  `http://localhost`** — funciona sin HTTPS, porque `localhost` cuenta
  como contexto seguro.
- **Probar entre dos dispositivos físicos distintos** (dos ordenadores, o
  PC + móvil) **sí necesita HTTPS**, incluso en tu propia red local. Abrir
  `http://192.168.1.23:5500` desde el móvil casi seguro fallará al crear
  la conexión WebRTC.

Opciones para probar entre dos dispositivos reales sin publicar nada
todavía:

- Un túnel HTTPS temporal hacia tu servidor local, por ejemplo `ngrok
  http 5500` o `cloudflared tunnel --url http://localhost:5500` — te dan
  una URL `https://...` pública en segundos.
- Certificados locales con [mkcert](https://github.com/FiloSottile/mkcert)
  si prefieres quedarte en tu red local con HTTPS de verdad.
- O, más simple: publicarlo ya (siguiente sección) y probar directamente
  desde la URL final.

El servidor de signaling también debe usar `wss://` (WebSocket seguro)
cuando el frontend se sirve por HTTPS — los navegadores bloquean mezclar
una página `https://` con un WebSocket `ws://` sin cifrar. La mayoría de
hostings para Node (Render, Railway, Fly.io…) te dan `wss://` automático.

---

## 12. Publicarlo

El **frontend** (`frontend/`) es HTML/CSS/JS puro: se puede publicar en
*cualquier* hosting de archivos estáticos — GitHub Pages, Netlify, Vercel,
Cloudflare Pages, un bucket S3 con hosting estático, etc. Todos te dan
HTTPS automáticamente, lo cual resuelve el punto anterior.

El **servidor de signaling** (`signaling-server/`) sí necesita un sitio
que ejecute procesos Node.js de larga duración con soporte de WebSocket
(no vale un hosting solo-estático). Opciones sencillas y con capa
gratuita: Render, Railway, Fly.io, un VPS pequeño con `pm2`, etc. Lo único
que se despliega ahí es ese único archivo `server.js` — no hay base de
datos que provisionar ni variables de entorno más allá del puerto.

Pasos:

1. Despliega `signaling-server/` en el hosting Node que elijas. Anota la
   URL, por ejemplo `wss://mi-chat-signaling.onrender.com`.
2. Edita `frontend/app.js`, en `CONFIG.SIGNALING_URL`, y sustituye la línea
   marcada con `⚠️` por esa URL `wss://`.
3. Sube `frontend/` (tal cual, sin build) a tu hosting estático.
4. Abre la URL pública desde dos dispositivos distintos.

No hace falta backend completo, no hace falta sistema de usuarios: es
literalmente un archivo estático + un proceso Node de ~150 líneas.

---

## 13. Pruebas sugeridas

| # | Prueba | Cómo |
|---|---|---|
| 1 | Dos navegadores distintos | Abre Chrome y Firefox en el mismo PC, entra con nombres distintos |
| 2 | Dos ordenadores | Publica (sección 12) o usa un túnel HTTPS (sección 11) y abre desde dos máquinas |
| 3 | PC y teléfono | Igual que la anterior, uno de los dos dispositivos es un móvil |
| 4 | Mensaje A → B | Escribe en la primera pestaña, comprueba que aparece en la segunda con nombre y hora |
| 5 | Mensaje B → A | Igual, en sentido contrario |
| 6 | Detección de cierre | Cierra una pestaña/navegador y comprueba que la otra muestra "…se ha desconectado" en pocos segundos |
| 7 | Tercer usuario | Con una sala ya llena (2 personas), abre una tercera pestaña con el mismo código de sala y comprueba el mensaje "Esta sala ya está llena." |
| 8 | Escribiendo… | Empieza a escribir en una pestaña sin enviar y comprueba que la otra muestra el indicador, y que desaparece al parar |

---

## 14. Seguridad y limitaciones — honestidad ante todo

Lo que sí cubre este proyecto:

- Todo el texto se pinta con `textContent`, nunca `innerHTML` → sin XSS por
  mensajes ni por nombres.
- Nombres y mensajes se recortan a una longitud máxima (24 y 2000
  caracteres) tanto en el formulario como al recibir datos por el
  `DataChannel`, por si un cliente modificado intentara saltarse la UI.
- Límite de frecuencia de envío en el propio emisor (máx. 5 mensajes cada 3
  segundos) para evitar que un uso normal se convierta en spam accidental.
- El código de sala solo admite letras, números, `-` y `_`.
- El transporte WebRTC va cifrado por DTLS de forma nativa del navegador
  (no es algo que este proyecto añada, es parte del estándar).

Lo que **no** puede cubrir esta arquitectura, y hay que decirlo claramente:

- Al no existir ningún servidor que vea el contenido de los mensajes, **no
  es posible moderar ni limitar server-side lo que un cliente
  técnicamente modificado envíe por el `DataChannel`** (por ejemplo, saltarse
  el límite de longitud llamando directamente a las APIs del navegador).
  Es un límite inherente a un diseño 100% P2P sin backend de mensajes —
  añadir esa protección exigiría un servidor que sí procese cada mensaje,
  justo lo que pediste evitar.
- En redes muy restrictivas (algunas corporativas, o operadores móviles con
  NAT simétrico agresivo) los servidores STUN públicos no bastan para
  encontrar una ruta directa, y WebRTC necesitaría además un servidor
  **TURN** (que retransmite el tráfico cuando no hay ruta directa posible).
  Este proyecto no incluye TURN porque exigiría infraestructura de servidor
  con más coste — si en tus pruebas dos dispositivos concretos no logran
  conectar, esa suele ser la causa.
- `beforeunload` es "mejor esfuerzo": la mayoría de navegadores lo disparan
  al cerrar una pestaña, pero no está garantizado al 100% (sobre todo en
  móvil). Por eso el servidor de signaling también hace *heartbeat* cada 30s
  para limpiar sesiones muertas aunque ese evento no llegue.
