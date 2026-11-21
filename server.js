import express from "express";
import cors from "cors";
import { spawn } from "child_process";

const app = express();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ service: "waveforge-backend", status: "running" });
});

app.get("/health", (_req, res) => {
  res.json({ service: "waveforge-backend", status: "ok" });
});

app.post("/convert", (req, res) => {
  const { sourceUrl, bitrate = "128k", title = "waveforge_track" } = req.body || {};
  const allowedBitrates = ["128k", "256k", "320k"];
  const safeBitrate = allowedBitrates.includes(bitrate) ? bitrate : "128k";

  console.log("POST /convert received:", sourceUrl, safeBitrate);

  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    return res.status(400).json({ error: "Provide a valid http/https direct audio sourceUrl" });
  }

  const safeName = String(title).replace(/[^a-z0-9_-]/gi, "_") || "waveforge_track";

  const ffmpeg = spawn("ffmpeg", [
    "-threads", "1",
    "-user_agent", "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "-headers", "Accept: */*\r\n",
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
  let finished = false;

  ffmpeg.stderr.on("data", (chunk) => {
    stderrLog += chunk.toString();
    if (stderrLog.length > 6000) {
      stderrLog = stderrLog.slice(-6000);
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
    finished = true;
    console.error("ffmpeg spawn error:", err.message);
    if (!headersSet && !res.headersSent) {
      res.status(500).json({ error: `Failed to start ffmpeg: ${err.message}` });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  ffmpeg.on("close", (code, signal) => {
    finished = true;
    console.log(`ffmpeg closed: code=${code}, signal=${signal}, bytesSent=${bytesSent}`);
    if (code !== 0 || bytesSent === 0) {
      if (!headersSet && !res.headersSent) {
        const lines = stderrLog.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        const detail = lines.slice(-2).join(" | ") || `code ${code}, signal ${signal || "none"}`;
        return res.status(400).json({ error: `ffmpeg failed: ${detail}` });
      }
    }
    if (!res.writableEnded) {
      res.end();
    }
  });

  req.on("aborted", () => {
    if (!finished) {
      console.log("Client aborted request; stopping ffmpeg");
      ffmpeg.kill("SIGTERM");
    }
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`WaveForge backend listening on port ${port}`);
});
