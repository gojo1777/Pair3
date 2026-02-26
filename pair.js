import express from 'express';
import fs from 'fs-extra';
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

// ESM වලදී path හැසිරවීමට අවශ්‍ය setup එක
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- MONGO SETUP ----------------
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://malvintech11_db_user:0SBgxRy7WsQZ1KTq@cluster0.xqgaovj.mongodb.net/?appName=Cluster0';
const MONGO_DB = process.env.MONGO_DB || 'Free_Mini';

let mongoClient, mongoDB;
let sessionsCol, numbersCol, adminsCol, newsletterCol, configsCol;

async function initMongo() {
    try {
        if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected()) return;
        mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        await mongoClient.connect();
        mongoDB = mongoClient.db(MONGO_DB);

        sessionsCol = mongoDB.collection('sessions');
        numbersCol = mongoDB.collection('numbers');
        adminsCol = mongoDB.collection('admins');
        newsletterCol = mongoDB.collection('newsletter_list');
        configsCol = mongoDB.collection('configs');

        console.log('✅ MongoDB Initialized Successfully');
    } catch (e) {
        console.error('❌ Mongo Initialization Error:', e);
    }
}

// ---------------- Mongo Helpers ----------------
async function saveCredsToMongo(number, creds, keys = null) {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await sessionsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, creds, keys, updatedAt: new Date() } }, { upsert: true });
}

async function loadCredsFromMongo(number) {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    return await sessionsCol.findOne({ number: sanitized });
}

async function addNumberToMongo(number) {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
}

// ---------------- EmpirePair Function ----------------

export async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
    
    await initMongo().catch(() => {});

    try {
        const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
        if (mongoDoc && mongoDoc.creds) {
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
            if (mongoDoc.keys) fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
            console.log('📂 Prefilled session from database');
        }
    } catch (e) { console.warn('⚠️ MongoDB prefill failed', e); }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    try {
        const socket = makeWASocket({
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            version: [2, 3000, 1015901307],
            browser: ["Ubuntu", "Chrome", "20.0.0.0"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            fireInitQueries: true,
            syncFullHistory: true,
            markOnlineOnConnect: true
        });

        // Global map setup (Restart කිරීම් සඳහා)
        // සටහන: activeSockets global variable එකක් ලෙස පවතී නම් පමණක් මෙය ක්‍රියා කරයි
        if (typeof global.activeSockets !== 'undefined') global.activeSockets.set(sanitizedNumber, socket);

        // Handlers (මේවා ඔබගේ අනෙක් ESM modules වල තිබිය යුතුයි)
        if (typeof global.setupStatusHandlers === 'function') global.setupStatusHandlers(socket);
        if (typeof global.setupCommandHandlers === 'function') global.setupCommandHandlers(socket, sanitizedNumber);
        if (typeof global.setupMessageHandlers === 'function') global.setupMessageHandlers(socket);

        if (!socket.authState.creds.registered) {
            await delay(8000); 
            
            try {
                const code = await socket.requestPairingCode(sanitizedNumber);
                if (code && !res.headersSent) {
                    const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                    return res.send({ code: formattedCode });
                }
            } catch (err) {
                console.error('❌ Pairing Request Error:', err);
                if (!res.headersSent) return res.status(500).send({ error: "Code generation failed. Try again." });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            try {
                const credsFile = path.join(sessionPath, 'creds.json');
                if (fs.existsSync(credsFile)) {
                    const credsObj = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
                    await saveCredsToMongo(sanitizedNumber, credsObj, state.keys);
                }
            } catch (err) { console.error('💾 DB Save Error:', err); }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ Connected Successfully: ${sanitizedNumber}`);
                const userJid = jidNormalizedUser(socket.user.id);
                
                await socket.sendMessage(userJid, { text: `✅ *OSHIYA-MD Connected*\n\nYour bot is now active on ${sanitizedNumber}` });
                await addNumberToMongo(sanitizedNumber);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut || reason === 515) {
                    try { fs.removeSync(sessionPath); } catch (e) {}
                }
            }
        });

    } catch (error) {
        console.error('❌ EmpirePair Main Error:', error);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}

export default router;
