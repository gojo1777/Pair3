import express from 'express';
import fs from 'fs'; // බාහිර පැකේජ අවශ්‍ය නොවේ
import path from 'path';
import os from 'os';
import pino from 'pino';
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'url';

// ඔබේ package.json හි ඇති 'baileyz' භාවිතා කිරීම
import pkg from 'baileyz';
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    DisconnectReason
} = pkg;

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- MONGO SETUP ----------------
// ඔබේ MongoDB URL එක මෙහි ඇත
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://malvintech11_db_user:0SBgxRy7WsQZ1KTq@cluster0.xqgaovj.mongodb.net/?appName=Cluster0';
const MONGO_DB = process.env.MONGO_DB || 'Free_Mini';

let mongoClient, mongoDB, sessionsCol;

async function initMongo() {
    try {
        if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected()) return;
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        mongoDB = mongoClient.db(MONGO_DB);
        sessionsCol = mongoDB.collection('sessions');
        console.log('✅ MongoDB Connected [OSHIYA-MD]');
    } catch (e) {
        console.error('❌ MongoDB Error:', e);
    }
}

// ---------------- EmpirePair Function ----------------

export async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
    
    // අවශ්‍ය ෆෝල්ඩරය සෑදීම
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    await initMongo().catch(() => {});

    // MongoDB වෙතින් පැරණි session දත්ත ලබා ගැනීම
    try {
        const doc = await sessionsCol.findOne({ number: sanitizedNumber });
        if (doc && doc.creds) {
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(doc.creds));
            console.log('📂 Creds restored from MongoDB');
        }
    } catch (e) { console.warn('⚠️ No prefilled session found'); }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    try {
        const socket = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            // Railway සර්වර් වලදී හිර නොවී ක්‍රියා කිරීමට මෙම අගයන් වැදගත් වේ
            version: [2, 3000, 1017531202], 
            browser: ["Ubuntu", "Chrome", "20.0.0.0"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000
        });

        // Pairing Code එක ඉල්ලීම
        if (!socket.authState.creds.registered) {
            // සර්වර් එක සූදානම් වීමට තත්පර 10ක් රැඳී සිටීම (Railway Network Delay Fix)
            await delay(10000); 
            
            try {
                const code = await socket.requestPairingCode(sanitizedNumber);
                if (code && !res.headersSent) {
                    const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                    return res.send({ code: formattedCode });
                }
            } catch (err) {
                console.error('❌ Pairing Code Error:', err);
                if (!res.headersSent) return res.status(500).send({ error: "Could not generate code." });
            }
        }

        // Session දත්ත සුරැකීම
        socket.ev.on('creds.update', async () => {
            await saveCreds();
            try {
                const credsData = JSON.parse(fs.readFileSync(path.join(sessionPath, 'creds.json'), 'utf-8'));
                await sessionsCol.updateOne(
                    { number: sanitizedNumber },
                    { $set: { number: sanitizedNumber, creds: credsData, updatedAt: new Date() } },
                    { upsert: true }
                );
            } catch (err) { console.error('💾 DB Save Error:', err); }
        });

        // සම්බන්ධතාවය විවෘත වූ විට
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ ${sanitizedNumber} Linked!`);
                const userJid = jidNormalizedUser(socket.user.id);
                await socket.sendMessage(userJid, { text: "✅ *OSHIYA-MD PAIRING SUCCESSFUL*" });
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut || reason === 401) {
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                }
            }
        });

    } catch (error) {
        console.error('❌ Fatal Error:', error);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}

export default router;
