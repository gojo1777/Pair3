import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema({
    number: { 
        type: String, 
        required: true, 
        unique: true,      // ✅ Duplicate entries වළකින්න
        index: true        // ✅ Fast lookup සඳහා
    },
    creds: { 
        type: Object, 
        required: true 
    },
    createdAt: { 
        type: Date, 
        default: Date.now,
        expires: 60 * 60 * 24 * 30  // ✅ 30 දිනකට පස්සේ auto delete (optional)
    }
});

export default mongoose.model("Session", sessionSchema);
