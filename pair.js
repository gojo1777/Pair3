import express from "express";
import fs from "fs";
import pino from "pino";
import Session from "./models/Session.js";
import pkg from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore, 
    fetchLatestBaileysVersion, 
    DisconnectReason 
} = pkg;

const router = express.Router();
const activeSessions = new Map();

function removeFile(path) {
    try {
        if (fs.existsSync(path)) {
            fs.rmSync(path, { recursive: true, force: true });
        }
    } catch (e) {
        console.error("Remove Error:", e);
    }
}

router.get("/", async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).json({ error: "Phone number required" });

    num = num.replace(/[^0-9]/g, "");
    const phone = pn("+" + num);
    if (!phone.isValid()) return res.status(400).json({ error: "Invalid phone number" });

    num = phone.getNumber("e164").replace("+", "");
    const sessionDir = `./sessions/${num}`;

    if (activeSessions.has(num)) {
        try {
            const oldSock = activeSessions.get(num);
            oldSock.ev.removeAllListeners();
            oldSock.end();
        } catch {}
        activeSessions.delete(num);
    }
    removeFile(sessionDir);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "22.0.0"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        });

        activeSessions.set(num, sock);
        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                console.log(`✅ ${num} connected!`);
                try {
                    await Session.findOneAndUpdate(
                        { number: num },
                        { number: num, creds: state.creds },
                        { upsert: true }
                    );
                } catch (err) {
                    console.error("DB Save Error:", err);
                }
            }

            if (connection === "close") {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ ${num} disconnected. Reason: ${reason}`);
                if (reason === DisconnectReason.loggedOut || reason === 515) {
                    removeFile(sessionDir);
                    activeSessions.delete(num);
                }
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(3000);

            try {
                const code = await sock.requestPairingCode(num);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`🔑 Pairing code for ${num}: ${formatted}`);
                return res.json({ code: formatted });
            } catch (err) {
                console.error("Pairing Error:", err.message);
                removeFile(sessionDir);
                activeSessions.delete(num);
                return res.status(500).json({ error: "Failed to get pairing code: " + err.message });
            }
        } else {
            return res.json({ message: "Already Registered" });
        }

    } catch (err) {
        console.error("Main Error:", err);
        removeFile(sessionDir);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
