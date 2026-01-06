import express from "express";
import cors from "cors";
import { fal } from "@fal-ai/client";

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// Middleware
// ===============================
app.use(cors());
app.use(express.json());

// ===============================
// Fal.ai configuration (CORRECT)
// ===============================
fal.config({
  credentials: process.env.FAL_KEY, // DO NOT hardcode
});

// ===============================
// Health check
// ===============================
app.get("/", (req, res) => {
  res.send("Calevid backend is running");
});

app.get("/status/test", (req, res) => {
  res.json({ status: "Node backend is running" });
});

// ===============================
// VIDEO GENERATION (REAL)
// ===============================
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        status: "error",
        message: "Prompt is required",
      });
    }

    console.log("VIDEO PROMPT:", prompt);

    // 🔥 OVI AI via Fal.ai
    const result = await fal.subscribe("fal-ai/ovi", {
      input: {
        prompt: prompt,
      },
      logs: true,
    });

    console.log("FAL RESPONSE:", result);

    // Ovi returns video URL(s)
    const videoUrl =
      result?.output?.video?.url ||
      result?.output?.video_url ||
      null;

    if (!videoUrl) {
      return res.status(500).json({
        status: "error",
        message: "Video generated but URL not found",
        raw: result,
      });
    }

    return res.json({
      status: "success",
      message: "Video generated successfully",
      videoUrl: videoUrl,
    });
  } catch (error) {
    console.error("FAL VIDEO ERROR:", error);

    return res.status(500).json({
      status: "error",
      message: "Fal.ai video generation failed",
      error: error.message,
    });
  }
});

// ===============================
// Start server
// ===============================
app.listen(PORT, () => {
  console.log(`Calevid backend running on port ${PORT}`);
});
