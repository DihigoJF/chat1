const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const escapeHtml = require('escape-html');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configuración de Socket.IO con CORS
const io = new Server(server, {
    cors: {
        // ⚠️ REEMPLAZA con la URL de tu frontend en Netlify (sin barra al final)
        origin: "https://chat-763y.netlify.app",
        methods: ["GET", "POST"]
    }
});

// Servir archivos estáticos (opcional, si quieres que el backend también sirva el frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Estado en memoria
const chatState = {
    users: {},
    messages: [],
    room: 'chat',
    maxUsers: 2,
};

function getConnectedUsers() {
    return Object.values(chatState.users).map(u => u.name);
}

function broadcastState() {
    const userList = getConnectedUsers();
    io.to(chatState.room).emit('user-list', userList);
    io.to(chatState.room).emit('history', chatState.messages);
}

io.on('connection', (socket) => {
    console.log(`Nuevo cliente conectado: ${socket.id}`);

    socket.on('join', (name) => {
        const sanitizedName = escapeHtml(name.trim());
        if (!sanitizedName || sanitizedName.length > 20) {
            socket.emit('join-error', 'Nombre inválido (máximo 20 caracteres y no vacío)');
            return;
        }

        const currentUsers = getConnectedUsers();
        if (currentUsers.length >= chatState.maxUsers) {
            socket.emit('join-error', 'El chat está lleno. Actualmente hay 2 personas conectadas.');
            return;
        }

        if (currentUsers.includes(sanitizedName)) {
            socket.emit('join-error', 'Ese nombre ya está en uso. Elige otro.');
            return;
        }

        chatState.users[socket.id] = { name: sanitizedName, id: socket.id };
        socket.join(chatState.room);

        socket.emit('history', chatState.messages);
        broadcastState();
        socket.emit('join-success', { name: sanitizedName });
    });

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
        if (chatState.messages.length > 100) chatState.messages.shift();

        io.to(chatState.room).emit('new-message', message);
    });

    socket.on('typing', (isTyping) => {
        const user = chatState.users[socket.id];
        if (!user) return;
        socket.to(chatState.room).emit('typing-indicator', {
            name: user.name,
            isTyping: isTyping,
        });
    });

    socket.on('disconnect', (reason) => {
        console.log(`Cliente desconectado: ${socket.id}, razón: ${reason}`);
        const user = chatState.users[socket.id];
        if (user) {
            delete chatState.users[socket.id];
            broadcastState();
            io.to(chatState.room).emit('user-disconnected', user.name);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
