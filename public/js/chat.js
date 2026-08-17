// Módulo de chat: maneja la interfaz y eventos de chat
const Chat = (() => {
    let currentUser = '';
    let messages = [];
    let isTyping = false;
    let typingTimeout = null;

    // Elementos DOM
    const loginScreen = document.getElementById('login-screen');
    const chatScreen = document.getElementById('chat-screen');
    const nameInput = document.getElementById('name-input');
    const joinBtn = document.getElementById('join-btn');
    const loginError = document.getElementById('login-error');
    const messagesArea = document.getElementById('messages-area');
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const userListEl = document.getElementById('user-list');
    const typingIndicator = document.getElementById('typing-indicator');
    const leaveBtn = document.getElementById('leave-btn');
    const statusEl = document.getElementById('user-status');

    const socket = Connection.getSocket();

    // Inicializar eventos
    function init() {
        // Eventos de Socket.IO
        socket.on('join-success', (data) => {
            currentUser = data.name;
            showChatScreen();
            // Guardar nombre en sessionStorage
            sessionStorage.setItem('chatUsername', currentUser);
            // Marcar como conectado
            setStatus('online', 'Conectado');
            // Enfocar input
            messageInput.focus();
        });

        socket.on('join-error', (msg) => {
            loginError.textContent = msg;
        });

        socket.on('history', (history) => {
            messages = history || [];
            renderMessages();
        });

        socket.on('new-message', (message) => {
            messages.push(message);
            renderMessages();
            scrollToBottom();
            // Notificación visual opcional
            if (message.name !== currentUser) {
                // Sonido opcional si se desea
                // playSound();
            }
        });

        socket.on('user-list', (users) => {
            renderUserList(users);
        });

        socket.on('user-disconnected', (name) => {
            // No es necesario porque user-list ya se actualiza, pero podemos mostrar un mensaje
        });

        socket.on('typing-indicator', (data) => {
            if (data.name !== currentUser) {
                if (data.isTyping) {
                    typingIndicator.textContent = `${data.name} está escribiendo...`;
                } else {
                    typingIndicator.textContent = '';
                }
            }
        });

        socket.on('disconnect', () => {
            setStatus('offline', 'Desconectado');
        });

        socket.on('connect', () => {
            setStatus('online', 'Conectado');
            // Si ya teníamos un nombre, intentar reingresar
            const storedName = sessionStorage.getItem('chatUsername');
            if (storedName) {
                socket.emit('join', storedName);
            }
        });

        // Eventos UI
        joinBtn.addEventListener('click', handleJoin);
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleJoin();
        });

        sendBtn.addEventListener('click', handleSend);
        messageInput.addEventListener('keydown', handleKeydown);
        messageInput.addEventListener('input', handleTyping);

        leaveBtn.addEventListener('click', handleLeave);

        // Recuperar nombre si existe en sessionStorage
        const stored = sessionStorage.getItem('chatUsername');
        if (stored) {
            nameInput.value = stored;
            // Auto-unirse al cargar si ya estaba en sesión? mejor manual.
        }

        // Si el socket ya está conectado, mostrar estado
        if (Connection.isConnected()) {
            setStatus('online', 'Conectado');
        }

        // Eventos de conexión personalizados (disparados desde connection.js)
        document.addEventListener('socket-connected', () => {
            setStatus('online', 'Conectado');
            // Reintentar unirse si hay nombre almacenado
            const storedName = sessionStorage.getItem('chatUsername');
            if (storedName && !currentUser) {
                socket.emit('join', storedName);
            }
        });

        document.addEventListener('socket-disconnected', () => {
            setStatus('offline', 'Desconectado');
        });

        document.addEventListener('socket-error', () => {
            setStatus('error', 'Error de conexión');
        });
    }

    function handleJoin() {
        const name = nameInput.value.trim();
        if (!name) {
            loginError.textContent = 'El nombre no puede estar vacío.';
            return;
        }
        if (name.length > 20) {
            loginError.textContent = 'El nombre no puede tener más de 20 caracteres.';
            return;
        }
        // Validar caracteres (solo letras, números y espacios)
        if (!/^[a-zA-Z0-9\s]+$/.test(name)) {
            loginError.textContent = 'El nombre solo puede contener letras, números y espacios.';
            return;
        }

        loginError.textContent = '';
        // Emitir join al servidor
        socket.emit('join', name);
    }

    function showChatScreen() {
        loginScreen.style.display = 'none';
        chatScreen.style.display = 'flex';
        // Enfocar input de mensaje
        setTimeout(() => messageInput.focus(), 100);
    }

    function renderMessages() {
        messagesArea.innerHTML = '';
        messages.forEach((msg) => {
            const isOwn = msg.name === currentUser;
            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${isOwn ? 'sent' : 'received'}`;

            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = msg.text;

            const info = document.createElement('div');
            info.className = 'info';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'name';
            nameSpan.textContent = msg.name;
            const timeSpan = document.createElement('span');
            timeSpan.className = 'time';
            const date = new Date(msg.timestamp);
            timeSpan.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            if (isOwn) {
                info.appendChild(timeSpan);
                info.appendChild(nameSpan);
            } else {
                info.appendChild(nameSpan);
                info.appendChild(timeSpan);
            }

            messageDiv.appendChild(bubble);
            messageDiv.appendChild(info);
            messagesArea.appendChild(messageDiv);
        });
        scrollToBottom();
    }

    function renderUserList(users) {
        userListEl.innerHTML = '';
        if (!users || users.length === 0) {
            userListEl.innerHTML = '<span style="color:#999;">Esperando usuarios...</span>';
            return;
        }
        users.forEach((name) => {
            const item = document.createElement('div');
            item.className = 'user-item';
            const avatar = document.createElement('div');
            avatar.className = 'avatar';
            avatar.textContent = name.charAt(0).toUpperCase();
            const nameSpan = document.createElement('span');
            nameSpan.className = 'name';
            nameSpan.textContent = name;
            const dot = document.createElement('span');
            dot.className = `status-dot ${name === currentUser ? 'online' : 'online'}`; // todos los conectados están online
            if (name === currentUser) {
                // resaltar propio
                nameSpan.style.fontWeight = 'bold';
            }
            item.appendChild(avatar);
            item.appendChild(nameSpan);
            item.appendChild(dot);
            userListEl.appendChild(item);
        });
    }

    function setStatus(state, text) {
        const icon = statusEl.querySelector('i');
        if (state === 'online') {
            icon.style.color = '#2ecc71';
            statusEl.innerHTML = `<i class="fas fa-circle" style="color:#2ecc71;"></i> ${text}`;
        } else if (state === 'offline') {
            icon.style.color = '#bdc3c7';
            statusEl.innerHTML = `<i class="fas fa-circle" style="color:#bdc3c7;"></i> ${text}`;
        } else {
            icon.style.color = '#e74c3c';
            statusEl.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#e74c3c;"></i> ${text}`;
        }
    }

    function handleSend() {
        const text = messageInput.value.trim();
        if (!text) return;
        if (text.length > 500) {
            alert('El mensaje no puede superar los 500 caracteres.');
            return;
        }
        // Enviar
        socket.emit('chat-message', { text });
        messageInput.value = '';
        messageInput.style.height = 'auto';
        // Dejar de escribir
        clearTypingTimeout();
        socket.emit('typing', false);
        messageInput.focus();
    }

    function handleKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }

    function handleTyping() {
        const text = messageInput.value;
        if (text.trim().length > 0 && !isTyping) {
            isTyping = true;
            socket.emit('typing', true);
        } else if (text.trim().length === 0 && isTyping) {
            clearTypingTimeout();
            socket.emit('typing', false);
            isTyping = false;
        }
        // Autoajuste de altura
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';

        // Reiniciar timeout para dejar de escribir
        clearTypingTimeout();
        typingTimeout = setTimeout(() => {
            if (isTyping) {
                isTyping = false;
                socket.emit('typing', false);
            }
        }, 1500);
    }

    function clearTypingTimeout() {
        if (typingTimeout) {
            clearTimeout(typingTimeout);
            typingTimeout = null;
        }
    }

    function handleLeave() {
        if (confirm('¿Estás seguro de que quieres abandonar el chat?')) {
            // Desconectar socket y recargar o volver al login
            socket.disconnect();
            // Limpiar sesión
            sessionStorage.removeItem('chatUsername');
            // Recargar página para volver al login
            location.reload();
        }
    }

    function scrollToBottom() {
        messagesArea.scrollTop = messagesArea.scrollHeight;
    }

    // Inicializar
    init();

    return {
        // Exponer si es necesario
    };
})();