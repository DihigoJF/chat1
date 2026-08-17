let socket = null;

let username = null;

const receiver = "PersonaB";


const loginScreen =
    document.querySelector(".login");

const chat =
    document.getElementById("chat");

const usernameInput =
    document.getElementById("username");

const loginButton =
    document.getElementById("loginButton");

const messageInput =
    document.getElementById("messageInput");

const sendButton =
    document.getElementById("sendButton");

const messagesContainer =
    document.getElementById("messages");

const status =
    document.getElementById("status");

const typing =
    document.getElementById("typing");


/*
===========================================
LOGIN
===========================================
*/

loginButton.addEventListener(
    "click",
    connect
);


function connect() {

    username =
        usernameInput.value.trim();


    if (!username) {

        alert(
            "Escribe un nombre"
        );

        return;
    }


    /*
    Crear conexión WebSocket
    */

    socket =
        new WebSocket(
            `ws://${location.host}`
        );


    socket.addEventListener(
        "open",
        () => {

            socket.send(
                JSON.stringify({

                    type: "login",

                    username

                })
            );

        }
    );


    socket.addEventListener(
        "message",
        handleServerMessage
    );


    socket.addEventListener(
        "close",
        () => {

            status.textContent =
                "Desconectado";

        }
    );

}


/*
===========================================
MENSAJES DEL SERVIDOR
===========================================
*/

function handleServerMessage(event) {

    const data =
        JSON.parse(event.data);


    /*
    Login exitoso
    */

    if (
        data.type ===
        "login_success"
    ) {

        loginScreen
            .classList
            .add("hidden");

        chat
            .classList
            .remove("hidden");

        return;
    }


    /*
    Historial
    */

    if (
        data.type ===
        "history"
    ) {

        data.messages.forEach(
            renderMessage
        );

        scrollBottom();

        return;
    }


    /*
    Nuevo mensaje
    */

    if (
        data.type ===
        "message"
    ) {

        renderMessage(
            data.message
        );

        scrollBottom();

        /*
        Marcar como leído
        */

        socket.send(
            JSON.stringify({

                type: "read",

                messageId:
                    data.message.id

            })
        );

        return;
    }


    /*
    Confirmación de envío
    */

    if (
        data.type ===
        "message_sent"
    ) {

        return;
    }


    /*
    Persona escribiendo
    */

    if (
        data.type ===
        "typing"
    ) {

        if(data.typing){

            typing.textContent =
                `${data.username} está escribiendo...`;

        } else {

            typing.textContent =
                "";

        }

        return;
    }


    /*
    Estado
    */

    if (
        data.type ===
        "user_status"
    ) {

        if(
            data.username ===
            receiver
        ) {

            status.textContent =
                data.status ===
                "online"
                ? "En línea"
                : "Desconectado";

        }

        return;
    }

}


/*
===========================================
ENVIAR
===========================================
*/

function sendMessage() {

    const text =
        messageInput.value.trim();


    if (!text)
        return;


    if (
        socket.readyState !==
        WebSocket.OPEN
    ) {

        alert(
            "No estás conectado"
        );

        return;
    }


    socket.send(
        JSON.stringify({

            type: "message",

            receiver,

            text

        })
    );


    messageInput.value = "";

}


/*
===========================================
RENDERIZAR
===========================================
*/

function renderMessage(message) {

    const div =
        document.createElement(
            "div"
        );


    const mine =
        message.sender === username;


    div.className =
        `message ${
            mine
            ? "mine"
            : "theirs"
        }`;


    const date =
        new Date(
            message.time
        );


    div.innerHTML = `

        ${escapeHTML(
            message.text
        )}

        <span class="time">

            ${date.toLocaleTimeString(
                [],
                {
                    hour: "2-digit",
                    minute: "2-digit"
                }
            )}

        </span>

    `;


    /*
    Evitar duplicados
    */

    if (
        document.querySelector(
            `[data-message-id="${message.id}"]`
        )
    ) {

        return;

    }


    div.dataset.messageId =
        message.id;


    messagesContainer.appendChild(
        div
    );

}


/*
===========================================
ENTER
===========================================
*/

messageInput.addEventListener(
    "keydown",
    event => {

        if (
            event.key === "Enter"
        ) {

            event.preventDefault();

            sendMessage();

        }

    }
);


sendButton.addEventListener(
    "click",
    sendMessage
);


/*
===========================================
TYPING
===========================================
*/

let typingTimeout;


messageInput.addEventListener(
    "input",
    () => {

        if (
            socket &&
            socket.readyState ===
            WebSocket.OPEN
        ) {

            socket.send(
                JSON.stringify({

                    type: "typing",

                    receiver,

                    typing: true

                })
            );

        }


        clearTimeout(
            typingTimeout
        );


        typingTimeout =
            setTimeout(() => {

                if (
                    socket &&
                    socket.readyState ===
                    WebSocket.OPEN
                ) {

                    socket.send(
                        JSON.stringify({

                            type: "typing",

                            receiver,

                            typing: false

                        })
                    );

                }

            },800);

    }
);


/*
===========================================
SCROLL
===========================================
*/

function scrollBottom() {

    messagesContainer.scrollTop =
        messagesContainer.scrollHeight;

}


/*
===========================================
SEGURIDAD
===========================================
*/

function escapeHTML(text) {

    const div =
        document.createElement(
            "div"
        );

    div.textContent =
        text;

    return div.innerHTML;

}
