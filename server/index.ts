import express, { Request, Response } from 'express';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import { Readable } from "stream";
import { promisify } from "util";
import { pipeline } from "stream/promises";
import axios from 'axios';
import FormData from 'form-data';
import { OAuth2Client } from "google-auth-library";
import cookieParser from "cookie-parser";
import { execFileSync, execSync } from 'child_process';

const streamPipeline = promisify(pipeline);
const upload = multer({ dest: path.join(__dirname, '../tmp_uploads') });
const BATCH_SIZE = 2;
const prisma = new PrismaClient();

const app = express();
const port = 3000;

app.use(cookieParser());
app.use(
  cors({
    origin: [
      "http://127.0.0.1",
      "http://127.0.0.1:80",
      "http://localhost",
      "http://localhost:80",
      "https://clip-flip.com",
      "https://www.clip-flip.com",
      "http://56.228.95.201",
      "http://56.228.95.201:80",
    ],
    credentials: true,
  })
);
app.use(express.json());

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "1005873499572-tfcfkhv3bhl9o8mbddvpnvsdi7ua5ele.apps.googleusercontent.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Directories
const tempBaseDir = path.resolve(__dirname, "../storage/temp/videos");
const tempThumbDir = path.resolve(__dirname, "../storage/temp/thumbnails");
const outputDir = path.resolve(__dirname, "../video1/new");
const outputDirThumbnails = path.resolve(__dirname, "../video1/new/thumbnails");

// Segment payload interface
interface SegmentItem {
  tempKey: string;
  tempVideoName: string;
  tempFirstThumbName: string;
  tempMiddleThumbName: string;
  title: string;
  startTime: number;
  endTime: number;
}

// Ensure all required directories exist
[tempBaseDir, tempThumbDir, outputDir, outputDirThumbnails].forEach((dir) => {
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
});

function moveFileCrossDevice(src: string, dest: string) {
  try {
    fsSync.renameSync(src, dest);
  } catch (err: any) {
    if (err.code === "EXDEV") {
      fsSync.copyFileSync(src, dest);
      fsSync.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

function getVideoDuration(filePath: string): number {
  const output = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]).toString();
  return parseFloat(output);
}

// ============================================================================
// SHARED BUSINESS LOGIC: Moves temp files to final paths & updates Database
// ============================================================================
async function processSegmentBatch(segments: SegmentItem[], tagId?: number | string) {
  return await prisma.$transaction(async (tx) => {
    const results = [];

    for (const seg of segments) {
      const srcVideo = path.join(tempBaseDir, seg.tempVideoName);
      const srcFirstThumb = path.join(tempThumbDir, seg.tempFirstThumbName);
      const srcMidThumb = path.join(tempThumbDir, seg.tempMiddleThumbName);

      if (!fsSync.existsSync(srcVideo)) {
        throw new Error(`Temp video file missing: ${seg.tempVideoName}`);
      }

      const newVideo = await tx.newVideo.create({
        data: {
          title: seg.title,
          startTime: seg.startTime,
          endTime: seg.endTime,
          tags: tagId
            ? { connect: [{ id: Number(tagId) }] }
            : undefined,
        },
        include: { tags: true },
      });

      const segmentId = newVideo.id;
      const destVideo = path.join(outputDir, `${segmentId}.mp4`);
      const destFirstThumb = path.join(outputDirThumbnails, `${segmentId}_first.jpg`);
      const destMidThumb = path.join(outputDirThumbnails, `${segmentId}_middle.jpg`);

      if (!fsSync.existsSync(outputDir)) fsSync.mkdirSync(outputDir, { recursive: true });
      if (!fsSync.existsSync(outputDirThumbnails)) fsSync.mkdirSync(outputDirThumbnails, { recursive: true });

      fsSync.renameSync(srcVideo, destVideo);
      if (fsSync.existsSync(srcFirstThumb)) fsSync.renameSync(srcFirstThumb, destFirstThumb);
      if (fsSync.existsSync(srcMidThumb)) fsSync.renameSync(srcMidThumb, destMidThumb);

      results.push(newVideo);
    }

    return results;
  });
}

app.post('/videos', async (req: Request, res: Response) => {
  try {
    const { id, studio, title, models, tag } = req.body;

    const videoId = Number(id);
    if (!videoId || isNaN(videoId)) {
      return res.status(400).json({ error: 'Valid video ID is required' });
    }

    const createData: any = {};
    const updateData: any = {};

    if (title !== undefined) {
      createData.title = title;
      updateData.title = title;
    }

    if (studio !== undefined) {
      createData.studio = studio;
      updateData.studio = studio;
    }

    if (models !== undefined) {
      const modelNames = Array.isArray(models) ? models : [models];
      const connectOrCreateModels = modelNames.map((name: string) => ({
        where: { name },
        create: { name }
      }));

      createData.models = { connectOrCreate: connectOrCreateModels };
      updateData.models = { connectOrCreate: connectOrCreateModels };
    }

    if (tag && typeof tag === 'object' && typeof tag.id === 'number') {
      const tagConnectArray = [{ id: tag.id }];
      createData.tags = { connect: tagConnectArray };
      updateData.tags = { connect: tagConnectArray };
    }

    const video = await prisma.video.upsert({
      where: { id: videoId },
      create: createData,
      update: updateData,
      include: {
        tags: true,
        models: true
      }
    });

    res.json(video);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Failed to process video',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.post('/videos/remove-tag', async (req: Request, res: Response) => {
  try {
    const { videoId, tagTitle } = req.body;

    if (!videoId || !tagTitle) {
      return res.status(400).json({ error: 'videoId and tagTitle are required' });
    }

    const video = await prisma.video.update({
      where: { id: Number(videoId) },
      data: {
        tags: {
          disconnect: {
            title: tagTitle
          }
        }
      },
      include: {
        tags: true,
        models: true
      }
    });

    res.json(video);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove tag' });
  }
});

app.get('/videos/:id', async (req: Request, res: Response) => {
  const videoId = parseInt(req.params.id);

  try {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: {
        tags: true,
        models: true,
        reactions: {
          select: {
            userId: true,
            type: true,
          },
        },
      },
    });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(video);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

app.get("/seo-tags/:tag", async (req: Request, res: Response) => {
  try {
    const tag = req.params.tag.toLowerCase().trim();

    const allowedTags = [
      "anal", "amateur", "blowjob", "panties", "ass", "cfnm", "cum",
      "cowgirl", "gangbang", "doggy", "deepthroat", "handjob", "choking",
      "feet", "big boobs", "shemale", "pregnant"
    ];

    if (!allowedTags.includes(tag)) {
      return res.status(404).json({ error: "Tag page not found" });
    }

    const allClips = await prisma.video.findMany({
      where: {
        tags: {
          some: {
            title: {
              equals: tag,
            },
          },
        },
      },
      include: {
        tags: true,
        models: true,
      },
      orderBy: {
        id: "desc",
      },
    });

    const groupedByTitle = new Map<string, typeof allClips>();

    for (const clip of allClips) {
      const title = clip.title?.trim();
      if (!title) continue;

      if (!groupedByTitle.has(title)) {
        groupedByTitle.set(title, []);
      }
      groupedByTitle.get(title)!.push(clip);
    }

    const videos = Array.from(groupedByTitle.entries()).map(
      ([title, videoClips], index) => {
        const firstClip = videoClips[0];

        return {
          index: index + 1,
          title,
          slug: title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, ""),
          models: firstClip.models.map((model) => model.name),
          tags: Array.from(
            new Set(firstClip.tags.map((tagItem) => tagItem.title))
          ),
          clipCount: videoClips.length,
          clipIds: videoClips.map((clip) => clip.id),
        };
      }
    );

    const titleFromSlug = (slug: string): string => {
      return slug
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    };

    const groupedClipCount = videos.reduce(
      (sum, video) => sum + video.clipCount,
      0
    );

    res.json({
      tag,
      title: `${titleFromSlug(tag)} Porn Clips - Free ${titleFromSlug(tag)} Videos | ClipFlip`,
      description:
        `Browse free ${titleFromSlug(tag)} porn clips on ClipFlip. Watch adult video previews and open clips in the endless random player.`,
      heading: `${titleFromSlug(tag)} Porn Clips`,
      intro:
        `Browse ${titleFromSlug(tag)} porn clips grouped by video title. Hover previews to see available clips, then open the endless player.`,
      canonicalUrl: `https://clip-flip.com/${tag}/`,
      videoCount: videos.length,
      clipCount: groupedClipCount,
      videoBaseUrl: "http://127.0.0.1",
      thumbnailBaseUrl: "https://clip-flip.com/video/thumbnails/",
      videos,
    });
  } catch (error) {
    console.error("Error building SEO tag page data:", error);
    res.status(500).json({
      error: "Failed to build SEO tag page data",
    });
  }
});

app.get("/videos", async (req: Request, res: Response) => {
  const search = req.query.search?.toString() || "";
  const userId = Number(req.cookies.userId);

  const videos = await prisma.video.findMany({
    where: search
      ? {
        OR: [
          { title: { contains: search } },
          { studio: { contains: search } },
          { models: { some: { name: { contains: search } } } },
          { tags: { some: { title: { contains: search } } } },
        ],
      }
      : undefined,
    include: {
      tags: true,
      models: true,
      reactions: {
        select: {
          userId: true,
          type: true,
        },
      },
    },
    orderBy: { id: "desc" },
  });

  const mappedVideos = videos.map((video) => {
    const likes = video.reactions.filter((r) => r.type === "like").length;
    const dislikes = video.reactions.filter((r) => r.type === "dislike").length;
    const myReaction = userId
      ? video.reactions.find((r) => r.userId === userId)?.type ?? null
      : null;

    return {
      ...video,
      likes,
      dislikes,
      myReaction,
      reactions: undefined,
    };
  });

  res.json(mappedVideos);
});

app.get("/new", async (req: Request, res: Response) => {
  try {
    const videos = await prisma.newVideo.findMany({
      orderBy: { id: "asc" },
      include: {
        tags: true,
      }
    });

    res.json(videos);
  } catch (error) {
    console.error("Failed to fetch new videos:", error);
    res.status(500).json({
      error: "Failed to fetch new videos",
    });
  }
});

app.get('/tags', async (req, res) => {
  try {
    const search =
      typeof req.query.search === 'string'
        ? req.query.search.trim()
        : undefined;

    const tags = await prisma.tag.findMany({
      where: search
        ? {
          title: {
            contains: search,
          },
        }
        : undefined,
      orderBy: {
        title: 'asc',
      },
      include: {
        _count: {
          select: {
            videos: true,
          },
        },
      },
    });

    const result = tags.map((tag) => ({
      ...tag,
      videoCount: tag._count.videos,
      _count: undefined,
    }));

    res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

app.post('/videos/by-tags', async (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'Tags must be a non-empty array' });
  }
  try {
    const videos = await prisma.video.findMany({
      where: {
        AND: tags.map(tagTitle => ({
          tags: {
            some: { title: tagTitle }
          }
        }))
      },
      include: {
        tags: true,
        models: true
      }
    });
    res.json(videos);
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

app.get("/ai", async (_req, res) => {
  console.log("AI started");

  try {
    const dir = "./segments";
    const outDir = "./filtered";

    await fs.mkdir(outDir, { recursive: true });
    const files = await fs.readdir(dir);

    const groups = new Map<string, { first?: string; middle?: string }>();

    for (const file of files) {
      const match = file.match(/^(\d+)_(first|middle)\.jpg$/);
      if (!match) continue;

      const [, id, type] = match;
      if (!groups.has(id)) groups.set(id, {});
      groups.get(id)![type as "first" | "middle"] = file;
    }

    for (const [id, pair] of groups) {
      const videoPath = path.join(dir, `${id}.mp4`);

      if (!pair.first || !pair.middle) {
        await fs.rm(videoPath, { force: true });
        if (pair.first) await fs.rm(path.join(dir, pair.first), { force: true });
        if (pair.middle) await fs.rm(path.join(dir, pair.middle), { force: true });
        continue;
      }

      const hiveRes = await axios.post(
        "https://api.thehive.ai/api/v3/chat/completions",
        {
          model: "hive/vision-language-model",
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `
Analyze the images.

Return ONLY valid JSON:

{
  "ass_visible": true | false,
  "panties_visible": true | false
}

Rules:
- "ass_visible": true ONLY if female buttocks are clearly visible (not just shape)
- "panties_visible": true ONLY if underwear (panties) is clearly identifiable
- If unsure about ANY → return false
- Do NOT guess
`
                },
                {
                  type: "media_url",
                  media_url: {
                    url: `data:image/jpeg;base64,${(await fs.readFile(path.join(dir, pair.middle))).toString("base64")}`,
                  },
                },
              ],
            },
          ],
        },
        {
          headers: {
            authorization: `Bearer ${process.env.HIVE_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const raw = hiveRes.data.choices?.[0]?.message?.content;
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw.map((c: any) => c.text || "").join("")
            : "";

      let parsed: any = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { ass_visible: false, panties_visible: false };
      }

      const match = Boolean(parsed.ass_visible) && Boolean(parsed.panties_visible);

      if (match) {
        await fs.copyFile(videoPath, path.join(outDir, `${id}.mp4`));
        await fs.rm(videoPath, { force: true });
      } else {
        await fs.rm(videoPath, { force: true });
      }

      await fs.rm(path.join(dir, pair.first), { force: true });
      await fs.rm(path.join(dir, pair.middle), { force: true });
    }

    res.json("done");
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.get('/', async (req, res) => {
  res.json({ ok: true });
});

app.post(
  "/upload-video",
  upload.array("files"),
  async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    try {
      const segmentLength = 4;
      const processedSegments: SegmentItem[] = [];
      const { tagId, title } = req.body;

      if (!fsSync.existsSync(tempBaseDir)) fsSync.mkdirSync(tempBaseDir, { recursive: true });
      if (!fsSync.existsSync(tempThumbDir)) fsSync.mkdirSync(tempThumbDir, { recursive: true });

      for (const file of files) {
        const duration = getVideoDuration(file.path);

        for (let start = 0; start + segmentLength <= duration; start += segmentLength) {
          const end = start + segmentLength;
          const mid = ((start + end) / 2).toFixed(2);

          const tempKey = crypto.randomUUID();
          const tempVideoName = `${tempKey}.mp4`;
          const tempFirstThumbName = `${tempKey}_first.jpg`;
          const tempMiddleThumbName = `${tempKey}_middle.jpg`;

          const videoOut = path.join(tempBaseDir, tempVideoName);
          const firstOut = path.join(tempThumbDir, tempFirstThumbName);
          const middleOut = path.join(tempThumbDir, tempMiddleThumbName);

          execFileSync(
            "ffmpeg",
            [
              "-y",
              "-ss", String(start),
              "-i", file.path,
              "-t", String(segmentLength),
              "-c:v", "libx264",
              "-preset", "medium",
              "-crf", "22",
              "-maxrate", "6M",
              "-bufsize", "12M",
              "-c:a", "aac",
              "-b:a", "128k",
              "-vf", "scale=min(1920\\,iw):-2",
              videoOut,
            ],
            { stdio: "pipe" }
          );

          execFileSync(
            "ffmpeg",
            [
              "-y",
              "-ss", String(start),
              "-i", file.path,
              "-strict", "unofficial",
              "-frames:v", "1",
              firstOut,
            ],
            { stdio: "pipe" }
          );

          execFileSync(
            "ffmpeg",
            [
              "-y",
              "-ss", String(mid),
              "-i", file.path,
              "-strict", "unofficial",
              "-frames:v", "1",
              middleOut,
            ],
            { stdio: "pipe" }
          );

          if (!fsSync.existsSync(videoOut)) {
            throw new Error(`FFmpeg ran but segment file was not created: ${videoOut}`);
          }

          processedSegments.push({
            tempKey,
            tempVideoName,
            tempFirstThumbName,
            tempMiddleThumbName,
            title: title + "," + file.originalname,
            startTime: start,
            endTime: end,
          });
        }

        if (fsSync.existsSync(file.path)) {
          fsSync.unlinkSync(file.path);
        }
      }

      const BATCH_SIZE = 10;
      const confirmResults = [];

      for (let i = 0; i < processedSegments.length; i += BATCH_SIZE) {
        const batch = processedSegments.slice(i, i + BATCH_SIZE);
        const formData = new FormData();

        formData.append("metadata", JSON.stringify({ segments: batch, tagId }));

        for (const seg of batch) {
          const videoPath = path.join(tempBaseDir, seg.tempVideoName);
          const firstThumbPath = path.join(tempThumbDir, seg.tempFirstThumbName);
          const midThumbPath = path.join(tempThumbDir, seg.tempMiddleThumbName);

          formData.append("videos", fsSync.createReadStream(videoPath), seg.tempVideoName);
          if (fsSync.existsSync(firstThumbPath)) {
            formData.append("thumbs", fsSync.createReadStream(firstThumbPath), seg.tempFirstThumbName);
          }
          if (fsSync.existsSync(midThumbPath)) {
            formData.append("thumbs", fsSync.createReadStream(midThumbPath), seg.tempMiddleThumbName);
          }
        }

        const confirmResponse = await axios.post(
          "https://clip-flip.com/api/confirm-segments",
          formData,
          {
            headers: {
              ...formData.getHeaders(),
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }
        );

        if (confirmResponse.data?.videos) {
          confirmResults.push(...confirmResponse.data.videos);
        }
      }

      return res.json({
        success: true,
        message: "Upload processed and segments confirmed successfully",
        videos: confirmResults,
      });
    } catch (error) {
      console.error("Error uploading video:", error);
      return res.status(500).json({
        error: "Failed to process uploaded video segments",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

const confirmUpload = multer({ dest: tempBaseDir });

app.post(
  "/confirm-segments",
  confirmUpload.fields([
    { name: "videos", maxCount: 20 },
    { name: "thumbs", maxCount: 40 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const uploadedVideos = files["videos"] || [];
      const uploadedThumbs = files["thumbs"] || [];

      const { segments, tagId } = JSON.parse(req.body.metadata) as {
        segments: SegmentItem[];
        tagId?: number | string;
      };

      if (!segments || segments.length === 0) {
        return res.status(400).json({ error: "No segment metadata provided" });
      }

      const videoFileMap = new Map(uploadedVideos.map((f) => [f.originalname, f.path]));
      const thumbFileMap = new Map(uploadedThumbs.map((f) => [f.originalname, f.path]));

      const createdRecords = await prisma.$transaction(async (tx) => {
        const results = [];

        for (const seg of segments) {
          const tempVideoPath = videoFileMap.get(seg.tempVideoName);
          const tempFirstThumbPath = thumbFileMap.get(seg.tempFirstThumbName);
          const tempMidThumbPath = thumbFileMap.get(seg.tempMiddleThumbName);

          if (!tempVideoPath || !fsSync.existsSync(tempVideoPath)) {
            throw new Error(`Temp video binary missing for file: ${seg.tempVideoName}`);
          }

          const newVideo = await tx.newVideo.create({
            data: {
              title: seg.title,
              startTime: seg.startTime,
              endTime: seg.endTime,
              tags: tagId ? { connect: [{ id: Number(tagId) }] } : undefined,
            },
            include: { tags: true },
          });

          const segmentId = newVideo.id;
          const destVideo = path.join(outputDir, `${segmentId}.mp4`);
          const destFirstThumb = path.join(outputDirThumbnails, `${segmentId}_first.jpg`);
          const destMidThumb = path.join(outputDirThumbnails, `${segmentId}_middle.jpg`);

          if (!fsSync.existsSync(outputDir)) fsSync.mkdirSync(outputDir, { recursive: true });
          if (!fsSync.existsSync(outputDirThumbnails)) fsSync.mkdirSync(outputDirThumbnails, { recursive: true });

          moveFileCrossDevice(tempVideoPath, destVideo);

          if (tempFirstThumbPath && fsSync.existsSync(tempFirstThumbPath)) {
            moveFileCrossDevice(tempFirstThumbPath, destFirstThumb);
          }
          if (tempMidThumbPath && fsSync.existsSync(tempMidThumbPath)) {
            moveFileCrossDevice(tempMidThumbPath, destMidThumb);
          }

          results.push(newVideo);
        }

        return results;
      });

      return res.json({
        success: true,
        message: "Segments confirmed and saved successfully",
        videos: createdRecords,
      });
    } catch (error) {
      console.error("Error confirming segment binaries:", error);
      return res.status(500).json({
        error: "Failed to confirm and persist video segments",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

app.delete("/video/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const outputDir = path.join(__dirname, "../video1/new");
    const thumbnailsDir = path.join(outputDir, "thumbnails");

    const videoFile = path.join(outputDir, `${id}.mp4`);
    const firstImage = path.join(thumbnailsDir, `${id}_first.jpg`);
    const middleImage = path.join(thumbnailsDir, `${id}_middle.jpg`);

    await prisma.newVideo.delete({
      where: { id },
    });

    const deleteIfExists = (file: string) => {
      if (!fsSync.existsSync(file)) return;
      try {
        fsSync.unlinkSync(file);
      } catch (e) {
        console.error("Failed to delete file:", e);
      }
    };

    deleteIfExists(videoFile);
    deleteIfExists(firstImage);
    deleteIfExists(middleImage);

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to delete video",
    });
  }
});

app.post("/video/:id/approve", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const PROJECT_ROOT = path.resolve(__dirname, "..");

    const pendingDir = path.join(PROJECT_ROOT, "video1/new");
    const pendingThumbDir = path.join(PROJECT_ROOT, "video1/new/thumbnails");
    const approvedDir = path.join(PROJECT_ROOT, "video1");
    const approvedThumbDir = path.join(PROJECT_ROOT, "video/thumbnails");

    const sourceVideo = path.join(pendingDir, `${id}.mp4`);
    const sourceFirstThumb = path.join(pendingThumbDir, `${id}_first.jpg`);

    const newVideo = await prisma.newVideo.findUnique({
      where: { id },
      include: {
        tags: true,
      },
    });

    if (!newVideo) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (!fsSync.existsSync(sourceVideo)) {
      return res.status(400).json({
        error: `Source video file missing on disk: ${sourceVideo}`,
      });
    }

    if (!fsSync.existsSync(approvedDir)) {
      fsSync.mkdirSync(approvedDir, { recursive: true });
    }
    if (!fsSync.existsSync(approvedThumbDir)) {
      fsSync.mkdirSync(approvedThumbDir, { recursive: true });
    }

    const createdVideo = await prisma.$transaction(async (tx) => {
      const video = await tx.video.create({
        data: {
          title: newVideo.title,
          tags: {
            connect: newVideo.tags.map((tag) => ({ id: tag.id })),
          },
        },
      });

      await tx.newVideo.delete({
        where: { id },
      });

      return video;
    });

    const newId = createdVideo.id;
    const destVideo = path.join(approvedDir, `${newId}.mp4`);
    const destFirstThumb = path.join(approvedThumbDir, `${newId}.jpg`);

    moveFileCrossDevice(sourceVideo, destVideo);

    if (fsSync.existsSync(sourceFirstThumb)) {
      moveFileCrossDevice(sourceFirstThumb, destFirstThumb);
    }

    return res.json({
      success: true,
      message: `Video ${id} approved successfully and saved as ID ${newId}`,
      video: createdVideo,
    });
  } catch (error) {
    console.error("Error approving video:", error);
    return res.status(500).json({
      error: "Failed to approve video",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/download", async (req, res) => {
  const urlParamIndex = req.originalUrl.indexOf("url=");
  if (urlParamIndex === -1) {
    return res.status(400).json({ error: "Provide a valid URL (?url=...)" });
  }

  const initialUrl = req.originalUrl.substring(urlParamIndex + 4);

  let parsedUrl;
  try {
    parsedUrl = new URL(initialUrl);
  } catch (err) {
    return res.status(400).json({ error: "Invalid URL provided." });
  }

  const outputDir = path.join(__dirname, "../segments");
  await fs.mkdir(outputDir, { recursive: true });

  const fetchHeaders = {
    "accept": "*/*",
    "accept-language": "en,lt;q=0.9",
    "cache-control": "no-cache",
    "origin": "https://www.pornhub.com",
    "pragma": "no-cache",
    "priority": "u=1, i",
    "referer": "https://www.pornhub.com/",
    "sec-ch-ua": '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
  };

  res.json({ message: "Download loop started in the background!", outputDir });

  (async () => {
    let currentIndex = 1;
    let downloaded = 0;
    let hasMore = true;

    try {
      while (hasMore) {
        const currentPathname = parsedUrl.pathname.replace(/seg-\d+/, `seg-${currentIndex}`);
        const currentUrl = `${parsedUrl.origin}${currentPathname}${parsedUrl.search}`;

        console.log(`[Segment ${currentIndex}] Fetching...`);

        const response = await fetch(currentUrl, { headers: fetchHeaders });

        if (!response.ok) {
          console.log(`❌ Stopped at segment ${currentIndex}. Status: ${response.status}`);
          hasMore = false;
          break;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const fileName = `segment_${String(currentIndex).padStart(5, "0")}.mp4`;
        const tempFilePath = path.join(outputDir, `temp_${fileName}`);
        const finalFilePath = path.join(outputDir, fileName);

        await fs.writeFile(tempFilePath, buffer);

        try {
          console.log(`[Segment ${currentIndex}] Processing with FFmpeg...`);
          execFileSync(
            "ffmpeg",
            [
              "-y",
              "-i", tempFilePath,
              "-c:v", "libx264",
              "-preset", "medium",
              "-crf", "22",
              "-maxrate", "6M",
              "-bufsize", "12M",
              "-c:a", "aac",
              "-b:a", "128k",
              "-vf", "scale=min(1920\\,iw):-2",
              finalFilePath,
            ],
            { stdio: "pipe" }
          );

          await fs.unlink(tempFilePath);
          console.log(`✅ Processed and saved ${fileName}`);
          downloaded++;
          currentIndex++;
        } catch (ffmpegError) {
          console.error(
            `❌ FFmpeg failed on ${fileName}:`,
            ffmpegError instanceof Error ? ffmpegError.message : String(ffmpegError)
          );
          break;
        }
      }

      console.log(`\n🎉 Download finished! Total segments grabbed: ${downloaded}`);
    } catch (err) {
      console.error(
        "Error during background download:",
        err instanceof Error ? err.message : String(err)
      );
    }
  })();
});

app.post("/auth/google", async (req: Request, res: Response) => {
  try {
    const { credential } = req.body;

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload?.sub || !payload?.email) {
      return res.status(401).json({ error: "Invalid Google token" });
    }

    const user = await prisma.user.upsert({
      where: { googleId: payload.sub },
      update: {
        email: payload.email,
        name: payload.name ?? null,
        picture: payload.picture ?? null,
      },
      create: {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name ?? null,
        picture: payload.picture ?? null,
      },
    });

    res.cookie("userId", user.id, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    return res.json({ success: true, user });
  } catch (err) {
    return res.status(401).json({ success: false, error: "Login failed" });
  }
});

app.get("/auth/me", async (req, res) => {
  const userId = Number(req.cookies.userId);

  if (!userId) {
    return res.json({ loggedIn: false, user: null });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  res.json({
    loggedIn: !!user,
    user,
  });
});

app.get("/videos/favorites/:userId", async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);

    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    const videos = await prisma.video.findMany({
      where: {
        reactions: {
          some: {
            userId,
          },
        },
      },
      include: {
        tags: true,
      },
      orderBy: {
        id: "desc",
      },
    });

    res.json(videos);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to fetch favorite videos",
    });
  }
});

app.post("/auth/logout", (req: Request, res: Response) => {
  res.clearCookie("userId");
  return res.json({ success: true });
});

app.post("/videos/:id/reaction", async (req: Request, res: Response) => {
  const userId = Number(req.cookies.userId);
  const videoId = Number(req.params.id);
  const { type } = req.body;

  if (!userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  if (!["like", "dislike"].includes(type)) {
    return res.status(400).json({ error: "Invalid reaction" });
  }

  const existing = await prisma.videoReaction.findUnique({
    where: {
      userId_videoId: {
        userId,
        videoId,
      },
    },
  });

  if (existing?.type === type) {
    await prisma.videoReaction.delete({
      where: {
        userId_videoId: {
          userId,
          videoId,
        },
      },
    });
  } else {
    await prisma.videoReaction.upsert({
      where: {
        userId_videoId: {
          userId,
          videoId,
        },
      },
      update: {
        type,
      },
      create: {
        userId,
        videoId,
        type,
      },
    });
  }

  const likes = await prisma.videoReaction.count({
    where: {
      videoId,
      type: "like",
    },
  });

  const dislikes = await prisma.videoReaction.count({
    where: {
      videoId,
      type: "dislike",
    },
  });

  const reaction = await prisma.videoReaction.findUnique({
    where: {
      userId_videoId: {
        userId,
        videoId,
      },
    },
  });

  return res.json({
    likes,
    dislikes,
    reaction: reaction?.type ?? null,
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running at http://0.0.0.0:${port}`);
});
