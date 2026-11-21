import express from "express";
import cors from "cors";
import { spawn } from "child_process";

const app = express();

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*"
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ service: "waveforge-backend", status: "ok" });
});

app.post("/convert", (req, res) => {
  const { sourceUrl, bitrate = "256k", title = "waveforge_track" } = req.body || {};
  const allowedBitrates = ["128k", "256k", "320k"];
  const safeBitrate = allowedBitrates.includes(bitrate) ? bitrate : "256k";

  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    return res.status(400).json({ error: "Provide a valid http/https sourceUrl" });
  }

  const safeName = String(title).replace(/[^a-z0-9_-]/gi, "_") || "waveforge_track";

  res.setHeader("Content-Type", "audio/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.m4a"`);

  const ffmpeg = spawn("ffmpeg", [
    "-i", sourceUrl,
    "-vn",
    "-c:a", "aac",
    "-b:a", safeBitrate,
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov",
    "pipe:1"
  ]);

  ffmpeg.stdout.pipe(res);

  ffmpeg.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "ffmpeg failed to start" });
    }
  });

  ffmpeg.on("close", (code) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ error: "Audio conversion failed" });
    }
  });

  req.on("close", () => {
    ffmpeg.kill("SIGKILL");
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`WaveForge backend listening on port ${port}`);
});
