import express from 'express';
import fs from 'fs'; // Built-in fs භාවිතා කර ඇත, fs-extra අවශ්‍ය නොවේ
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import pino from 'pino';
import moment from 'moment-timezone';
import axios from 'axios';
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'url';

// Baileys library එක ESM වලට ගැලපෙන ලෙස import කිරීම
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
        console.log('✅ MongoDB Connected Successfully');
    } catch (e) {
        console.error('❌ MongoDB Connection Error:', e);
    }
}

// ---------------- EmpirePair Function ----------------

export async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
    
    // Folder එකක් නැත්නම් සෑදීම
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    await initMongo().catch(() => {});

    // MongoDB එකෙන් පරණ තොරතුරු ඇත්නම් ලබා ගැනීම
    try {
        const doc = await sessionsCol.findOne({ number: sanitizedNumber });
        if (doc && doc.creds) {
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(doc.creds));
            console.log('📂 Session prefilled from MongoDB');
        }
    } catch (e) { console.warn('⚠️ DB prefill failed'); }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    try {
        const socket = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            // 'Logging in' හිරවීම වැළැක්වීමට ස්ථාවර version එකක්
            version: [2, 3000, 1017531202], 
            browser: ["Ubuntu", "Chrome", "20.0.0.0"],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
        });

        // Pairing Code එක ලබා ගැනීම
        if (!socket.authState.creds.registered) {
            // සර්වර් එක සින්ක් වීමට ප්‍රමාණවත් කාලයක් ලබා දීම
            await delay(10000); 
            
            try {
                const code = await socket.requestPairingCode(sanitizedNumber);
                if (code && !res.headersSent) {
                    const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                    return res.send({ code: formatted });
                }
            } catch (err) {
                console.error('❌ Code Request Error:', err);
                if (!res.headersSent) return res.status(500).send({ error: "Failed to generate code." });
            }
        }

        // Creds update වන විට DB එකට save කිරීම
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

        // Connection status පරීක්ෂා කිරීම
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ Connected: ${sanitizedNumber}`);
                const userJid = jidNormalizedUser(socket.user.id);
                await socket.sendMessage(userJid, { text: "✅ *OSHIYA-MD Connected Successfully!*" });
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut || reason === 401) {
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                }
            }
        });

    } catch (error) {
        console.error('❌ Main Error:', error);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}

export default router;
