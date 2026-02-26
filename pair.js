import express from "express";
import fs from "fs";
import pino from "pino";
import Session from "./models/Session.js";
import makeWASocket, {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason
} from "@whiskeysockets/baileys"; // mod-baileys හරහා import වේ
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

    if (activeSessions.has(num)) {
        try {
            activeSessions.get(num).logout();
            activeSessions.get(num).ev.removeAllListeners();
        } catch {}
        activeSessions.delete(num);
    }
    removeFile(sessionDir);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        // mod-baileys සඳහා නිර්දේශිත settings
        const sock = makeWASocket({
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            // mod-baileys හි pairing සඳහා වඩාත් සුදුසු browser configuration එක
            browser: ['Ubuntu', 'Chrome', '20.00.1'], 
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
                console.log(`✅ ${num} ලොගින් විය!`);
                try {
                    await Session.findOneAndUpdate(
                        { number: num },
                        { number: num, creds: state.creds },
                        { upsert: true }
                    );
                } catch (err) {
                    console.error("DB Error:", err);
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

        // Pairing Code Logic
        if (!sock.authState.creds.registered) {
            // Socket එක stable වීමට තත්පර 5ක් ලබා දෙන්න
            await delay(5000); 
            
            try {
                // mod-baileys හි ඇති විශේෂත්වය: ඔබට අවශ්‍ය නම් custom code එකක් දිය හැක (උදා: "MYBOT001")
                // දැනට default code එක ලබා ගැනීමට:
                const code = await sock.requestPairingCode(num);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                
                return res.json({ code: formatted });
            } catch (err) {
                console.error("Pairing Error:", err);
                return res.status(500).json({ error: "කේතය ලබා ගැනීමට අපොහොසත් විය. නැවත උත්සාහ කරන්න." });
            }
        } else {
            return res.json({ message: "දැනටමත් ලොගින් වී ඇත." });
        }

    } catch (err) {
        console.error("Main Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
