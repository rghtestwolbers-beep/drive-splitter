import express from "express";
import fs from "fs";
import { execSync } from "child_process";
import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET;

const storage = new Storage();

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/split", async (req, res) => {
  const { fileId } = req.body;

  if (!fileId) return res.status(400).send("Missing fileId");

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  const drive = google.drive({ version: "v3", auth });

  const input = `/tmp/${fileId}.mp4`;
  const audio = `/tmp/${fileId}.mp3`;
  const outDir = `/tmp/chunks`;

  fs.mkdirSync(outDir, { recursive: true });

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

  execSync(`ffmpeg -i ${input} -vn -acodec libmp3lame ${audio}`);

  execSync(
    `ffmpeg -i ${audio} -f segment -segment_time 120 -c copy ${outDir}/part_%03d.mp3`
  );

  const files = fs.readdirSync(outDir);
  const urls = [];

  for (const file of files) {
    const destination = `chunks/${fileId}/${file}`;

    await storage.bucket(BUCKET).upload(`${outDir}/${file}`, {
      destination,
    });

    const [url] = await storage
      .bucket(BUCKET)
      .file(destination)
      .getSignedUrl({
        action: "read",
        expires: Date.now() + 3600 * 1000,
      });

    urls.push(url);
  }

  res.json({ chunks: urls });
});

app.listen(PORT, () => console.log("Running on", PORT));
