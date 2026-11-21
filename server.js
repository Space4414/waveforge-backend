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

async function findArchiveAudioUrl(trackTitle) {
  const cleanedQuery = trackTitle.replace(/[^\w\s-]/g, " ").trim();
  const q = encodeURIComponent(`(${cleanedQuery}) AND mediatype:(audio)`);
  const searchUrl = `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&rows=5&page=1&output=json`;

  const searchRes = await fetch(searchUrl, {
    headers: { "User-Agent": "WaveForge/1.0 (spotiaac.vercel.app)" }
  });
  if (!searchRes.ok) {
    throw new Error("Failed to search Internet Archive audio catalog.");
  }

  const searchData = await searchRes.json();
  const docs = searchData?.response?.docs || [];
  const audioExts = [".m4a", ".mp3", ".ogg", ".opus", ".flac", ".wav"];

  for (const doc of docs) {
    const id = doc.identifier;
    if (!id) continue;
    const metaRes = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}/files`, {
      headers: { "User-Agent": "WaveForge/1.0 (spotiaac.vercel.app)" }
    });
    if (!metaRes.ok) continue;
    const metaData = await metaRes.json();
    const files = metaData?.result || [];

    const match = files.find((f) => {
      const name = (f.name || "").toLowerCase();
      return audioExts.some((ext) => name.endsWith(ext));
    });

    if (match?.name) {
      return `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(match.name)}`;
    }
  }

  throw new Error(`No streamable audio match found on Internet Archive for "${trackTitle}".`);
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

    const audioUrl = await findArchiveAudioUrl(trackTitle);
    console.log("Streaming source audio:", audioUrl);

    const audioRes = await fetch(audioUrl, {
      headers: { "User-Agent": "WaveForge/1.0 (spotiaac.vercel.app)" }
    });
    if (!audioRes.ok || !audioRes.body) {
      throw new Error("Could not stream audio file from source.");
    }

    const safeFilename = trackTitle.replace(/[^a-z0-9_-]/gi, "_").replace(/_+/g, "_") || "spotify_track";

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

    let ffmpegErr = "";
    let bytesSent = 0;
    let headersSet = false;
    let finished = false;

    ffmpeg.stderr.on("data", (chunk) => {
      ffmpegErr += chunk.toString();
      if (ffmpegErr.length > 4000) ffmpegErr = ffmpegErr.slice(-4000);
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
      console.log(`ffmpeg closed: code=${code}, signal=${signal}, bytesSent=${bytesSent}`);
      if ((code !== 0 || bytesSent === 0) && !headersSet && !res.headersSent) {
        const ffLines = ffmpegErr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        const detail = ffLines.slice(-2).join(" | ") || `ffmpeg code=${code}, signal=${signal || "none"}`;
        return res.status(400).json({ error: `Conversion failed: ${detail}` });
      }
      if (!res.writableEnded) {
        res.end();
      }
    });

    const reader = audioRes.body.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ffmpeg.stdin.writable) {
            const ok = ffmpeg.stdin.write(Buffer.from(value));
            if (!ok) {
              await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
            }
          }
        }
        if (ffmpeg.stdin.writable) ffmpeg.stdin.end();
      } catch (streamErr) {
        console.error("Audio stream pipe error:", streamErr);
        try { ffmpeg.stdin.destroy(); } catch {}
      }
    })();

    req.on("aborted", () => {
      if (!finished) {
        try { reader.cancel(); } catch {}
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
