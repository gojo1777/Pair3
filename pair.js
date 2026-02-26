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

    // පරණ session එක සම්පූර්ණයෙන්ම clear කරන්න
    if (activeSessions.has(num)) {
        try {
            activeSessions.get(num).end();
            activeSessions.get(num).ev.removeAllListeners();
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
            // 7.0.0-rc.8 වල පින් එක වැඩ කරන්න මෙන්න මේ Browser details අවශ්‍යමයි
            browser: ["Ubuntu", "Chrome", "110.0.5481.177"], 
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
                console.log(`✅ Connected: ${num}`);
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
                console.log(`❌ Disconnected: ${reason}`);

                // 515 ආවොත් auto restart එකක් වෙනුවට session එක delete කරලා refresh කරන්න ඉඩ දෙන්න
                if (reason === DisconnectReason.loggedOut || reason === 515) {
                    removeFile(sessionDir);
                    activeSessions.delete(num);
                }
            }
        });

        // මූලික ලියාපදිංචිය (Pairing Code)
        if (!sock.authState.creds.registered) {
            // 515 Error එක වළක්වන්න තත්පර 6ක delay එකක් දෙන්න
            await delay(6000); 
            
            try {
                const code = await sock.requestPairingCode(num);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                return res.json({ code: formatted });
            } catch (err) {
                console.error("Pairing Error:", err);
                // පින් එක Generate නොවුණොත් නැවත උත්සාහ කරන්න කියන්න
                return res.status(500).json({ error: "Failed to get code. Refresh and try again." });
            }
        } else {
            return res.json({ message: "Already Logged In" });
        }

    } catch (err) {
        console.error("Server Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
