const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const escapeHtml = require('escape-html');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir archivos estáticos desde 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Estado en memoria
const chatState = {
  // usuarios: { socketId: { name, id } }
  users: {},
  // mensajes: [ { name, text, timestamp } ]
  messages: [],
  // sala actual (solo una sala)
  room: 'chat',
  // límite de usuarios
  maxUsers: 2,
};

// Función para obtener los nombres de los usuarios conectados
function getConnectedUsers() {
  return Object.values(chatState.users).map(u => u.name);
}

// Función para enviar el estado actual a todos en la sala
function broadcastState() {
  const userList = getConnectedUsers();
  io.to(chatState.room).emit('user-list', userList);
  io.to(chatState.room).emit('history', chatState.messages);
}

io.on('connection', (socket) => {
  console.log(`Nuevo cliente conectado: ${socket.id}`);

  // Unirse al chat (se ejecuta cuando el cliente envía 'join')
  socket.on('join', (name) => {
    // Sanitizar nombre
    const sanitizedName = escapeHtml(name.trim());
    if (!sanitizedName || sanitizedName.length > 20) {
      socket.emit('join-error', 'Nombre inválido (máximo 20 caracteres y no vacío)');
      return;
    }

    // Verificar si ya hay 2 usuarios
    const currentUsers = getConnectedUsers();
    if (currentUsers.length >= chatState.maxUsers) {
      socket.emit('join-error', 'El chat está lleno. Actualmente hay 2 personas conectadas.');
      return;
    }

    // Verificar si el nombre ya está en uso (opcional)
    if (currentUsers.includes(sanitizedName)) {
      socket.emit('join-error', 'Ese nombre ya está en uso. Elige otro.');
      return;
    }

    // Guardar usuario
    chatState.users[socket.id] = { name: sanitizedName, id: socket.id };
    socket.join(chatState.room);

    // Enviar historial al nuevo usuario
    socket.emit('history', chatState.messages);

    // Notificar a todos los usuarios en la sala sobre la nueva lista
    broadcastState();

    // Notificar al nuevo usuario que el join fue exitoso
    socket.emit('join-success', { name: sanitizedName });

    // Enviar el estado de conexión de los demás (por si acaso)
    // Se maneja con user-list y presence
  });

  // Manejar mensaje
  socket.on('chat-message', (data) => {
    const user = chatState.users[socket.id];
    if (!user) {
      socket.emit('error', 'No estás autenticado en el chat.');
      return;
    }

    const text = escapeHtml(data.text.trim());
    if (!text || text.length > 500) {
      socket.emit('error', 'Mensaje vacío o demasiado largo (máx 500 caracteres)');
      return;
    }

    const message = {
      name: user.name,
      text: text,
      timestamp: new Date().toISOString(),
    };

    chatState.messages.push(message);
    // Limitar historial a 100 mensajes para evitar memoria infinita
    if (chatState.messages.length > 100) {
      chatState.messages.shift();
    }

    // Emitir a todos en la sala (incluido el emisor)
    io.to(chatState.room).emit('new-message', message);
  });

  // Indicador de escritura
  socket.on('typing', (isTyping) => {
    const user = chatState.users[socket.id];
    if (!user) return;
    // Enviar a los demás
    socket.to(chatState.room).emit('typing-indicator', {
      name: user.name,
      isTyping: isTyping,
    });
  });

  // Desconexión
  socket.on('disconnect', (reason) => {
    console.log(`Cliente desconectado: ${socket.id}, razón: ${reason}`);
    const user = chatState.users[socket.id];
    if (user) {
      delete chatState.users[socket.id];
      // Notificar a los demás que el usuario se fue
      broadcastState();
      // Opcional: emitir un evento de usuario desconectado
      io.to(chatState.room).emit('user-disconnected', user.name);
    }
  });

  // Manejar reconexión: Socket.IO ya intenta reconectar automáticamente,
  // pero podemos enviar el estado actual al reconectar.
  // La lógica de join se vuelve a ejecutar cuando el cliente emite 'join' nuevamente.
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});