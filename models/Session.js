import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema({
    number: { type: String, required: true },
    creds: { type: Object, required: true },
    createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Session", sessionSchema);
