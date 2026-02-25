// server.js (ESM)
// Caption renderer for n8n pipeline (Drive -> Cloud Run -> GCS signed URL)

import express from "express";
import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET;
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX || "captioned";

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

function getVideoInfo(filePath) {
  try {
    const info = ffprobeJson(filePath);
    const v = (info?.streams || []).find((s) => s.codec_type === "video");
    const width = Number(v?.width) || null;
    const height = Number(v?.height) || null;
    const durationSec = Number(info?.format?.duration);
    return {
      width,
      height,
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
    };
  } catch {
    return { width: null, height: null, durationSec: null };
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function srtTime(t) {
  const msTotal = Math.max(0, Math.round(t * 1000));
  const ms = msTotal % 1000;
  const sTotal = Math.floor(msTotal / 1000);
  const s = sTotal % 60;
  const mTotal = Math.floor(sTotal / 60);
  const m = mTotal % 60;
  const h = Math.floor(mTotal / 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, "0")}`;
}

// Minimal wrapping: enforce max 2 lines, try to keep within maxLineLen
function wrapToTwoLines(text, maxLineLen = 28) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return "";

// Better TikTok-style 2-line balancing (prevents huge single-line captions)
function balanceTwoLines(text, maxLen = 20) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= 2) return words.join(" ");

  let line1 = [];
  let line2 = [];
  let len = 0;

  for (const w of words) {
    const add = (line1.length ? 1 : 0) + w.length;
    if (len + add <= maxLen) {
      line1.push(w);
      len += add;
    } else {
      line2.push(w);
    }
  }

  // Rebalance so line2 isn't too short (prevents 1-word second line)
  while (
    line2.length > 0 &&
    line2.join(" ").length < Math.floor(maxLen * 0.45) &&
    line1.length > 2
  ) {
    line2.unshift(line1.pop());
  }

  if (!line2.length) return line1.join(" ");
  return `${line1.join(" ")}\\N${line2.join(" ")}`; // ASS newline
}
  
  // If already has line breaks, compress to <=2 lines
  const parts = t.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}\n${parts[1]}`;

  // If short enough, return as is
  if (t.length <= maxLineLen) return t;

  // Break on nearest space around midpoint, then re-wrap second line if needed
  const mid = Math.floor(t.length / 2);
  let cut = t.lastIndexOf(" ", mid);
  if (cut < 0) cut = t.indexOf(" ", mid);
  if (cut < 0) return t; // no spaces

  const line1 = t.slice(0, cut).trim();
  let line2 = t.slice(cut + 1).trim();

  // If second line still too long, try another cut inside line2
  if (line2.length > maxLineLen) {
    const mid2 = Math.floor(line2.length / 2);
    let cut2 = line2.lastIndexOf(" ", mid2);
    if (cut2 < 0) cut2 = line2.indexOf(" ", mid2);
    if (cut2 > 0) line2 = line2.slice(0, cut2).trim() + "…";
    else line2 = line2.slice(0, maxLineLen - 1).trim() + "…";
  }

  return `${line1}\n${line2}`;
}

// ASS timestamp format: H:MM:SS.cc (centiseconds)
function assTime(t) {
  const csTotal = Math.max(0, Math.round(t * 100)); // centiseconds
  const cs = csTotal % 100;
  const sTotal = Math.floor(csTotal / 100);
  const s = sTotal % 60;
  const mTotal = Math.floor(sTotal / 60);
  const m = mTotal % 60;
  const h = Math.floor(mTotal / 60);
  return `${h}:${pad2(m)}:${pad2(s)}.${String(cs).padStart(2, "0")}`;
}

// ASS colors are BBGGRR (&HBBGGRR&). We'll keep defaults.
function buildAss({ width, height, events, style }) {
  const PlayResX = width || 1080;
  const PlayResY = height || 1920;

  const font = style.font || "Arial";
  const alignment = Number(style.alignment ?? 2); // 2 = bottom-center
  const outline = Number(style.outline ?? 3);
  const shadow = Number(style.shadow ?? 0);

  // Resolution-aware defaults if not provided:
  const fontSize =
    style.fontSize != null
      ? Number(style.fontSize)
      : Math.round(PlayResY * 0.06); // ~6% of height
  const marginV =
    style.bottomMargin != null
      ? Number(style.bottomMargin)
      : Math.round(PlayResY * 0.09); // ~9% of height

  // ASS style fields:
  // Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,
  // Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,
  // BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  const PrimaryColour = style.highlightColor || "&H00FFFFFF&"; // highlight color
  const SecondaryColour = style.baseColor || "&H00FFFFFF&";   // base text color
  const OutlineColour = style.outlineColor || "&H00000000&"; // black
  const BackColour = style.backColor || "&H64000000&"; // slightly transparent black (mostly unused with BorderStyle=1)
  const Bold = style.bold === false ? 0 : 1;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${PlayResX}
PlayResY: ${PlayResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,${font},${fontSize},${PrimaryColour},${SecondaryColour},${OutlineColour},${BackColour},${Bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},80,80,${marginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  const body = events
    .map((e) => {
      const txt = String(e.text || "")
        .replace(/\r/g, "")
        .replace(/\n/g, "\\N") // ASS newline
        .replace(/{/g, "\\{")
        .replace(/}/g, "\\}");
      return `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Default,,0,0,0,,${txt}`;
    })
    .join("\n");

  return header + body + "\n";
}

// 🔹 Download video from Google Drive
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

// 🔹 Upload to GCS + signed URL
async function uploadAndSign(localPath, destination) {
  if (!BUCKET) throw new Error("Missing BUCKET env var");

  await storage.bucket(BUCKET).upload(localPath, {
    destination,
    resumable: false,
    validation: false,
  });

  const [url] = await storage.bucket(BUCKET).file(destination).getSignedUrl({
    action: "read",
    expires: Date.now() + 60 * 60 * 1000, // 1 hour
  });

  return url;
}

function normalizeSegments(rawSegments, opts) {
  const segments = Array.isArray(rawSegments) ? rawSegments : [];

  const chunkSeconds = Number(opts.chunkSeconds ?? 0); // if using chunkIndex offsets
  const defaultOffset = Number(opts.offsetSeconds ?? 0);

  const out = segments
    .map((s) => {
      const start = Number(s.start);
      const end = Number(s.end);
      const text = String(s.text || "").trim();

      const chunkIndex = s.chunkIndex != null ? Number(s.chunkIndex) : null;
      const extra =
        Number.isFinite(chunkSeconds) && chunkSeconds > 0 && Number.isFinite(chunkIndex)
          ? chunkIndex * chunkSeconds
          : 0;

      const offset = Number.isFinite(defaultOffset) ? defaultOffset : 0;

      return {
        start: (Number.isFinite(start) ? start : 0) + extra + offset,
        end: (Number.isFinite(end) ? end : 0) + extra + offset,
        text,
      };
    })
    .filter((s) => s.text && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // Clamp negatives and tiny weirdness
  for (const s of out) {
    if (s.start < 0) s.start = 0;
    if (s.end < 0) s.end = 0;
    if (s.end <= s.start) s.end = s.start + 0.2;
  }

  return out;
}

/**
 * POST /render-captions
 * Body:
 * {
 *   "fileId": "driveVideoId",
 *   "segments": [{start,end,text,chunkIndex?}, ...],
 *   "style": { font, fontSize, outline, shadow, bottomMargin, alignment, bold, maxLineLen, wrap },
 *   "wrap": true,
 *   "maxLineLen": 28,
 *   "chunkSeconds": 0,       // optional, for chunkIndex timing correction
 *   "offsetSeconds": 0       // optional
 * }
 */
app.post("/render-captions", async (req, res) => {
  const startedAt = Date.now();
  const { fileId } = req.body || {};
  let { segments } = req.body || {};

  const style = req.body?.style || {};
  const wrap = req.body?.wrap ?? true;
  const maxLineLen = Number(req.body?.maxLineLen ?? style.maxLineLen ?? 28);

  if (!fileId) return res.status(400).json({ error: "Missing fileId" });
  if (!BUCKET) return res.status(500).json({ error: "Missing BUCKET env var" });

  // Handle case where segments arrived stringified
  if (typeof segments === "string") {
    try {
      segments = JSON.parse(segments);
    } catch {
      return res.status(400).json({ error: "segments is a string but not valid JSON" });
    }
  }
  if (!Array.isArray(segments)) {
    return res.status(400).json({
      error: "segments must be an array",
      got: typeof segments,
    });
  }

  const workDir = `/tmp/${fileId}-render`;
  const inputPath = path.join(workDir, "input.mp4");
  const assPath = path.join(workDir, "subs.ass");
  const outputPath = path.join(workDir, "captioned.mp4");

  try {
    safeMkdir(workDir);

    // 1) Download original video
    await downloadDriveFile(fileId, inputPath);

    // 2) Probe for resolution (for auto font sizing)
    const info = getVideoInfo(inputPath);

    // 3) Normalize segments + wrap text
    const normalized = normalizeSegments(segments, {
      chunkSeconds: req.body?.chunkSeconds,
      offsetSeconds: req.body?.offsetSeconds,
    }).map((s) => ({
      ...s,
      text: wrap ? balanceTwoLines(s.text, maxLineLen) : s.text,
    }));

    if (!normalized.length) {
      return res.status(400).json({ error: "No usable segments after normalization" });
    }

    // 4) Build ASS + write to disk
    const ass = buildAss({
      width: info.width,
      height: info.height,
      events: normalized,
      style: {
        ...style,
        maxLineLen,
      },
    });
    fs.writeFileSync(assPath, ass, "utf8");

    // 5) Burn subtitles using libass
    // Re-encode video for compatibility + faststart
    const vf = `ass=${assPath.replace(/\\/g, "/")}`;
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
      "18",
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

    execFileSync("ffmpeg", ffArgs, { stdio: "ignore" });

    // 6) Upload captioned video + signed URL
    const destination = `${OUTPUT_PREFIX}/${fileId}.mp4`;
    const videoUrl = await uploadAndSign(outputPath, destination);

    return res.json({
      fileId,
      videoUrl,
      meta: {
        width: info.width,
        height: info.height,
        durationSec: info.durationSec,
        segments: normalized.length,
        elapsedMs: Date.now() - startedAt,
        bucket: BUCKET,
        destination,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err?.message || String(err),
    });
  } finally {
    safeRmdir(workDir);
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
