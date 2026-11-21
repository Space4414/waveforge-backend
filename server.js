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

async function getSpotifyMetadata(spotifyUrl) {
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
  const response = await fetch(oembedUrl);
  if (!response.ok) {
    throw new Error("Could not fetch Spotify track metadata. Check that the link is a public track.");
  }
  const data = await response.json();
  return data.title || "Unknown Track";
}

app.post("/convert-spotify", async (req, res) => {
  const { spotifyUrl, bitrate = "128k" } = req.body || {};
  const allowedBitrates = ["128k", "256k", "320k"];
  const safeBitrate = allowedBitrates.includes(bitrate) ? bitrate : "128k";

  if (!spotifyUrl || !/open\.spotify\.com\/(intl-[a-z]{2}\/)?track\//i.test(spotifyUrl)) {
    return res.status(400).json({ error: "Provide a valid Spotify track URL (open.spotify.com/track/...)." });
  }

  try {
    const trackTitle = await getSpotifyMetadata(spotifyUrl);
    console.log("Resolved Spotify track:", trackTitle);

    const safeFilename = trackTitle.replace(/[^a-z0-9_-]/gi, "_").replace(/_+/g, "_") || "spotify_track";
    const searchQuery = `scsearch1:${trackTitle}`;

    const ytdlpArgs = [
      "--no-playlist",
      "--no-warnings",
      "-o", "-",
      searchQuery
    ];

    const ytdlp = spawn("yt-dlp", ytdlpArgs);

    const ffmpeg = spawn("ffmpeg", [
      "-threads", "1",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-c:a", "aac",
      "-b:a", safeBitrate,
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov",
      "pipe:1"
    ]);

    ytdlp.stdout.pipe(ffmpeg.stdin);

    let ytdlpErr = "";
    let ffmpegErr = "";
    let ytdlpBytes = 0;
    let bytesSent = 0;
    let headersSet = false;
    let finished = false;

    ytdlp.stderr.on("data", (chunk) => {
      ytdlpErr += chunk.toString();
      if (ytdlpErr.length > 4000) ytdlpErr = ytdlpErr.slice(-4000);
    });

    ffmpeg.stderr.on("data", (chunk) => {
      ffmpegErr += chunk.toString();
      if (ffmpegErr.length > 4000) ffmpegErr = ffmpegErr.slice(-4000);
    });

    ytdlp.stdout.on("data", (chunk) => {
      ytdlpBytes += chunk.length;
    });

    ytdlp.stdout.on("error", () => {
      try { ffmpeg.stdin.destroy(); } catch {}
    });

    ffmpeg.stdout.on("data", (chunk) => {
      if (!headersSet) {
        headersSet = true;
        res.setHeader("Content-Type", "audio/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.m4a"`);
      }
      bytesSent += chunk.length;
      if (!res.write(chunk)) {
        ffmpeg.stdout.pause();
        res.once("drain", () => ffmpeg.stdout.resume());
      }
    });

    ffmpeg.on("close", (code, signal) => {
      finished = true;
      console.log(`ffmpeg closed: code=${code}, signal=${signal}, ytdlpBytes=${ytdlpBytes}, bytesSent=${bytesSent}`);
      if ((code !== 0 || bytesSent === 0) && !headersSet && !res.headersSent) {
        const ytLines = ytdlpErr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        const ffLines = ffmpegErr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        const detail =
          ytLines.slice(-2).join(" | ") ||
          ffLines.slice(-2).join(" | ") ||
          `yt-dlp sent ${ytdlpBytes} bytes, ffmpeg code=${code}, signal=${signal || "none"}`;
        return res.status(400).json({ error: `Conversion failed: ${detail}` });
      }
      if (!res.writableEnded) {
        res.end();
      }
    });

    req.on("aborted", () => {
      if (!finished) {
        ytdlp.kill("SIGTERM");
        ffmpeg.kill("SIGTERM");
      }
    });
  } catch (err) {
    console.error("Spotify convert error:", err);
    if (!res.headersSent) {
      res.status(400).json({ error: err.message });
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`WaveForge backend listening on port ${port}`);
});
