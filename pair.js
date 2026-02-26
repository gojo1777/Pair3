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
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";

const router = express.Router();
const activeSessions = new Map();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

router.get("/", async (req, res) => {
    let num = req.query.number;

    if (!num) {
        return res.status(400).send({ code: "Phone number is required" });
    }

    num = num.replace(/[^0-9]/g, "");

    const phone = pn("+" + num);
    if (!phone.isValid()) {
        return res.status(400).send({
            code: "Invalid phone number. Use full international format",
        });
    }

    num = phone.getNumber("e164").replace("+", "");

    if (activeSessions.has(num)) {
        try { activeSessions.get(num).end(); } catch (_) {}
        activeSessions.delete(num);
    }

    const dirs = `/tmp/wa_${num}`;
    removeFile(dirs);

    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            res.status(504).send({ code: "Pairing code request timed out" });
        }
        cleanup();
    }, 60000);

    function cleanup() {
        clearTimeout(timeout);
        removeFile(dirs);
        if (activeSessions.has(num)) {
            try { activeSessions.get(num).end(); } catch (_) {}
            activeSessions.delete(num);
        }
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    pino({ level: "fatal" })
                ),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }),
            browser: Browsers.windows("Chrome"),
        });

        activeSessions.set(num, sock);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                console.log(`✅ Connected: ${num}`);
                try {
                    const credsPath = `${dirs}/creds.json`;
                    const credsData = JSON.parse(fs.readFileSync(credsPath, "utf-8"));

                    await Session.findOneAndUpdate(
                        { number: num },
                        { number: num, creds: credsData },
                        { upsert: true, new: true }
                    );

                    console.log(`💾 Session saved: ${num}`);
                } catch (error) {
                    console.error("DB Save Error:", error);
                } finally {
                    await delay(1000);
                    cleanup();
                }
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 Disconnected [${num}]: ${statusCode}`);
                if (!res.headersSent) {
                    res.status(503).send({ code: "Connection closed unexpectedly" });
                }
                cleanup();
            }
        });

        sock.ev.on("creds.update", saveCreds);

        if (!sock.authState.creds.registered) {
            await delay(3000);
            try {
                let code = await sock.requestPairingCode(num);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                clearTimeout(timeout);
                if (!res.headersSent) {
                    res.send({ code });
                }
            } catch (error) {
                console.error("Pairing code error:", error);
                if (!res.headersSent) {
                    res.status(503).send({ code: "Failed to get pairing code" });
                }
                cleanup();
            }
        }

    } catch (err) {
        console.error("Session Error:", err);
        clearTimeout(timeout);
        if (!res.headersSent) {
            res.status(503).send({ code: "Service Unavailable" });
        }
        cleanup();
    }
});

export default router;
