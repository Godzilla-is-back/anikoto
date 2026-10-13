/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — streamResolver.extractor.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * Resolves embed → MegaPlay getSources → AES-decrypt enc → master.m3u8
 * qualities (1080 / 720 / 360 …).
 *
 * @exports
 *   resolveStreamUrl, resolveStreamUrls, parseM3u8Qualities
 * ======= • ======= • ======= • ======= • =======• =======
 */

import axios from "axios";
import crypto from "crypto";
import { headers } from "../configs/header.config.js";

// ══════════════════════════════════════════════════════════════
// STREAM RESOLVER
// ══════════════════════════════════════════════════════════════

const SERVER_NAME_MAP = {
  "VidPlay-1": "vidplay",
  "VidPlay-2": "vidplay",
  "HD-1": "hd",
  "HD-2": "hd",
  "Vidstream-1": "vidstream",
  "Vidstream-2": "vidstream",
  "VidCloud-1": "vidcloud",
  "VidCloud-2": "vidcloud",
  "StreamTape-1": "streamtape",
  "StreamTape-2": "streamtape",
};

// Always use the live MegaPlay host (megaplay-1.buzz is dead DNS).
const EMBED_API_MAP = {
  "vidtube.site": "megaplay.buzz",
  "vidplay.site": "megaplay.buzz",
  "megaplay.buzz": "megaplay.buzz",
  "embed.bunkrerrer.com": "megaplay.buzz",
};

// Same key/IV MegaPlay's app.main.js uses for AES-CBC (domains + source enc).
const MEGAPLAY_AES_KEY = "i?LMTAx0Q6,:}50U";
const MEGAPLAY_AES_IV = "W0;27ToaUpl_P%'c";

const normalizeServerName = (name) => {
  if (!name) return "unknown";
  return SERVER_NAME_MAP[name] || name.toLowerCase().replace(/[-\s]+\d+$/, "").trim();
};

/** Pad / truncate string to fixed byte length (MegaPlay padKeyBytes). */
const padKeyBytes = (str, len) => {
  const out = Buffer.alloc(len);
  const src = Buffer.from(String(str), "utf8");
  src.copy(out, 0, 0, Math.min(len, src.length));
  return out;
};

/** Base64url → Buffer */
const b64UrlDecode = (input) => {
  let s = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "====".slice(pad);
  return Buffer.from(s, "base64");
};

/**
 * Decrypt MegaPlay getSources `enc` field → { file: "…master.m3u8" }
 */
const decryptMegaPlayEnc = (enc) => {
  if (!enc || typeof enc !== "string") return null;
  try {
    const key = padKeyBytes(MEGAPLAY_AES_KEY, 32);
    const iv = padKeyBytes(MEGAPLAY_AES_IV, 16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const pt = Buffer.concat([decipher.update(b64UrlDecode(enc)), decipher.final()]);
    return JSON.parse(pt.toString("utf8"));
  } catch {
    return null;
  }
};

/** sub | dub from embed path */
const audioTypeFromEmbed = (embedUrl) => {
  try {
    const path = new URL(embedUrl).pathname.toLowerCase();
    if (path.includes("/dub")) return "dub";
  } catch { /* ignore */ }
  return "sub";
};

/**
 * Resolve embed page → real HLS master + per-quality media playlists.
 */
const resolveStreamUrl = async (embedUrl, options = {}) => {
  const { followRedirects = true, timeout = 15000 } = options;

  try {
    const embedResponse = await axios.get(embedUrl, {
      headers: {
        ...headers,
        Referer: "https://anikototv.to/",
        Origin: "https://anikototv.to",
      },
      timeout,
      maxRedirects: followRedirects ? 5 : 0,
    });

    const embedHtml =
      typeof embedResponse.data === "string"
        ? embedResponse.data
        : String(embedResponse.data);

    const dataId = embedHtml.match(/data-id="(\d+)"/)?.[1];
    const realId = embedHtml.match(/data-realid="([^"]+)"/)?.[1];
    const mediaId = embedHtml.match(/data-mediaid="([^"]+)"/)?.[1];

    if (!dataId) {
      return {
        url: null,
        qualities: [],
        skipData: null,
        type: null,
        error: "Could not extract player data-id from embed page",
      };
    }

    const embedDomain = new URL(embedUrl).hostname;
    const apiDomain = EMBED_API_MAP[embedDomain] || "megaplay.buzz";
    const audioType = audioTypeFromEmbed(embedUrl);

    // Live MegaPlay sources endpoint (old /ajax/sources is dead).
    const sourcesUrl = `https://${apiDomain}/stream/getSources?id=${encodeURIComponent(
      dataId
    )}&type=${audioType}`;

    const apiResponse = await axios.get(sourcesUrl, {
      headers: {
        ...headers,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: embedUrl,
        Origin: `https://${embedDomain}`,
      },
      timeout,
    });

    const apiData =
      typeof apiResponse.data === "string"
        ? (() => {
            try {
              return JSON.parse(apiResponse.data);
            } catch {
              return {};
            }
          })()
        : apiResponse.data || {};

    // Plain fields (legacy) or encrypted `enc`
    let streamUrl =
      apiData?.source || apiData?.url || apiData?.file || null;

    if (!streamUrl && apiData?.enc) {
      const decoded = decryptMegaPlayEnc(apiData.enc);
      streamUrl = decoded?.file || decoded?.source || decoded?.url || null;
    }

    // Nested sources array
    if (!streamUrl && Array.isArray(apiData?.sources) && apiData.sources[0]) {
      streamUrl =
        apiData.sources[0].file ||
        apiData.sources[0].src ||
        apiData.sources[0].url ||
        null;
    }

    if (!streamUrl) {
      return {
        url: null,
        qualities: [],
        skipData: null,
        type: null,
        error: "MegaPlay getSources returned no stream file (enc decrypt failed or empty)",
        dataId,
        realId,
        mediaId,
      };
    }

    const streamType =
      apiData?.type ||
      (String(streamUrl).includes(".m3u8") ? "hls" : "mp4");

    let qualities = [];
    if (String(streamUrl).includes(".m3u8") || streamType === "hls") {
      qualities = await parseM3u8Qualities(streamUrl, {
        headers: {
          ...headers,
          Referer: embedUrl,
          Origin: `https://${embedDomain}`,
        },
        timeout,
      });
    }

    const subtitles = extractSubtitles(apiData);

    const skipData =
      apiData?.skip_data ||
      (apiData?.intro || apiData?.outro
        ? {
            intro: apiData.intro
              ? [apiData.intro.start, apiData.intro.end]
              : null,
            outro: apiData.outro
              ? [apiData.outro.start, apiData.outro.end]
              : null,
          }
        : null);

    return {
      url: streamUrl,
      type: streamType === "hls" || String(streamUrl).includes(".m3u8") ? "hls" : streamType,
      qualities,
      subtitles,
      skipData,
      dataId,
      realId,
      mediaId,
      backup: apiData?.backup || null,
    };
  } catch (error) {
    return {
      url: null,
      qualities: [],
      skipData: null,
      type: null,
      error: error.message,
    };
  }
};

const resolveStreamUrls = async (embedUrl, options = {}) => {
  try {
    return await resolveStreamUrl(embedUrl, options);
  } catch (error) {
    return { url: null, error: error.message };
  }
};

// ══════════════════════════════════════════════════════════════
// M3U8 PARSER
// ══════════════════════════════════════════════════════════════

const parseM3u8Qualities = async (m3u8Url, options = {}) => {
  const { headers: customHeaders = {}, timeout = 10000 } = options;

  try {
    const response = await axios.get(m3u8Url, {
      headers: { ...headers, ...customHeaders },
      timeout,
    });

    const content =
      typeof response.data === "string"
        ? response.data
        : String(response.data);

    const qualities = [];
    const lines = content.split("\n").map((l) => l.trim());

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = lines[i].substring("#EXT-X-STREAM-INF:".length);
        const bandwidth = parseInt(attrs.match(/BANDWIDTH=(\d+)/)?.[1] || "0", 10);
        const resolution = attrs.match(/RESOLUTION=(\d+x\d+)/)?.[1] || "";
        const nameLabel = attrs.match(/NAME="([^"]+)"/)?.[1];
        const [width, height] = resolution.split("x").map(Number);
        const nextLine = lines[i + 1];

        if (nextLine && !nextLine.startsWith("#")) {
          const qualityUrl = nextLine.startsWith("http")
            ? nextLine
            : new URL(nextLine, m3u8Url).href;

          const label =
            nameLabel ||
            (height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}k` : "default");

          qualities.push({
            label,
            width: width || 0,
            height: height || 0,
            bandwidth,
            url: qualityUrl,
          });
        }
      }
    }

    if (qualities.length === 0 && content.includes("#EXTINF")) {
      qualities.push({
        label: "default",
        width: 0,
        height: 0,
        bandwidth: 0,
        url: m3u8Url,
      });
    }

    qualities.sort(
      (a, b) => (b.height || b.bandwidth) - (a.height || a.bandwidth)
    );

    return qualities;
  } catch {
    return [];
  }
};

// ══════════════════════════════════════════════════════════════
// SUBTITLE EXTRACTOR
// ══════════════════════════════════════════════════════════════

const extractSubtitles = (apiData) => {
  const subtitles = [];

  if (apiData?.subtitles && Array.isArray(apiData.subtitles)) {
    for (const sub of apiData.subtitles) {
      subtitles.push({
        label: sub.label || sub.language || "Unknown",
        language: sub.code || sub.language || "unknown",
        url: sub.url || sub.file || null,
        format: sub.format || "srt",
      });
    }
  }

  if (apiData?.tracks && Array.isArray(apiData.tracks)) {
    for (const track of apiData.tracks) {
      if (
        track.kind === "subtitles" ||
        track.kind === "captions" ||
        track.type === "subtitles"
      ) {
        subtitles.push({
          label: track.label || track.language || "Unknown",
          language: track.srclang || track.language || "unknown",
          url: track.file || track.src || null,
          format: track.format || "vtt",
        });
      }
    }
  }

  return subtitles;
};

export {
  resolveStreamUrl,
  resolveStreamUrls,
  parseM3u8Qualities,
  normalizeServerName,
  extractSubtitles,
};

// ══════════════════════════════════════════════════════════════ END
