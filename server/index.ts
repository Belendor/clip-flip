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
import crypto from 'crypto';

const streamPipeline = promisify(pipeline);
const upload = multer({ dest: path.join(__dirname, '../tmp_uploads') });
const BATCH_SIZE = 2;
const prisma = new PrismaClient();

const app = express();
const port = 3000;

app.set('trust proxy', true);
app.use(cookieParser());
app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
        origin.includes("clip-flip.com") ||
        origin.includes("56.228.95.201")
      ) {
        callback(null, true);
      } else {
        callback(null, true);
      }
    },
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
  model?: string;
  seriesNr?: number;
  seriesTotal?: number;
  startTime: number;
  endTime: number;
}

// Ensures video segments from the same source clip/title maintain chronological sequence
// even if individual segments were approved or added out of order
function sortVideosPreservingSequence<T extends { id: number; title?: string | null; seriesNr?: number | null; startTime?: number | null }>(items: T[]): T[] {
  const groupMap = new Map<string, T[]>();
  const soloItems: T[] = [];

  for (const item of items) {
    const groupKey = item.title ? item.title.trim() : "";
    if (groupKey) {
      const list = groupMap.get(groupKey) || [];
      list.push(item);
      groupMap.set(groupKey, list);
    } else {
      soloItems.push(item);
    }
  }

  interface VideoGroup {
    anchorId: number;
    items: T[];
  }

  const allGroups: VideoGroup[] = [];

  for (const [_, groupList] of groupMap.entries()) {
    groupList.sort((a, b) => {
      const sA = a.seriesNr ?? (a.startTime != null ? a.startTime : 0);
      const sB = b.seriesNr ?? (b.startTime != null ? b.startTime : 0);
      if (sA !== sB) return sA - sB;
      const tA = a.startTime ?? 0;
      const tB = b.startTime ?? 0;
      if (tA !== tB) return tA - tB;
      return a.id - b.id;
    });

    const minId = Math.min(...groupList.map((v) => v.id));
    allGroups.push({ anchorId: minId, items: groupList });
  }

  for (const solo of soloItems) {
    allGroups.push({ anchorId: solo.id, items: [solo] });
  }

  allGroups.sort((a, b) => a.anchorId - b.anchorId);
  return allGroups.flatMap((g) => g.items);
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
  try {
    const output = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]).toString().trim();
    const val = parseFloat(output);
    return isNaN(val) ? 0 : val;
  } catch (err) {
    console.error("ffprobe error on file:", filePath, err);
    return 0;
  }
}

interface SegmentRange {
  start: number;
  end: number;
  duration: number;
}

function calculateSegmentRanges(duration: number, maxSegments = 10): SegmentRange[] {
  if (duration <= 5.05 && duration >= 1.95) {
    return [{ start: 0, end: duration, duration }];
  }
  if (duration > 5.05 && duration < 6.0) {
    const half = parseFloat((duration / 2).toFixed(2));
    return [
      { start: 0, end: half, duration: half },
      { start: half, end: duration, duration: parseFloat((duration - half).toFixed(2)) },
    ];
  }
  const segmentLength = 4;
  const ranges: SegmentRange[] = [];
  let start = 0;
  while (start < duration && ranges.length < maxSegments) {
    const remaining = duration - start;
    if (remaining < 1.95) {
      if (ranges.length > 0 && (ranges[ranges.length - 1].duration + remaining) <= 5.05) {
        const last = ranges[ranges.length - 1];
        last.end = duration;
        last.duration = parseFloat((last.end - last.start).toFixed(2));
      }
      break;
    }
    if (remaining <= 5.05) {
      ranges.push({ start, end: duration, duration: parseFloat(remaining.toFixed(2)) });
      break;
    }
    const end = start + segmentLength;
    ranges.push({ start, end, duration: segmentLength });
    start = end;
  }
  return ranges;
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
    const { id, studio, title, models, source, tag } = req.body;

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

    if (source !== undefined) {
      const cleanSource = source ? String(source).trim() : null;
      createData.source = cleanSource;
      updateData.source = cleanSource;
    }

    if (models !== undefined) {
      const rawNames = Array.isArray(models) ? models : [models];
      const modelNames = rawNames
        .map((m: any) => typeof m === "string" ? m.trim() : (m?.name || "").trim())
        .filter((name: string) => name && name.length > 0);

      if (modelNames.length === 0) {
        updateData.models = { set: [] };
      } else {
        const connectOrCreateModels = modelNames.map((name: string) => ({
          where: { name },
          create: { name }
        }));
        createData.models = { connectOrCreate: connectOrCreateModels };
        updateData.models = { set: [], connectOrCreate: connectOrCreateModels };
      }
    }

    if (tag) {
      let tagId = typeof tag === 'object' && tag.id ? Number(tag.id) : null;
      let tagTitle = typeof tag === 'object' ? (tag.title || tag.name) : (typeof tag === 'string' ? tag : null);

      if (tagTitle && typeof tagTitle === 'string' && tagTitle.trim()) {
        const cleanTitle = tagTitle.trim();
        const tagConnectOrCreate = [{
          where: { title: cleanTitle },
          create: { title: cleanTitle }
        }];
        createData.tags = { connectOrCreate: tagConnectOrCreate };
        updateData.tags = { connectOrCreate: tagConnectOrCreate };
      } else if (tagId && !isNaN(tagId) && tagId > 0) {
        const tagConnectArray = [{ id: tagId }];
        createData.tags = { connect: tagConnectArray };
        updateData.tags = { connect: tagConnectArray };
      }
    }

    const video = await prisma.video.upsert({
      where: { id: videoId },
      create: createData,
      update: updateData,
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

    const likes = video.reactions.filter((r) => r.type === "like").length;
    const dislikes = video.reactions.filter((r) => r.type === "dislike").length;
    const mapped = {
      ...video,
      likes,
      dislikes,
      reactions: video.reactions,
    };

    res.json(mapped);
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
      },
    });

    res.json(video);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove tag' });
  }
});

app.get('/videos/tags-by-title', async (req: Request, res: Response) => {
  try {
    const rawTitle = req.query.title?.toString().trim();
    if (!rawTitle) {
      return res.json([]);
    }

    const videos = await prisma.video.findMany({
      where: {
        title: rawTitle,
      },
      select: {
        id: true,
        tags: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    const tagCounts = new Map<string, { id: number; title: string; count: number }>();
    for (const v of videos) {
      for (const t of v.tags) {
        if (!t.title) continue;
        const key = t.title.toLowerCase().trim();
        const existing = tagCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          tagCounts.set(key, { id: t.id, title: t.title.trim(), count: 1 });
        }
      }
    }

    const result = Array.from(tagCounts.values()).sort(
      (a, b) => b.count - a.count || a.title.localeCompare(b.title)
    );
    res.json(result);
  } catch (error) {
    console.error('Error fetching tags by title:', error);
    res.status(500).json({ error: 'Failed to fetch tags by title' });
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
      thumbnailBaseUrl: "https://clip-flip.com/thumbnail/videos/",
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
  const sort = req.query.sort?.toString() || "";
  const modelQuery = req.query.model?.toString()?.trim() || "";
  const rawUserId = req.cookies.userId || req.headers["x-user-id"];
  const userId = Number(rawUserId);

  let blacklistTags: string[] = [];
  if (userId && !isNaN(userId)) {
    try {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { blacklist: true } });
      if (u?.blacklist) blacklistTags = JSON.parse(u.blacklist);
    } catch (_) {}
  }

  const whereClause: any = {};
  if (modelQuery) {
    whereClause.models = {
      some: {
        name: { equals: modelQuery },
      },
    };
  }
  if (search) {
    whereClause.OR = [
      { title: { contains: search } },
      { studio: { contains: search } },
      { models: { some: { name: { contains: search } } } },
      { tags: { some: { title: { contains: search } } } },
    ];
  }
  if (blacklistTags.length > 0) {
    whereClause.NOT = {
      tags: {
        some: {
          title: {
            in: blacklistTags,
          },
        },
      },
    };
  }

  const videos = await prisma.video.findMany({
    where: Object.keys(whereClause).length > 0 ? whereClause : undefined,
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
    orderBy: { id: "asc" },
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
      reactions: video.reactions,
    };
  });

  if (sort === "liked" || sort === "favorite" || sort === "favorites") {
    const targetUserId = Number(req.query.userId) || userId;
    if (targetUserId) {
      const userLiked = mappedVideos.filter((v) =>
        v.reactions?.some((r: any) => r.userId === targetUserId && r.type === "like")
      );
      userLiked.sort((a, b) => a.id - b.id);
      return res.json(userLiked);
    }
    const likedOnly = mappedVideos.filter((v) => v.likes > 0);
    likedOnly.sort((a, b) => {
      if (b.likes !== a.likes) {
        return b.likes - a.likes; // Most liked first
      }
      return a.id - b.id; // Natural order (2, then 3, then 4)
    });
    return res.json(likedOnly);
  }

  if (sort === "trending" || sort === "likes" || sort === "rating") {
    const trendingOnly = mappedVideos.filter((v) => v.likes > 0);
    trendingOnly.sort((a, b) => {
      if (b.likes !== a.likes) {
        return b.likes - a.likes;
      }
      return a.id - b.id;
    });
    return res.json(trendingOnly);
  }

  if (sort === "oldest" || sort === "lowest" || sort === "lowest_likes" || sort === "least_liked") {
    const lowestOnly = [...mappedVideos];
    lowestOnly.sort((a, b) => {
      if (a.likes !== b.likes) {
        return a.likes - b.likes; // lowest likes first (0, then 1, 2...)
      }
      return a.id - b.id; // Natural order (1, 2, 3...)
    });
    return res.json(lowestOnly);
  }

  const sequenceOrderedVideos = sortVideosPreservingSequence(mappedVideos);
  res.json(sequenceOrderedVideos);
});

app.get("/new", async (req: Request, res: Response) => {
  try {
    const videos = await prisma.newVideo.findMany({
      orderBy: { id: "asc" },
      include: {
        tags: true,
      }
    });

    const sequenceOrderedNew = sortVideosPreservingSequence(videos);
    res.json(sequenceOrderedNew);
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

app.get('/models', async (req: Request, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
    const models = await prisma.model.findMany({
      where: search ? { name: { contains: search } } : undefined,
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { videos: true },
        },
      },
    });

    const result = models
      .map((model) => ({
        id: model.id,
        name: model.name.trim(),
        alias: model.alias,
        source: model.source || `https://www.redgifs.com/users/${encodeURIComponent(model.name.trim().toLowerCase().replace(/\s+/g, ''))}`,
        videoCount: model._count.videos,
      }))
      .filter((m) => m.name.length > 0);

    // Deduplicate by lowercase name if any duplicates exist in DB
    const seen = new Map<string, typeof result[0]>();
    for (const m of result) {
      const lower = m.name.toLowerCase();
      if (!seen.has(lower)) {
        seen.set(lower, m);
      } else {
        const existing = seen.get(lower)!;
        existing.videoCount = (existing.videoCount || 0) + (m.videoCount || 0);
        if (m.source && !existing.source) existing.source = m.source;
      }
    }

    res.status(200).json(Array.from(seen.values()));
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

app.get('/models/:name', async (req: Request, res: Response) => {
  try {
    const rawName = decodeURIComponent(req.params.name).trim();
    const rawUserId = req.cookies.userId || req.headers["x-user-id"];
    const userId = Number(rawUserId);

    const model = await prisma.model.findFirst({
      where: {
        name: { equals: rawName },
      },
      include: {
        videos: {
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
          orderBy: { id: "asc" },
        },
      },
    });

    if (!model) {
      return res.status(404).json({ error: "Model not found" });
    }

    const mappedVideos = model.videos.map((video) => {
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
        reactions: video.reactions,
      };
    });

    const sequenceOrderedVideos = sortVideosPreservingSequence(mappedVideos);

    res.json({
      id: model.id,
      name: model.name.trim(),
      alias: model.alias,
      source: model.source || `https://www.redgifs.com/users/${encodeURIComponent(model.name.trim().toLowerCase().replace(/\s+/g, ''))}`,
      videoCount: sequenceOrderedVideos.length,
      videos: sequenceOrderedVideos,
    });
  } catch (error) {
    console.error('Error fetching model by name:', error);
    res.status(500).json({ error: 'Failed to fetch model' });
  }
});

app.post('/models', async (req: Request, res: Response) => {
  try {
    const { name, source, alias } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Model name is required' });
    }
    const cleanName = name.trim();
    const model = await prisma.model.upsert({
      where: { name: cleanName },
      update: {
        source: source !== undefined ? (source ? String(source).trim() : null) : undefined,
        alias: alias !== undefined ? (alias ? String(alias).trim() : null) : undefined,
      },
      create: {
        name: cleanName,
        source: source ? String(source).trim() : null,
        alias: alias ? String(alias).trim() : null,
      },
    });
    res.json(model);
  } catch (error) {
    console.error('Error saving model:', error);
    res.status(500).json({ error: 'Failed to save model' });
  }
});

app.post('/videos/by-tags', async (req, res) => {
  const { tags } = req.body;
  const rawUserId = req.cookies.userId || req.headers["x-user-id"];
  const userId = Number(rawUserId);

  let blacklistTags: string[] = [];
  if (userId && !isNaN(userId)) {
    try {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { blacklist: true } });
      if (u?.blacklist) blacklistTags = JSON.parse(u.blacklist);
    } catch (_) {}
  }

  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'Tags must be a non-empty array' });
  }
  try {
    const whereClause: any = {
      AND: tags.map(tagTitle => ({
        tags: {
          some: { title: tagTitle }
        }
      }))
    };
    if (blacklistTags.length > 0) {
      whereClause.NOT = {
        tags: {
          some: {
            title: {
              in: blacklistTags,
            },
          },
        },
      };
    }
    const videos = await prisma.video.findMany({
      where: whereClause,
      include: {
        tags: true,
        models: true
      },
      orderBy: { id: "asc" }
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

    const cleanupFiles = (paths: string[]) => {
      for (const p of paths) {
        try {
          if (fsSync.existsSync(p)) fsSync.unlinkSync(p);
        } catch (_) {}
      }
    };

    try {
      const { tagId, title, userId: bodyUserId } = req.body;
      const uploaderId =
        req.cookies?.userId && !isNaN(Number(req.cookies.userId))
          ? Number(req.cookies.userId)
          : bodyUserId && !isNaN(Number(bodyUserId))
            ? Number(bodyUserId)
            : null;

      const isProduction =
        process.env.NODE_ENV === "production" ||
        fsSync.existsSync("/var/www/clipflip") ||
        Boolean(req.headers.host && (req.headers.host.includes("clip-flip.com") || req.headers.host.includes("56.228.95.201")));

      if (!fsSync.existsSync(tempBaseDir)) fsSync.mkdirSync(tempBaseDir, { recursive: true });
      if (!fsSync.existsSync(tempThumbDir)) fsSync.mkdirSync(tempThumbDir, { recursive: true });
      if (!fsSync.existsSync(outputDir)) fsSync.mkdirSync(outputDir, { recursive: true });
      if (!fsSync.existsSync(outputDirThumbnails)) fsSync.mkdirSync(outputDirThumbnails, { recursive: true });

      // Strict validation for production uploads: must be clips between 2s-5s and <= 5MB
      if (isProduction) {
        for (const file of files) {
          if (file.size > 5 * 1024 * 1024) {
            cleanupFiles(files.map((f) => f.path));
            return res.status(400).json({
              error: `Video is too heavy: "${file.originalname}" is ${(file.size / (1024 * 1024)).toFixed(2)} MB. Maximum allowed size is 5 MB.`,
            });
          }

          const duration = getVideoDuration(file.path);
          if (duration > 5.05) {
            cleanupFiles(files.map((f) => f.path));
            return res.status(400).json({
              error: `Video is too long: "${file.originalname}" is ${duration.toFixed(1)}s. Clips must be 5 seconds or shorter (allowed range: 2s–5s).`,
            });
          }
          if (duration < 1.95) {
            cleanupFiles(files.map((f) => f.path));
            return res.status(400).json({
              error: `Video is too short: "${file.originalname}" is ${duration.toFixed(1)}s. Clips must be at least 2 seconds (allowed range: 2s–5s).`,
            });
          }
        }

        // On production: process clips directly without heavy slicing
        const createdOnProd = [];
        for (const file of files) {
          const duration = getVideoDuration(file.path);
          const mid = (duration / 2).toFixed(2);
          const tempKey = crypto.randomUUID();
          const firstOut = path.join(tempThumbDir, `${tempKey}_first.jpg`);
          const middleOut = path.join(tempThumbDir, `${tempKey}_middle.jpg`);

          execFileSync(
            "ffmpeg",
            ["-y", "-ss", "0", "-i", file.path, "-strict", "unofficial", "-frames:v", "1", firstOut],
            { stdio: "pipe" }
          );

          execFileSync(
            "ffmpeg",
            ["-y", "-ss", String(mid), "-i", file.path, "-strict", "unofficial", "-frames:v", "1", middleOut],
            { stdio: "pipe" }
          );

          const videoTitle = title && String(title).trim() ? `${String(title).trim()},${file.originalname}` : file.originalname;

          const newVideo = await prisma.newVideo.create({
            data: {
              title: videoTitle,
              startTime: 0,
              endTime: duration,
              seriesNr: 1,
              seriesTotal: 1,
              userId: uploaderId && !isNaN(uploaderId) ? uploaderId : undefined,
              tags: tagId ? { connect: [{ id: Number(tagId) }] } : undefined,
            },
            include: { tags: true },
          });

          const segmentId = newVideo.id;
          const destVideo = path.join(outputDir, `${segmentId}.mp4`);
          const destFirstThumb = path.join(outputDirThumbnails, `${segmentId}_first.jpg`);
          const destMidThumb = path.join(outputDirThumbnails, `${segmentId}_middle.jpg`);

          moveFileCrossDevice(file.path, destVideo);
          if (fsSync.existsSync(firstOut)) moveFileCrossDevice(firstOut, destFirstThumb);
          if (fsSync.existsSync(middleOut)) moveFileCrossDevice(middleOut, destMidThumb);

          createdOnProd.push(newVideo);
        }

        return res.json({
          success: true,
          message: "Clips verified and uploaded to production successfully",
          videos: createdOnProd,
        });
      }

      // Local instance upload: slices video into 4s segments and sends batches to prod
      const segmentLength = 4;
      const processedSegments: SegmentItem[] = [];

      for (const file of files) {
        const duration = getVideoDuration(file.path);

        const ranges = calculateSegmentRanges(duration, 10);
        const totalSegments = ranges.length;

        for (let idx = 0; idx < ranges.length; idx++) {
          const range = ranges[idx];
          const segNr = idx + 1;
          const mid = ((range.start + range.end) / 2).toFixed(2);

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
              "-ss", String(range.start),
              "-i", file.path,
              "-t", String(range.duration),
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
              "-ss", String(range.start),
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

          const videoTitle = title && String(title).trim() ? `${String(title).trim()},${file.originalname}` : file.originalname;

          processedSegments.push({
            tempKey,
            tempVideoName,
            tempFirstThumbName,
            tempMiddleThumbName,
            title: videoTitle,
            seriesNr: segNr,
            seriesTotal: totalSegments,
            startTime: range.start,
            endTime: range.end,
          });
        }

        if (fsSync.existsSync(file.path)) {
          fsSync.unlinkSync(file.path);
        }
      }

      if (processedSegments.length === 0) {
        return res.status(400).json({
          error: "No valid video segments could be generated. Uploaded videos must be at least 2 seconds long.",
        });
      }

      const BATCH_SIZE = 10;
      const confirmResults = [];

      for (let i = 0; i < processedSegments.length; i += BATCH_SIZE) {
        const batch = processedSegments.slice(i, i + BATCH_SIZE);
        const formData = new FormData();

        formData.append("metadata", JSON.stringify({ segments: batch, tagId, userId: uploaderId }));

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
            timeout: 180000,
          }
        );

        if (confirmResponse.data?.videos) {
          confirmResults.push(...confirmResponse.data.videos);
        }

        // Clean up temp segment binaries on local machine after successful transfer
        for (const seg of batch) {
          const videoPath = path.join(tempBaseDir, seg.tempVideoName);
          const firstThumbPath = path.join(tempThumbDir, seg.tempFirstThumbName);
          const midThumbPath = path.join(tempThumbDir, seg.tempMiddleThumbName);
          if (fsSync.existsSync(videoPath)) fsSync.unlinkSync(videoPath);
          if (fsSync.existsSync(firstThumbPath)) fsSync.unlinkSync(firstThumbPath);
          if (fsSync.existsSync(midThumbPath)) fsSync.unlinkSync(midThumbPath);
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

// Helper to query RedGIFs metadata (uploader/model, canonical ID, tags, mediaUrl)
async function fetchRedGifsDetails(url: string): Promise<{ uploader?: string; videoId?: string; title?: string; tags?: string[]; mediaUrl?: string }> {
  const match =
    url.match(/redgifs\.com\/(?:watch\/|ifr\/)([a-zA-Z0-9]+)/i) ||
    url.match(/redgifs\.com\/(?:[a-zA-Z0-9_\/]*\/)?([a-zA-Z0-9]+)(?:-mobile|-silent)?\.(?:m4s|mp4|webm)/i);

  if (!match) {
    try {
      const u = new URL(url);
      const name = path.parse(path.basename(u.pathname)).name;
      return { videoId: name, title: name };
    } catch (_) {
      return {};
    }
  }

  const rawId = match[1];
  try {
    const authRes = await axios.get("https://api.redgifs.com/v2/auth/temporary", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });
    const token = authRes.data?.token;
    if (!token) return { videoId: rawId, title: rawId };

    const gifRes = await axios.get(`https://api.redgifs.com/v2/gifs/${rawId.toLowerCase()}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    const gif = gifRes.data?.gif;
    if (!gif) return { videoId: rawId, title: rawId };

    let casedId = rawId;
    if (gif.urls?.hd) {
      const hdMatch = gif.urls.hd.match(/redgifs\.com\/([a-zA-Z0-9]+)\.mp4/i);
      if (hdMatch) casedId = hdMatch[1];
    }

    const uploader = gif.userName || undefined;
    const title = uploader ? `${uploader},${casedId}` : casedId;

    return {
      uploader,
      videoId: casedId,
      title,
      tags: gif.tags || [],
      mediaUrl: gif.urls?.hd || undefined,
    };
  } catch (_) {
    return { videoId: rawId, title: rawId };
  }
}

// Duplicate defence: check if a video with the same title or video ID already exists in DB
async function checkTitleExists(
  titleToCheck?: string,
  videoIdToCheck?: string
): Promise<{ exists: boolean; inLocation?: "new" | "approved"; title?: string; id?: number }> {
  if (!titleToCheck && !videoIdToCheck) return { exists: false };

  const conditions: any[] = [];
  if (titleToCheck && titleToCheck.trim()) {
    conditions.push({ title: titleToCheck.trim() });
  }
  if (videoIdToCheck && videoIdToCheck.trim() && videoIdToCheck.trim().length > 3) {
    conditions.push({ title: { contains: videoIdToCheck.trim() } });
  }

  if (conditions.length === 0) return { exists: false };

  // Check if any matching video exists in New or Video
  const existingInNew = await prisma.newVideo.findFirst({
    where: { OR: conditions },
    select: { id: true, title: true, seriesNr: true, seriesTotal: true },
  });

  const existingInVideo = await prisma.video.findFirst({
    where: { OR: conditions },
    select: { id: true, title: true, seriesNr: true, seriesTotal: true },
  });

  const foundItem = existingInNew || existingInVideo;
  if (!foundItem) return { exists: false };

  // If the found video was part of a multi-segment series, check whether all segments were actually uploaded
  const expectedTotal = foundItem.seriesTotal;
  if (expectedTotal && expectedTotal > 1) {
    const [countInNew, countInVideo] = await Promise.all([
      prisma.newVideo.count({ where: { OR: conditions } }),
      prisma.video.count({ where: { OR: conditions } }),
    ]);
    const totalFound = countInNew + countInVideo;
    if (totalFound < expectedTotal) {
      // Incomplete upload! Not all segments exist yet, allow upload so remaining segments can be completed
      return { exists: false };
    }
  }

  if (existingInNew) {
    return {
      exists: true,
      inLocation: "new",
      title: existingInNew.title || titleToCheck,
      id: existingInNew.id,
    };
  }

  if (existingInVideo) {
    return {
      exists: true,
      inLocation: "approved",
      title: existingInVideo.title || titleToCheck,
      id: existingInVideo.id,
    };
  }

  return { exists: false };
}

// Endpoint to inspect RedGIFs metadata (returns uploader, title, tags, and duplicate status)
app.get("/redgifs-info", async (req: Request, res: Response) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!rawUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }
  try {
    const details = await fetchRedGifsDetails(rawUrl);
    const duplicate = await checkTitleExists(details.title, details.videoId);
    return res.json({
      ...details,
      duplicate,
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to retrieve RedGIFs info" });
  }
});

// Endpoint to check if a title/video ID already exists (duplicate defence)
app.get("/check-duplicate", async (req: Request, res: Response) => {
  const title = typeof req.query.title === "string" ? req.query.title.trim() : undefined;
  const videoId = typeof req.query.videoId === "string" ? req.query.videoId.trim() : undefined;
  const url = typeof req.query.url === "string" ? req.query.url.trim() : undefined;

  let effectiveTitle = title;
  let effectiveVideoId = videoId;

  if (url) {
    try {
      const details = await fetchRedGifsDetails(url);
      if (!effectiveTitle) effectiveTitle = details.title;
      if (!effectiveVideoId) effectiveVideoId = details.videoId;
    } catch (_) {}
  }

  const result = await checkTitleExists(effectiveTitle, effectiveVideoId);
  return res.json(result);
});

// Helper for downloading video from remote URL
async function downloadRemoteMedia(url: string, destPath: string): Promise<{ finalUrl: string; uploader?: string; videoId?: string; autoTitle?: string; tags?: string[] }> {
  let finalUrl = url.trim();
  let uploader: string | undefined;
  let videoId: string | undefined;
  let autoTitle: string | undefined;
  let tags: string[] = [];

  try {
    const detail = await fetchRedGifsDetails(finalUrl);
    if (detail.mediaUrl) finalUrl = detail.mediaUrl;
    uploader = detail.uploader;
    videoId = detail.videoId;
    autoTitle = detail.title;
    if (detail.tags) tags = detail.tags;
  } catch (_) {}

  const response = await axios({
    method: "GET",
    url: finalUrl,
    responseType: "stream",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Referer: "https://www.redgifs.com/",
    },
    timeout: 180000,
  });

  const writer = fsSync.createWriteStream(destPath);
  response.data.pipe(writer);

  await new Promise<void>((resolve, reject) => {
    writer.on("finish", () => {
      writer.close();
      resolve();
    });
    writer.on("error", (err) => {
      try { if (fsSync.existsSync(destPath)) fsSync.unlinkSync(destPath); } catch (_) {}
      reject(err);
    });
  });

  return { finalUrl, uploader, videoId, autoTitle, tags };
}

// Ingest video directly from link(s) (e.g. RedGIFs .m4s / .mp4) -> download -> slice -> upload to prod -> delete
app.post("/upload-url", async (req: Request, res: Response) => {
  const { url, urls, title, tagId, tags: bodyTags, maxSegments = 10 } = req.body;

  const rawList: string[] = [];
  if (Array.isArray(urls)) {
    rawList.push(...urls);
  } else if (typeof urls === "string") {
    rawList.push(...urls.split(/[\r\n,]+/).map((s: string) => s.trim()).filter(Boolean));
  }
  if (typeof url === "string" && url.trim()) {
    rawList.push(...url.trim().split(/[\r\n,]+/).map((s: string) => s.trim()).filter(Boolean));
  }

  const cleanUrls = Array.from(new Set(rawList.map((u) => u.trim()))).filter(
    (u) => u.startsWith("http://") || u.startsWith("https://")
  );

  if (cleanUrls.length === 0) {
    return res.status(400).json({ error: "Please provide at least one valid video URL (e.g. https://media.redgifs.com/...)" });
  }

  if (!fsSync.existsSync(tempBaseDir)) fsSync.mkdirSync(tempBaseDir, { recursive: true });
  if (!fsSync.existsSync(tempThumbDir)) fsSync.mkdirSync(tempThumbDir, { recursive: true });

  const uploaderId =
    req.cookies?.userId && !isNaN(Number(req.cookies.userId))
      ? Number(req.cookies.userId)
      : req.body.userId && !isNaN(Number(req.body.userId))
        ? Number(req.body.userId)
        : null;

  const segmentLength = 4;
  const processedSegments: SegmentItem[] = [];
  const tempFilesToClean: string[] = [];
  const skippedDuplicates: Array<{ title: string; videoId?: string; location?: string; reason: string }> = [];

  const cleanupAll = () => {
    for (const f of tempFilesToClean) {
      try {
        if (fsSync.existsSync(f)) fsSync.unlinkSync(f);
      } catch (_) {}
    }
  };

  try {
    for (let uIdx = 0; uIdx < cleanUrls.length; uIdx++) {
      const sourceUrl = cleanUrls[uIdx];

      // Pre-check duplicate before download to save bandwidth and CPU
      let preInfo: any = null;
      try {
        preInfo = await fetchRedGifsDetails(sourceUrl);
      } catch (_) {}

      const candidateTitle = title && String(title).trim() ? String(title).trim() : preInfo?.title;
      if (candidateTitle || preInfo?.videoId) {
        const dupCheck = await checkTitleExists(candidateTitle, preInfo?.videoId);
        if (dupCheck.exists) {
          console.log(`[upload-url] 🛡️ Duplicate blocked before download: "${dupCheck.title}" already exists in ${dupCheck.inLocation}! Skipping.`);
          skippedDuplicates.push({
            title: dupCheck.title || candidateTitle,
            videoId: preInfo?.videoId,
            location: dupCheck.inLocation,
            reason: `Already exists in ${dupCheck.inLocation === 'new' ? 'New tab (pending review)' : 'Video library'}`,
          });
          continue;
        }
      }

      const rawTempKey = crypto.randomUUID();
      const rawTempPath = path.join(tempBaseDir, `raw_${rawTempKey}.mp4`);
      tempFilesToClean.push(rawTempPath);

      console.log(`[upload-url] Downloading (${uIdx + 1}/${cleanUrls.length}): ${sourceUrl}`);
      const { finalUrl, uploader, videoId, autoTitle } = await downloadRemoteMedia(sourceUrl, rawTempPath);

      const duration = getVideoDuration(rawTempPath);
      console.log(`[upload-url] Downloaded successfully! Duration: ${duration.toFixed(1)}s (Uploader: ${uploader || 'none'})`);

      const urlObj = new URL(finalUrl);
      const urlFileName = path.basename(urlObj.pathname);
      const fallbackTitle = path.parse(urlFileName).name || `Clip ${uIdx + 1}`;
      const baseTitle =
        title && String(title).trim()
          ? String(title).trim()
          : (autoTitle || fallbackTitle);

      // Post-download duplicate double-check with resolved title and ID
      const postDupCheck = await checkTitleExists(baseTitle, videoId);
      if (postDupCheck.exists) {
        console.log(`[upload-url] 🛡️ Duplicate blocked post-download: "${baseTitle}" already exists in ${postDupCheck.inLocation}! Skipping.`);
        skippedDuplicates.push({
          title: baseTitle,
          videoId,
          location: postDupCheck.inLocation,
          reason: `Already exists in ${postDupCheck.inLocation === 'new' ? 'New tab (pending review)' : 'Video library'}`,
        });
        try { if (fsSync.existsSync(rawTempPath)) fsSync.unlinkSync(rawTempPath); } catch (_) {}
        continue;
      }

      const ranges = calculateSegmentRanges(duration, Number(maxSegments) || 10);
      const totalSegments = ranges.length;

      for (let idx = 0; idx < ranges.length; idx++) {
        const range = ranges[idx];
        const segNr = idx + 1;
        const mid = ((range.start + range.end) / 2).toFixed(2);

        const tempKey = crypto.randomUUID();
        const tempVideoName = `${tempKey}.mp4`;
        const tempFirstThumbName = `${tempKey}_first.jpg`;
        const tempMiddleThumbName = `${tempKey}_middle.jpg`;

        const videoOut = path.join(tempBaseDir, tempVideoName);
        const firstOut = path.join(tempThumbDir, tempFirstThumbName);
        const middleOut = path.join(tempThumbDir, tempMiddleThumbName);

        tempFilesToClean.push(videoOut, firstOut, middleOut);

        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-ss", String(range.start),
            "-i", rawTempPath,
            "-t", String(range.duration),
            "-c:v", "libx264",
            "-preset", "fast",
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

        execFileSync("ffmpeg", ["-y", "-ss", String(range.start), "-i", rawTempPath, "-strict", "unofficial", "-frames:v", "1", firstOut], { stdio: "pipe" });
        execFileSync("ffmpeg", ["-y", "-ss", String(mid), "-i", rawTempPath, "-strict", "unofficial", "-frames:v", "1", middleOut], { stdio: "pipe" });

        processedSegments.push({
          tempKey,
          tempVideoName,
          tempFirstThumbName,
          tempMiddleThumbName,
          title: baseTitle,
          model: uploader,
          seriesNr: segNr,
          seriesTotal: totalSegments,
          startTime: range.start,
          endTime: range.end,
        });
      }

      // Immediately delete the raw downloaded video
      try {
        if (fsSync.existsSync(rawTempPath)) fsSync.unlinkSync(rawTempPath);
      } catch (_) {}
    }

    if (processedSegments.length === 0) {
      cleanupAll();
      if (skippedDuplicates.length > 0) {
        return res.status(409).json({
          error: `Upload skipped: Video "${skippedDuplicates[0].title}" already exists in ${skippedDuplicates[0].reason}.`,
          skippedDuplicates,
        });
      }
      return res.status(400).json({ error: "No valid video segments could be extracted." });
    }

    const targetUrl = process.env.CLIPFLIP_TARGET_URL || "https://clip-flip.com";
    const isProduction =
      process.env.NODE_ENV === "production" ||
      fsSync.existsSync("/var/www/clipflip") ||
      Boolean(req.headers.host && (req.headers.host.includes("clip-flip.com") || req.headers.host.includes("56.228.95.201")));

    const confirmResults: any[] = [];

    // When running locally, upload to production server
    if (!isProduction) {
      console.log(`[upload-url] Uploading ${processedSegments.length} sliced segments to production (${targetUrl})...`);
      const BATCH_SIZE = 10;
      for (let i = 0; i < processedSegments.length; i += BATCH_SIZE) {
        const batch = processedSegments.slice(i, i + BATCH_SIZE);
        const formData = new FormData();

        formData.append(
          "metadata",
          JSON.stringify({
            segments: batch,
            tagId,
            tags: bodyTags,
            userId: uploaderId,
          })
        );

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
          `${targetUrl.replace(/\/+$/, "")}/api/confirm-segments`,
          formData,
          {
            headers: { ...formData.getHeaders() },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 180000,
          }
        );

        if (confirmResponse.data?.videos) {
          confirmResults.push(...confirmResponse.data.videos);
        }
      }
    } else {
      // If executed directly on production, save to production storage directly
      for (const seg of processedSegments) {
        const videoPath = path.join(tempBaseDir, seg.tempVideoName);
        const firstThumbPath = path.join(tempThumbDir, seg.tempFirstThumbName);
        const midThumbPath = path.join(tempThumbDir, seg.tempMiddleThumbName);

        const titleParts = seg.title ? seg.title.split(",") : [];
        const modelCandidate = seg.model || (titleParts.length > 1 ? titleParts[0].trim() : undefined);

        const newVideo = await prisma.newVideo.create({
          data: {
            title: seg.title,
            startTime: seg.startTime,
            endTime: seg.endTime,
            seriesNr: seg.seriesNr ?? null,
            seriesTotal: seg.seriesTotal ?? null,
            userId: uploaderId && !isNaN(uploaderId) ? uploaderId : undefined,
            tags: tagId ? { connect: [{ id: Number(tagId) }] } : undefined,
            models: modelCandidate
              ? {
                  connectOrCreate: [
                    {
                      where: { name: modelCandidate },
                      create: { name: modelCandidate },
                    },
                  ],
                }
              : undefined,
          },
          include: { tags: true, models: true },
        });

        const segmentId = newVideo.id;
        const destVideo = path.join(outputDir, `${segmentId}.mp4`);
        const destFirstThumb = path.join(outputDirThumbnails, `${segmentId}_first.jpg`);
        const destMidThumb = path.join(outputDirThumbnails, `${segmentId}_middle.jpg`);

        moveFileCrossDevice(videoPath, destVideo);
        if (fsSync.existsSync(firstThumbPath)) moveFileCrossDevice(firstThumbPath, destFirstThumb);
        if (fsSync.existsSync(midThumbPath)) moveFileCrossDevice(midThumbPath, destMidThumb);

        confirmResults.push(newVideo);
      }
    }

    return res.json({
      success: true,
      message: `Processed ${cleanUrls.length} URL(s) into ${processedSegments.length} clips and uploaded to production! (0 bytes kept on local machine)`,
      clipsCreated: processedSegments.length,
      videos: confirmResults,
    });
  } catch (error) {
    console.error("Error in upload-url:", error);
    return res.status(500).json({
      error: "Failed to download and process video from URL",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    // ALWAYS clean up all files from the local computer!
    cleanupAll();
  }
});

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

      const cleanupAll = () => {
        for (const f of [...uploadedVideos, ...uploadedThumbs]) {
          try {
            if (fsSync.existsSync(f.path)) fsSync.unlinkSync(f.path);
          } catch (_) {}
        }
      };

      // Strict validation for segment uploads: <= 5MB and between 2s and 5s duration
      for (const videoFile of uploadedVideos) {
        if (videoFile.size > 5 * 1024 * 1024) {
          cleanupAll();
          return res.status(400).json({
            error: `Video is too heavy: "${videoFile.originalname}" is ${(videoFile.size / (1024 * 1024)).toFixed(2)} MB. Maximum allowed size is 5 MB.`,
          });
        }

        const duration = getVideoDuration(videoFile.path);
        if (duration > 5.05) {
          cleanupAll();
          return res.status(400).json({
            error: `Video is too long: "${videoFile.originalname}" is ${duration.toFixed(1)}s. Clips must be 5 seconds or shorter (allowed range: 2s–5s).`,
          });
        }
        if (duration < 1.95) {
          cleanupAll();
          return res.status(400).json({
            error: `Video is too short: "${videoFile.originalname}" is ${duration.toFixed(1)}s. Clips must be at least 2 seconds (allowed range: 2s–5s).`,
          });
        }
      }

      const { segments, tagId, tags: metaTags, userId: metaUserId } = JSON.parse(req.body.metadata) as {
        segments: SegmentItem[];
        tagId?: number | string;
        tags?: string[] | string;
        userId?: number | string;
      };

      const uploaderId =
        req.cookies?.userId && !isNaN(Number(req.cookies.userId))
          ? Number(req.cookies.userId)
          : metaUserId && !isNaN(Number(metaUserId))
            ? Number(metaUserId)
            : null;

      if (!segments || segments.length === 0) {
        cleanupAll();
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

          let tagConnectOrCreate: { where: { title: string }; create: { title: string } }[] = [];
          if (Array.isArray(metaTags)) {
            tagConnectOrCreate = metaTags
              .map((t) => String(t).trim())
              .filter(Boolean)
              .map((t) => ({ where: { title: t }, create: { title: t } }));
          } else if (typeof metaTags === "string" && metaTags.trim()) {
            tagConnectOrCreate = [{ where: { title: metaTags.trim() }, create: { title: metaTags.trim() } }];
          }

          const titleParts = seg.title ? seg.title.split(",") : [];
          const modelCandidate = seg.model || (titleParts.length > 1 ? titleParts[0].trim() : undefined);
          const rawVideoId = titleParts.length > 1 ? titleParts[1].trim() : undefined;

          // Duplicate defence: check if this specific segment or video already exists in DB
          const dupConditions: any[] = [];
          if (seg.seriesNr != null) {
            dupConditions.push({
              title: seg.title,
              seriesNr: seg.seriesNr,
            });
            if (rawVideoId && rawVideoId.length > 3) {
              dupConditions.push({
                title: { contains: rawVideoId },
                seriesNr: seg.seriesNr,
              });
            }
          } else if (seg.startTime != null && seg.startTime > 0) {
            dupConditions.push({
              title: seg.title,
              startTime: seg.startTime,
            });
            if (rawVideoId && rawVideoId.length > 3) {
              dupConditions.push({
                title: { contains: rawVideoId },
                startTime: seg.startTime,
              });
            }
          } else {
            dupConditions.push({ title: seg.title });
            if (rawVideoId && rawVideoId.length > 3) {
              dupConditions.push({ title: { contains: rawVideoId } });
            }
          }

          const dupInNew = await tx.newVideo.findFirst({ where: { OR: dupConditions } });
          const dupInVideo = await tx.video.findFirst({ where: { OR: dupConditions } });

          if (dupInNew || dupInVideo) {
            console.log(`[confirm-segments] 🛡️ Duplicate skipped for "${seg.title}" segment #${seg.seriesNr ?? 1} (already exists in ${dupInNew ? 'New' : 'Video'})`);
            continue;
          }

          const newVideo = await tx.newVideo.create({
            data: {
              title: seg.title,
              startTime: seg.startTime,
              endTime: seg.endTime,
              seriesNr: seg.seriesNr ?? null,
              seriesTotal: seg.seriesTotal ?? null,
              userId: uploaderId && !isNaN(uploaderId) ? uploaderId : undefined,
              tags: tagConnectOrCreate.length > 0
                ? { connectOrCreate: tagConnectOrCreate }
                : (tagId ? { connect: [{ id: Number(tagId) }] } : undefined),
              models: modelCandidate
                ? {
                    connectOrCreate: [
                      {
                        where: { name: modelCandidate },
                        create: { name: modelCandidate },
                      },
                    ],
                  }
                : undefined,
            },
            include: { tags: true, models: true },
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
          studio: newVideo.studio,
          seriesNr: newVideo.seriesNr,
          seriesTotal: newVideo.seriesTotal,
          startTime: newVideo.startTime,
          endTime: newVideo.endTime,
          userId: newVideo.userId,
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

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuffer = Buffer.from(hash, "hex");
  const testBuffer = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(hashBuffer, testBuffer);
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp) {
    return realIp.trim();
  }
  return req.ip || req.socket.remoteAddress || "";
}

function getBrowserId(req: Request): string | undefined {
  const headerId = req.headers["x-browser-id"];
  if (typeof headerId === "string" && headerId.trim()) {
    return headerId.trim();
  }
  const cookieId = req.cookies?.browserId;
  if (typeof cookieId === "string" && cookieId.trim()) {
    return cookieId.trim();
  }
  return undefined;
}

function setUserCookie(res: Response, userId: number) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("userId", String(userId), {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });
}

function setBrowserCookie(res: Response, browserId: string) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("browserId", browserId, {
    httpOnly: false,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });
}

interface DeviceInfo {
  deviceType: "Mobile" | "Tablet" | "Desktop" | "Bot" | "Unknown";
  os: string;
  browser: string;
}

function parseUserAgent(uaString: string | undefined): DeviceInfo {
  if (!uaString) {
    return { deviceType: "Unknown", os: "Unknown", browser: "Unknown" };
  }

  const ua = uaString.toLowerCase();

  // 1. Device Type
  let deviceType: DeviceInfo["deviceType"] = "Desktop";
  if (/bot|crawler|spider|crawling/i.test(ua)) {
    deviceType = "Bot";
  } else if (/ipad|tablet|(android(?!.*mobile))|kindle|silk/i.test(ua)) {
    deviceType = "Tablet";
  } else if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile|windows phone/i.test(ua)) {
    deviceType = "Mobile";
  }

  // 2. Operating System
  let os = "Other";
  if (/windows phone/i.test(ua)) os = "Windows Phone";
  else if (/windows nt 10/i.test(ua)) os = "Windows 10/11";
  else if (/windows nt 6\.3/i.test(ua)) os = "Windows 8.1";
  else if (/windows nt 6\.2/i.test(ua)) os = "Windows 8";
  else if (/windows nt 6\.1/i.test(ua)) os = "Windows 7";
  else if (/windows/i.test(ua)) os = "Windows";
  else if (/iphone/i.test(ua)) os = "iOS (iPhone)";
  else if (/ipad/i.test(ua)) os = "iOS (iPad)";
  else if (/android/i.test(ua)) {
    const match = ua.match(/android\s([0-9\.]+)/i);
    os = match ? `Android ${match[1]}` : "Android";
  } else if (/mac os x/i.test(ua)) {
    os = "macOS";
  } else if (/cros/i.test(ua)) {
    os = "Chrome OS";
  } else if (/linux/i.test(ua)) {
    os = "Linux";
  }

  // 3. Browser
  let browser = "Other";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";
  else if (/samsungbrowser/i.test(ua)) browser = "Samsung";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";
  else if (/msie|trident/i.test(ua)) browser = "IE";

  return { deviceType, os, browser };
}

const geoCache = new Map<string, { country: string; countryCode: string; city?: string }>();

async function lookupIpGeo(ip?: string, cfCountry?: string): Promise<{ country: string; countryCode: string; city?: string } | null> {
  if (!ip) return cfCountry ? { country: cfCountry, countryCode: cfCountry } : null;

  const cleanIp = ip.replace(/^::ffff:/, "").trim();

  // Check private / local ranges
  if (
    !cleanIp ||
    cleanIp === "127.0.0.1" ||
    cleanIp === "::1" ||
    cleanIp.startsWith("192.168.") ||
    cleanIp.startsWith("10.") ||
    cleanIp.startsWith("172.16.") ||
    cleanIp === "localhost"
  ) {
    return { country: "Local / Private", countryCode: "LOC" };
  }

  if (geoCache.has(cleanIp)) {
    return geoCache.get(cleanIp)!;
  }

  if (cfCountry && cfCountry.length === 2 && cfCountry !== "XX") {
    const res = { country: cfCountry, countryCode: cfCountry };
    geoCache.set(cleanIp, res);
    return res;
  }

  try {
    const response = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode,city`, {
      timeout: 2000,
    });
    if (response.data && response.data.status === "success") {
      const geo = {
        country: response.data.country || "Unknown",
        countryCode: response.data.countryCode || "",
        city: response.data.city || "",
      };
      geoCache.set(cleanIp, geo);
      return geo;
    }
  } catch (_) {}

  return cfCountry ? { country: cfCountry, countryCode: cfCountry } : null;
}

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

    const rawUserId = req.cookies.userId;
    const currentUserId = Number(rawUserId);
    let currentUser: any = null;
    if (rawUserId && !isNaN(currentUserId)) {
      currentUser = await prisma.user.findUnique({ where: { id: currentUserId } });
    }

    const existingGoogleUser = await prisma.user.findUnique({
      where: { googleId: payload.sub },
    });

    let targetUser: any = null;

    if (currentUser?.isGuest) {
      if (existingGoogleUser) {
        // Transfer guest reactions to existing Google account
        const guestReactions = await prisma.videoReaction.findMany({
          where: { userId: currentUser.id },
        });
        for (const r of guestReactions) {
          await prisma.videoReaction.upsert({
            where: {
              userId_videoId: {
                userId: existingGoogleUser.id,
                videoId: r.videoId,
              },
            },
            update: { type: r.type },
            create: {
              userId: existingGoogleUser.id,
              videoId: r.videoId,
              type: r.type,
            },
          });
        }
        // Transfer uploads
        await prisma.video.updateMany({
          where: { userId: currentUser.id },
          data: { userId: existingGoogleUser.id },
        });
        await prisma.newVideo.updateMany({
          where: { userId: currentUser.id },
          data: { userId: existingGoogleUser.id },
        });

        // Clean up temporary guest user
        await prisma.user.delete({ where: { id: currentUser.id } }).catch(() => {});

        // Update target user with latest Google profile info
        targetUser = await prisma.user.update({
          where: { id: existingGoogleUser.id },
          data: {
            email: payload.email,
            name: payload.name ?? existingGoogleUser.name,
            picture: payload.picture ?? existingGoogleUser.picture,
          },
        });
      } else {
        // Upgrade current guest user directly
        targetUser = await prisma.user.update({
          where: { id: currentUser.id },
          data: {
            googleId: payload.sub,
            email: payload.email,
            name: payload.name ?? currentUser.name,
            picture: payload.picture ?? null,
            isGuest: false,
          },
        });
      }
    } else {
      // Normal upsert
      targetUser = await prisma.user.upsert({
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
          isGuest: false,
        },
      });
    }

    setUserCookie(res, targetUser.id);

    return res.json({
      success: true,
      user: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        username: targetUser.username,
        picture: targetUser.picture,
        isGuest: !!targetUser.isGuest,
      },
    });
  } catch (err) {
    console.error("Google auth error:", err);
    return res.status(401).json({ success: false, error: "Login failed" });
  }
});

app.post("/auth/register", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");

    if (cleanUsername.length < 3) {
      return res.status(400).json({ error: "Username must be at least 3 characters." });
    }
    if (cleanPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const existing = await prisma.user.findFirst({
      where: { username: { equals: cleanUsername } },
    });
    if (existing) {
      return res.status(400).json({ error: "Username is already taken." });
    }

    const hashedPassword = hashPassword(cleanPassword);
    const rawUserId = req.cookies.userId;
    const currentUserId = Number(rawUserId);
    let currentUser: any = null;
    if (rawUserId && !isNaN(currentUserId)) {
      currentUser = await prisma.user.findUnique({ where: { id: currentUserId } });
    }

    let user: any = null;
    if (currentUser?.isGuest) {
      user = await prisma.user.update({
        where: { id: currentUser.id },
        data: {
          username: cleanUsername,
          name: cleanUsername,
          password: hashedPassword,
          isGuest: false,
        },
      });
    } else {
      const clientIp = getClientIp(req);
      const browserId = getBrowserId(req);
      user = await prisma.user.create({
        data: {
          username: cleanUsername,
          name: cleanUsername,
          password: hashedPassword,
          isGuest: false,
          browserId: browserId || null,
          lastIp: clientIp || null,
        },
      });
    }

    setUserCookie(res, user.id);
    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        picture: user.picture,
        isGuest: false,
      },
    });
  } catch (err: any) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Registration failed." });
  }
});

const ADMIN_EMAILS = ["belendorrr@gmail.com"];

function checkIsAdmin(user: { email?: string | null; username?: string | null } | null | undefined): boolean {
  if (!user) return false;
  if (user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  if (user.username && (user.username.toLowerCase() === "admin" || user.username.toLowerCase() === "belendor")) return true;
  return false;
}

app.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");

    if (!cleanUsername || !cleanPassword) {
      return res.status(400).json({ error: "Username and password required." });
    }

    const user = await prisma.user.findFirst({
      where: { username: { equals: cleanUsername } },
    });

    if (!user || !user.password || !verifyPassword(cleanPassword, user.password)) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    // Merge temporary guest likes/uploads into logged-in user if different
    const rawUserId = req.cookies.userId;
    const currentUserId = Number(rawUserId);
    if (rawUserId && !isNaN(currentUserId) && currentUserId !== user.id) {
      const currentGuest = await prisma.user.findUnique({ where: { id: currentUserId } });
      if (currentGuest?.isGuest) {
        const guestReactions = await prisma.videoReaction.findMany({
          where: { userId: currentGuest.id },
        });
        for (const r of guestReactions) {
          await prisma.videoReaction.upsert({
            where: { userId_videoId: { userId: user.id, videoId: r.videoId } },
            update: { type: r.type },
            create: { userId: user.id, videoId: r.videoId, type: r.type },
          });
        }
        await prisma.video.updateMany({
          where: { userId: currentGuest.id },
          data: { userId: user.id },
        });
        await prisma.newVideo.updateMany({
          where: { userId: currentGuest.id },
          data: { userId: user.id },
        });
        await prisma.user.delete({ where: { id: currentGuest.id } }).catch(() => {});
      }
    }

    setUserCookie(res, user.id);
    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        picture: user.picture,
        isGuest: !!user.isGuest,
        isAdmin: checkIsAdmin(user),
      },
    });
  } catch (err: any) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed." });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const rawUserId = req.cookies.userId;
    const cookieUserId = Number(rawUserId);
    const clientIp = getClientIp(req);
    const browserId = getBrowserId(req);
    const userAgent = (req.headers["user-agent"] as string) || "";
    const cfCountry = typeof req.headers["cf-ipcountry"] === "string" ? req.headers["cf-ipcountry"].toUpperCase() : undefined;
    const { deviceType, os, browser } = parseUserAgent(userAgent);

    let user: any = null;

    if (rawUserId && !isNaN(cookieUserId)) {
      user = await prisma.user.findUnique({
        where: { id: cookieUserId },
      });
    }

    // If not authenticated via cookie, find or create guest user
    if (!user) {
      // 1. Try finding by browserId
      if (browserId) {
        user = await prisma.user.findFirst({
          where: {
            isGuest: true,
            browserId: browserId,
          },
          orderBy: { updatedAt: "desc" },
        });
      }

      // 2. If not found by browserId, try finding by IP
      if (!user && clientIp) {
        user = await prisma.user.findFirst({
          where: {
            isGuest: true,
            lastIp: clientIp,
          },
          orderBy: { updatedAt: "desc" },
        });
      }

      // 3. If still not found, create new guest user
      if (!user) {
        const maxGuest = await prisma.user.findFirst({
          where: { guestNumber: { not: null } },
          orderBy: { guestNumber: "desc" },
          select: { guestNumber: true },
        });
        const nextGuestNumber = (maxGuest?.guestNumber || 0) + 1;
        const guestName = `Guest ${nextGuestNumber}`;
        const geo = await lookupIpGeo(clientIp, cfCountry);

        user = await prisma.user.create({
          data: {
            isGuest: true,
            guestNumber: nextGuestNumber,
            name: guestName,
            browserId: browserId || null,
            lastIp: clientIp || null,
            country: geo?.country || null,
            countryCode: geo?.countryCode || (cfCountry || null),
            city: geo?.city || null,
            device: deviceType,
            os: os,
            browser: browser,
            userAgent: userAgent ? userAgent.substring(0, 300) : null,
          },
        });
      }

      setUserCookie(res, user.id);
    }

    // Keep metadata updated if browserId, IP, or device changed
    const updates: any = {};
    if (browserId && user.browserId !== browserId) {
      updates.browserId = browserId;
    }
    if (clientIp && user.lastIp !== clientIp) {
      updates.lastIp = clientIp;
    }
    if (deviceType && user.device !== deviceType && deviceType !== "Unknown") {
      updates.device = deviceType;
    }
    if (os && user.os !== os && os !== "Other") {
      updates.os = os;
    }
    if (browser && user.browser !== browser && browser !== "Other") {
      updates.browser = browser;
    }
    if (userAgent && (!user.userAgent || user.userAgent !== userAgent.substring(0, 300))) {
      updates.userAgent = userAgent.substring(0, 300);
    }
    if ((!user.country || !user.countryCode) && clientIp) {
      const geo = await lookupIpGeo(clientIp, cfCountry);
      if (geo) {
        updates.country = geo.country;
        updates.countryCode = geo.countryCode;
        if (geo.city) updates.city = geo.city;
      }
    }

    if (Object.keys(updates).length > 0) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: updates,
      });
    }

    if (browserId) {
      setBrowserCookie(res, browserId);
    }

    const isAdmin = checkIsAdmin(user);
    const [likesCount, approvedUploads, pendingUploads] = await Promise.all([
      prisma.videoReaction.count({
        where: { userId: user.id, type: "like" },
      }),
      prisma.video.count({
        where: { userId: user.id },
      }),
      prisma.newVideo.count({
        where: { userId: user.id },
      }),
    ]);

    const uploadsCount = approvedUploads + pendingUploads;

    return res.json({
      loggedIn: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        picture: user.picture,
        isGuest: !!user.isGuest,
        guestNumber: user.guestNumber,
        country: user.country,
        countryCode: user.countryCode,
        city: user.city,
        device: user.device,
        os: user.os,
        browser: user.browser,
        isAdmin,
        likesCount,
        uploadsCount,
        approvedUploads,
        pendingUploads,
        preference: user.preference || null,
        blacklist: user.blacklist ? JSON.parse(user.blacklist) : [],
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    console.error("Error in /auth/me:", err);
    return res.status(500).json({ error: "Failed to authenticate" });
  }
});

app.post("/user/preferences", async (req: Request, res: Response) => {
  try {
    const { preference, blacklist } = req.body;
    const rawUserId = req.cookies.userId || req.headers["x-user-id"] || req.body.userId;
    const userId = Number(rawUserId);
    const browserId = req.cookies.cf_bid || req.body.browserId;

    let user = null;
    if (userId && !isNaN(userId)) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    } else if (browserId) {
      user = await prisma.user.findFirst({ where: { browserId } });
    }

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const updates: any = {};
    if (typeof preference === "string") {
      updates.preference = preference;
    }
    if (Array.isArray(blacklist)) {
      updates.blacklist = JSON.stringify(blacklist);
    } else if (typeof blacklist === "string") {
      updates.blacklist = blacklist;
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: updates,
    });

    return res.json({
      success: true,
      preference: updatedUser.preference,
      blacklist: updatedUser.blacklist ? JSON.parse(updatedUser.blacklist) : [],
    });
  } catch (err) {
    console.error("Error updating user preferences:", err);
    return res.status(500).json({ error: "Failed to update preferences" });
  }
});

app.get("/admin/stats", async (req: Request, res: Response) => {
  try {
    const userId = Number(req.cookies.userId);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !ADMIN_EMAILS.includes((user.email || "").toLowerCase())) {
      return res.status(403).json({ error: "Forbidden: Admin access required" });
    }

    const [totalUsers, totalGuests, totalRegistered, totalLikes, totalVideos, totalUploads, pendingUploads, usersList] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isGuest: true } }),
      prisma.user.count({ where: { isGuest: false } }),
      prisma.videoReaction.count({ where: { type: "like" } }),
      prisma.video.count(),
      prisma.video.count({ where: { userId: { not: null } } }),
      prisma.newVideo.count(),
      prisma.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          username: true,
          isGuest: true,
          guestNumber: true,
          picture: true,
          lastIp: true,
          country: true,
          countryCode: true,
          city: true,
          device: true,
          os: true,
          browser: true,
          preference: true,
          blacklist: true,
          createdAt: true,
          updatedAt: true,
          reactions: {
            where: { type: "like" },
            select: { videoId: true },
          },
          uploadedVideos: {
            select: { id: true },
          },
          uploadedNewVideos: {
            select: { id: true },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const users = usersList.map((u) => {
      const approvedCount = u.uploadedVideos.length;
      const pendingCount = u.uploadedNewVideos.length;
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        username: u.username,
        isGuest: u.isGuest,
        guestNumber: u.guestNumber,
        picture: u.picture,
        lastIp: u.lastIp,
        country: u.country,
        countryCode: u.countryCode,
        city: u.city,
        device: u.device,
        os: u.os,
        browser: u.browser,
        preference: u.preference || null,
        blacklist: u.blacklist ? JSON.parse(u.blacklist) : [],
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        likesCount: u.reactions.length,
        uploadsCount: approvedCount + pendingCount,
        approvedUploads: approvedCount,
        pendingUploads: pendingCount,
        isAdmin: ADMIN_EMAILS.includes((u.email || "").toLowerCase()),
      };
    });

    users.sort((a, b) => b.likesCount - a.likesCount);

    return res.json({
      success: true,
      stats: {
        totalUsers,
        totalGuests,
        totalRegistered,
        totalLikes,
        totalVideos,
        totalUploads,
        pendingUploads,
        users,
      },
    });
  } catch (error) {
    console.error("Error fetching admin stats:", error);
    return res.status(500).json({ error: "Failed to fetch admin statistics" });
  }
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
            type: "like",
          },
        },
      },
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
      orderBy: {
        id: "asc",
      },
    });

    const mappedVideos = videos.map((video) => {
      const likes = video.reactions.filter((r) => r.type === "like").length;
      const dislikes = video.reactions.filter((r) => r.type === "dislike").length;
      return {
        ...video,
        likes,
        dislikes,
        myReaction: "like",
        reactions: video.reactions,
      };
    });

    res.json(mappedVideos);
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const handleVideoPlayer = async (req: Request, res: Response) => {
  const originalUri = (req.headers['x-original-uri'] as string) || (req.query.src as string) || (req.query.url as string) || req.path;
  const cleanPath = (originalUri || '').split('?')[0];

  let rawVideoUrl = "";
  let thumbPath = "/thumbnails/preview.jpg";
  let title = "ClipFlip";

  // Check different URL patterns
  // /v/new/298 or /watch/new/298 or /new/298.mp4
  const newMatch = cleanPath.match(/(?:\/v\/new\/|\/watch\/new\/|\/new\/)(\d+)/i);
  // /v/123 or /watch/123 or /video/123.mp4 or /video1/123.mp4
  const stdMatch = cleanPath.match(/(?:\/v\/|\/watch\/|\/video\/|\/video1\/)(\d+)/i);

  try {
    if (newMatch) {
      const vidId = parseInt(newMatch[1], 10);
      rawVideoUrl = `/video1/new/${vidId}.mp4?raw=1`;
      thumbPath = `/video1/new/thumbnails/${vidId}_middle.jpg`;
      const newVid = await prisma.newVideo.findUnique({
        where: { id: vidId },
        include: { tags: true, models: true },
      });
      if (newVid?.title) {
        title = newVid.title;
      } else {
        title = `Clip #${vidId}`;
      }
    } else if (stdMatch) {
      const vidId = parseInt(stdMatch[1], 10);
      // Determine if batch 1 or batch 2
      const isBatch2 = cleanPath.includes('/video1/') || vidId >= 11256;
      rawVideoUrl = isBatch2 ? `/video1/${vidId}.mp4?raw=1` : `/video/${vidId}.mp4?raw=1`;
      thumbPath = `/thumbnail/${vidId}.jpg`;
      const vid = await prisma.video.findUnique({
        where: { id: vidId },
        include: { tags: true, models: true },
      });
      if (vid?.title) {
        title = vid.title;
      } else {
        title = `Clip #${vidId}`;
      }
    } else {
      rawVideoUrl = `${cleanPath.replace(/\.gifv$/i, '.mp4')}?raw=1`;
      title = path.basename(cleanPath).replace(/\.(mp4|gifv)$/i, '');
    }
  } catch (err) {
    console.error("Error looking up video:", err);
    rawVideoUrl = `${cleanPath}?raw=1`;
  }

  const rawHost = req.get('x-forwarded-host') || req.get('host') || 'clip-flip.com';
  const isLocal = rawHost.includes('localhost') || rawHost.includes('127.0.0.1');
  const canonicalHost = isLocal ? rawHost : 'clip-flip.com';
  const proto = isLocal ? 'http' : 'https';
  const fullBase = `${proto}://${canonicalHost}`;
  const absoluteRawUrl = `${fullBase}${rawVideoUrl}`;
  const absoluteThumbUrl = `${fullBase}${thumbPath}`;
  const safeTitle = escapeHtml(title);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>${safeTitle}</title>

  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=2">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?v=2">
  <link rel="icon" type="image/png" sizes="512x512" href="/favicon.png?v=2">
  <link rel="icon" href="/favicon.ico?v=2" type="image/x-icon">
  <link rel="shortcut icon" href="/favicon.ico?v=2" type="image/x-icon">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">

  <meta property="og:site_name" content="ClipFlip">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="Watch on ClipFlip">
  <meta property="og:type" content="video.other">
  <meta property="og:video" content="${absoluteRawUrl}">
  <meta property="og:video:secure_url" content="${absoluteRawUrl}">
  <meta property="og:video:type" content="video/mp4">
  <meta property="og:video:width" content="720">
  <meta property="og:video:height" content="1280">
  <meta property="og:image" content="${absoluteThumbUrl}">
  <meta property="og:image:width" content="720">
  <meta property="og:image:height" content="1280">

  <meta name="twitter:card" content="player">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:image" content="${absoluteThumbUrl}">
  <meta name="twitter:player:stream" content="${absoluteRawUrl}">
  <meta name="twitter:player:stream:content_type" content="video/mp4">
  <meta name="twitter:player:width" content="720">
  <meta name="twitter:player:height" content="1280">

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      background: #000; color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
      display: flex; align-items: center; justify-content: center;
    }
    .player-wrap {
      position: relative; width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      background: #000;
    }
    video {
      width: 100%; height: 100%;
      max-width: 100vw; max-height: 100vh;
      object-fit: contain;
    }
    .controls-overlay {
      position: absolute; top: 12px; left: 14px; right: 14px;
      display: flex; justify-content: space-between; align-items: center;
      pointer-events: none; z-index: 10;
    }
    .btn-pill {
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.25);
      color: #fff; padding: 6px 14px; border-radius: 9999px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      backdrop-filter: blur(8px);
      display: inline-flex; align-items: center; gap: 6px;
      user-select: none; transition: background 0.15s, border-color 0.15s;
    }
    .btn-pill:hover { background: rgba(255, 255, 255, 0.2); }
    .btn-pill.active {
      border-color: #38bdf8; color: #38bdf8; background: rgba(14, 165, 233, 0.15);
    }
  </style>
</head>
<body>
  <div class="player-wrap">
    <div class="controls-overlay">
      <button id="repeatBtn" class="btn-pill active" title="Toggle video repeat">🔁 Repeat: ON</button>
      <button id="soundBtn" class="btn-pill" title="Toggle audio">🔇 Tap to Unmute</button>
    </div>

    <video id="v" src="${rawVideoUrl}" autoplay loop muted playsinline controls></video>
  </div>

  <script>
    const v = document.getElementById('v');
    const repeatBtn = document.getElementById('repeatBtn');
    const soundBtn = document.getElementById('soundBtn');

    // Force loop enabled
    v.loop = true;

    // Bulletproof loop listener for mobile browsers where native loop can stall
    v.addEventListener('ended', function() {
      if (v.loop) {
        v.currentTime = 0;
        v.play();
      }
    });

    // Autoplay attempt
    v.play().catch(function() {});

    // Repeat toggle button
    repeatBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      v.loop = !v.loop;
      if (v.loop) {
        repeatBtn.classList.add('active');
        repeatBtn.textContent = '🔁 Repeat: ON';
      } else {
        repeatBtn.classList.remove('active');
        repeatBtn.textContent = '➡️ Repeat: OFF';
      }
    });

    // Sound toggle button
    soundBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      v.muted = !v.muted;
      updateSoundUI();
    });

    function updateSoundUI() {
      if (v.muted || v.volume === 0) {
        soundBtn.textContent = '🔇 Tap to Unmute';
        soundBtn.classList.remove('active');
      } else {
        soundBtn.textContent = '🔊 Sound: ON';
        soundBtn.classList.add('active');
      }
    }

    v.addEventListener('volumechange', updateSoundUI);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
};

app.get(['/v/*', '/watch/*', '/player', '/video/*', '/video1/*'], handleVideoPlayer);

app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running at http://0.0.0.0:${port}`);
});
