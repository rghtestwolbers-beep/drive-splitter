import express from "express";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET;

const storage = new Storage();

app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

function bytesToMB(bytes) {
  return bytes / 1024 / 1024;
}

/**
 * Estimate a safe segment_time (seconds) so each MP4 chunk stays under maxChunkMB.
 * Uses ffprobe to get bitrate. Adds a safety margin (0.85).
 */
function estimateSegmentSeconds(inputPath, maxChunkMB) {
  const maxBytes = maxChunkMB * 1024 * 1024;
  const json = execSync(
    `ffprobe -v error -print_format json -show_format "${inputPath}"`,
    { encoding: "utf8" }
  );
  const info = JSON.parse(json);
  const bitRate = Number(info?.format?.bit_rate || 0); // bits/sec
  if (!bitRate || bitRate <= 0) {
    // fallback: 30s chunks if bitrate unknown
    return 30;
  }
  const maxSeconds = (maxBytes * 8) / bitRate; // seconds
  return Math.max(5, Math.floor(maxSeconds * 0.85)); // safety margin
}

app.post("/split-video", async (req, res) => {
  try {
    const { fileId, maxChunkMB = 24 } = req.body;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });
    if (!BUCKET) return res.status(500).json({ error: "Missing BUCKET env var" });

    // Drive auth (Cloud Run service account)
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });

    const workDir = `/tmp/${fileId}`;
    fs.mkdirSync(workDir, { recursive: true });

    const inputPath = `${workDir}/input.mp4`;
    const outDir = `${workDir}/chunks`;
    fs.mkdirSync(outDir, { recursive: true });

    // Download from Drive
    const dl = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    await new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(inputPath);
      dl.data.pipe(dest);
      dest.on("finish", resolve);
      dest.on("error", reject);
    });

    // Decide segment duration based on bitrate
    const segmentSeconds = estimateSegmentSeconds(inputPath, maxChunkMB);

    // Split MP4 (copy streams, no re-encode)
    // Note: keyframes matter; some parts may slightly exceed. If you need strict size, re-encode.
    execSync(
      `ffmpeg -y -i "${inputPath}" -c copy -map 0 -f segment -segment_time ${segmentSeconds} -reset_timestamps 1 "${outDir}/part_%03d.mp4"`,
      { stdio: "ignore" }
    );

    const files = fs.readdirSync(outDir).filter(f => f.endsWith(".mp4")).sort();
    const chunks = [];

    for (const file of files) {
      const localPath = path.join(outDir, file);
      const sizeMB = bytesToMB(fs.statSync(localPath).size);

      const destination = `video_chunks/${fileId}/${file}`;
      await storage.bucket(BUCKET).upload(localPath, { destination });

      const [url] = await storage.bucket(BUCKET).file(destination).getSignedUrl({
        action: "read",
        expires: Date.now() + 60 * 60 * 1000,
      });

      chunks.push({ file, sizeMB: Number(sizeMB.toFixed(2)), url });
    }

    res.json({
      fileId,
      maxChunkMB,
      segmentSeconds,
      count: chunks.length,
      chunks,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`Running on ${PORT}`));
