import express from "express";
import cors from "cors";
import { spawn } from "child_process";

const app = express();

const allowedOrigins = [
  process.env.ALLOWED_ORIGIN,
  "https://waveforge-backend.onrender.com"
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, true);
      }
    }
  })
);

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    service: "waveforge-backend",
    status: "running",
    url: "https://waveforge-backend.onrender.com"
  });
});

app.get("/health", (_req, res) => {
  res.json({ service: "waveforge-backend", status: "ok" });
});

app.post("/convert", (req, res) => {
  const { sourceUrl, bitrate = "256k", title = "waveforge_track" } = req.body || {};
  const allowedBitrates = ["128k", "256k", "320k"];
  const safeBitrate = allowedBitrates.includes(bitrate) ? bitrate : "256k";

  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    return res.status(400).json({ error: "Provide a valid http/https direct audio sourceUrl" });
  }

  const safeName = String(title).replace(/[^a-z0-9_-]/gi, "_") || "waveforge_track";

  const ffmpeg = spawn("ffmpeg", [
    "-user_agent", "Mozilla/5.0",
    "-i", sourceUrl,
    "-vn",
    "-c:a", "aac",
    "-b:a", safeBitrate,
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov",
    "pipe:1"
  ]);

  let stderrLog = "";
  let bytesSent = 0;
  let headersSet = false;

  ffmpeg.stderr.on("data", (chunk) => {
    stderrLog += chunk.toString();
    if (stderrLog.length > 4000) {
      stderrLog = stderrLog.slice(-4000);
    }
  });

  ffmpeg.stdout.on("data", (chunk) => {
    if (!headersSet) {
      headersSet = true;
      res.setHeader("Content-Type", "audio/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.m4a"`);
    }
    bytesSent += chunk.length;
    if (!res.write(chunk)) {
      ffmpeg.stdout.pause();
      res.once("drain", () => ffmpeg.stdout.resume());
    }
  });

  ffmpeg.on("error", (err) => {
    if (!headersSet && !res.headersSent) {
      res.status(500).json({ error: `Failed to start ffmpeg: ${err.message}` });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  ffmpeg.on("close", (code) => {
    if (code !== 0 || bytesSent === 0) {
      if (!headersSet && !res.headersSent) {
        const lastLine = stderrLog.trim().split("\n").pop() || "ffmpeg exited with an error";
        return res.status(400).json({ error: `Conversion failed: ${lastLine}` });
      }
    }
    if (!res.writableEnded) {
      res.end();
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
