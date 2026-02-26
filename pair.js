import express from "express";
import fs from "fs";
import pino from "pino";
import Session from "./models/Session.js";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";

const router = express.Router();
const activeSessions = new Map();

// පැරණි Session files ඉවත් කිරීමේ function එක
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

    // දැනට එම අංකයෙන් session එකක් තිබේ නම් එය නවත්වන්න
    if (activeSessions.has(num)) {
        try { 
            activeSessions.get(num).ev.removeAllListeners();
            activeSessions.get(num).end(); 
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
            // Pairing code සඳහා මෙන්න මේ browser setting එක අනිවාර්යයි
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
                console.log("✅ Connected:", num);
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
                console.log("❌ Disconnected. Reason:", reason);

                if (reason === DisconnectReason.loggedOut) {
                    removeFile(sessionDir);
                    activeSessions.delete(num);
                } else {
                    // අවශ්‍ය නම් මෙතැනදී auto-reconnect logic එකක් දැමිය හැක
                }
            }
        });

        // Pairing Code එක ඉල්ලීම
        // මෙහිදී 3000ms (තත්පර 3ක) delay එකක් ලබා දෙන්නේ socket එක register වීමට කාලය ලබා දීමටයි
        if (!sock.authState.creds.registered) {
            await delay(3000); 
            try {
                const code = await sock.requestPairingCode(num);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                
                // Code එක ලැබුණු පසු response එක ලබා දේ
                return res.json({ code: formatted });
            } catch (err) {
                console.error("Pairing Request Error:", err);
                return res.status(500).json({ error: "Could not generate code. Please try again." });
            }
        } else {
            return res.json({ message: "Already Registered" });
        }

    } catch (err) {
        console.error("Internal Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
