import express from "express";
import fs from "fs";
import { execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET;
const storage = new Storage();

async function splitHandler(req, res) {
  try {
    const { fileId, maxChunkMB = 24, bitrateKbps = 64 } = req.body;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });
    if (!BUCKET) return res.status(500).json({ error: "Missing BUCKET env var" });

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });

    const workDir = `/tmp/${fileId}`;
    fs.mkdirSync(workDir, { recursive: true });

    const input = `${workDir}/input`;
    const audio = `${workDir}/audio.mp3`;
    const outDir = `${workDir}/chunks`;
    fs.mkdirSync(outDir, { recursive: true });

    // download from Drive
    const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
    await new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(input);
      response.data.pipe(dest);
      dest.on("finish", resolve);
      dest.on("error", reject);
    });

    // encode audio at target bitrate
    execSync(`ffmpeg -y -i "${input}" -vn -ac 1 -ar 44100 -b:a ${bitrateKbps}k "${audio}"`, { stdio: "ignore" });

    // estimate segment duration to keep chunks under maxChunkMB
    const maxBytes = maxChunkMB * 1024 * 1024;
    const bytesPerSec = (bitrateKbps * 1000) / 8;
    const segmentSeconds = Math.max(15, Math.floor(maxBytes / bytesPerSec)); // minimum 15s

    execSync(
      `ffmpeg -y -i "${audio}" -f segment -segment_time ${segmentSeconds} -c copy "${outDir}/part_%03d.mp3"`,
      { stdio: "ignore" }
    );

    const files = fs.readdirSync(outDir).filter(f => f.endsWith(".mp3")).sort();
    const urls = [];

    for (const file of files) {
      const destination = `chunks/${fileId}/${file}`;
      await storage.bucket(BUCKET).upload(`${outDir}/${file}`, { destination });

      // IMPORTANT: this needs iam.serviceAccounts.signBlob permission (you already hit this)
      const [url] = await storage.bucket(BUCKET).file(destination).getSignedUrl({
        action: "read",
        expires: Date.now() + 3600 * 1000,
      });

      urls.push({ file, url });
    }

    return res.json({ fileId, maxChunkMB, bitrateKbps, segmentSeconds, count: urls.length, chunks: urls });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

// accept BOTH endpoints
app.post("/split", splitHandler);
app.post("/split-video", splitHandler);

app.listen(PORT, () => console.log(`Running on ${PORT}`));
