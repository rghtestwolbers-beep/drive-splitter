// server.js (ESM)
// Caption renderer service (Drive -> Cloud Run -> GCS public URL)
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
//
// Notes:
// - Designed for 1080x1920 vertical social video styling.
// - Produces ASS subtitles (better control than SRT for TikTok styling).
// - Uploads to BUCKET and returns public URL: https://storage.googleapis.com/<BUCKET>/<destination>

import express from "express";
import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json({ limit: "25mb" })); // segments can be big-ish

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET; // set this to your PUBLIC bucket: n8n-socialclips-public
const DEFAULT_OUTPUT_PREFIX = process.env.OUTPUT_PREFIX || "captioned";

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

// Download file from Google Drive by fileId
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

// Upload to GCS (public bucket) and return public URL
async function uploadAndReturnPublicUrl(localPath, destination, contentType = "video/mp4") {
  if (!BUCKET) throw new Error("Missing BUCKET env var");

  const bucket = storage.bucket(BUCKET);
  await bucket.upload(localPath, {
    destination,
    resumable: false,
    validation: false,
    contentType,
  });

  // Bucket is public -> direct URL works without signing
  return `https://storage.googleapis.com/${BUCKET}/${destination}`;
}

// ---------- Caption formatting ----------

// Normalize text (avoid double spaces, optional comma spacing cleanup)
function cleanText(t) {
  return String(t || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " "); // non-breaking spaces
}

// Wrap into max 2 lines with maxLineLen (approx char count)
function wrapTwoLines(text, maxLineLen = 20) {
  const words = cleanText(text).split(" ").filter(Boolean);
  if (words.length <= 1) return [cleanText(text)];

  // greedy build lines, but keep max 2 lines
  const lines = [];
  let current = "";

  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length <= maxLineLen || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = w;
      if (lines.length === 1) {
        // continue for second line
        continue;
      } else {
        // already have 2 lines -> pack remainder into line2
        current = `${lines[1] ? lines[1] + " " : ""}${w}`;
      }
    }
  }
  if (current) lines.push(current);

  if (lines.length <= 2) return lines;

  // If we ended up with >2, merge into 2 lines:
  const first = lines[0];
  const rest = lines.slice(1).join(" ");
  return [first, rest];
}

// Balanced split: try to split into two lines near equal length
function balanceToTwoLines(text, maxLineLen = 20) {
  const cleaned = cleanText(text);
  if (cleaned.length <= maxLineLen) return [cleaned];

  const words = cleaned.split(" ").filter(Boolean);
  if (words.length <= 2) return wrapTwoLines(cleaned, maxLineLen);

  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    if (a.length > maxLineLen * 1.6) continue; // don't make line1 crazy long
    if (b.length > maxLineLen * 2.2) continue; // avoid insane line2
    const score = Math.abs(a.length - b.length);
    if (!best || score < best.score) best = { a, b, score };
  }

  if (best) {
    // enforce approximate max
    const a = best.a.length > maxLineLen ? wrapTwoLines(best.a, maxLineLen)[0] : best.a;
    const bLines = wrapTwoLines(best.b, maxLineLen);
    return [a, bLines.join(" ")];
  }

  return wrapTwoLines(cleaned, maxLineLen);
}

function toAssTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100); // centiseconds
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${hh}:${pad(mm)}:${pad(ss)}.${pad(cs)}`;
}

// Escape ASS special characters
function assEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

// Build ASS content with TikTok-like defaults
function buildAss({ segments, wrap, maxLineLen, style, playResX = 1080, playResY = 1920 }) {
  const s = style || {};
  const font = s.font || "Arial";
  const fontSize = Number.isFinite(Number(s.fontSize)) ? Number(s.fontSize) : 54; // TikTok-ish
  const bottomMargin = Number.isFinite(Number(s.bottomMargin)) ? Number(s.bottomMargin) : 220; // safe-area
  const outline = Number.isFinite(Number(s.outline)) ? Number(s.outline) : 3;
  const alignment = Number.isFinite(Number(s.alignment)) ? Number(s.alignment) : 2; // bottom-center
  const bold = s.bold === false ? 0 : -1; // ASS: -1 = bold, 0 = normal

  // White text + black outline
  // ASS colors: &HAABBGGRR
  const primary = "&H00FFFFFF"; // white
  const outlineColor = "&H00000000"; // black
  const backColor = "&H64000000"; // slight shadow/box alpha if you later want BorderStyle=3

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2", // smart wrap
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, " +
      "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${font},${fontSize},${primary},${primary},${outlineColor},${backColor},${bold},0,0,0,100,100,0,0,1,${outline},0,${alignment},80,80,${bottomMargin},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = [];
  for (const seg of segments) {
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const text = cleanText(seg.text);
    if (!text) continue;

    let lines = [text];
    if (wrap) {
      // balanced wrapping tends to look more TikTok
      lines = balanceToTwoLines(text, maxLineLen);
      if (lines.length > 2) lines = lines.slice(0, 2);
    }

    const assText = assEscape(lines.join("\\N"));
    events.push(
      `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${assText}`
    );
  }

  return `${header}\n${events.join("\n")}\n`;
}

function applyChunkOffsets(segments, segmentSeconds = 0) {
  // If segments include chunkIndex, add offsets: start += chunkIndex * segmentSeconds
  const ss = Number(segmentSeconds) || 0;
  if (!ss) return segments;

  return segments.map((s) => {
    const ci = Number(s.chunkIndex);
    if (!Number.isFinite(ci)) return s;
    return {
      ...s,
      start: Number(s.start) + ci * ss,
      end: Number(s.end) + ci * ss,
    };
  });
}

// ---------- Endpoint ----------

app.post("/render-captions", async (req, res) => {
  const startedAt = Date.now();
  try {
    if (!BUCKET) return res.status(500).json({ error: "Missing BUCKET env var" });

    const body = req.body || {};
    const fileId = String(body.fileId || "").trim();
    let segments = body.segments;

    if (!fileId) return res.status(400).json({ error: "Missing fileId" });
    if (!segments) return res.status(400).json({ error: "Missing segments" });

    // Allow segments to be passed as a JSON string
    if (typeof segments === "string") {
      try {
        segments = JSON.parse(segments);
      } catch {
        return res.status(400).json({ error: "segments must be an array or valid JSON string" });
      }
    }
    if (!Array.isArray(segments)) {
      return res.status(400).json({ error: "segments must be an array" });
    }

    // Optional chunk timing correction
    const segmentSeconds = body.segmentSeconds ?? body.chunkSeconds ?? 0;
    segments = applyChunkOffsets(segments, segmentSeconds);

    // Reduce to required fields + clean
    segments = segments
      .map((s) => ({
        start: Number(s.start),
        end: Number(s.end),
        text: cleanText(s.text),
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);

    if (segments.length === 0) {
      return res.status(400).json({ error: "segments array is empty after cleaning" });
    }

    const wrap = body.wrap !== false; // default true
    const maxLineLen = Number.isFinite(Number(body.maxLineLen)) ? Number(body.maxLineLen) : 20;
    const style = body.style || {};
    const outputPrefix = String(body.outputPrefix || DEFAULT_OUTPUT_PREFIX).replace(/^\/+|\/+$/g, "");

    const workDir = `/tmp/${fileId}-render`;
    safeMkdir(workDir);

    const inputPath = path.join(workDir, "input.mp4");
    const assPath = path.join(workDir, "captions.ass");
    const outputPath = path.join(workDir, "output.mp4");

    // 1) download original video
    await downloadDriveFile(fileId, inputPath);

    const metaIn = getVideoMeta(inputPath);

    // 2) build ASS (TikTok defaults: fontSize 54, maxLineLen 20, bottomMargin 220)
    const ass = buildAss({
      segments,
      wrap,
      maxLineLen,
      style,
      playResX: 1080,
      playResY: 1920,
    });
    fs.writeFileSync(assPath, ass, "utf8");

    // 3) burn subtitles with ffmpeg + libass
    // Note: subtitles burn requires re-encode video.
    // Use a sane preset for Cloud Run.
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

    // Show ffmpeg output in Cloud Run logs (super helpful)
    execFileSync("ffmpeg", ffArgs, { stdio: "inherit" });

    const metaOut = getVideoMeta(outputPath);

    // 4) upload to GCS public bucket
    const destination = `${outputPrefix}/${fileId}.mp4`;
    const videoUrl = await uploadAndReturnPublicUrl(outputPath, destination, "video/mp4");

    // 5) respond
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
        styleUsed: {
          font: style.font || "Arial",
          fontSize: Number.isFinite(Number(style.fontSize)) ? Number(style.fontSize) : 54,
          bottomMargin: Number.isFinite(Number(style.bottomMargin)) ? Number(style.bottomMargin) : 220,
          outline: Number.isFinite(Number(style.outline)) ? Number(style.outline) : 3,
          alignment: Number.isFinite(Number(style.alignment)) ? Number(style.alignment) : 2,
          bold: style.bold === false ? false : true,
          maxLineLen,
          wrap,
        },
      },
    });
  } catch (err) {
    console.error("render-captions error:", err);

    // Make Google API errors readable
    const status = err?.code || err?.response?.status || 500;
    const details = err?.response?.data;

    return res.status(500).json({
      error: err?.message || String(err),
      status,
      details,
    });
  } finally {
    // cleanup tmp
    const fileId = String(req.body?.fileId || "").trim();
    if (fileId) safeRmdir(`/tmp/${fileId}-render`);
  }
});

app.listen(PORT, () => console.log(`Caption renderer listening on ${PORT}`));
