app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ ok: true }));

import express from "express";
import fs from "fs";
import { execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json({ limit: "20mb" })); // body is small (only fileId), keep it low

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET;

const storage = new Storage();

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/split", async (req, res) => {
  try {
    const { fileId, segmentSeconds = 120 } = req.body;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });
    if (!BUCKET) return res.status(500).json({ error: "Missing BUCKET env var" });

    // Auth using Cloud Run service account (n8n-splitter-sa)
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });

    const workDir = `/tmp/${fileId}`;
    fs.mkdirSync(workDir, { recursive: true });

    const inputPath = `${workDir}/input`;
    const audioPath = `${workDir}/audio.mp3`;
    const chunksDir = `${workDir}/chunks`;
    fs.mkdirSync(chunksDir, { recursive: true });

    // Download file from Drive
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

    // Extract audio
    execSync(`ffmpeg -y -i "${inputPath}" -vn -acodec libmp3lame "${audioPath}"`, { stdio: "ignore" });

    // Split into chunks
    execSync(
      `ffmpeg -y -i "${audioPath}" -f segment -segment_time ${segmentSeconds} -c copy "${chunksDir}/part_%03d.mp3"`,
      { stdio: "ignore" }
    );

    const files = fs.readdirSync(chunksDir).filter(f => f.endsWith(".mp3")).sort();
    const urls = [];

    for (const file of files) {
      const destination = `chunks/${fileId}/${file}`;
      await storage.bucket(BUCKET).upload(`${chunksDir}/${file}`, { destination });

      const [url] = await storage.bucket(BUCKET).file(destination).getSignedUrl({
        action: "read",
        expires: Date.now() + 60 * 60 * 1000, // 1 hour
      });

      urls.push({ file, url });
    }

    res.json({ fileId, segmentSeconds, count: urls.length, chunks: urls });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
