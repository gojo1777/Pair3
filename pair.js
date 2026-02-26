import express from "express";
import fs from "fs";
import pino from "pino";
import Session from "./models/Session.js";
// ✅ mod-baileys වලදී makeWASocket { } නැතිව default import එකක් ලෙස ගත යුතුය
import makeWASocket, {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason
} from "@whiskeysockets/baileys"; 
import pn from "awesome-phonenumber";

const router = express.Router();
const activeSessions = new Map();

// Session files පිරිසිදු කිරීමේ ශ්‍රිතය
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

    // අංකය Format කර ගැනීම
    num = num.replace(/[^0-9]/g, "");
    const phone = pn("+" + num);

    if (!phone.isValid()) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    num = phone.getNumber("e164").replace("+", "");
    const sessionDir = `./sessions/${num}`;

    // පරණ session එකක් ඇත්නම් එය නවත්වන්න
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
            // Pairing code සඳහා mod-baileys නිර්දේශ කරන browser settings
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
                console.log(`✅ ${num} සම්බන්ධතාවය සාර්ථකයි!`);
                try {
                    await Session.findOneAndUpdate(
                        { number: num },
                        { number: num, creds: state.creds },
                        { upsert: true }
                    );
                } catch (err) {
                    console.error("Database Save Error:", err);
                }
            }

            if (connection === "close") {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ සම්බන්ධතාවය බිඳ වැටුණි: ${reason}`);

                // 515 error එකක් හෝ logout වීමක් සිදුවුවහොත් clear කරන්න
                if (reason === DisconnectReason.loggedOut || reason === 515) {
                    removeFile(sessionDir);
                    activeSessions.delete(num);
                }
            }
        });

        // Pairing Code එක ලබා ගැනීම
        if (!sock.authState.creds.registered) {
            // Railway server වලදී handshake එක සිදු වීමට තත්පර 6ක් රැඳී සිටීම අනිවාර්යයි
            await delay(6000); 
            
            try {
                const code = await sock.requestPairingCode(num);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                
                // සාර්ථකව කේතය ලැබුණු පසු එය ලබා දේ
                return res.json({ code: formatted });
            } catch (err) {
                console.error("Pairing Request Error:", err);
                return res.status(500).json({ error: "කේතය ලබා ගැනීමට නොහැකි විය. කරුණාකර නැවත refresh කරන්න." });
            }
        } else {
            return res.json({ message: "දැනටමත් ලියාපදිංචි වී ඇත." });
        }

    } catch (err) {
        console.error("Internal Server Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
