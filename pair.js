import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pino from 'pino';
import pkg from 'baileyz';
import { fileURLToPath } from 'url';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
} = pkg;

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
    
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    try {
        const socket = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            version: [2, 3000, 1017531202],
            browser: ["Ubuntu", "Chrome", "20.0.0.0"]
        });

        if (!socket.authState.creds.registered) {
            await delay(10000); // Railway Network Fix
            
            try {
                const code = await socket.requestPairingCode(sanitizedNumber);
                if (code && !res.headersSent) {
                    const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                    return res.send({ code: formattedCode });
                }
            } catch (err) {
                if (!res.headersSent) return res.status(500).send({ error: "Code Generation Failed" });
            }
        }

        socket.ev.on('creds.update', saveCreds);

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log(`✅ ${sanitizedNumber} Linked Successfully!`);
            }
        });

    } catch (error) {
        if (!res.headersSent) res.status(500).send({ error: "Internal Error" });
    }
}

// Frontend එකෙන් එන GET request එක හැසිරවීම
router.get('/', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).send({ error: "No number provided" });
    await EmpirePair(number, res);
});

export default router;
