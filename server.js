const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 3000;

const server = http.createServer((req, res) => {

    let filePath;

    if (req.url === "/") {
        filePath = path.join(__dirname, "public", "index.html");
    } else {
        filePath = path.join(__dirname, "public", req.url);
    }

    if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
    }

    const ext = path.extname(filePath);

    const contentTypes = {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript"
    };

    res.writeHead(200, {
        "Content-Type":
            contentTypes[ext] || "text/plain"
    });

    fs.createReadStream(filePath).pipe(res);
});


const wss = new WebSocket.Server({
    server
});


const users = new Map();

const messages = [];


function sendToUser(username, data) {

    const socket = users.get(username);

    if (
        socket &&
        socket.readyState === WebSocket.OPEN
    ) {
        socket.send(
            JSON.stringify(data)
        );
    }
}


function broadcast(data) {

    const message =
        JSON.stringify(data);

    wss.clients.forEach(client => {

        if (
            client.readyState === WebSocket.OPEN
        ) {
            client.send(message);
        }

    });
}


wss.on("connection", socket => {

    console.log("Nueva conexión");


    socket.on("message", raw => {

        let data;

        try {

            data =
                JSON.parse(raw.toString());

        } catch {

            return;

        }


        /*
        ==========================================
        LOGIN
        ==========================================
        */

        if (data.type === "login") {

            const username =
                data.username;

            if (!username)
                return;


            users.set(
                username,
                socket
            );


            socket.username =
                username;


            socket.send(
                JSON.stringify({
                    type: "login_success",
                    username
                })
            );


            /*
            Enviar historial
            */

            socket.send(
                JSON.stringify({
                    type: "history",
                    messages
                })
            );


            /*
            Avisar que está online
            */

            broadcast({

                type: "user_status",

                username,

                status: "online"

            });


            return;
        }


        /*
        ==========================================
        MENSAJE
        ==========================================
        */

        if (data.type === "message") {

            if (!socket.username)
                return;


            const message = {

                id:
                    Date.now() +
                    "-" +
                    Math.random()
                        .toString(36)
                        .substring(2),

                sender:
                    socket.username,

                receiver:
                    data.receiver,

                text:
                    data.text,

                time:
                    new Date().toISOString(),

                status:
                    "sent"

            };


            messages.push(message);


            /*
            Enviar al receptor
            */

            sendToUser(
                data.receiver,
                {
                    type: "message",
                    message
                }
            );


            /*
            Confirmar al emisor
            */

            socket.send(
                JSON.stringify({
                    type: "message_sent",
                    message
                })
            );


            return;
        }


        /*
        ==========================================
        ESCRIBIENDO
        ==========================================
        */

        if (data.type === "typing") {

            sendToUser(
                data.receiver,
                {
                    type: "typing",
                    username:
                        socket.username,
                    typing:
                        data.typing
                }
            );


            return;
        }


        /*
        ==========================================
        LEÍDO
        ==========================================
        */

        if (data.type === "read") {

            const message =
                messages.find(
                    m => m.id === data.messageId
                );


            if (!message)
                return;


            message.status =
                "read";


            sendToUser(
                message.sender,
                {
                    type: "message_read",
                    messageId:
                        message.id
                }
            );


            return;
        }

    });


    /*
    ==========================================
    DESCONECCIÓN
    ==========================================
    */

    socket.on("close", () => {

        if (!socket.username)
            return;


        users.delete(
            socket.username
        );


        broadcast({

            type: "user_status",

            username:
                socket.username,

            status: "offline"

        });


        console.log(
            socket.username,
            "se desconectó"
        );

    });

});


server.listen(
    PORT,
    () => {

        console.log(
            `Servidor ejecutándose en http://localhost:${PORT}`
        );

    }
);
