import express from "express";
import fs from "fs";
import pino from "pino";
import Session from "./models/Session.js";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    DisconnectReason
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";

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

    if (!num) {
        return res.status(400).json({ error: "Phone number required" });
    }

    num = num.replace(/[^0-9]/g, "");
    const phone = pn("+" + num);

    if (!phone.isValid()) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    num = phone.getNumber("e164").replace("+", "");

    const sessionDir = `./sessions/${num}`;

    // kill old session
    if (activeSessions.has(num)) {
        try { activeSessions.get(num).end(); } catch {}
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
            browser: Browsers.macOS("Safari"), // ✅ FIXED
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
                console.log("✅ Connected:", num);

                try {
                    await Session.findOneAndUpdate(
                        { number: num },
                        { number: num, creds: state.creds },
                        { upsert: true }
                    );
                    console.log("💾 Session Saved:", num);
                } catch (err) {
                    console.error("DB Save Error:", err);
                }
            }

            if (connection === "close") {
                const reason = lastDisconnect?.error?.output?.statusCode;

                console.log("❌ Disconnected:", reason);

                if (reason !== DisconnectReason.loggedOut) {
                    console.log("🔁 Reconnecting...");
                } else {
                    removeFile(sessionDir);
                }

                activeSessions.delete(num);
            }
        });

        // ✅ FIXED REGISTER CHECK
        if (!state.creds.registered) {
            await delay(5000);

            const code = await sock.requestPairingCode(num);
            const formatted = code?.match(/.{1,4}/g)?.join("-") || code;

            return res.json({ code: formatted });
        }

        return res.json({ message: "Already Registered" });

    } catch (err) {
        console.error("Session Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
