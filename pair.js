import express from "express";
import fs from "fs";
import pino from "pino";
import Session from "./models/Session.js";
import pkg from "@whiskeysockets/baileys"; // මුළු package එකම pkg ලෙස ගන්න
import pn from "awesome-phonenumber";

// මෙතැනදී makeWASocket එක නිවැරදිව වෙන් කර ගනිමු
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

    // පරණ session එකක් තිබේ නම් එය සම්පූර්ණයෙන්ම නවත්වන්න
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

        // 65 වන පේළියේ තිබූ දෝෂය මෙතැනදී විසඳේ
        const sock = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.0.0"], 
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
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
                if (reason === DisconnectReason.loggedOut || reason === 515) {
                    removeFile(sessionDir);
                    activeSessions.delete(num);
                }
            }
        });

        if (!sock.authState.creds.registered) {
            // "Logging in..." හිරවීම වැළැක්වීමට තත්පර 10ක delay එකක් ලබා දෙන්න
            await delay(10000); 
            
            try {
                const code = await sock.requestPairingCode(num);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                return res.json({ code: formatted });
            } catch (err) {
                console.error("Pairing Error:", err);
                return res.status(500).json({ error: "Failed to get pairing code." });
            }
        } else {
            return res.json({ message: "Already Registered" });
        }

    } catch (err) {
        console.error("Main Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
