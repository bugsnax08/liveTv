"use strict";
//creta a simple socket server
Object.defineProperty(exports, "__esModule", { value: true });
const socket_io_1 = require("socket.io");
const io = new socket_io_1.Server(3008);
io.on("connection", (socket) => {
    console.log("a user connected");
    socket.on("message", (message) => {
        console.log(message);
    });
    socket.on("disconnect", () => {
        console.log("a user disconnected");
    });
});
io.listen(3008);
