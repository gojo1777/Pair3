import express from "express";
import fs from "fs";
import pino from "pino";
import Session from "./models/Session.js";
// ✅ dew-baileys සඳහා makeWASocket { } නැතිව import කළ යුතුය
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

/**
 * පැරණි session files ඉවත් කිරීම
 */
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

    // අංකය පිරිසිදු කිරීම සහ Format කිරීම
    num = num.replace(/[^0-9]/g, "");
    const phone = pn("+" + num);

    if (!phone.isValid()) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    num = phone.getNumber("e164").replace("+", "");
    const sessionDir = `./sessions/${num}`;

    // දැනට ක්‍රියාත්මක session එකක් ඇත්නම් එය නවත්වන්න
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
            // Pairing code සාර්ථක වීමට මීට වඩා අලුත් browser fingerprint එකක් භාවිතා කරමු
            browser: ["Chrome (Linux)", "Chrome", "110.0.0"], 
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
                console.log(`✅ ${num} සම්බන්ධතාවය තහවුරු විය!`);
                try {
                    // Mongoose හරහා session එක database එකට සුරැකීම
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
                console.log(`❌ සම්බන්ධතාවය විසන්ධි විය. හේතුව: ${reason}`);

                // 515 (Restart Required) හෝ Logout වූ විට session ඉවත් කරන්න
                if (reason === DisconnectReason.loggedOut || reason === 515) {
                    removeFile(sessionDir);
                    activeSessions.delete(num);
                }
            }
        });

        // Pairing Code ඉල්ලීම
        if (!sock.authState.creds.registered) {
            // Railway server වල handshake එකට වැඩි වෙලාවක් අවශ්‍යයි
            // 515 error එක එන්නේ මේ වෙලාව මදි වූ විටයි
            await delay(8000); 
            
            try {
                const code = await sock.requestPairingCode(num);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                
                // Code එක generate වූ පසු JSON response එක ලබා දේ
                return res.json({ code: formatted });
            } catch (err) {
                console.error("Pairing Error:", err);
                return res.status(500).json({ error: "Code එක ලබා ගැනීමට නොහැකි විය. නැවත refresh කරන්න." });
            }
        } else {
            return res.json({ message: "දැනටමත් Login වී ඇත." });
        }

    } catch (err) {
        console.error("Main Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
