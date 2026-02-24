import express from "express";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();
// Captions requests can be large; raise this so you don't hit 413.
app.use(express.json({ limit: "25mb" }));

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

async function downloadDriveFileToPath(fileId, outPath) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  const dl = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });

  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(outPath);
    dl.data.pipe(dest);
    dest.on("finish", resolve);
    dest.on("error", reject);
  });
}

function srtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);

  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

function buildSrtFromSegments(segments) {
  return segments
    .filter((s) => s && s.text && Number(s.end) > Number(s.start))
    .map((s, i) => {
      const start = srtTime(s.start);
      const end = srtTime(s.end);
      const text = String(s.text).replace(/\r?\n+/g, " ").trim();
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join("\n");
}

/**
 * Burn subtitles into video using ffmpeg.
 * NOTE: ffmpeg subtitles filter uses libass; your image must include ffmpeg with libass.
 */
function burnSubtitlesToVideo({ inputPath, srtPath, outputPath, fontSize, bottomMargin }) {
  // Force-style works when libass is available.
  const vf = `subtitles=${srtPath}:force_style='FontSize=${fontSize},MarginV=${bottomMargin}'`;

  execSync(
    `ffmpeg -y -i "${inputPath}" -vf "${vf}" ` +
      `-c:v libx264 -preset veryfast -crf 18 ` +
      `-c:a aac -b:a 192k -movflags +faststart "${outputPath}"`,
    { stdio: "ignore" }
  );
}

async function uploadToGcsAndSign(localPath, destination) {
  if (!BUCKET) throw new Error("Missing BUCKET env var");

  await storage.bucket(BUCKET).upload(localPath, { destination });

  const [url] = await storage.bucket(BUCKET).file(destination).getSignedUrl({
    action: "read",
    expires: Date.now() + 60 * 60 * 1000, // 1 hour
  });

  return url;
}

app.post("/split-video", async (req, res) => {
  try {
    const { fileId, maxChunkMB = 24 } = req.body;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });
    if (!BUCKET) return res.status(500).json({ error: "Missing BUCKET env var" });

    const workDir = `/tmp/${fileId}`;
    fs.mkdirSync(workDir, { recursive: true });

    const inputPath = `${workDir}/input.mp4`;
    const outDir = `${workDir}/chunks`;
    fs.mkdirSync(outDir, { recursive: true });

    // Download from Drive
    await downloadDriveFileToPath(fileId, inputPath);

    // Decide segment duration based on bitrate
    const segmentSeconds = estimateSegmentSeconds(inputPath, maxChunkMB);

    // Split MP4 (copy streams, no re-encode)
    // Note: keyframes matter; some parts may slightly exceed. If you need strict size, re-encode.
    execSync(
      `ffmpeg -y -i "${inputPath}" -c copy -map 0 -f segment -segment_time ${segmentSeconds} -reset_timestamps 1 "${outDir}/part_%03d.mp4"`,
      { stdio: "ignore" }
    );

    const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".mp4")).sort();
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

app.post("/render-captions", async (req, res) => {
  try {
    const { fileId, segments, style } = req.body;

    if (!fileId) return res.status(400).json({ error: "Missing fileId" });
    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: "Missing segments[]" });
    }
    if (!BUCKET) return res.status(500).json({ error: "Missing BUCKET env var" });

    const fontSize = style?.fontSize ?? 48;
    const bottomMargin = style?.bottomMargin ?? 80;

    const workDir = `/tmp/${fileId}-render`;
    fs.mkdirSync(workDir, { recursive: true });

    const inputPath = `${workDir}/input.mp4`;
    const srtPath = `${workDir}/captions.srt`;
    const outputPath = `${workDir}/output.mp4`;

    // 1) Download original video from Drive
    await downloadDriveFileToPath(fileId, inputPath);

    // 2) Write SRT
    fs.writeFileSync(srtPath, buildSrtFromSegments(segments), "utf8");

    // 3) Burn subtitles
    burnSubtitlesToVideo({ inputPath, srtPath, outputPath, fontSize, bottomMargin });

    // 4) Upload output to GCS + return signed URL
    const destination = `captioned/${fileId}/output.mp4`;
    const url = await uploadToGcsAndSign(outputPath, destination);

    return res.json({ fileId, output: { file: "output.mp4", url } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`Running on ${PORT}`));
