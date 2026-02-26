// server.js (ESM) - Caption Renderer for Cloud Run
// POST /render-captions
//
// Body:
// {
//   fileId: "driveFileId",
//   segments: [{ start: 0.0, end: 1.2, text: "..." }, ...],
//   wrap: true,
//   maxLineLen: 20,
//   style: { font, fontSize, bottomMargin, outline, alignment, bold },
//   outputPrefix: "captioned" // optional
// }

import express from "express";
import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

console.log("Booting caption-renderer...");
console.log("PORT:", process.env.PORT, "BUCKET:", process.env.BUCKET);

const app = express();
app.use(express.json({ limit: "25mb" }));

const PORT = Number(process.env.PORT || 8080);
const BUCKET = process.env.BUCKET;
const OUTPUT_PREFIX_DEFAULT = process.env.OUTPUT_PREFIX || "captioned";

const storage = new Storage();

app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

function safeMkdir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function safeRmdir(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function ffprobeJson(filePath) {
  const out = execSync(
    `ffprobe -v error -print_format json -show_format -show_streams "${filePath}"`,
    { encoding: "utf8" }
  );
  return JSON.parse(out);
}

function getVideoMeta(filePath) {
  try {
    const info = ffprobeJson(filePath);
    const durationSec = Number(info?.format?.duration);
    const v = (info?.streams || []).find((s) => s.codec_type === "video");
    const width = Number(v?.width);
    const height = Number(v?.height);
    return {
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
    };
  } catch {
    return { durationSec: null, width: null, height: null };
  }
}

async function downloadDriveFile(fileId, outputPath) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(outputPath);
    response.data.pipe(dest);
    dest.on("finish", resolve);
    dest.on("error", reject);
  });
}

async function uploadPublic(localPath, destination, contentType = "video/mp4") {
  if (!BUCKET) throw new Error("Missing BUCKET env var");
  const bucket = storage.bucket(BUCKET);

  await bucket.upload(localPath, {
    destination,
    resumable: false,
    validation: false,
    contentType,
  });

  // Bucket is public, so direct URL (no expiry)
  return `https://storage.googleapis.com/${BUCKET}/${destination}`;
}

// -------- text helpers --------

function cleanText(t) {
  return String(t || "")
    .replace(/\u00A0/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function splitTwoLinesBalanced(text, maxLen) {
  const cleaned = cleanText(text);
  if (!cleaned) return [""];

  if (cleaned.length <= maxLen) return [cleaned];

  const words = cleaned.split(" ").filter(Boolean);
  if (words.length <= 1) return [cleaned];

  // Find split point that makes line lengths as equal as possible
  let bestIdx = 1;
  let bestScore = Infinity;

  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    // hard caps to avoid ridiculous lines
    if (a.length > maxLen * 1.8) continue;
    if (b.length > maxLen * 2.4) continue;

    const score = Math.abs(a.length - b.length);
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const lineA = words.slice(0, bestIdx).join(" ");
  const lineB = words.slice(bestIdx).join(" ");

  // If lineB is still too long, do a simple wrap within second line (no third line)
  if (lineB.length > maxLen * 2) {
    const trimmed = lineB.slice(0, maxLen * 2).trim();
    return [lineA, trimmed];
  }

  return [lineA, lineB];
}

function toAssTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${hh}:${pad2(mm)}:${pad2(ss)}.${pad2(cs)}`;
}

function assEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function applyChunkOffsets(segments, segmentSeconds = 0) {
  const segSec = Number(segmentSeconds) || 0;
  if (!segSec) return segments;

  return segments.map((s) => {
    const idx = Number(s.chunkIndex);
    if (!Number.isFinite(idx)) return s;
    return {
      ...s,
      start: Number(s.start) + idx * segSec,
      end: Number(s.end) + idx * segSec,
    };
  });
}

function buildAss({ segments, wrap, maxLineLen, style, playResX, playResY }) {
  const st = style || {};

  const font = st.font || "Arial";
  const fontSize = Number.isFinite(Number(st.fontSize)) ? Number(st.fontSize) : 54; // TikTok-ish
  const bottomMargin = Number.isFinite(Number(st.bottomMargin)) ? Number(st.bottomMargin) : 220;
  const outline = Number.isFinite(Number(st.outline)) ? Number(st.outline) : 3;
  const alignment = Number.isFinite(Number(st.alignment)) ? Number(st.alignment) : 2; // bottom-center
  const bold = st.bold === false ? 0 : -1;

  const primary = "&H00FFFFFF";
  const outlineColor = "&H00000000";
  const backColor = "&H00000000";

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut," +
      " ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${font},${fontSize},${primary},${primary},${outlineColor},${backColor},${bold},0,0,0,100,100,0,0,1,${outline},0,${alignment},80,80,${bottomMargin},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const ev = [];
  for (const seg of segments) {
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const raw = cleanText(seg.text);
    if (!raw) continue;

    let lines = [raw];
    if (wrap) {
      lines = splitTwoLinesBalanced(raw, maxLineLen);
      if (lines.length > 2) lines = lines.slice(0, 2);
    }

    const assText = assEscape(lines.join("\\N"));
    ev.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${assText}`);
  }

  return `${header}\n${ev.join("\n")}\n`;
}

// -------- endpoint --------

app.post("/render-captions", async (req, res) => {
  const startedAt = Date.now();
  const body = req.body || {};
  const fileId = String(body.fileId || "").trim();
  const workDir = fileId ? `/tmp/${fileId}-render` : `/tmp/render-${Date.now()}`;

  try {
    if (!BUCKET) return res.status(500).json({ error: "Missing BUCKET env var" });
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    let segments = body.segments;
    if (!segments) return res.status(400).json({ error: "Missing segments" });

    // Allow stringified JSON
    if (typeof segments === "string") {
      try {
        segments = JSON.parse(segments);
      } catch {
        return res.status(400).json({ error: "segments must be an array or valid JSON string" });
      }
    }
    if (!Array.isArray(segments)) return res.status(400).json({ error: "segments must be an array" });

    // chunk correction
    const segmentSeconds = body.segmentSeconds ?? body.chunkSeconds ?? 0;
    segments = applyChunkOffsets(segments, segmentSeconds);

    // normalize segments
    segments = segments
      .map((s) => ({
        start: Number(s.start),
        end: Number(s.end),
        text: cleanText(s.text),
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);

    if (!segments.length) return res.status(400).json({ error: "segments array empty after cleaning" });

    const wrap = body.wrap !== false;
    const maxLineLen = Number.isFinite(Number(body.maxLineLen)) ? Number(body.maxLineLen) : 20;
    const style = body.style || {};
    const outputPrefix = String(body.outputPrefix || OUTPUT_PREFIX_DEFAULT).replace(/^\/+|\/+$/g, "");

    safeMkdir(workDir);

    const inputPath = path.join(workDir, "input.mp4");
    const assPath = path.join(workDir, "captions.ass");
    const outputPath = path.join(workDir, "output.mp4");

    await downloadDriveFile(fileId, inputPath);
    const metaIn = getVideoMeta(inputPath);

    // Use actual video dimensions if detected; fall back to vertical
    const playResX = metaIn.width || 1080;
    const playResY = metaIn.height || 1920;

    const ass = buildAss({ segments, wrap, maxLineLen, style, playResX, playResY });
    fs.writeFileSync(assPath, ass, "utf8");

    // Burn subtitles
    const vf = `ass=${assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}`;

    const ffArgs = [
      "-y",
      "-i",
      inputPath,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ];

    execFileSync("ffmpeg", ffArgs, { stdio: "inherit" });

    const metaOut = getVideoMeta(outputPath);
    const destination = `${outputPrefix}/${fileId}.mp4`;
    const videoUrl = await uploadPublic(outputPath, destination, "video/mp4");

    return res.json({
      fileId,
      videoUrl,
      meta: {
        width: metaOut.width ?? metaIn.width,
        height: metaOut.height ?? metaIn.height,
        durationSec: metaOut.durationSec ?? metaIn.durationSec,
        segments: segments.length,
        elapsedMs: Date.now() - startedAt,
        bucket: BUCKET,
        destination,
      },
    });
  } catch (err) {
    console.error("render-captions error:", err);
    return res.status(500).json({
      error: err?.message || String(err),
      status: err?.code || err?.response?.status || 500,
      details: err?.response?.data,
    });
  } finally {
    safeRmdir(workDir);
  }
});

// IMPORTANT: listen on 0.0.0.0 for Cloud Run
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Caption renderer listening on ${PORT}`);
});
