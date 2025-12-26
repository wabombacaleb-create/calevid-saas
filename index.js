import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // Make sure installed: npm install node-fetch

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- Root route ---
app.get("/", (req, res) => {
  res.send("Calevid backend is running");
});

// --- Generate video route ---
app.post("/generate-video", async (req, res) => {
  const { prompt, aspect_ratio, length } = req.body;

  if (!prompt) return res.status(400).json({ error: "Prompt is required" });

  try {
    // --- Pika Labs API call ---
    const response = await fetch("https://api.pikalabs.com/v1/videos", { // replace with actual endpoint
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer YOUR_PIKA_SECRET_KEY" // replace with your secret key
      },
      body: JSON.stringify({
        prompt,
        aspect_ratio: aspect_ratio || "16:9",
        length: length || 10
      })
    });

    const data = await response.json();

    if (data.video_url) {
      res.json({
        status: "success",
        message: "Video generated successfully",
        prompt,
        videoUrl: data.video_url
      });
    } else {
      // Free account / test mode fallback
      res.json({
        status: "success",
        message: "Video generation simulated (test mode)",
        prompt,
        videoUrl: "https://example.com/sample-video.mp4"
      });
    }

  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// --- Verify Paystack payment ---
app.post("/verify-payment", async (req, res) => {
  const { reference } = req.body;

  if (!reference) return res.status(400).json({ error: "Payment reference is required" });

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: "GET",
      headers: {
        Authorization: "Bearer sk_test_a8ca1636111892f24c336e7959d2fc1648dc0ff7" // Replace with your Paystack secret key
      }
    });

    const data = await response.json();

    if (data.status && data.data.status === "success") {
      res.json({ status: "success", message: "Payment verified", data: data.data });
    } else {
      res.status(400).json({ status: "failed", message: "Payment not successful", data: data.data });
    }
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Calevid backend running on port ${PORT}`);
});
