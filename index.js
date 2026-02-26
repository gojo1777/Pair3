import express from "express";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import path from "path";
import events from "events";
import session from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";

import pairRouter from "./pair.js";

const app = express();

// ✅ Listeners සීමාව වැඩි කිරීම (Baileys සඳහා වැදගත් වේ)
events.EventEmitter.defaultMaxListeners = 500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;

const MONGO_URL = process.env.MONGO_URL || "mongodb+srv://sayuaradark_db_user:qK3BV8XVv2JJJD5a@cluster0.w8wb15r.mongodb.net/?appName=Cluster0";

// 🔥 MongoDB සම්බන්ධතාවය
mongoose
  .connect(MONGO_URL)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// ✅ Session middleware setup
app.use(
  session({
    secret: "oshiya-md-secret",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: MONGO_URL,
      collectionName: "web_sessions",
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // දින 1ක්
    },
  })
);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Static ෆයිල්ස් (HTML/CSS) ලබා දීම
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "pair.html"));
});

// Pair Router එක සම්බන්ධ කිරීම
app.use("/pair", pairRouter);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export default app;
