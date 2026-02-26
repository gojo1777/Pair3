import express from "express";
import fs from "fs";
import pino from "pino";
import mongoose from "mongoose";
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

    let dirs = "./" + num;
    removeFile(dirs);

    num = num.replace(/[^0-9]/g, "");

    const phone = pn("+" + num);

    if (!phone.isValid()) {
        return res.status(400).send({
            code: "Invalid phone number. Use full international format",
        });
    }

    num = phone.getNumber("e164").replace("+", "");

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
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

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === "open") {
                    console.log("✅ Connected!");

                    try {
                        const credsPath = dirs + "/creds.json";
                        const credsData = JSON.parse(
                            fs.readFileSync(credsPath, "utf-8")
                        );

                        await Session.create({
                            number: num,
                            creds: credsData,
                        });

                        console.log("💾 Session saved to MongoDB");

                        await delay(1000);
                        removeFile(dirs);
                        process.exit(0);

                    } catch (error) {
                        console.error("DB Save Error:", error);
                        removeFile(dirs);
                        process.exit(1);
                    }
                }

                if (connection === "close") {
                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;

                    if (statusCode !== 401) {
                        initiateSession();
                    }
                }
            });

            if (!sock.authState.creds.registered) {
                await delay(3000);

                try {
                    let code = await sock.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;

                    if (!res.headersSent) {
                        res.send({ code });
                    }
                } catch (error) {
                    if (!res.headersSent) {
                        res.status(503).send({
                            code: "Failed to get pairing code",
                        });
                    }
                    process.exit(1);
                }
            }

            sock.ev.on("creds.update", saveCreds);

        } catch (err) {
            console.error("Session Error:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            process.exit(1);
        }
    }

    await initiateSession();
});

export default router;
