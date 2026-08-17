// Módulo de conexión con Socket.IO
const Connection = (() => {
    let socket = null;
    let connected = false;

    function init() {
        if (!socket) {
            // AQUÍ: reemplaza con la URL de tu servidor en Render
            const SERVER_URL = 'https://chat-763y.netlify.app/public/'; // ← Cambia esto
            socket = io(SERVER_URL, {
                reconnectionAttempts: 5,
                timeout: 10000,
            });
            socket.on('connect', () => {
                connected = true;
                console.log('Conectado al servidor');
                document.dispatchEvent(new CustomEvent('socket-connected'));
            });
            socket.on('disconnect', (reason) => {
                connected = false;
                console.log('Desconectado del servidor:', reason);
                document.dispatchEvent(new CustomEvent('socket-disconnected', { detail: { reason } }));
            });
            socket.on('connect_error', (err) => {
                console.error('Error de conexión:', err);
                document.dispatchEvent(new CustomEvent('socket-error', { detail: { error: err } }));
            });
        }
        return socket;
    }

    function getSocket() {
        if (!socket) init();
        return socket;
    }

    function isConnected() {
        return connected && socket && socket.connected;
    }

    return {
        init,
        getSocket,
        isConnected,
    };
})();
