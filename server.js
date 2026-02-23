import express from "express";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET;

const storage = new Storage();

app.post("/split", async (req, res) => {
  try {
    const { fileId, maxChunkMB = 24, bitrateKbps = 64 } = req.body;

    if (!fileId) return res.status(400).send("Missing fileId");
    if (!BUCKET) return res.status(500).send("Missing BUCKET env var");

    // 🎯 Calculate seconds per chunk based on target size
    const segmentSeconds = Math.max(
      30,
      Math.floor((maxChunkMB * 8000) / bitrateKbps)
    );

    const workDir = `/tmp/${fileId}`;
    const input = `${workDir}/input`;
    const audio = `${workDir}/audio.mp3`;
    const outDir = `${workDir}/chunks`;

    fs.mkdirSync(outDir, { recursive: true });

    // 🔐 Drive auth (uses Cloud Run service account)
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });

    // ⬇️ Download file from Drive
    const response = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    await new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(input);
      response.data.pipe(dest);
      dest.on("finish", resolve);
      dest.on("error", reject);
    });

    // 🎵 Extract audio with predictable bitrate
    execSync(
      `ffmpeg -y -i "${input}" -vn -ac 1 -b:a ${bitrateKbps}k -ar 44100 "${audio}"`,
      { stdio: "ignore" }
    );

    // ✂️ Split into size-controlled chunks
    execSync(
      `ffmpeg -y -i "${audio}" -f segment -segment_time ${segmentSeconds} -c copy "${outDir}/part_%03d.mp3"`,
      { stdio: "ignore" }
    );

    const files = fs
      .readdirSync(outDir)
      .filter(f => f.endsWith(".mp3"))
      .sort();

    const results = [];

    for (const file of files) {
      const localPath = path.join(outDir, file);
      const destination = `chunks/${fileId}/${file}`;

      await storage.bucket(BUCKET).upload(localPath, { destination });

      const [url] = await storage
        .bucket(BUCKET)
        .file(destination)
        .getSignedUrl({
          action: "read",
          expires: Date.now() + 60 * 60 * 1000,
        });

      const sizeBytes = fs.statSync(localPath).size;

      results.push({
        file,
        sizeMB: +(sizeBytes / 1024 / 1024).toFixed(2),
        url,
      });
    }

    res.json({
      fileId,
      segmentSeconds,
      bitrateKbps,
      maxChunkMB,
      chunks: results,
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(PORT, () => console.log("Running on", PORT));
