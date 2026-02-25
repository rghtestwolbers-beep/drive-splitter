// server.js (ESM)
// ✅ Fixes:
// - Better subtitle styling for vertical video (no huge text)
// - Optional automatic time-offset per chunk (solves “captions too early”)
// - Safer SRT generation (sorting + sanitize newlines)
// - Escapes paths for ffmpeg subtitles filter
// - More robust defaults + useful debug output

import express from "express";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();

// Captions payload can be large
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
  if (!bitRate || bitRate <= 0) return 30; // fallback
  const maxSeconds = (maxBytes * 8) / bitRate; // seconds
  return Math.max(5, Math.floor(maxSeconds * 0.85)); // safety margin
}

async function downloadDriveFileToPath(fileId, outPath) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  const dl = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

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

/**
 * Optional: wrap long lines for nicer captions (2 lines max-ish)
 * Simple wrapper; you can tune maxLen.
 */
function wrapCaption(text, maxLen = 32) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;

  const words = t.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length <= maxLen) line = candidate;
    else {
      if (line) lines.push(line);
      line = w;
      if (lines.length === 1) break; // keep ~2 lines max
    }
  }
  if (line && lines.length < 2) lines.push(line);

  return lines.join("\n");
}

/**
 * Build SRT from segments.
 * Expected segment shape:
 * { start:number, end:number, text:string }
 *
 * Supports optional chunk offsets:
 * - If segment has { chunkIndex } and request provides segmentSeconds,
 *   and request has applyChunkOffsets=true, we shift timestamps:
 *   start += chunkIndex * segmentSeconds
 */
function normalizeSegments({
  segments,
  applyChunkOffsets = false,
  segmentSeconds = 0,
  globalOffsetSeconds = 0,
}) {
  const segSec = Number(segmentSeconds) || 0;
  const globalOff = Number(globalOffsetSeconds) || 0;

  return (
    (Array.isArray(segments) ? segments : [])
      // normalize + clean
      .map((s) => {
        const start = Number(s?.start);
        const end = Number(s?.end);
        const text = s?.text;

        const chunkIndex = Number(s?.chunkIndex);
        const chunkOff =
          applyChunkOffsets && Number.isFinite(chunkIndex) && segSec > 0
            ? chunkIndex * segSec
            : 0;

        return {
          start: (Number.isFinite(start) ? start : 0) + chunkOff + globalOff,
          end: (Number.isFinite(end) ? end : 0) + chunkOff + globalOff,
          text: String(text ?? "").trim(),
        };
      })
      // keep only valid ranges
      .filter((s) => s.text && s.end > s.start)
      // sort by time (important!)
      .sort((a, b) => a.start - b.start || a.end - b.end)
  );
}

function buildSrtFromSegments(segments, { wrap = true, maxLineLen = 32 } = {}) {
  return segments
    .map((s, i) => {
      const start = srtTime(s.start);
      const end = srtTime(s.end);
      const clean = String(s.text)
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      const finalText = wrap ? wrapCaption(clean, maxLineLen) : clean;

      return `${i + 1}\n${start} --> ${end}\n${finalText}\n`;
    })
    .join("\n");
}

/**
 * ffmpeg subtitles filter path escaping.
 * libass expects special escaping for ':' and '\' on some platforms.
 * (Linux is usually ok, but this makes it safer.)
 */
function escapeForFfmpegSubtitlesFilter(p) {
  // Use forward slashes and escape ':' and '\'
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * Burn subtitles into video using ffmpeg.
 * Uses libass styling. Good defaults for vertical social video.
 */
function burnSubtitlesToVideo({
  inputPath,
  srtPath,
  outputPath,
  style = {},
}) {
  // Good defaults for vertical video (TikTok/Reels)
// Better defaults for 1080x1920 vertical video
const fontSize = Number(style.fontSize ?? 44);
const bottomMargin = Number(style.bottomMargin ?? 160);
  const outline = Number(style.outline ?? 2);
  const shadow = Number(style.shadow ?? 0);
  const alignment = Number(style.alignment ?? 2); // 2 = bottom-center

  // Optional: pick a font name available in container
  const fontName = style.fontName ? String(style.fontName) : null;

  // Optional: text color; ASS uses &HAABBGGRR (alpha, blue, green, red)
  // White = &H00FFFFFF. We'll keep default white.
  const primaryColour = style.primaryColour
    ? String(style.primaryColour)
    : null;

  const srtEscaped = escapeForFfmpegSubtitlesFilter(srtPath);

const marginLR = Number(style.marginLR ?? 80);

const styleParts = [
  `FontSize=${fontSize}`,
  `MarginV=${bottomMargin}`,
  `MarginL=${marginLR}`,
  `MarginR=${marginLR}`,
  `Outline=${outline}`,
  `Shadow=${shadow}`,
  `Alignment=${alignment}`,
  `BorderStyle=1`,
  `Bold=1`,
];
  if (fontName) styleParts.push(`FontName=${fontName}`);
  if (primaryColour) styleParts.push(`PrimaryColour=${primaryColour}`);

  const forceStyle = styleParts.join(",");

// Detect video size so libass scales correctly (prevents giant text)
const probe = execSync(
  `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${inputPath}"`,
  { encoding: "utf8" }
);
const { width, height } = JSON.parse(probe).streams[0];

// IMPORTANT: original_size makes FontSize behave consistently
const vf = `subtitles='${srtEscaped}':original_size=${width}x${height}:force_style='${forceStyle}'`;
  // Re-encode video to burn captions reliably
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

// -------------------- SPLIT --------------------

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

// -------------------- RENDER CAPTIONS --------------------

app.post("/render-captions", async (req, res) => {
  try {
    let {
      fileId,
      segments,
      style,
      applyChunkOffsets = false,
      segmentSeconds = 0,
      globalOffsetSeconds = 0,
      wrap = true,
      maxLineLen = 32,
    } = req.body;

    // ✅ Accept segments as JSON string (from n8n) or real array
    if (typeof segments === "string") {
      try {
        segments = JSON.parse(segments);
      } catch {
        return res.status(400).json({ error: "Invalid segments JSON" });
      }
    }

    if (!fileId) {
      return res.status(400).json({ error: "Missing fileId" });
    }

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: "Missing segments[]" });
    }

    if (!BUCKET) {
      return res.status(500).json({ error: "Missing BUCKET env var" });
    }

    const workDir = `/tmp/${fileId}-render`;
    fs.mkdirSync(workDir, { recursive: true });

    const inputPath = `${workDir}/input.mp4`;
    const srtPath = `${workDir}/captions.srt`;
    const outputPath = `${workDir}/output.mp4`;

    // 1️⃣ Download original video
    await downloadDriveFileToPath(fileId, inputPath);

    // 2️⃣ Normalize + sort segments
    const normalized = normalizeSegments({
      segments,
      applyChunkOffsets,
      segmentSeconds,
      globalOffsetSeconds,
    });

    // 3️⃣ Write SRT
    fs.writeFileSync(
      srtPath,
      buildSrtFromSegments(normalized, { wrap, maxLineLen }),
      "utf8"
    );

    // 4️⃣ Burn subtitles
    burnSubtitlesToVideo({
      inputPath,
      srtPath,
      outputPath,
      style: style ?? {},
    });

    // 5️⃣ Upload result
    const destination = `captioned/${fileId}/output.mp4`;
    const url = await uploadToGcsAndSign(outputPath, destination);

    return res.json({
      fileId,
      output: { file: "output.mp4", url },
      debug: {
        segmentsReceived: segments.length,
        segmentsUsed: normalized.length,
        applyChunkOffsets,
        segmentSeconds,
        globalOffsetSeconds,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});
